// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { DiscoveredPeer } from './utilities/peer';

// Type definitions for the functions we'll expose to the renderer
// This is good practice for TypeScript in the renderer process
declare global {
    interface Window {
        electron: {
            startPeerDiscovery: () => void;
            onPeerUpdate: (callback: (event: Electron.IpcRendererEvent, peers: DiscoveredPeer[]) => void) => () => void;
            getAppVersion: () => Promise<string>;
            getUsername: () => Promise<string>;
            setUsername: (newUsername: string) => Promise<boolean>;
            getUserId: () => Promise<string>;
            generateNewUserId: () => Promise<string>;
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

    onPeerUpdate: (callback: (event: Electron.IpcRendererEvent, peers: DiscoveredPeer[]) => void): () => void => {
        // Listen for 'peer-update' events from the main process
        ipcRenderer.on('peer-update', callback);
        // Return a function to remove the listener when no longer needed   
        return () => {
            ipcRenderer.removeListener('peer-update', callback);
        };
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

    // You can expose other utilities here, for example:
    // openFile: () => ipcRenderer.invoke('open-file-dialog'),
    // saveFile: (data: string) => ipcRenderer.invoke('save-file-dialog', data),
});

// Optional: Log when preload script runs for debugging
console.log('Preload script loaded successfully!');