// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { DiscoveredPeer } from './utilities/peerDiscovery';

// Type definitions for the functions we'll expose to the renderer
// This is good practice for TypeScript in the renderer process

interface SelectedItem {
    path: string;
    name: string;
    size: number;
    isDirectory: boolean;
    lastModified: string;
}

export type Progress = {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number; // Optional: speed calculation
    parentId?: string;
}

declare global {
    interface Window {
        electron: {
            startPeerDiscovery: () => void;
            startTcpServer: () => void;
            onPeerUpdate: (callback: (event: Electron.IpcRendererEvent, peers: DiscoveredPeer[]) => void) => () => void;
            sendFilesToPeers: (files: SelectedItem[], peers: DiscoveredPeer[]) => void;
            onConnectionResponse: (callback: (event: Electron.IpcRendererEvent, peer: DiscoveredPeer, status: string, reason?: string) => void) => () => void;
            connectToPeer: (peer: DiscoveredPeer) => void;
            getAppVersion: () => Promise<string>;
            getUsername: () => Promise<string>;
            setUsername: (newUsername: string) => Promise<boolean>;
            getUserId: () => Promise<string>;
            getStoragePath: () => Promise<string>;
            setStoragePath: () => Promise<boolean | string>;
            onProgressUpdate: (callback: (event: Electron.IpcRendererEvent, progress: Progress) => void) => () => void;
            onHashingProgress: (callback: (event: Electron.IpcRendererEvent, progress: { filePath: string, percentage: number }) => void) => () => void; // New callback for hashing
            generateNewUserId: () => Promise<string>;
            onPeerConnectionRequest: (
                callback: (
                    event: Electron.IpcRendererEvent,
                    peer: DiscoveredPeer,
                    requestId: string
                ) => void
            ) => () => void;
            respondToPeerConnectionRequest: (requestId: string, accepted: boolean, reason?: string) => void;
            openFile: (options?: Electron.OpenDialogOptions) => Promise<SelectedItem[] | null>;
        };
    }
};

contextBridge.exposeInMainWorld('electron', {
    /**
     * Sends a message to the main process.
     * This function is exposed to the renderer process.
     * @param message The message string to send.
     */

    startPeerDiscovery: () => {
        ipcRenderer.send('start-peer-discovery');
    },

    startTcpServer: () => {
        ipcRenderer.send('start-tcp-server');
    },
    openFile: async (options = {}): Promise<SelectedItem[] | null> => {
        try {
            return await ipcRenderer.invoke('dialog:openFile', options);
        } catch (error) {
            console.error('Error opening file dialog:', error);
            return null;
        }
    },

    sendFilesToPeers: (files: SelectedItem[], peers: DiscoveredPeer[]) => {
        ipcRenderer.send('send-files-to-peers', files, peers);
    },

    onPeerConnectionRequest: (callback: (event: Electron.IpcRendererEvent, peer: DiscoveredPeer, requestId: string) => void): () => void => {
        ipcRenderer.on('peer-connection-request', callback);

        return () => {
            ipcRenderer.removeListener('peer-connection-request', callback);
        };
    },

    onProgressUpdate: (callback: (event: Electron.IpcRendererEvent, progress: Progress) => void): () => void => {
        ipcRenderer.on('transfer-progress-update', callback);

        return () => {
            ipcRenderer.removeListener('progress-update', callback);
        }
    },

    onHashingProgress: (callback: (event: Electron.IpcRendererEvent, progress: { filePath: string, percentage: number }) => void): () => void => {
        ipcRenderer.on('hashing-progress', callback);

        return () => {
            ipcRenderer.removeListener('hashing-progress', callback);
        }
    },


    onPeerUpdate: (callback: (event: Electron.IpcRendererEvent, peers: DiscoveredPeer[]) => void): () => void => {
        // Listen for 'peer-update' events from the main process
        ipcRenderer.on('peer-update', callback);
        // Return a function to remove the listener when no longer needed   
        return () => {
            ipcRenderer.removeListener('peer-update', callback);
        };
    },

    onConnectionResponse: (callback: (event: Electron.IpcRendererEvent, peer: DiscoveredPeer, status: string, reason?: string) => void): () => void => {
        // Listen for 'connection-response' events from the main process
        ipcRenderer.on('connect-to-peer-response', callback);
        // Return a function to remove the listener when no longer needed
        return () => {
            ipcRenderer.removeListener('connection-response', callback);
        };
    },

    connectToPeer: (peer: DiscoveredPeer): void => {
        ipcRenderer.send('connect-to-peer', peer);
    },

    getAppVersion: async (): Promise<string> => {
        const version = await ipcRenderer.invoke('get-app-version');
        return version;
    },

    getStoragePath: async (): Promise<string> => {
        const storagePath = await ipcRenderer.invoke('get-storage-path');
        return storagePath;
    },
    setStoragePath: async (): Promise<boolean> => {
        const success = await ipcRenderer.invoke('set-storage-path');
        return success;
    },

    getUsername: async (): Promise<string> => {
        const username = await ipcRenderer.invoke('get-username');
        return username;
    },

    setUsername: async (newUsername: string): Promise<boolean> => {
        const success = await ipcRenderer.invoke('set-username', newUsername);
        return success;
    },

    getUserId: async (): Promise<string> => {
        const userId = await ipcRenderer.invoke('get-userid');
        return userId;
    },

    generateNewUserId: async (): Promise<string> => {
        const newUserId = await ipcRenderer.invoke('generate-new-userid');
        return newUserId;
    },

    respondToPeerConnectionRequest: (requestId: string, accepted: boolean, reason?: string) => {
        ipcRenderer.send('peer-connection-response', { requestId, accepted, reason });
    },

    // You can expose other utilities here, for example:
    // openFile: () => ipcRenderer.invoke('open-file-dialog'),
    // saveFile: (data: string) => ipcRenderer.invoke('save-file-dialog', data),
});

// Optional: Log when preload script runs for debugging
console.log('Preload script loaded successfully!');