import {
    useState,
    useEffect

} from "react";


interface DiscoveryMessage {
    appId: string;       // A unique ID for your application (e.g., "MyFileTransferApp_v1")
    instanceId: string;  // A unique ID for this specific running instance
    peerName: string;    // A user-friendly name for this peer (e.g., computer name or user-defined)
    tcpPort: number;     // The TCP port this instance is listening on for file transfers
    timestamp: number;   // To help detect stale messages
}

// Define the structure of a discovered peer for internal tracking
export interface DiscoveredPeer extends DiscoveryMessage { // Exported for use in renderer process types
    lastSeen: number; // Timestamp when the last beacon from this peer was received
    ipAddress: string; // The IP address of the peer (from the UDP packet)
}

export const PeerView = () => {
    // State to manage the list of discovered peers
    const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
    // State to control the sonar animation and discovery mode
    const [isDiscovering, setIsDiscovering] = useState(false);

    useEffect(() => {
        // Check if the 'electron' API is available
        if (window.electron) {
            console.log('Electron API is available in the renderer!');

            // --- Listener for replies from Main Process ---
            // This will update the peers state when new peer information is received
            const cleanup = window.electron.onPeerUpdate((_event, peers) => {
                setPeers(peers);
                // If peers are found, and we were in discovery mode, we might want to stop the animation
                if (peers.length > 0 && isDiscovering) {
                    setIsDiscovering(false); // Stop discovery animation once peers are found
                }
            });

            // --- Fetch app version using invoke ---
            const fetchAppVersion = async () => {
                try {
                    const version = await window.electron.getAppVersion();
                    console.log('App Version:', version);
                } catch (error) {
                    console.error('Failed to get app version:', error);
                }
            };

            fetchAppVersion();

            // Cleanup function to remove the listener when component unmounts
            return () => {
                cleanup(); // Call the cleanup function returned by onReplyFromMain
            };
        } else {
            console.warn('Electron API is NOT available in the renderer. Are you running in Electron?');
        }
    }, [isDiscovering]); // Add isDiscovering to dependencies to re-evaluate when it changes

    /**
     * Initiates the peer discovery process.
     * Activates the sonar animation and calls the Electron API to start discovery.
     * Sets a timeout to stop the animation after a few seconds if no peers are found,
     * to prevent it from running indefinitely.
     */
    const startDiscovery = () => {
        if (window.electron) {
            setIsDiscovering(true);
            console.log('Starting peer discovery...');
            // Start sonar animation
            window.electron.startPeerDiscovery();

            // Set a timeout to stop discovery animation after 10 seconds
            // This is a fallback in case no peers are found to explicitly stop the animation
            setTimeout(() => {
                if (isDiscovering) { // Only stop if it's still discovering
                    setIsDiscovering(false);
                    console.log('Discovery animation stopped after timeout.');
                }
            }, 10000); // Stop after 10 seconds
        } else {
            console.warn('Electron API is NOT available in the renderer. Are you running in Electron?');
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-4xl font-bold text-white">Peers</h1>
                {/* "Add Peer" button - Always visible now */}
                <button className="modern-button text-white font-bold py-2 px-6 rounded-lg shadow-md">
                    Add Peer
                </button>
            </div>

            {peers.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-grow bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center shadow-lg">
                    <p className="text-gray-400 text-xl mb-8">
                        {isDiscovering ? "Searching for peers..." : "No peers detected yet. Click the button to start finding others!"}
                    </p>
                    {/* Sonar animation container - always rendered, visibility controlled by opacity */}
                    <div className={`relative w-48 h-48 mb-8 flex items-center justify-center transition-opacity duration-500 ${isDiscovering ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                        {/* Sonar base circle */}
                        <div className="absolute w-full h-full bg-blue-600 rounded-full opacity-30"></div>
                        {/* Sonar pulse effect - apply animation class conditionally */}
                        <div className={`absolute w-full h-full bg-blue-600 rounded-full opacity-0 ${isDiscovering ? 'sonar-pulse' : ''}`}></div>
                        {/* Inner core */}
                        <div className="absolute w-24 h-24 bg-blue-700 rounded-full flex items-center justify-center text-white text-3xl font-bold">
                            📡
                        </div>
                    </div>
                    <button
                        className="modern-button text-white font-bold py-4 px-10 rounded-lg text-xl shadow-lg"
                        onClick={startDiscovery}
                        disabled={isDiscovering} // Disable button while discovering
                    >
                        {isDiscovering ? "Searching..." : "Find Peer"}
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {peers.map((peer) => (
                        <div key={peer.instanceId} className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg flex flex-col">
                            <h3 className="text-xl font-semibold text-white mb-2">{peer.peerName}</h3>
                            <p className="text-gray-400 text-sm mb-1">ID: {peer.instanceId}</p>
                            <p className="text-gray-500 text-xs mt-auto pt-2">Last active: {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                            <p className="text-gray-500 text-xs mt-auto pt-2">IP: {peer.ipAddress}</p>
                            <p className="text-gray-500 text-xs mt-auto pt-2">Port: {peer.tcpPort}</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

}