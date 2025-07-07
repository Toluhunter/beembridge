// main.ts
import { app, BrowserWindow, screen, ipcMain, dialog } from 'electron';
import { FrameParser } from './utilities/framingProtocol';
import { DiscoveredPeer, startDiscovery } from './utilities/peerDiscovery';
import { connectToPeer, startTcpServer } from './utilities/peerConnection';
import * as path from 'path';
import * as url from 'url';
import * as dotenv from 'dotenv';
import * as net from 'net';
import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'; // npm install uuid
import * as fs from 'fs';
import { Progress, Result } from './utilities/transfer/types';
import { initiateFileTransfer } from './utilities/transfer/sender';
dotenv.config();

let mainWindow: BrowserWindow | null;

const isDev = process.env.NODE_ENV === 'development';

const store = new Store<{ userName: string, userId: string }>({
    defaults: {
        userName: `BeemBridge User`,
        userId: `BB_USER_${crypto.randomUUID().replace(/-/g, '').substring(0, 10).toUpperCase()}`,
    },
});

interface SelectedFile {
    path: string;
    name: string;
    size: number;
    type: string;
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
        startDiscovery(sendToRenderer);
        console.log("Peer discovery initiated from renderer request.");
    });

    ipcMain.on('send-files-to-peers', (event, files: SelectedFile[], peers: DiscoveredPeer[]) => {
        console.log("Sending files:", files.map(f => f.name));
        const targetPeer: DiscoveredPeer = peers[0]; // For now, just send to the first peer
        const socket = activeConnections.get(targetPeer.instanceId)?.socket as net.Socket;
        files.forEach(file => {
            initiateFileTransfer(
                socket,
                file.path,
                targetPeer.instanceId,
                targetPeer.peerName,
                (progress: Progress) => {
                    console.log(`File transfer progress for ${file.name}: ${progress.percentage}%`);
                },
                (result: Result) => {
                    console.error(`File transfer result for ${file.name}:`, result.status);
                },
                (fileId: string, message: string) => {
                    console.error(`File transfer error for ${file.name}: ${message}`);
                }
            )

        });

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
                socket.on('data', (data) => {
                    try {
                        const frameParser = new FrameParser();
                        const message = frameParser.feed(data);
                        console.log(`[RECEIVER] Received message from ${peer.peerName}:`, message);
                        activeConnections.set(peer.instanceId, { peer, socket });
                    } catch (e) {
                        console.error("[RECEIVER] Error parsing data:", e);
                    }
                });
            },
            store.get('userId') // Pass the userId from the store
        );
    });

    ipcMain.handle('dialog:openFile', async (event, options) => {
        const defaultOptions = {
            properties: ['openFile'], // Default to opening files
            filters: [],
        };
        const selecteFiles: SelectedFile[] = [];
        const mergedOptions = { ...defaultOptions, ...options };

        const { canceled, filePaths } = await dialog.showOpenDialog(mergedOptions);
        if (canceled) {
            return null;
        }
        for (const filepath of filePaths) {
            try {
                console.log(filepath)
                const stats = await fs.promises.stat(filepath);
                selecteFiles.push({
                    path: filepath,
                    name: path.basename(filepath),
                    size: stats.size, // Size in bytes
                    type: stats.isDirectory() ? 'directory' : 'file', // Simple type check
                    lastModified: stats.mtime.toISOString(), // Last modified date
                });
            } catch (error) {
                console.error(`Error getting file info for ${filepath}:`, error);
                return null; // Return null for files that failed to read info
            }
        }
        return selecteFiles;

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
                    socket.on('data', (data) => {
                        try {
                            const frameParser = new FrameParser();
                            const message = frameParser.feed(data);
                            console.log(`[SENDER] Received message from ${peer.peerName}:`, message);
                        } catch (e) {
                            console.error("[SENDER] Error parsing data:", e);
                        }
                    });
                },
                peer.instanceId
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