import { useEffect, useRef, useState } from 'react';

type Status = 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled';

type MockTransferItem = {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number;
    parentId?: string;
    rootDir?: string;
    status: Status;
};

export function useMockTransferEngine(enabled: boolean) {
    const [mockActiveTransfers, setMockActiveTransfers] = useState<MockTransferItem[]>([]);
    const [mockHashingProgress, setMockHashingProgress] = useState<Record<string, number>>({});
    const timersRef = useRef<number[]>([]);
    const isMountedRef = useRef<boolean>(false);

    const genId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? (crypto as any).randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));

    const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    const pick = <T,>(arr: T[]) => arr[randInt(0, arr.length - 1)];

    const fileBases = ['report', 'photo', 'video', 'backup', 'notes', 'dataset', 'archive', 'invoice', 'design', 'music'];
    const fileExts = ['txt', 'jpg', 'png', 'mp4', 'zip', 'csv', 'pdf', 'docx', 'json', 'wav'];
    const folderBases = ['Project_Really_long_group_Name_To_test_break_word'];

    const makeFileName = () => `${pick(fileBases)}_${randInt(100, 9999)}.${pick(fileExts)}`;
    const makeFolderName = () => `${pick(folderBases)}_${randInt(1, 50)}`;

    const clearAllTimers = () => {
        timersRef.current.forEach((id) => window.clearInterval(id));
        timersRef.current.forEach((id) => window.clearTimeout(id));
        timersRef.current = [];
    };

    const simulateHashing = (filePath: string): Promise<void> => {
        return new Promise((resolve) => {
            let pct = 0;
            setMockHashingProgress((prev) => ({ ...prev, [filePath]: pct }));
            const durationMs = randInt(800, 2500);
            const stepMs = 120;
            const totalSteps = Math.ceil(durationMs / stepMs);
            let steps = 0;
            const id = window.setInterval(() => {
                steps += 1;
                pct = Math.min(100, Math.round((steps / totalSteps) * 100));
                setMockHashingProgress((prev) => ({ ...prev, [filePath]: pct }));
                if (pct >= 100) {
                    window.clearInterval(id);
                    const tid = window.setTimeout(() => {
                        setMockHashingProgress((prev) => {
                            const copy = { ...prev };
                            delete copy[filePath];
                            return copy;
                        });
                        resolve();
                    }, 200);
                    timersRef.current.push(tid);
                }
            }, stepMs);
            timersRef.current.push(id);
        });
    };

    const simulateSingleTransfer = async (): Promise<void> => {
        const fileName = makeFileName();
        const filePath = `/home/user/${fileName}`;
        await simulateHashing(filePath);

        const fileId = genId();
        const totalBytes = randInt(5_000_000, 900_000_000);
        const longOrShort = Math.random() < 0.5 ? 10_000 : 100_000; // 10s or 100s
        const startTs = Date.now();
        const endTs = startTs + longOrShort;
        const bytesPerMs = totalBytes / longOrShort;

        setMockActiveTransfers((prev) => ([
            ...prev,
            {
                fileId,
                fileName,
                totalBytes,
                transferredBytes: 0,
                percentage: 0,
                speedKbps: Math.max(1, Math.round((bytesPerMs * 1000) / 1024)),
                status: 'in-progress',
            },
        ]));

        const id = window.setInterval(() => {
            const now = Date.now();
            const elapsed = Math.min(now - startTs, longOrShort);
            const transferredBytes = Math.floor(bytesPerMs * elapsed);
            const percentage = Math.min(100, Math.round((elapsed / longOrShort) * 100));
            const speedKbps = Math.max(1, Math.round((bytesPerMs * 1000) / 1024));
            setMockActiveTransfers((prev) => prev.map((t) =>
                t.fileId === fileId
                    ? { ...t, transferredBytes, percentage, speedKbps, status: percentage >= 100 ? 'completed' : 'in-progress' }
                    : t
            ));
            if (now >= endTs) {
                window.clearInterval(id);
                const tid = window.setTimeout(() => {
                    setMockActiveTransfers((prev) => prev.filter((t) => t.fileId !== fileId));
                    if (isMountedRef.current && enabled) scheduleNextMock();
                }, 800);
                timersRef.current.push(tid);
            }
        }, 250);
        timersRef.current.push(id);
    };

    const simulateFolderTransfer = async (): Promise<void> => {
        const folderName = makeFolderName();
        const childCount = randInt(3, 6);
        const childNames = Array.from({ length: childCount }).map(() => makeFileName());

        await Promise.all(childNames.map((n) => simulateHashing(`/home/user/${folderName}/${n}`)));

        const childIds = childNames.map(() => genId());
        const totals = childNames.map(() => randInt(5_000_000, 900_000_000));
        // Ensure all group (folder) items take the long duration (100s)
        const durations = childNames.map(() => 100_000);
        const starts = durations.map(() => Date.now());
        const ends = starts.map((s, i) => s + durations[i]);
        const bytesPerMs = totals.map((tb, i) => tb / durations[i]);

        setMockActiveTransfers((prev) => ([
            ...prev,
            ...childNames.map((fileName, i) => ({
                fileId: childIds[i],
                fileName,
                totalBytes: totals[i],
                transferredBytes: 0,
                percentage: 0,
                speedKbps: Math.max(1, Math.round((bytesPerMs[i] * 1000) / 1024)),
                parentId: folderName,
                rootDir: folderName,
                status: 'in-progress',
            } as MockTransferItem)),
        ]));

        const updaterId = window.setInterval(() => {
            const now = Date.now();
            let allDone = true;
            let seenAny = false;
            setMockActiveTransfers((prev) => prev.map((t) => {
                const idx = childIds.indexOf(t.fileId);
                if (idx === -1) return t;
                seenAny = true;
                const elapsed = Math.min(now - starts[idx], durations[idx]);
                const transferredBytes = Math.floor(bytesPerMs[idx] * elapsed);
                const percentage = Math.min(100, Math.round((elapsed / durations[idx]) * 100));
                const speedKbps = Math.max(1, Math.round((bytesPerMs[idx] * 1000) / 1024));
                const status: Status = percentage >= 100 ? 'completed' : 'in-progress';
                if (status !== 'completed') allDone = false;
                return { ...t, transferredBytes, percentage, speedKbps, status };
            }));

            // Prevent premature cleanup if the group hasn't been committed to state yet
            if (!seenAny) allDone = false;

            if (now >= Math.max(...ends) || allDone) {
                window.clearInterval(updaterId);
                const tid = window.setTimeout(() => {
                    setMockActiveTransfers((prev) => prev.filter((t) => t.parentId !== folderName));
                    if (isMountedRef.current && enabled) scheduleNextMock();
                }, 900);
                timersRef.current.push(tid);
            }
        }, 300);
        timersRef.current.push(updaterId);
    };

    const scheduleNextMock = () => {
        const delay = randInt(500, 1500);
        const tid = window.setTimeout(() => {
            if (!isMountedRef.current || !enabled) return;
            // Bias towards folder (group) transfers for higher frequency (~75%)
            if (Math.random() < 0.25) {
                simulateSingleTransfer();
            } else {
                simulateFolderTransfer();
            }
        }, delay);
        timersRef.current.push(tid);
    };

    // Spawn an initial burst of concurrent single transfers for testing pagination
    const spawnInitialSingles = () => {
        const count = randInt(5, 10);
        for (let i = 0; i < count; i++) {
            // Fire and forget; each will hash then start transferring
            void simulateSingleTransfer();
        }
    };

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            clearAllTimers();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!isMountedRef.current) return;
        if (enabled) {
            clearAllTimers();
            setMockActiveTransfers([]);
            setMockHashingProgress({});
            // Start with a burst of 5-10 single transfers to ensure enough visible items
            spawnInitialSingles();
            // Continue background scheduling to keep activity flowing
            scheduleNextMock();
        } else {
            clearAllTimers();
            setMockActiveTransfers([]);
            setMockHashingProgress({});
        }
        return () => {
            clearAllTimers();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    return { mockActiveTransfers, mockHashingProgress };
}
