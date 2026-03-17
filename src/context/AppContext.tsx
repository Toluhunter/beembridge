import React, { createContext, useContext, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ─── Shared types ──────────────────────────────────────────────────────────────

export interface DiscoveryMessage {
    appId: string;
    instanceId: string;
    peerName: string;
    tcpPort: number;
    timestamp: number;
}

export interface DiscoveredPeer extends DiscoveryMessage {
    lastSeen: number;
    ipAddress: string;
}

export interface SelectedItem {
    name: string;
    path: string;
    size: number;
    isDirectory: boolean;
}

export type TransferStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled';

export interface Progress {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number;
    parentId?: string;
    rootDir?: string;
}

export interface ActiveTransferDisplayItem extends Progress {
    status: TransferStatus;
}

// ─── Context interface ─────────────────────────────────────────────────────────

interface AppContextValue {
    userName: string;
    setUserName: (v: string) => void;
    userId: string;
    setUserId: (v: string) => void;
    storagePath: string;
    setStoragePath: (v: string) => void;

    /** When true, all views use simulated data instead of live backend calls. Persisted to localStorage. */
    mockMode: boolean;
    setMockMode: (v: boolean) => void;

    isDiscovering: boolean;
    setIsDiscovering: (v: boolean) => void;
    discoveredPeers: DiscoveredPeer[];
    setDiscoveredPeers: React.Dispatch<React.SetStateAction<DiscoveredPeer[]>>;
    connectedPeers: DiscoveredPeer[];
    setConnectedPeers: React.Dispatch<React.SetStateAction<DiscoveredPeer[]>>;

    selectedFiles: SelectedItem[];
    setSelectedFiles: React.Dispatch<React.SetStateAction<SelectedItem[]>>;
    activeTransfers: ActiveTransferDisplayItem[];
    setActiveTransfers: React.Dispatch<React.SetStateAction<ActiveTransferDisplayItem[]>>;
    hashingProgress: Record<string, number>;
    setHashingProgress: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}

const AppContext = createContext<AppContextValue | null>(null);

// ─── Provider ──────────────────────────────────────────────────────────────────

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [userName, setUserName] = useState('BeemBridge User');
    const [userId, setUserId] = useState('BB_USER_1234567890');
    const [storagePath, setStoragePath] = useState('');

    const [mockMode, setMockModeState] = useState<boolean>(
        () => localStorage.getItem('beembridge_mock_mode') === 'true'
    );

    const [isDiscovering, setIsDiscovering] = useState(false);
    const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>([]);
    const [connectedPeers, setConnectedPeers] = useState<DiscoveredPeer[]>([]);

    const [selectedFiles, setSelectedFiles] = useState<SelectedItem[]>([]);
    const [activeTransfers, setActiveTransfers] = useState<ActiveTransferDisplayItem[]>([]);
    const [hashingProgress, setHashingProgress] = useState<Record<string, number>>({});

    const setMockMode = (v: boolean) => setMockModeState(v);

    useEffect(() => {
        localStorage.setItem('beembridge_mock_mode', String(mockMode));
    }, [mockMode]);

    // Load persisted identity and storage path from Rust backend on first mount
    useEffect(() => {
        invoke<{ user_name: string; user_id: number }>('get_identity')
            .then(({ user_name, user_id }) => {
                setUserName(user_name);
                setUserId(String(user_id));
            })
            .catch((err) => console.error('Failed to load identity:', err));

        invoke<string>('get_storage_path')
            .then((path) => setStoragePath(path))
            .catch((err) => console.error('Failed to load storage path:', err));
    }, []);

    return (
        <AppContext.Provider value={{
            userName, setUserName,
            userId, setUserId,
            storagePath, setStoragePath,
            mockMode, setMockMode,
            isDiscovering, setIsDiscovering,
            discoveredPeers, setDiscoveredPeers,
            connectedPeers, setConnectedPeers,
            selectedFiles, setSelectedFiles,
            activeTransfers, setActiveTransfers,
            hashingProgress, setHashingProgress,
        }}>
            {children}
        </AppContext.Provider>
    );
};

// ─── Hook ──────────────────────────────────────────────────────────────────────

export const useAppContext = (): AppContextValue => {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useAppContext must be used inside AppProvider');
    return ctx;
};
