// MOCK PEERS — for UI testing only. Set to false or delete this file to disable.
export const MOCK_PEERS_ENABLED = true;

import { useEffect, useRef, useState } from 'react';
import type { DiscoveredPeer } from '../components/views/peers';

const MOCK_PEER_DATA: DiscoveredPeer[] = [
    {
        appId: 'beembridge',
        instanceId: 'mock-peer-laptop-alice',
        peerName: "Alice's Laptop",
        tcpPort: 9001,
        timestamp: Date.now(),
        lastSeen: new Date().toISOString(),
        ipAddress: '192.168.1.42',
    },
    {
        appId: 'beembridge',
        instanceId: 'mock-peer-desktop-bob',
        peerName: "Bob's Desktop",
        tcpPort: 9002,
        timestamp: Date.now(),
        lastSeen: new Date(Date.now() - 30000).toISOString(),
        ipAddress: '192.168.1.87',
    },
    {
        appId: 'beembridge',
        instanceId: 'mock-peer-phone-carol',
        peerName: "Carol's Phone",
        tcpPort: 9003,
        timestamp: Date.now(),
        lastSeen: new Date(Date.now() - 90000).toISOString(),
        ipAddress: '192.168.1.103',
    },
    {
        appId: 'beembridge',
        instanceId: 'mock-peer-tablet-dave',
        peerName: "Dave's Tablet",
        tcpPort: 9004,
        timestamp: Date.now(),
        lastSeen: new Date(Date.now() - 120000).toISOString(),
        ipAddress: '192.168.1.215',
    },
];

const DISCOVERY_DELAY_MS = 5000;

export function useMockPeerDiscovery(isDiscovering: boolean) {
    const [mockDiscoveredPeers, setMockDiscoveredPeers] = useState<DiscoveredPeer[]>([]);
    const isMountedRef = useRef(false);
    const timerRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            window.clearTimeout(timerRef.current);
        };
    }, []);

    useEffect(() => {
        if (!MOCK_PEERS_ENABLED) return;

        window.clearTimeout(timerRef.current);
        setMockDiscoveredPeers([]);

        if (isDiscovering) {
            timerRef.current = window.setTimeout(() => {
                if (isMountedRef.current) {
                    setMockDiscoveredPeers(
                        MOCK_PEER_DATA.map(p => ({ ...p, lastSeen: new Date().toISOString(), timestamp: Date.now() }))
                    );
                }
            }, DISCOVERY_DELAY_MS);
        }

        return () => {
            window.clearTimeout(timerRef.current);
        };
    }, [isDiscovering]);

    const simulateMockConnect = (
        peer: DiscoveredPeer,
        onResult: (peer: DiscoveredPeer, status: string) => void
    ): boolean => {
        if (!MOCK_PEERS_ENABLED) return false;
        if (!peer.instanceId.startsWith('mock-peer-')) return false;
        window.setTimeout(() => {
            if (isMountedRef.current) onResult(peer, 'accepted');
        }, 2000);
        return true;
    };

    return { mockDiscoveredPeers, simulateMockConnect };
}
