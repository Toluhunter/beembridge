import React, { useState, useEffect } from "react";
import { FiTrash2, FiPlus } from 'react-icons/fi';
import { invoke } from '@tauri-apps/api/core';
import { useAppContext, SelectedItem, DiscoveredPeer } from '../../context/AppContext.js';

interface ExplorerViewProps {
    onAddFiles: (files: SelectedItem[]) => void;
    onRemoveFiles: (filesToRemove: SelectedItem[]) => void;
    onSendFilesToPeers: (files: SelectedItem[], targetPeers: DiscoveredPeer[]) => void;
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({ onAddFiles, onRemoveFiles, onSendFilesToPeers }) => {
    const { selectedFiles, connectedPeers } = useAppContext();

    const [showSendModal, setShowSendModal] = useState(false);
    const [selectedPeerForSending, setSelectedPeerForSending] = useState<DiscoveredPeer | null>(null);
    const [selectedItemsForRemoval, setSelectedItemsForRemoval] = useState<Set<string>>(new Set());
    const [sortColumn, setSortColumn] = useState<keyof SelectedItem | null>('name');
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 5;

    const handleOpenFile = async () => {
        try {
            const filePaths = await invoke<string[]>('open_file_dialog');
            if (filePaths && filePaths.length > 0) {
                const files = await invoke<SelectedItem[]>('get_file_stats', { paths: filePaths });
                onAddFiles(files);
            }
        } catch (error) {
            console.error("Error opening files:", error);
        }
    };

    const handleAddFilesClick = () => {
        handleOpenFile();
    };

    const formatFileSize = (bytes: number): string => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const handleSendClick = () => {
        setShowSendModal(true);
        setSelectedPeerForSending(null);
    };

    const handleCloseSendModal = () => {
        setShowSendModal(false);
        setSelectedPeerForSending(null);
    };

    const handlePeerSelectionChange = (peer: DiscoveredPeer) => {
        setSelectedPeerForSending(peer);
    };

    const handleConfirmSend = () => {
        if (selectedPeerForSending && selectedFiles.length > 0) {
            selectedFiles.forEach(file => console.log("Selected File:", file.name));
            handleCloseSendModal();
            onSendFilesToPeers(selectedFiles, [selectedPeerForSending]);
        } else {
            console.warn("No files selected or no peer chosen for sending.");
        }
    };

    const handleAddDirectoryClick = async () => {
        try {
            const dirPath = await invoke<string | null>('open_directory_dialog');
            if (dirPath) {
                const files = await invoke<SelectedItem[]>('get_file_stats', { paths: [dirPath] });
                onAddFiles(files);
            }
        } catch (error) {
            console.error("Error opening directory:", error);
        }
    };

    const handleCheckboxChange = (path: string, isChecked: boolean) => {
        setSelectedItemsForRemoval(prev => {
            const newSet = new Set(prev);
            if (isChecked) {
                newSet.add(path);
            } else {
                newSet.delete(path);
            }
            return newSet;
        });
    };

    const handleRemoveSelected = () => {
        const itemsToRemove = selectedFiles.filter(file => selectedItemsForRemoval.has(file.path));
        onRemoveFiles(itemsToRemove);
        setSelectedItemsForRemoval(new Set());
    };

    const getType = (file: SelectedItem): string => {
        if (file.isDirectory) return 'Folder';
        const parts = file.name.split('.');
        if (parts.length > 1) {
            return parts[parts.length - 1].toUpperCase();
        }
        return 'File';
    };

    const handleSort = (column: keyof SelectedItem) => {
        if (sortColumn === column) {
            setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortColumn(column);
            setSortDirection('asc');
        }
    };

    const sortedFiles = [...selectedFiles].sort((a, b) => {
        if (!sortColumn) return 0;

        let aValue: any;
        let bValue: any;

        if (sortColumn === 'isDirectory') {
            aValue = getType(a);
            bValue = getType(b);
        } else {
            aValue = a[sortColumn];
            bValue = b[sortColumn];
        }

        if (sortColumn === 'isDirectory') {
            if (aValue === bValue) return 0;
            if (sortDirection === 'asc') {
                return aValue ? -1 : 1;
            } else {
                return aValue ? 1 : -1;
            }
        }

        if (typeof aValue === 'string' && typeof bValue === 'string') {
            return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        } else if (typeof aValue === 'number' && typeof bValue === 'number') {
            return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
        }

        return 0;
    });

    const totalSize = selectedFiles.reduce((acc, item) => acc + item.size, 0);
    const totalPages = Math.ceil(sortedFiles.length / itemsPerPage) || 1;
    const paginatedFiles = sortedFiles.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    useEffect(() => {
        if (currentPage > totalPages) {
            setCurrentPage(totalPages);
        }
    }, [selectedFiles.length, totalPages, currentPage]);

    // TODO: Wire up Tauri drag-and-drop via @tauri-apps/plugin-drag-drop when plugin is added

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 px-4 pt-4 pb-2 md:px-6 md:pt-6">
                <h1 className="text-2xl md:text-4xl font-bold text-content mb-1">File Explorer</h1>
                <p className="text-content-muted text-sm md:text-base">Browse and manage your files for transfer.</p>
            </div>

            {/* Drag zone — desktop only */}
            <div className="hidden md:block flex-shrink-0 px-6 pb-4">
                <div
                    className="border border-dashed border-border rounded-lg flex flex-col items-center justify-center text-content-dim p-6 w-full"
                    id="drop-zone"
                >
                    <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                    </svg>
                    <p className="text-sm text-center">Drag and drop files and folders here, or use Add Files / Add Folder below.</p>
                </div>
            </div>

            {/* Desktop table section */}
            <div className="hidden md:flex flex-col flex-1 min-h-0 px-6 pb-6">
                <div className="border border-border-subtle rounded-lg shadow-md overflow-hidden flex flex-col flex-1 min-h-0">
                    {/* Toolbar */}
                    <div className="flex justify-between items-center px-4 py-3 border-b border-border-subtle bg-card/50 flex-shrink-0">
                        <div className="text-content font-semibold text-sm">
                            {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} — {formatFileSize(totalSize)}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleRemoveSelected}
                                disabled={selectedItemsForRemoval.size === 0}
                                className={
                                    `px-3 py-1.5 border rounded-lg text-sm font-semibold transition-colors ` +
                                    (selectedItemsForRemoval.size === 0
                                        ? 'border-content-dim text-content-dim cursor-not-allowed'
                                        : 'border-red-600 text-content hover:bg-red-700')
                                }
                            >
                                Remove{selectedItemsForRemoval.size > 0 ? ` (${selectedItemsForRemoval.size})` : ''}
                            </button>
                            <button
                                onClick={handleAddFilesClick}
                                className="px-3 py-1.5 border border-border text-content-secondary hover:bg-raised rounded-lg text-sm font-semibold transition-colors"
                            >
                                Add Files
                            </button>
                            <button
                                onClick={handleAddDirectoryClick}
                                className="px-3 py-1.5 border border-border text-content-secondary hover:bg-raised rounded-lg text-sm font-semibold transition-colors"
                            >
                                Add Folder
                            </button>
                            <button
                                onClick={handleSendClick}
                                disabled={selectedFiles.length === 0}
                                className="modern-button px-4 py-1.5 rounded-lg text-content text-sm font-bold shadow-md disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                            >
                                Send
                            </button>
                        </div>
                    </div>

