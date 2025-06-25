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
    const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>([]);
    // State to manage the list of connected peers
    const [connectedPeers, setConnectedPeers] = useState<DiscoveredPeer[]>([]);
    // State to control the sonar animation and discovery mode
    const [isDiscovering, setIsDiscovering] = useState(false);
    const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);

    useEffect(() => {
        // Check if the 'electron' API is available
        if (window.electron) {
            console.log('Electron API is available in the renderer!');

            // --- Listener for replies from Main Process ---
            // This will update the discoveredPeers state when new peer information is received
            const cleanup = window.electron.onPeerUpdate((_event, newDiscoveries) => {
                const filteredDiscoveries = newDiscoveries.filter(
                    newPeer => !connectedPeers.some(connectedPeer => connectedPeer.instanceId === newPeer.instanceId)
                );
                setDiscoveredPeers(filteredDiscoveries);

                // If new peers are found, and we were in discovery mode, stop the animation
                if (newDiscoveries.length > 0 && isDiscovering) {
                    setIsDiscovering(false);
                }
            });

            const cleanupConnectionResponse = window.electron.onConnectionResponse((_event, peer, status, reason) => {
                onConnectionResponse(peer, status, reason);
                setConnectingPeerId(null);
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
                cleanupConnectionResponse(); // Clean up connection response listener
            };
        } else {
            console.warn('Electron API is NOT available in the renderer. Are you running in Electron?');
        }
    }); // Add connectedPeers to dependencies for accurate filtering

    /**
     * Initiates the peer discovery process.
     * Activates the sonar animation and calls the Electron API to start discovery.
     * Sets a timeout to stop the animation after a few seconds if no peers are found,
     * to prevent it from running indefinitely.
     */
    const startDiscovery = () => {
        setIsDiscovering(true);
        if (window.electron) {
            console.log('Starting peer discovery...');
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

    /**
     * Handles the action to connect to a discovered peer.
     * Moves the peer from the discovered list to the connected list.
     * @param peerToConnect The peer object to connect to.
     */
    const handleConnect = (peerToConnect: DiscoveredPeer) => {
        if (window.electron) {
            setConnectingPeerId(peerToConnect.instanceId); // Set connecting state
            console.log(`Attempting to connect to peer: ${peerToConnect.peerName} (${peerToConnect.instanceId})`);
            window.electron.connectToPeer(peerToConnect);
        } else {
            console.warn('Electron API is NOT available. Cannot connect to peer.');
            setConnectingPeerId(null); // Clear connecting state if Electron API is not available
        }
    };

    const onConnectionResponse = (peer: DiscoveredPeer, status: string, reason?: string) => {
        console.log(`[RECEIVER] Connection status with ${peer.peerName}: ${status}${reason ? ` (${reason})` : ''}`);
        if (status === 'accepted') {
            // Move peer from discovered to connected list
            setConnectedPeers(prevConnected => {
                // Prevent adding duplicates to connectedPeers
                if (!prevConnected.some(p => p.instanceId === peer.instanceId)) {
                    return [...prevConnected, peer];
                }
                return prevConnected;
            });
            // Remove peer from discovered list as it's now connected
            setDiscoveredPeers(prevDiscovered => prevDiscovered.filter(p => p.instanceId !== peer.instanceId));
            console.log("[RECEIVER] Connection ready! You can send data now.");
        } else if (status === 'rejected' || status === 'failed') {
            console.log("[RECEIVER] Connection failed or rejected. Please try another peer.");
            // If connection failed, ensure the peer is back in discovered if it was attempting to connect
            // This is primarily for cases where a peer might have been removed from discovered during the connecting state
            setDiscoveredPeers(prevDiscovered => {
                if (!prevDiscovered.some(p => p.instanceId === peer.instanceId) &&
                    !connectedPeers.some(p => p.instanceId === peer.instanceId)) {
                    return [...prevDiscovered, peer];
                }
                return prevDiscovered;
            });
        }
        setConnectingPeerId(null); // Always clear the connecting state after a response
    };

    return (
        <div className="flex flex-col h-full p-6">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-4xl font-bold text-white">Peers</h1>
                {/* "Add Peer" button - Always visible now */}
                <button className="modern-button text-white font-bold py-2 px-6 rounded-lg shadow-md">
                    Add Peer
                </button>
            </div>

            {/* Connected Peers Section */}
            <div className="mb-8">
                <h2 className="text-3xl font-semibold text-white mb-4">Connected Peers</h2>
                {connectedPeers.length === 0 ? (
                    <div className="bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center shadow-lg">
                        <p className="text-gray-400 text-lg">No peers currently connected.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {connectedPeers.map((peer) => (
                            <div key={peer.instanceId} className="bg-gray-800 rounded-xl p-5 border-2 border-green-500 shadow-lg flex flex-col items-start">
                                <h3 className="text-xl font-semibold text-white mb-2">{peer.peerName} <span className="text-green-400 text-sm">(Connected)</span></h3>
                                <p className="text-gray-400 text-sm mb-1">ID: {peer.instanceId}</p>
                                <p className="text-gray-500 text-xs mt-auto pt-2">Last active: {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                                <p className="text-gray-500 text-xs pt-0.5">IP: {peer.ipAddress}</p>
                                <p className="text-gray-500 text-xs pt-0.5">Port: {peer.tcpPort}</p>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Discovered Peers Section */}
            <div>
                <h2 className="text-3xl font-semibold text-white mb-4">Discovered Peers</h2>
                {discoveredPeers.length === 0 && !isDiscovering ? (
                    <div className="flex flex-col items-center justify-center bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center shadow-lg">
                        <p className="text-gray-400 text-xl mb-8">
                            No peers detected yet. Click the button to start finding others!
                        </p>
                        <div className={`relative w-48 h-48 mb-8 flex items-center justify-center transition-opacity duration-500 ${isDiscovering ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                            <div className="absolute w-full h-full bg-blue-600 rounded-full opacity-30"></div>
                            <div className={`absolute w-full h-full bg-blue-600 rounded-full opacity-0 ${isDiscovering ? 'sonar-pulse' : ''}`}></div>
                            <div className="absolute w-24 h-24 bg-blue-700 rounded-full flex items-center justify-center text-white text-3xl font-bold">
                                📡
                            </div>
                        </div>
                        <button
                            className="modern-button text-white font-bold py-4 px-10 rounded-lg text-xl shadow-lg"
                            onClick={startDiscovery}
                            disabled={isDiscovering}
                        >
                            {isDiscovering ? "Searching..." : "Find Peer"}
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {discoveredPeers.map((peer) => (
                            <div
                                key={peer.instanceId}
                                className={`bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg flex flex-col items-start
                                    ${connectingPeerId === peer.instanceId ? 'connecting-animation' : ''}`}
                            >
                                <h3 className="text-xl font-semibold text-white mb-2">{peer.peerName}</h3>
                                <p className="text-gray-400 text-sm mb-1">ID: {peer.instanceId}</p>
                                <p className="text-gray-500 text-xs mt-auto pt-2">Last active: {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                                <p className="text-gray-500 text-xs pt-0.5">IP: {peer.ipAddress}</p>
                                <p className="text-gray-500 text-xs pt-0.5">Port: {peer.tcpPort}</p>
                                <button
                                    className="modern-button mt-4 w-full py-2 px-4 text-white font-bold rounded-lg shadow-md"
                                    onClick={() => handleConnect(peer)}
                                    disabled={connectingPeerId === peer.instanceId} // Disable while connecting
                                >
                                    {connectingPeerId === peer.instanceId ? (
                                        <span className="flex items-center justify-center">
                                            <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                            </svg>
                                            Connecting...
                                        </span>
                                    ) : (
                                        "Connect"
                                    )}
                                </button>
                            </div>
                        ))}
                        {/* Show sonar animation if discovering and no peers are found yet in discovered list */}
                        {isDiscovering && discoveredPeers.length === 0 && (
                            <div className="flex flex-col items-center justify-center bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center shadow-lg col-span-full">
                                <p className="text-gray-400 text-xl mb-8">Searching for peers...</p>
                                <div className={`relative w-48 h-48 mb-8 flex items-center justify-center transition-opacity duration-500 opacity-100`}>
                                    <div className="absolute w-full h-full bg-blue-600 rounded-full opacity-30"></div>
                                    <div className={`absolute w-full h-full bg-blue-600 rounded-full opacity-0 sonar-pulse`}></div>
                                    <div className="absolute w-24 h-24 bg-blue-700 rounded-full flex items-center justify-center text-white text-3xl font-bold">
                                        📡
                                    </div>
                                </div>
                                <button
                                    className="modern-button text-white font-bold py-4 px-10 rounded-lg text-xl shadow-lg"
                                    onClick={startDiscovery}
                                    disabled={isDiscovering}
                                >
                                    Searching...
                                </button>
                            </div>
                        )}
                        {/* Button to start discovery when peers are present in the discovered list, but not currently discovering */}
                        {discoveredPeers.length > 0 && !isDiscovering && (
                            <div className="col-span-full flex justify-center mt-6">
                                <button
                                    className="modern-button text-white font-bold py-4 px-10 rounded-lg text-xl shadow-lg"
                                    onClick={startDiscovery}
                                >
                                    Re-scan for Peers
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};