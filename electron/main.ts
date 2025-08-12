// main.ts
import { app, BrowserWindow, screen, ipcMain, dialog } from 'electron';
import { DiscoveredPeer, startDiscovery } from './utilities/peerDiscovery';
import { connectToPeer, startTcpServer } from './utilities/peerConnection';
import * as path from 'path';
import * as os from 'os';
import * as url from 'url';
import * as dotenv from 'dotenv';
import * as net from 'net';
import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'; // npm install uuid
import * as fs from 'fs';
import { Progress, Result } from './utilities/transfer/types';
import { initiateFileTransfer, calculateFileHash } from './utilities/transfer/sender';
import { handleIncomingFileTransfer } from './utilities/transfer/receiver';
dotenv.config();

let mainWindow: BrowserWindow | null;

const isDev = process.env.NODE_ENV === 'development';

const homeDir = os.homedir();
const downloadsDir = path.join(homeDir, 'Downloads');

// Construct the path to the beembridge-received folder inside downloads
const beembridgeReceivedDir = path.join(downloadsDir, 'beembridge-received');

// Ensure the directory exists
if (!fs.existsSync(beembridgeReceivedDir)) {
  fs.mkdirSync(beembridgeReceivedDir, { recursive: true });
}

const store = new Store<{ userName: string, userId: string, storagePath: string }>({
  defaults: {
    userName: `BeemBridge User`,
    userId: `BB_USER_${crypto.randomUUID().replace(/-/g, '').substring(0, 10).toUpperCase()}`,
    storagePath: beembridgeReceivedDir
  },
});

interface SelectedItem {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  lastModified: string;
}

