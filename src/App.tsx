'use client';
import './App.css';
import React, { useEffect, useState } from 'react';
import { PeerView } from './components/views/peers.js';
import { ExplorerView } from './components/views/explorer.js';
import { TransferHistoryView } from './components/views/transfer-history.js';
import { ActiveTransferView } from './components/views/active-transfers.js';
import { SettingsView } from './components/views/settings.js';
import { Sidebar, SidebarItem } from './components/shared/sidebar.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Footer } from './components/shared/footer.js';
import { BottomNav } from './components/shared/bottom-nav.js';
import { AppProvider, useAppContext, SelectedItem, DiscoveredPeer, ActiveTransferDisplayItem } from './context/AppContext.js';

// ─── Inner component (has access to context) ──────────────────────────────────

const AppContent = () => {
    const [activeView, setActiveView] = useState<SidebarItem['id']>('peers');
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

    const {
        userName,
        userId,
        selectedFiles,
        setSelectedFiles,
        setActiveTransfers,
        setHashingProgress,
    } = useAppContext();

    const handleAddSelectedFiles = (newFiles: SelectedItem[]) => {
        const uniqueNewFiles = newFiles.filter(newFile =>
            !selectedFiles.some(existingFile =>
                existingFile.name === newFile.name && existingFile.size === newFile.size
            )
        );
        setSelectedFiles(prevFiles => [...prevFiles, ...uniqueNewFiles]);
    };

    const handleRemoveSelectedFiles = (filesToRemove: SelectedItem[]) => {
        setSelectedFiles(prevFiles =>
            prevFiles.filter(existingFile =>
                !filesToRemove.some(fileToRemove =>
                    existingFile.name === fileToRemove.name && existingFile.size === fileToRemove.size
                )
            )
        );
    };

    const handleSendFilesToPeers = (files: SelectedItem[], targetPeers: DiscoveredPeer[]) => {
        if (targetPeers.length > 0) {
            const peerID = targetPeers[0].instanceId;
            invoke('initiate_file_transfer', { peerId: peerID, items: files });
        }
        setActiveView('active-transfers');
        setSelectedFiles([]);
    };

    const toggleSidebar = () => {
        setIsSidebarCollapsed(prev => !prev);
    };

    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;
        let unlistenHashing: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;

        const setup = async () => {
            unlistenProgress = await listen<ActiveTransferDisplayItem>('onProgressUpdate', ({ payload: progress }) => {
                setActiveTransfers(prevTransfers => {
                    const existingIndex = prevTransfers.findIndex(t => t.fileId === progress.fileId);

                    let derivedStatus: ActiveTransferDisplayItem['status'] = 'in-progress';
                    if (progress.percentage >= 100) {
                        derivedStatus = 'completed';
                    } else if (progress.percentage < 0) {
                        derivedStatus = 'failed';
                    } else if (progress.percentage === 0 && progress.transferredBytes === 0) {
                        derivedStatus = 'pending';
                    }

                    const updatedDisplayItem: ActiveTransferDisplayItem = { ...progress, status: derivedStatus };

                    if (existingIndex > -1) {
                        const updatedTransfers = [...prevTransfers];
                        updatedTransfers[existingIndex] = updatedDisplayItem;
                        return updatedTransfers;
                    } else {
                        return [...prevTransfers, updatedDisplayItem];
                    }
                });
            });

            unlistenHashing = await listen<{ filePath: string; percentage: number }>('onHashingProgress', ({ payload: progress }) => {
                if (progress.percentage === 100) {
                    setHashingProgress(prev => {
                        const next = { ...prev };
                        delete next[progress.filePath];
                        return next;
                    });
                } else {
                    setHashingProgress(prev => ({ ...prev, [progress.filePath]: progress.percentage }));
                }
            });

            unlistenComplete = await listen<{ fileId: string; status: ActiveTransferDisplayItem['status'] }>('onTransferComplete', ({ payload: result }) => {
                setActiveTransfers(prevTransfers => {
                    const existingIndex = prevTransfers.findIndex(t => t.fileId === result.fileId);
                    if (existingIndex > -1) {
                        const updatedTransfers = [...prevTransfers];
                        updatedTransfers[existingIndex].status = result.status;
                        if (result.status === 'completed') updatedTransfers[existingIndex].percentage = 100;
                        return updatedTransfers;
                    }
                    return prevTransfers;
                });
            });
        };

        setup();

        return () => {
            unlistenProgress?.();
            unlistenHashing?.();
            unlistenComplete?.();
        };
    }, []);

    return (
        <div className="flex flex-col h-screen w-screen bg-canvas text-content overflow-hidden safe-top safe-sides">
            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar: desktop only */}
                <div className="hidden md:flex">
                    <Sidebar
                        logoBb="/logo-bb.svg"
                        isSidebarCollapsed={isSidebarCollapsed}
                        toggleSidebar={toggleSidebar}
                        activeView={activeView}
                        setActiveView={setActiveView}
                        userName={userName}
                        userId={userId}
                    />
                </div>

                {/* Main Content */}
                <main className="flex-1 p-4 overflow-auto">
                    {activeView === 'peers' && (
                        <PeerView />
                    )}

                    {activeView === 'history' && (
                        <TransferHistoryView />
                    )}

                    {activeView === 'active-transfers' && (
                        <ActiveTransferView />
                    )}

                    {activeView === 'explorer' && (
                        <ExplorerView
                            onAddFiles={handleAddSelectedFiles}
                            onRemoveFiles={handleRemoveSelectedFiles}
                            onSendFilesToPeers={handleSendFilesToPeers}
                        />
                    )}

                    {activeView === 'settings' && (
                        <SettingsView />
                    )}
                </main>
            </div>

            {/* Footer: desktop only */}
            <div className="hidden md:block">
                <Footer />
            </div>

            {/* Bottom nav: mobile only */}
            <BottomNav activeView={activeView} setActiveView={setActiveView} />
        </div>
    );
};

// ─── Root component wraps everything in the provider ──────────────────────────

const App = () => (
    <AppProvider>
        <AppContent />
    </AppProvider>
);

export default App;
