import React, { useRef } from "react";

// Define an interface for a selected file to include properties we care about
export interface SelectedFile {
    name: string;
    size: number;
    type: string;
}
interface ExplorerViewProps {
    selectedFiles: SelectedFile[];
    onAddFiles: (files: SelectedFile[]) => void;
    onRemoveFile: (fileToRemove: SelectedFile) => void;
}


export const ExplorerView: React.FC<ExplorerViewProps> = ({ selectedFiles, onAddFiles, onRemoveFile }) => { // Changed to a non-exported const here
    // Ref for the hidden file input element
    const fileInputRef = useRef<HTMLInputElement>(null);
    // State to store the list of selected files

    /**
     * Handles the click event on the "Add Files" button.
     * Programmatically triggers a click on the hidden file input element,
     * opening the system's file explorer dialog.
     */
    const handleAddFilesClick = () => {
        fileInputRef.current?.click();
        console.log('Opening file explorer...');
    };

    /**
     * Handles the change event when files are selected in the file input.
     * Extracts file details (name, size, type) and updates the `selectedFiles` state.
     * @param event The change event from the file input.
     */
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files && event.target.files.length > 0) {
            const newlySelectedFiles: SelectedFile[] = Array.from(event.target.files).map(file => ({
                name: file.name,
                size: file.size,
                type: file.type,
            }));
            onAddFiles(newlySelectedFiles); // Let the parent handle duplicate filtering
            console.log('Processed new files for adding:', newlySelectedFiles);
        }
    };

    /**
     * Formats file size into a human-readable string (e.g., "1.2 MB", "500 KB").
     * @param bytes The size of the file in bytes.
     * @returns A formatted string representing the file size.
     */
    const formatFileSize = (bytes: number): string => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div className="relative flex flex-col h-full bg-gray-800 rounded-2xl border border-gray-700 p-8 shadow-lg">
            {/* Header section */}
            <h1 className="text-4xl font-bold text-white mb-4 text-center">File Explorer</h1>
            <p className="text-gray-400 text-lg mb-6 text-center">Browse and manage your files for transfer.</p>

            {/* Hidden file input element */}
            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                multiple // Allow selection of multiple files
                className="hidden" // Keep the input hidden from the UI
            />

            {/* Section to display selected files */}
            <div className="flex-1 w-full bg-gray-900 rounded-xl p-4 overflow-y-auto custom-scrollbar border border-gray-700">
                {selectedFiles.length === 0 ? (
                    // Message displayed when no files are selected
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                        <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        <p className="text-lg">No files selected yet.</p>
                        <p className="text-sm">Click the `+` button to add files.</p>
                    </div>
                ) : (
                    // List of selected files
                    <ul className="space-y-3">
                        {selectedFiles.map((file, index) => (
                            <li
                                key={index} // Using index as key is acceptable here since file list is only appended
                                className="flex items-center justify-between bg-gray-800 p-3 rounded-lg shadow-md border border-gray-700 hover:bg-gray-700 transition-colors duration-150"
                            >
                                <div className="flex items-center flex-grow min-w-0">
                                    {/* File icon based on type (simplified for demonstration) */}
                                    <span className="mr-3 text-blue-400 text-2xl">
                                        {file.type.startsWith('image/') ? '🖼️' :
                                            file.type.startsWith('video/') ? '🎥' :
                                                file.type.startsWith('audio/') ? '🎵' :
                                                    file.type.includes('pdf') ? '📄' :
                                                        '📁'}
                                    </span>
                                    {/* File name with text overflow handling */}
                                    <span className="text-white font-medium truncate flex-grow">
                                        {file.name}
                                    </span>
                                </div>
                                <div className="flex items-center flex-shrink-0">
                                    <span className="text-gray-400 text-sm ml-4">
                                        {formatFileSize(file.size)}
                                    </span>
                                    {/* Remove button */}
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

            {/* Plus SVG Circle Icon for adding files - positioned at the bottom right */}
            <button
                onClick={handleAddFilesClick}
                className="absolute bottom-6 right-6 w-16 h-16 bg-blue-600 hover:bg-blue-700 rounded-full flex items-center justify-center text-white text-5xl font-light shadow-lg transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-opacity-50"
                aria-label="Add Files"
            >
                +
            </button>

        </div>
    );
};

