import React, { useState } from "react";
import { DiscoveredPeer } from "@/components/views/peers";


// Define an interface for a selected file to include properties we care about
interface SelectedFile {
    path: string;
    name: string;
    size: number;
    type: string;
    lastModified: string;
}

interface ExplorerViewProps {
    selectedFiles: SelectedFile[];
    onAddFiles: (files: SelectedFile[]) => void;
    onRemoveFile: (fileToRemove: SelectedFile) => void;
    connectedPeers: DiscoveredPeer[]; // Added connectedPeers prop
    onSendFilesToPeers: (files: SelectedFile[], targetPeers: DiscoveredPeer[]) => void; // New prop for sending files
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({ selectedFiles, onAddFiles, onRemoveFile, connectedPeers, onSendFilesToPeers }) => {
    const [showSendModal, setShowSendModal] = useState(false);
    const [selectedPeersForSending, setSelectedPeersForSending] = useState<DiscoveredPeer[]>([]);

    const handleOpenFile = async () => {
        if (window.electron) {
            const files = await window.electron.openFile({
                properties: ['openFile', 'multiSelections'], // Allow multiple file selection
                filters: [
                    { name: 'Text Files', extensions: ['txt', 'md'] },
                    { name: 'Images', extensions: ['jpg', 'png', 'gif'] },
                    { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            if (files) {
                onAddFiles(files);
            } else {
                onAddFiles([]);
                console.log('File selection canceled.');
            }
        } else {
            console.warn('electronAPI not available. Are you running in Electron?');
            // Fallback for web environment if needed
            alert('This feature is only available in the Electron desktop application.');
        }
    };
    const handleAddFilesClick = () => {
        handleOpenFile();
        console.log('Opening file explorer...');
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
        // Reset selected peers for sending when opening the modal
        setSelectedPeersForSending([]);
    };

    const handleCloseSendModal = () => {
        setShowSendModal(false);
        setSelectedPeersForSending([]); // Clear selected peers when closing
    };

    const handlePeerSelectionChange = (peer: DiscoveredPeer, isChecked: boolean) => {
        setSelectedPeersForSending(prev => {
            if (isChecked) {
                return [...prev, peer];
            } else {
                return prev.filter(p => p.instanceId !== peer.instanceId);
            }
        });
    };

    const handleConfirmSend = () => {
        if (selectedPeersForSending.length > 0 && selectedFiles.length > 0) {
            selectedFiles.forEach(file => console.log("Selected File:", file.name));
            onSendFilesToPeers(selectedFiles, selectedPeersForSending);
            handleCloseSendModal(); // Close modal after initiating send
        } else {
            console.warn("No files selected or no peers chosen for sending.");
        }
    };


    return (
        <div className="relative flex flex-col h-full bg-gray-800 rounded-2xl border border-gray-700 p-8 shadow-lg">
            <h1 className="text-4xl font-bold text-white mb-4 text-center">File Explorer</h1>
            <p className="text-gray-400 text-lg mb-6 text-center">Browse and manage your files for transfer.</p>

            <button
                onChange={handleOpenFile}
                className="hidden"
            />

            <div className="flex-1 w-full bg-gray-900 rounded-xl p-4 overflow-y-auto custom-scrollbar border border-gray-700">
                {selectedFiles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                        <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        <p className="text-lg">No files selected yet.</p>
                        <p className="text-sm">Click the `+`` button to add files.</p>
                    </div>
                ) : (
                    <ul className="space-y-3">
                        {selectedFiles.map((file, index) => (
                            <li
                                key={`${file.name}-${file.size}-${index}`}
                                className="flex items-center justify-between bg-gray-800 p-3 rounded-lg shadow-md border border-gray-700 hover:bg-gray-700 transition-colors duration-150"
                            >
                                <div className="flex items-center flex-grow min-w-0">
                                    <span className="mr-3 text-blue-400 text-2xl">
                                        {file.type.startsWith('image/') ? '�️' :
                                            file.type.startsWith('video/') ? '🎥' :
                                                file.type.startsWith('audio/') ? '🎵' :
                                                    file.type.includes('pdf') ? '📄' :
                                                        '📁'}
                                    </span>
                                    <span className="text-white font-medium truncate flex-grow">
                                        {file.name}
                                    </span>
                                </div>
                                <div className="flex items-center flex-shrink-0">
                                    <span className="text-gray-400 text-sm ml-4">
                                        {formatFileSize(file.size)}
                                    </span>
                                    <button
                                        onClick={() => onRemoveFile(file)}
                                        className="ml-3 p-1 rounded-full bg-red-600 hover:bg-red-700 text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50 transition-colors duration-150"
                                        aria-label={`Remove ${file.name}`}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                                        </svg>
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Send Button - Always visible now */}
            <button
                onClick={handleSendClick}
                className="modern-button absolute bottom-6 left-6 py-3 px-6 rounded-lg text-lg font-bold shadow-lg transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-opacity-50"
                aria-label="Send Files"
                disabled={selectedFiles.length === 0} // Disable if no files are selected
            >
                Send Selected Files ({selectedFiles.length})
            </button>

            {/* Plus SVG Circle Icon for adding files */}
            <button
                onClick={handleAddFilesClick}
                className="absolute bottom-6 right-6 w-16 h-16 bg-blue-600 hover:bg-blue-700 rounded-full flex items-center justify-center text-white text-5xl font-light shadow-lg transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-opacity-50"
                aria-label="Add Files"
            >
                +
            </button>

            {/* Send Modal */}
            {showSendModal && (
                <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-800 rounded-xl p-8 shadow-2xl max-w-lg w-full border border-gray-700">
                        <h2 className="text-3xl font-bold text-white mb-6 text-center">Send Files To...</h2>
                        {connectedPeers.length === 0 ? (
                            <div className="text-gray-400 text-center p-4 bg-gray-700 rounded-lg">
                                <p className="mb-2">No connected peers found.</p>
                                <p>Connected peers will appear here once you establish a connection in the &quot;Peers&quot; view.</p>
                            </div>
                        ) : (
                            <div className="max-h-60 overflow-y-auto custom-scrollbar mb-6">
                                {connectedPeers.map(peer => (
                                    <label key={peer.instanceId} className="flex items-center p-3 bg-gray-700 rounded-lg mb-2 cursor-pointer hover:bg-gray-600 transition-colors duration-150">
                                        <input
                                            type="checkbox"
                                            checked={selectedPeersForSending.some(p => p.instanceId === peer.instanceId)}
                                            onChange={(e) => handlePeerSelectionChange(peer, e.target.checked)}
                                            className="form-checkbox h-5 w-5 text-blue-600 bg-gray-900 border-gray-600 rounded focus:ring-blue-500"
                                        />
                                        <span className="ml-3 text-white font-medium">{peer.peerName}</span>
                                        <span className="ml-auto text-gray-400 text-sm">{peer.ipAddress}</span>
                                    </label>
                                ))}
                            </div>
                        )}

                        <div className="flex justify-end space-x-4 mt-4"> {/* Added mt-4 here */}
                            <button
                                onClick={handleCloseSendModal}
                                className="px-6 py-2 rounded-lg text-white font-bold bg-gray-700 hover:bg-gray-600 transition-colors duration-200 shadow-md"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmSend}
                                className="modern-button px-6 py-2 rounded-lg text-white font-bold shadow-md"
                                disabled={selectedPeersForSending.length === 0} // Disable if no peers are selected
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