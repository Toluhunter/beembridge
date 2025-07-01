// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { DiscoveredPeer } from './utilities/peerDiscovery';

// Type definitions for the functions we'll expose to the renderer
// This is good practice for TypeScript in the renderer process
declare global {
    interface Window {
        electron: {
            startPeerDiscovery: () => void;
            startTcpServer: () => void;
            onPeerUpdate: (callback: (event: Electron.IpcRendererEvent, peers: DiscoveredPeer[]) => void) => () => void;
            onConnectionResponse: (callback: (event: Electron.IpcRendererEvent, peer: DiscoveredPeer, status: string, reason?: string) => void) => () => void;
            connectToPeer: (peer: DiscoveredPeer) => void;
            getAppVersion: () => Promise<string>;
            getUsername: () => Promise<string>;
            setUsername: (newUsername: string) => Promise<boolean>;
            getUserId: () => Promise<string>;
            generateNewUserId: () => Promise<string>;
            onPeerConnectionRequest: (
                callback: (
                    event: Electron.IpcRendererEvent,
                    peer: DiscoveredPeer,
                    requestId: string
                ) => void
            ) => () => void;
            respondToPeerConnectionRequest: (requestId: string, accepted: boolean, reason?: string) => void;
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

    onPeerConnectionRequest: (callback: (event: Electron.IpcRendererEvent, peer: DiscoveredPeer, requestId: string) => void): () => void => {
        ipcRenderer.on('peer-connection-request', callback);

        return () => {
            ipcRenderer.removeListener('peer-connection-request', callback);
        };
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