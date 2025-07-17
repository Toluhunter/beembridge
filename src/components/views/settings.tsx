// components/views/settings.tsx (Modified)
import React, { useState, useEffect } from 'react';

interface SettingsViewProps {
    currentUserName: string;
    currentUserId: string;
    storagePath: string;
    onUpdateUserNameInMainProcess: (newName: string) => Promise<boolean>;
    onGenerateNewUserId: () => Promise<void>;
    onSetStoragePath: () => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
    currentUserName,
    currentUserId,
    storagePath,
    onUpdateUserNameInMainProcess,
    onGenerateNewUserId,
    onSetStoragePath
}) => {
    // These states now live here, controlling the username editing UI
    const [tempUserName, setTempUserName] = useState(currentUserName);
    const [isEditingUsername, setIsEditingUsername] = useState(false);

    // Effect to update tempUserName when currentUserName prop changes (e.g., initial load)
    useEffect(() => {
        setTempUserName(currentUserName);
    }, [currentUserName]);

    const handleUserNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setTempUserName(event.target.value);
    };

    const handleSaveUserName = async () => {
        // Trim whitespace from the new username
        const trimmedName = tempUserName.trim();
        if (trimmedName !== '' && trimmedName !== currentUserName) {
            try {
                // Call the prop that sends update to main process
                const success = await onUpdateUserNameInMainProcess(trimmedName);
                if (success) {
                    setIsEditingUsername(false); // Exit editing mode on successful save
                    // The `currentUserName` prop will be updated from App.tsx via IPC,
                    // which will then update `tempUserName` via the useEffect above.
                    console.log("Username saved and sent to main process.");
                } else {
                    console.error("Failed to save username to store.");
                }
            } catch (error) {
                console.error("Error saving username via IPC:", error);
            }
        } else {
            // If name is empty or unchanged, just exit editing mode
            setIsEditingUsername(false);
            setTempUserName(currentUserName); // Reset temp if no change or invalid
        }
    };

    const handleCancelEdit = () => {
        setIsEditingUsername(false);
        setTempUserName(currentUserName); // Revert to the last saved username
    };

    const handleGenerateId = async () => {
        // This will trigger the parent App component to update userId
        await onGenerateNewUserId();
    };

    return (
        <div className="flex flex-col h-full bg-gray-800 rounded-2xl border border-gray-700 p-8 shadow-lg">
            <h1 className="text-4xl font-bold text-white mb-6 text-center">Settings</h1>

            {/* User Name Section */}
            <div className="mb-8 p-6 bg-gray-900 rounded-xl border border-gray-700">
                <h2 className="text-2xl font-semibold text-white mb-4">User Profile</h2>
                <div className="mb-4 flex items-center">
                    <label htmlFor="username" className="block text-gray-400 text-sm font-medium mr-4 w-24">
                        Username:
                    </label>
                    {isEditingUsername ? (
                        <>
                            <input
                                type="text"
                                id="username"
                                value={tempUserName}
                                onChange={handleUserNameChange}
                                className="flex-grow p-3 rounded-lg bg-gray-700 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 mr-2"
                                placeholder="Enter new username"
                            />
                            <button
                                onClick={handleSaveUserName}
                                className="modern-button text-white font-bold py-2 px-4 rounded-lg shadow-md transition-colors duration-200 mr-2"
                            >
                                Save
                            </button>
                            <button
                                onClick={handleCancelEdit}
                                className="modern-button text-white font-bold py-2 px-4 rounded-lg shadow-md bg-red-600 hover:bg-red-700 transition-colors duration-200"
                            >
                                Cancel
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="text-white text-lg flex-grow">{currentUserName}</p>
                            <button
                                onClick={() => setIsEditingUsername(true)}
                                className="modern-button text-white font-bold py-2 px-4 rounded-lg shadow-md transition-colors duration-200"
                            >
                                Edit
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* User ID Section */}
            <div className="mb-8 p-6 bg-gray-900 rounded-xl border border-gray-700">
                <h2 className="text-2xl font-semibold text-white mb-4">User ID</h2>
                <p className="text-gray-300 text-lg mb-4 break-all">
                    Current ID: <span className="font-mono bg-gray-700 p-2 rounded-md">{currentUserId}</span>
                </p>
                <button
                    onClick={handleGenerateId}
                    className="modern-button text-white font-bold py-2 px-4 rounded-lg shadow-md transition-colors duration-200"
                >
                    Generate New ID
                </button>
            </div>

            {/* Storage Path Section */}
            <div className="mb-8 p-6 bg-gray-900 rounded-xl border border-gray-700">
                <h2 className="text-2xl font-semibold text-white mb-4">Storage Path</h2>
                <p className="text-gray-300 text-lg mb-4 break-all">
                    Files will be saved to: <span className="font-mono bg-gray-700 p-2 rounded-md">{storagePath}</span>
                </p>
                <button
                    onClick={onSetStoragePath}
                    className="modern-button text-white font-bold py-2 px-4 rounded-lg shadow-md transition-colors duration-200"
                >
                    Set Storage Path
                </button>

            </div>

            {/* Profile Picture Section (Placeholder) */}
            <div className="p-6 bg-gray-900 rounded-xl border border-gray-700">
                <h2 className="text-2xl font-semibold text-white mb-4">Profile Picture</h2>
                <p className="text-gray-400 mb-4">
                    Feature to upload or select a profile picture will be available here.
                </p>
                <button
                    className="modern-button opacity-50 cursor-not-allowed text-white font-bold py-2 px-4 rounded-lg shadow-md"
                    disabled
                >
                    Upload Picture (Coming Soon)
                </button>
            </div>
        </div>
    );
};