const pendingConnectionRequests = new Map<string, { accept: () => void, reject: (reason: string) => void }>();
const activeConnections = new Map<string, { peer: DiscoveredPeer, socket: net.Socket }>();

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.floor(width * 0.8),
    height: Math.floor(height * 0.8),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // Optional: for exposing Node.js APIs to renderer
      nodeIntegration: false, // Recommended for security
      contextIsolation: true, // Recommended for security
    },
  });
  const pathToNextRenderer = path.join(__dirname, '..', '..', 'renderer', 'index.html');

  if (isDev) {
    // Load Next.js development server URL
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // Load the Next.js static build
    mainWindow.loadURL(
      url.format({
        pathname: pathToNextRenderer,
        protocol: 'file:',
        slashes: true,
      })
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  ipcMain.on('start-peer-discovery', (event) => {

    // Example: Send a reply back to the specific renderer that sent the message
    const sendToRenderer = event.sender.send.bind(event.sender);
    startDiscovery(sendToRenderer, store.get('userName'), store.get('userId'));
    console.log("Peer discovery initiated from renderer request.");
  });


  interface TransferFilePrep {
    name: string;
    fileId: string;
    filePath: string;
    parentId?: string;
    prefix?: string;
  }

  ipcMain.on('send-files-to-peers', async (event, files: SelectedItem[], peers: DiscoveredPeer[]) => {
    console.log("Sending files:", files.map(f => f.name));
    const fileQueue: TransferFilePrep[] = [];

    const targetPeer: DiscoveredPeer = peers[0]; // For now, just send to the first peer
    const socket = activeConnections.get(targetPeer.instanceId)?.socket as net.Socket;

    // Helper to recursively read directories and populate fileQueue
    async function readDirectoryRecursive(dirPath: string, parentId: string, rootDir: string) {
      const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const dirent of dirents) {
        const filePath = path.join(dirPath, dirent.name);
        if (dirent.isDirectory()) {
          await readDirectoryRecursive(filePath, parentId, rootDir);
        } else {
          const fileId = await calculateFileHash(filePath, (percentage) => {
            event.sender.send('hashing-progress', { filePath, percentage });
          });
          const prefix = path.join(path.basename(rootDir), path.relative(rootDir, path.dirname(filePath)));

          fileQueue.push({
            name: dirent.name,
            fileId,
            filePath,
            parentId,
            prefix: prefix === '' ? '' : prefix + path.sep
          });
        }
      }
    }

    // Sequentially process files
    for (const file of files) {
      console.log(`Processing file: ${file.name}, Path: ${file.path}, Is Directory: ${file.isDirectory}`);
      if (file.isDirectory) {
        const parentId = uuidv4();
        await readDirectoryRecursive(file.path, parentId, file.path);
      } else {
        const fileId = await calculateFileHash(file.path, (percentage) => {
          event.sender.send('hashing-progress', { filePath: file.path, percentage });
        });
        fileQueue.push({
          name: file.name,
          fileId,
          filePath: file.path,
          prefix: '', // No prefix for single files
        });
        console.log(`File processed: ${file.name}, ID: ${fileId}`);
      }
    }

    // Queue and concurrency control
    let activeTransfers = 0;
    const MAX_CONCURRENT_TRANSFERS = 2; // Limit concurrent transfers

    async function sendNext() {
      console.log(`Initiating transfer for file`);
      while (activeTransfers < MAX_CONCURRENT_TRANSFERS && fileQueue.length > 0) {
        const file = fileQueue.shift();
        if (!file) break;
        activeTransfers++;
        initiateFileTransfer(
          socket,
          file.fileId,
          file.filePath,
          store.get('userId'),
          store.get('userName'),
          (progress: Progress) => {
            event.sender.send('transfer-progress-update', progress);
          },
          (result: Result) => {
            activeTransfers--;
            console.error(`File transfer result for ${file.name}:`, result.status);
            sendNext(); // Trigger next file transfer if any
          },
          (fileId: string, message: string) => {
            activeTransfers--;
            console.error(`File transfer error for ${file.fileId}: ${message}`);
            sendNext(); // Trigger next file transfer if any
          },
          file.parentId,
          file.prefix // Pass the prefix if needed by your transfer logic
        );
        await new Promise(resolve => setTimeout(resolve, 1500)); // Small delay to avoid overwhelming the socket
      }
    }

    sendNext();
  });

  ipcMain.on('start-tcp-server', (event) => {
    console.log("TCP Server started from renderer request.");
    startTcpServer(
      (peer, accept, reject) => {
        const requestId = uuidv4();
        pendingConnectionRequests.set(requestId, { accept, reject });
        event.sender.send('peer-connection-request', peer, requestId);
      },
      (peer, socket) => {
        console.log(`[RECEIVER] Connection ESTABLISHED with ${peer.peerName}.`);
        activeConnections.set(peer.instanceId, { peer, socket });
        handleIncomingFileTransfer(
          socket,
          store.get('storagePath'),
          peer,
          store.get('userId'),
          store.get('userName'),
          (progress: Progress) => {
            event.sender.send('transfer-progress-update', progress);
          },
          (result: Result) => {
            console.error(`File transfer result for ${result.fileName}:`, result.status);
          },
          (fileId: string, message: string) => {
            console.error(`File transfer error for ${fileId}: ${message}`);
          },
          (progress: { filePath: string, percentage: number }) => {
            event.sender.send('hashing-progress', progress);
          }
          ,
          (
            fileId: string,
            fileName: string,
            fileSize: number,
            senderPeerName: string,
            accept: (fileId: string) => void,
          ) => {
            console.log(`[RECEIVER] File received from ${senderPeerName}: ${fileName}`);
            accept(fileId); // Automatically accept the file transfer
          }
        )
      },
      store.get('userId') // Pass the userId from the store
    );
  });

  ipcMain.handle('dialog:openFile', async (event, options) => {
    const defaultOptions = {
      properties: ['openFile'], // Default to opening files
      filters: [],
    };
    const selectedItems: SelectedItem[] = [];
    const mergedOptions = { ...defaultOptions, ...options };

    const { canceled, filePaths } = await dialog.showOpenDialog(mergedOptions);
    if (canceled) {
      return null;
    }
    for (const filepath of filePaths) {
      try {
        console.log(filepath)
        const stats = await fs.promises.stat(filepath);

        selectedItems.push({
          path: filepath,
          name: path.basename(filepath),
          size: stats.size, // Size in bytes
          isDirectory: stats.isDirectory(), // Simple type check
          lastModified: stats.mtime.toISOString(), // Last modified date
        });
      } catch (error) {
        console.error(`Error getting file info for ${filepath}:`, error);
        return null; // Return null for files that failed to read info
      }
    }
    return selectedItems;

  });

  // Listen for renderer's response
  ipcMain.on('peer-connection-response', (event, { requestId, accepted, reason }) => {
    const handlers = pendingConnectionRequests.get(requestId);
    if (handlers) {
      if (accepted) {
        handlers.accept();
      } else {
        handlers.reject(reason || "User rejected connection.");
      }
      pendingConnectionRequests.delete(requestId);
    }
  });

  ipcMain.on('connect-to-peer', async (event, peer: DiscoveredPeer) => {
    // This is where you would handle the connection logic to the peer
    // For now, we just log it and return a success status
    console.log(`Connecting to peer: ${peer.peerName} (${peer.ipAddress}:${peer.tcpPort})`);
    // Simulate a successful connection
    try {
      connectToPeer(
        peer,
        (peer, status, reason) => {
          console.log(`[SENDER] Connection status with ${peer.peerName}: ${status}${reason ? ` (${reason})` : ''}`);
          event.sender.send('connect-to-peer-response', peer, status, reason);
        },
        (peer, socket) => {
          console.log(`[SENDER] Connection ESTABLISHED with ${peer.peerName}.`);
          activeConnections.set(peer.instanceId, { peer, socket });

        },
        store.get('userName'),
        store.get('userId')
      );
    }
    catch (error) {
      let errorMessage = 'Unknown error parsing data';
      if (error instanceof Error) errorMessage = error.message;
      console.error(`[TCP Client] Error parsing incoming data from ${peer.peerName}: ${errorMessage}`);
      // event.sender.send('connect-to-peer-response', false, `Failed to connect: ${error.message}`);
    }
  });

  // Handler for two-way (invoke/handle) messages from renderer
  ipcMain.handle('get-app-version', async () => {
    // You can perform any Node.js operations here
    const version = app.getVersion();
    console.log('Renderer requested app version:', version);
    return version; // This will be the resolved value of the promise in the renderer
  });

  ipcMain.handle('get-username', async () => {
    const userName = store.get('userName');
    console.log('Renderer requested username:', userName);
    return userName;
  });

  ipcMain.handle('set-storage-path', async () => {
    try {
      // Open dialog for selecting a single directory
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory', 'dontAddToRecent'],
        title: 'Select Storage Directory',
        message: 'Choose a folder to store received files',
      });
      if (canceled || filePaths.length === 0) {
        return false;
      }
      const selectedDir = filePaths[0];
      store.set('storagePath', selectedDir);
      console.log('Storage path updated to:', selectedDir);
      return selectedDir;
    } catch (error) {
      console.error('Error setting storage path:', error);
      return false;
    }
  });

  ipcMain.handle('get-storage-path', async () => {
    const storagePath = store.get('storagePath');
    console.log('Renderer requested storage path:', storagePath);
    return storagePath;
  });

  ipcMain.handle('set-username', async (_event, newUserName: string) => {
    store.set('userName', newUserName);
    console.log('Username updated to:', newUserName);
    return true;
  });

  ipcMain.handle('get-userid', async () => {
    const userId = store.get('userId');
    console.log('Renderer requested user ID:', userId);
    return userId;
  });

  ipcMain.handle('generate-new-userid', async () => {
    const newUserId = `BB_USER_${crypto.randomUUID().replace(/-/g, '').substring(0, 10).toUpperCase()}`;
    store.set('userId', newUserId);
    console.log('New User ID generated:', newUserId);
    return newUserId;
  });



}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
