import { RiRadarFill } from "react-icons/ri";
import { useMockPeerDiscovery } from '../../utils/mockPeers';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ThreeCircles } from "react-loader-spinner";
import { MdDevices } from "react-icons/md";
import React, {
    useState,
    useEffect,
    useCallback
} from "react";
import { useAppContext, DiscoveredPeer } from '../../context/AppContext.js';

// Re-export for any other files that import DiscoveredPeer from this module
export type { DiscoveredPeer } from '../../context/AppContext.js';

const PEER_DISCOVERY_TIME = 30 * 1000;

export const PeerView: React.FC = () => {
    const {
        userName,
        isDiscovering,
        setIsDiscovering,
        discoveredPeers,
        setDiscoveredPeers,
        connectedPeers,
        setConnectedPeers,
        mockMode,
    } = useAppContext();

    const [incomingRequest, setIncomingRequest] = useState<{ peer: DiscoveredPeer, requestId: string, accept: () => void, reject: () => void } | null>(null);
    const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);
    const [isDiscoveryButtonDisabled, setIsDiscoveryButtonDisabled] = useState(false);
    const [ellipsis, setEllipsis] = useState<string>('');
    const [connectedPage, setConnectedPage] = useState(1);
    const [connectedPerPage, setConnectedPerPage] = useState<number>(3);
    const [discoveredPage, setDiscoveredPage] = useState(1);
    const [discoveredPerPage, setDiscoveredPerPage] = useState<number>(6);

    const updatePerPage = useCallback(() => {
        if (typeof window === 'undefined') return;
        const w = window.innerWidth;

        let conn = 1;
        if (w >= 1536) conn = 5;
        else if (w >= 1280) conn = 4;
        else if (w >= 1024) conn = 3;
        else if (w >= 768) conn = 2;
        else conn = 1;

        let disc = 1;
        if (w >= 1536) disc = 5;
        else if (w >= 1280) disc = 5;
        else if (w >= 1024) disc = 4;
        else if (w >= 768) disc = 3;
        else if (w >= 640) disc = 2;
        else disc = 1;

        setConnectedPerPage(conn);
        setDiscoveredPerPage(disc);
        setConnectedPage(1);
        setDiscoveredPage(1);
    }, []);

    useEffect(() => {
        updatePerPage();
        window.addEventListener('resize', updatePerPage);
        return () => window.removeEventListener('resize', updatePerPage);
    }, [updatePerPage]);

    useEffect(() => {
        if (!isDiscovering || mockMode) return;

        let unlisten: (() => void) | undefined;

        listen<DiscoveredPeer[]>('onPeerDiscoveryUpdate', ({ payload: peers }) => {
            const filtered = peers.filter(
                p => !connectedPeers.some(c => c.instanceId === p.instanceId)
            );
            setDiscoveredPeers(filtered);
        }).then(fn => { unlisten = fn; });

        return () => { unlisten?.(); };
    }, [isDiscovering, mockMode, connectedPeers]);

    useEffect(() => {
        let idx = 0;
        let timer: NodeJS.Timeout | undefined;

        const currentLength = mockMode ? 0 : discoveredPeers.length;
        if (isDiscovering && currentLength === 0) {
            timer = setInterval(() => {
                idx = (idx + 1) % 4;
                setEllipsis('.'.repeat(idx));
            }, 500);
        } else {
            setEllipsis('');
        }

        return () => {
            if (timer) clearInterval(timer);
        };
    }, [isDiscovering, discoveredPeers.length, mockMode]);

    const onConnectionResponse = useCallback((peer: DiscoveredPeer, status: string, reason?: string) => {
        console.log(`[RECEIVER] Connection status with ${peer.peerName}: ${status}${reason ? ` (${reason})` : ''}`);
        if (status === 'accepted') {
            setConnectedPeers(prevConnected => {
                if (!prevConnected.some(p => p.instanceId === peer.instanceId)) {
                    return [...prevConnected, peer];
                }
                return prevConnected;
            });
            setDiscoveredPeers(prevDiscovered => prevDiscovered.filter(p => p.instanceId !== peer.instanceId));
            console.log("[RECEIVER] Connection ready! You can send data now.");
        } else if (status === 'rejected' || status === 'failed' || status === 'timeout') {
            console.log("[RECEIVER] Connection failed or rejected. Please try another peer.");
            setDiscoveredPeers(prevDiscovered => {
                if (!prevDiscovered.some(p => p.instanceId === peer.instanceId)) {
                    return [...prevDiscovered, peer];
                }
                return prevDiscovered;
            });
        }
        setConnectingPeerId(null);
    }, [setConnectedPeers, setDiscoveredPeers]);

    useEffect(() => {
        let unlistenConnectionRequest: (() => void) | undefined;
        let unlistenConnectionResponse: (() => void) | undefined;
        let unlistenPeerConnected: (() => void) | undefined;

        const setup = async () => {
            unlistenConnectionRequest = await listen<{ peer: DiscoveredPeer; requestId: string }>(
                'onPeerConnectionRequest',
                ({ payload: { peer, requestId } }) => {
                    console.log(`[RECEIVER] Connection request from ${peer.peerName} (${requestId})`);
                    const accept = () => {
                        invoke('respond_to_peer_connection_request', { requestId, accept: true });
                        setIncomingRequest(null);
                    };
                    const reject = () => {
                        invoke('respond_to_peer_connection_request', { requestId, accept: false });
                        setIncomingRequest(null);
                    };
                    setIncomingRequest({ peer, requestId, accept, reject });
                }
            );

            unlistenConnectionResponse = await listen<{ peer: DiscoveredPeer; status: string; reason?: string }>(
                'onConnectionResponse',
                ({ payload: { peer, status, reason } }) => {
                    onConnectionResponse(peer, status, reason);
                    setConnectingPeerId(null);
                }
            );

            unlistenPeerConnected = await listen<DiscoveredPeer>(
                'onPeerConnected',
                ({ payload: peer }) => {
                    console.log(`[RECEIVER] Connection status with ${peer.peerName}: accepted`);
                    onConnectionResponse(peer, 'accepted');
                }
            );
        };

        setup();

        return () => {
            unlistenConnectionRequest?.();
            unlistenConnectionResponse?.();
            unlistenPeerConnected?.();
        };
    }, [onConnectionResponse]);

    const startDiscovery = () => {
        if (isDiscoveryButtonDisabled) return;
        setIsDiscoveryButtonDisabled(true);
        setTimeout(() => setIsDiscoveryButtonDisabled(false), 1200);

        if (isDiscovering) {
            if (!mockMode) invoke('stop_peer_discovery');
            setIsDiscovering(false);
            setDiscoveredPeers([]);
        } else {
            if (!mockMode) invoke('start_peer_discovery', { peerName: userName });
            setIsDiscovering(true);
        }
    };

    const { mockDiscoveredPeers, simulateMockConnect } = useMockPeerDiscovery(isDiscovering && mockMode);
    const renderDiscoveredPeers = mockMode ? mockDiscoveredPeers : discoveredPeers;

    const handleConnect = (peerToConnect: DiscoveredPeer) => {
        setConnectingPeerId(peerToConnect.instanceId);
        console.log(`Attempting to connect to peer: ${peerToConnect.peerName} (${peerToConnect.instanceId})`);
        if (mockMode) {
            simulateMockConnect(peerToConnect, onConnectionResponse);
        } else {
            invoke('connect_to_peer', { peer: peerToConnect });
        }
    };

    const handleDisconnect = async (peerToDisconnect: DiscoveredPeer) => {
        setConnectingPeerId(null);
        console.log(`Attempting to disconnect from peer: ${peerToDisconnect.peerName} (${peerToDisconnect.instanceId})`);
        if (!mockMode) {
            try {
                await invoke('disconnect_from_peer', { instanceId: peerToDisconnect.instanceId });
            } catch (err) {
                console.error("DisconnectFromPeer error:", err);
            }
        }
        setConnectedPeers(prev => prev.filter(p => p.instanceId !== peerToDisconnect.instanceId));
    };

    return (
        <div className="flex flex-col h-full px-4 pt-4 md:px-6 md:pt-6">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl md:text-4xl font-bold text-content">Peers</h1>
                {incomingRequest && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
                        <div className="bg-card rounded-lg p-6 w-full max-w-md">
                            <h2 className="text-2xl font-bold text-content mb-4">Incoming Connection Request</h2>
                            <p className="text-content-secondary mb-4">
                                {incomingRequest.peer.peerName} ({incomingRequest.peer.ipAddress}:{incomingRequest.peer.tcpPort}) wants to connect.
                            </p>
                            <div className="flex justify-end">
                                <button
                                    className="mr-2 px-4 py-2 rounded-lg bg-red-500 text-content hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                                    onClick={() => {
                                        if (incomingRequest) {
                                            incomingRequest.reject();
                                            setIncomingRequest(null);
                                        }
                                    }}
                                >
                                    Reject
                                </button>
                                <button
                                    className="px-4 py-2 rounded-lg bg-green-500 text-content hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
                                    onClick={() => {
                                        if (incomingRequest) {
                                            incomingRequest.accept();
                                            setConnectedPeers(prevConnected => {
                                                if (!prevConnected.some(p => p.instanceId === incomingRequest.peer.instanceId)) {
                                                    return [...prevConnected, incomingRequest.peer];
                                                }
                                                return prevConnected;
                                            });
                                            setIncomingRequest(null);
                                        }
                                    }}
                                >
                                    Accept
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Discovery control */}
            <div className="flex justify-end mb-6">
                <button
                    className="modern-button text-content font-bold py-2 px-6 rounded-lg shadow-md"
                    onClick={startDiscovery}
                    disabled={isDiscoveryButtonDisabled}
                >
                    {isDiscovering ? 'Stop' : 'Find Peer'}
                </button>
            </div>

            {/* ── MOBILE layout (< md) ── */}
            <div className="md:hidden flex-1 flex flex-col gap-4 min-h-0">

                {/* Connected peers — mobile list */}
                {connectedPeers.length > 0 && (
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-content-muted px-1 mb-2">
                            Connected ({connectedPeers.length})
                        </p>
                        <div className="rounded-xl overflow-hidden border border-green-700/30 divide-y divide-border-subtle/30">
                            {connectedPeers.map((peer) => (
                                <div key={peer.instanceId} className="flex items-center gap-3 px-4 py-3 bg-card/60 min-h-[64px]">
                                    <MdDevices className="text-green-400 text-2xl shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-content leading-tight truncate">{peer.peerName}</p>
                                        <p className="text-xs text-content-dim">{peer.ipAddress} · Port {peer.tcpPort}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs text-green-400 font-medium hidden sm:inline">● Connected</span>
                                        <button
                                            onClick={() => handleDisconnect(peer)}
                                            className="border border-red-600 text-red-500 px-3 py-2 rounded-lg text-sm hover:bg-red-600 hover:text-content transition-colors"
                                        >
                                            Disconnect
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Discovered peers — mobile list */}
                {(connectedPeers.length === 0 || isDiscovering) && (
                    <div className="flex-1 flex flex-col">
                        {(isDiscovering || renderDiscoveredPeers.length > 0) && (
                            <p className="text-xs font-semibold uppercase tracking-wider text-content-muted px-1 mb-2">
                                Nearby Devices
                            </p>
                        )}

                        {isDiscovering && renderDiscoveredPeers.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-center">
                                <ThreeCircles
                                    visible={true}
                                    height="80"
                                    width="80"
                                    color="oklch(49.6% 0.265 301.924)"
                                    ariaLabel="three-circles-loading"
                                    wrapperStyle={{}}
                                    wrapperClass=""
                                />
                                <p className="text-content text-base mt-4 text-center">
                                    Searching for peers<span>{ellipsis}</span>
                                </p>
                            </div>
                        ) : renderDiscoveredPeers.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-center">
                                <img src="/src/assets/images/location-search_nesh.svg" alt="Location Search" className="max-w-[180px] w-full mb-6" />
                                <p className="text-content-muted text-lg">No peers detected yet.</p>
                            </div>
                        ) : (
                            <div className="overflow-y-auto rounded-xl border border-border-subtle/40 divide-y divide-border-subtle/30">
                                {renderDiscoveredPeers.map((peer) => (
                                    <div
                                        key={peer.instanceId}
                                        className={`flex items-center gap-3 px-4 py-3 bg-card/60 min-h-[64px] ${connectingPeerId === peer.instanceId ? 'connecting-animation' : ''}`}
                                    >
                                        <MdDevices className="text-blue-400 text-2xl shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium text-content leading-tight truncate">{peer.peerName}</p>
                                            <p className="text-xs text-content-dim">{peer.ipAddress} · {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                                        </div>
                                        <button
                                            className="modern-button py-2 px-4 text-content font-bold rounded-lg shadow-md text-sm shrink-0"
                                            onClick={() => handleConnect(peer)}
                                            disabled={connectingPeerId === peer.instanceId}
                                        >
                                            {connectingPeerId === peer.instanceId ? (
                                                <span className="flex items-center gap-2">
                                                    <svg className="animate-spin h-4 w-4 text-content" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                    </svg>
                                                    Connecting...
                                                </span>
                                            ) : 'Connect'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ── DESKTOP layout (≥ md) ── */}
            <div className="hidden md:flex md:flex-col md:flex-1">

                {/* Connected Peers Section */}
                {connectedPeers.length > 0 && (
                    <div className="mb-6">
                        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6 justify-items-center">
                            {(() => {
                                const total = connectedPeers.length;
                                const totalPages = Math.ceil(total / connectedPerPage) || 1;
                                const start = (connectedPage - 1) * connectedPerPage;
                                const end = start + connectedPerPage;
                                const pageItems = connectedPeers.slice(start, end);
                                return (
                                    <>
                                        {pageItems.map((peer) => (
                                            <div key={peer.instanceId} className="relative bg-card/60 h-64 rounded-xl p-4 border border-green-700/40 shadow-2xl w-full aspect-square flex flex-col justify-between break-words">
                                                <div className="space-y-1 flex flex-col items-center text-center">
                                                    <MdDevices className="text-green-400 text-6xl mb-1" />
                                                    <h3 className="text-lg font-semibold text-content leading-tight break-words">{peer.peerName} <span className="text-green-400 text-sm">(Connected)</span></h3>
                                                    <p className="text-content-muted text-sm break-words">ID: {peer.instanceId}</p>
                                                </div>
                                                <div className="flex flex-col items-center w-full justify-between pt-2 gap-2">
                                                    <p className="text-content-dim text-xs">Last active: {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                                                    <button
                                                        onClick={() => handleDisconnect(peer)}
                                                        className="border border-red-600 text-red-600 px-3 py-1 rounded-md hover:bg-red-600 hover:text-content transition-colors text-sm"
                                                    >
                                                        Disconnect
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                        {totalPages > 1 && (
                                            <div className="col-span-full flex justify-between items-center p-2 mt-4 border-t border-border-subtle bg-card/30 rounded">
                                                <div className="text-sm text-content-muted">
                                                    Showing {Math.min(start + 1, total)} to {Math.min(end, total)} of {total} items
                                                </div>
                                                <div className="flex items-center space-x-2">
                                                    <button
                                                        onClick={() => setConnectedPage(prev => Math.max(prev - 1, 1))}
                                                        disabled={connectedPage === 1}
                                                        className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                                        aria-label="Previous Page"
                                                    >{'<'}</button>
                                                    <div className="text-sm text-content-secondary">{connectedPage} / {totalPages}</div>
                                                    <button
                                                        onClick={() => setConnectedPage(prev => Math.min(prev + 1, totalPages))}
                                                        disabled={connectedPage === totalPages}
                                                        className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                                        aria-label="Next Page"
                                                    >{'>'}</button>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                )}

                {/* Discovered Peers Section */}
                <div className="flex-1 flex flex-col">
                    {(connectedPeers.length == 0 || isDiscovering) && (
                        <div className="flex-1 overflow-y-auto min-h-60 border-t border-border-subtle/50 md:border md:rounded-2xl md:shadow-xl p-3 md:p-6 relative">
                            {isDiscovering && renderDiscoveredPeers.length === 0 && (
                                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black bg-opacity-30">
                                    <div className="p-6 bg-transparent rounded flex flex-col items-center">
                                        <ThreeCircles
                                            visible={true}
                                            height="100"
                                            width="100"
                                            color="oklch(49.6% 0.265 301.924)"
                                            ariaLabel="three-circles-loading"
                                            wrapperStyle={{}}
                                            wrapperClass=""
                                        />
                                        <p className="text-content text-lg mt-4 text-center">Searching for peers
                                            <span className="ml-2">{ellipsis}</span>
                                        </p>
                                    </div>
                                </div>
                            )}
                            {renderDiscoveredPeers.length === 0 && !isDiscovering ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <div className="mb-8">
                                        <img src="/src/assets/images/location-search_nesh.svg" alt="Location Search" className="max-w-xs w-full" />
                                    </div>
                                    <p className="text-content-muted text-xl mb-8">
                                        No peers detected yet.
                                    </p>
                                </div>
                            ) : (
                                <div className="relative">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-5 gap-6 justify-items-center">
                                        {(() => {
                                            const total = renderDiscoveredPeers.length;
                                            const totalPages = Math.ceil(total / discoveredPerPage) || 1;
                                            const start = (discoveredPage - 1) * discoveredPerPage;
                                            const end = start + discoveredPerPage;
                                            const pageItems = renderDiscoveredPeers.slice(start, end);
                                            return (
                                                <>
                                                    {pageItems.map((peer) => (
                                                        <div
                                                            key={peer.instanceId}
                                                            className={`bg-card/60 rounded-xl p-4 border border-border-subtle/40 shadow-2xl w-full h-80 aspect-square flex flex-col justify-between break-words whitespace-normal
                                                            ${connectingPeerId === peer.instanceId ? 'connecting-animation' : ''}`}
                                                        >
                                                            <div className="flex justify-center">
                                                                <MdDevices className="text-blue-400 text-6xl" />
                                                            </div>
                                                            <div className="space-y-1">
                                                                <h3 className="text-lg font-semibold text-content leading-tight break-words whitespace-normal">{peer.peerName}</h3>
                                                                <p className="text-content-muted text-sm break-words whitespace-normal">ID: {peer.instanceId}</p>
                                                                <p className="text-content-dim text-xs break-words whitespace-normal">IP: {peer.ipAddress}</p>
                                                            </div>
                                                            <div className="flex flex-col gap-4 justify-between items-center pt-2">
                                                                <p className="text-content-dim text-xs">Last: {new Date(peer.lastSeen).toLocaleTimeString()}</p>
                                                                <button
                                                                    className="modern-button ml-4 py-1 px-3 text-content font-bold rounded-lg shadow-md text-sm"
                                                                    onClick={() => handleConnect(peer)}
                                                                    disabled={connectingPeerId === peer.instanceId}
                                                                >
                                                                    {connectingPeerId === peer.instanceId ? (
                                                                        <span className="flex items-center justify-center">
                                                                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-content" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
                                                        </div>
                                                    ))}
                                                    {totalPages > 1 && (
                                                        <div className="col-span-full flex justify-between items-center p-2 mt-4 border-t border-border-subtle bg-card/30 rounded">
                                                            <div className="text-sm text-content-muted">
                                                                Showing {Math.min(start + 1, total)} to {Math.min(end, total)} of {total} items
                                                            </div>
                                                            <div className="flex items-center space-x-2">
                                                                <button
                                                                    onClick={() => setDiscoveredPage(prev => Math.max(prev - 1, 1))}
                                                                    disabled={discoveredPage === 1}
                                                                    className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                                                    aria-label="Previous Page"
                                                                >{'<'}</button>
                                                                <div className="text-sm text-content-secondary">{discoveredPage} / {totalPages}</div>
                                                                <button
                                                                    onClick={() => setDiscoveredPage(prev => Math.min(prev + 1, totalPages))}
                                                                    disabled={discoveredPage === totalPages}
                                                                    className="px-2 py-1 text-content-secondary hover:text-content disabled:opacity-50 transition-colors"
                                                                    aria-label="Next Page"
                                                                >{'>'}</button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
};