                    {/* Scrollable table area */}
                    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
                        <table className="min-w-full divide-y divide-border-subtle">
                            <thead className="bg-raised/50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider">
                                        <input
                                            type="checkbox"
                                            className="form-checkbox h-4 w-4 text-blue-600 transition duration-150 ease-in-out"
                                            checked={selectedItemsForRemoval.size === selectedFiles.length && selectedFiles.length > 0}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setSelectedItemsForRemoval(new Set(selectedFiles.map(file => file.path)));
                                                } else {
                                                    setSelectedItemsForRemoval(new Set());
                                                }
                                            }}
                                        />
                                    </th>
                                    <th
                                        className="px-6 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider cursor-pointer"
                                        onClick={() => handleSort('name')}
                                    >
                                        Name {sortColumn === 'name' && (sortDirection === 'asc' ? '🔼' : '🔽')}
                                    </th>
                                    <th
                                        className="px-6 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider cursor-pointer"
                                        onClick={() => handleSort('isDirectory')}
                                    >
                                        Type {sortColumn === 'isDirectory' && (sortDirection === 'asc' ? '🔼' : '🔽')}
                                    </th>
                                    <th
                                        className="px-6 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider cursor-pointer"
                                        onClick={() => handleSort('size')}
                                    >
                                        Size {sortColumn === 'size' && (sortDirection === 'asc' ? '🔼' : '🔽')}
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border-subtle">
                                {paginatedFiles.length > 0 ? (
                                    paginatedFiles.map((file) => (
                                        <tr key={file.path} className="hover:bg-raised/30 transition-colors">
                                            <td className="px-4 py-4 whitespace-nowrap">
                                                <input
                                                    type="checkbox"
                                                    className="form-checkbox h-4 w-4 text-blue-600 transition duration-150 ease-in-out"
                                                    checked={selectedItemsForRemoval.has(file.path)}
                                                    onChange={(e) => handleCheckboxChange(file.path, e.target.checked)}
                                                />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-content">
                                                <span className="mr-2">{file.isDirectory ? '📁' : '📄'}</span>
                                                {file.name}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-content-muted">
                                                {getType(file)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-content-muted">
                                                {formatFileSize(file.size)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                                <button
                                                    onClick={() => onRemoveFiles([file])}
                                                    className="text-red-500 hover:text-red-400 transition-colors"
                                                    aria-label={`Remove ${file.name}`}
                                                >
                                                    Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-10 text-center text-content-dim">
                                            No files selected yet. Drag and drop files here or use the buttons above.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    <div className="flex justify-between items-center px-4 py-2 border-t border-border-subtle bg-card/30 flex-shrink-0">
                        <div className="text-sm text-content-muted">
                            {selectedFiles.length > 0 ? (
                                <>Showing {(currentPage - 1) * itemsPerPage + 1}–{Math.min(currentPage * itemsPerPage, selectedFiles.length)} of {selectedFiles.length}</>
                            ) : (
                                <>0 items</>
                            )}
                        </div>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                    disabled={currentPage === 1}
                                    className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                    aria-label="Previous Page"
                                >
                                    {'<'}
                                </button>
                                <span className="text-sm text-content-secondary">{currentPage} / {totalPages}</span>
                                <button
                                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                                    disabled={currentPage === totalPages}
                                    className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                    aria-label="Next Page"
                                >
                                    {'>'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Mobile section */}
            <div className="md:hidden flex-1 flex flex-col overflow-hidden">
                {/* Scrollable file list */}
                <div className="flex-1 overflow-y-auto">
                    {selectedFiles.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
                            <div className="w-16 h-16 rounded-full bg-card/60 flex items-center justify-center mb-4">
                                <FiPlus className="text-3xl text-content-dim" />
                            </div>
                            <p className="text-base font-medium text-content-muted">No files added</p>
                            <p className="text-sm text-content-dim mt-1">Tap Add Files or Add Folder below</p>
                        </div>
                    ) : (
                        selectedFiles.map((file) => (
                            <div key={file.path} className="flex items-center px-4 py-3 border-b border-border-subtle/50 hover:bg-raised/30 transition-colors">
                                <span className="text-2xl mr-3 flex-shrink-0">
                                    {file.isDirectory ? '📁' : '📄'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-content truncate">{file.name}</p>
                                    <p className="text-xs text-content-muted">{file.isDirectory ? 'Folder' : formatFileSize(file.size)}</p>
                                </div>
                                <button
                                    onClick={() => onRemoveFiles([file])}
                                    className="ml-3 flex-shrink-0 p-1.5 text-content-dim hover:text-red-400 transition-colors"
                                    aria-label={`Remove ${file.name}`}
                                >
                                    <FiTrash2 className="text-base" />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                {/* Mobile action bar */}
                <div className="flex gap-2 px-4 py-3 border-t border-border-subtle flex-shrink-0">
                    <button
                        onClick={handleAddFilesClick}
                        className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-content-secondary hover:bg-raised transition-colors"
                    >
                        + Add Files
                    </button>
                    <button
                        onClick={handleAddDirectoryClick}
                        className="px-4 py-2.5 border border-border rounded-xl text-sm font-medium text-content-secondary hover:bg-raised transition-colors"
                    >
                        Folder
                    </button>
                    {selectedFiles.length > 0 && (
                        <button
                            onClick={handleSendClick}
                            className="modern-button px-5 py-2.5 rounded-xl text-content text-sm font-bold"
                        >
                            Send
                        </button>
                    )}
                </div>
            </div>

            {/* Send Modal */}
            {showSendModal && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-end sm:items-center justify-center">
                    <div className="bg-card w-full rounded-t-3xl sm:rounded-2xl sm:max-w-lg p-6 shadow-2xl border border-border-subtle/40">
                        <h2 className="text-xl font-bold text-content mb-4">Send Files To…</h2>
                        {connectedPeers.length === 0 ? (
                            <div className="text-content-muted text-center p-4 bg-raised rounded-lg mb-6">
                                <p className="mb-1 font-medium">No connected peers found.</p>
                                <p className="text-sm">Connected peers will appear here once you establish a connection in the Peers view.</p>
                            </div>
                        ) : (
                            <div className="max-h-60 overflow-y-auto custom-scrollbar mb-6">
                                {connectedPeers.map(peer => (
                                    <label key={peer.instanceId} className="flex items-center p-3 bg-raised rounded-lg mb-2 cursor-pointer hover:bg-muted-fill transition-colors">
                                        <input
                                            type="radio"
                                            name="peer-selection"
                                            checked={selectedPeerForSending?.instanceId === peer.instanceId}
                                            onChange={() => handlePeerSelectionChange(peer)}
                                            className="form-radio h-5 w-5 text-blue-600 bg-surface border-border rounded focus:ring-blue-500"
                                        />
                                        <span className="ml-3 text-content font-medium">{peer.peerName}</span>
                                        <span className="ml-auto text-content-muted text-sm">{peer.ipAddress}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-3">
                            <button
                                onClick={handleCloseSendModal}
                                className="flex-1 px-4 py-2.5 rounded-xl bg-raised hover:bg-muted-fill text-content text-sm font-medium transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmSend}
                                disabled={!selectedPeerForSending}
                                className="flex-1 modern-button px-4 py-2.5 rounded-xl text-content text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                            >
                                Confirm Send
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ExplorerView;
