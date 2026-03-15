import { useState } from 'react';
import { FaFile, FaFileImage, FaFileVideo, FaFileAudio, FaFileArchive, FaFileCode } from 'react-icons/fa';
import { FiArrowUpRight, FiArrowDownLeft, FiTrash2 } from 'react-icons/fi';
import { CiSearch } from 'react-icons/ci';

interface TransferRecord {
    id: string;
    fileName: string;
    fileSize: number;
    direction: 'sent' | 'received';
    peerName: string;
    completedAt: Date;
    status: 'completed' | 'failed' | 'cancelled';
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(date: Date): string {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(fileName: string) {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
        return <FaFileImage className="text-purple-400 flex-shrink-0" />;
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext))
        return <FaFileVideo className="text-blue-400 flex-shrink-0" />;
    if (['mp3', 'wav', 'flac', 'ogg', 'aac'].includes(ext))
        return <FaFileAudio className="text-green-400 flex-shrink-0" />;
    if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext))
        return <FaFileArchive className="text-yellow-400 flex-shrink-0" />;
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'json', 'html', 'css'].includes(ext))
        return <FaFileCode className="text-accent-light flex-shrink-0" />;
    return <FaFile className="text-content-muted flex-shrink-0" />;
}

function getStatusBadge(status: TransferRecord['status']) {
    switch (status) {
        case 'completed': return 'bg-green-500/15 text-green-400';
        case 'failed': return 'bg-red-500/15 text-red-400';
        case 'cancelled': return 'bg-muted-fill/30 text-content-muted';
    }
}

function groupByDate(records: TransferRecord[]): { label: string; items: TransferRecord[] }[] {
    const todayStr = new Date().toDateString();
    const yesterdayStr = new Date(Date.now() - 86_400_000).toDateString();
    const groups: { label: string; items: TransferRecord[] }[] = [];
    const seen = new Map<string, TransferRecord[]>();

    records.forEach(r => {
        const dateStr = r.completedAt.toDateString();
        const label =
            dateStr === todayStr ? 'Today' :
            dateStr === yesterdayStr ? 'Yesterday' :
            r.completedAt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

        if (!seen.has(label)) {
            const arr: TransferRecord[] = [];
            seen.set(label, arr);
            groups.push({ label, items: arr });
        }
        seen.get(label)!.push(r);
    });
    return groups;
}

const MOCK_RECORDS: TransferRecord[] = [
    { id: '1', fileName: 'project-presentation.pdf', fileSize: 4.2 * 1024 * 1024, direction: 'sent', peerName: 'Alice-MacBook', completedAt: new Date(Date.now() - 5 * 60 * 1000), status: 'completed' },
    { id: '2', fileName: 'vacation-photos.zip', fileSize: 238 * 1024 * 1024, direction: 'received', peerName: 'Bob-Desktop', completedAt: new Date(Date.now() - 32 * 60 * 1000), status: 'completed' },
    { id: '3', fileName: 'meeting-recording.mp4', fileSize: 1.8 * 1024 * 1024 * 1024, direction: 'sent', peerName: 'Charlie-Laptop', completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), status: 'failed' },
    { id: '4', fileName: 'design-assets.tar.gz', fileSize: 56 * 1024 * 1024, direction: 'received', peerName: 'Alice-MacBook', completedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), status: 'completed' },
    { id: '5', fileName: 'budget-q3.xlsx', fileSize: 84 * 1024, direction: 'sent', peerName: 'Dave-PC', completedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), status: 'cancelled' },
    { id: '6', fileName: 'soundtrack.flac', fileSize: 42 * 1024 * 1024, direction: 'received', peerName: 'Bob-Desktop', completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), status: 'completed' },
    { id: '7', fileName: 'app-source-code.zip', fileSize: 12 * 1024 * 1024, direction: 'sent', peerName: 'Charlie-Laptop', completedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), status: 'completed' },
];

export const TransferHistoryView = () => {
    const records = MOCK_RECORDS;
    const [searchQuery, setSearchQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);

    const filteredRecords = records.filter(r => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return r.fileName.toLowerCase().includes(q) || r.peerName.toLowerCase().includes(q);
    });

    const mobileGroups = groupByDate(filteredRecords);

    const handleToggleSearch = () => {
        setShowSearch(prev => {
            if (prev) setSearchQuery('');
            return !prev;
        });
    };

    return (
        <div className="flex flex-col h-full px-4 pt-4 md:px-6 md:pt-6">

            {/* Header */}
            <div className="flex-shrink-0 flex justify-between items-center mb-3">
                <h1 className="text-2xl md:text-4xl font-bold text-content">Transfer History</h1>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleToggleSearch}
                        className={`p-2 rounded-lg transition-colors ${showSearch ? 'bg-accent/20 text-accent-light' : 'text-content-dim hover:bg-raised hover:text-content'}`}
                        aria-label="Search history"
                    >
                        <CiSearch className="text-xl" />
                    </button>
                    <button
                        disabled
                        className="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border-subtle text-content-dim cursor-not-allowed"
                    >
                        <FiTrash2 className="text-base" />
                        Clear History
                    </button>
                </div>
            </div>

            {/* Search bar */}
            {showSearch && (
                <div className="flex-shrink-0 mb-3">
                    <div className="flex items-center bg-surface border border-border rounded-lg px-3 py-2 gap-2 focus-within:ring-2 focus-within:ring-accent transition-shadow">
                        <CiSearch className="text-content-dim text-lg flex-shrink-0" />
                        <input
                            autoFocus
                            type="text"
                            placeholder="Search by file or peer…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-content placeholder:text-content-dim outline-none"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="text-content-dim hover:text-content text-xs px-1.5 py-0.5 rounded transition-colors"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* ── MOBILE layout ── */}
            <div className="md:hidden flex-1 overflow-y-auto">
                {filteredRecords.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center py-12 px-6">
                        {searchQuery ? (
                            <>
                                <CiSearch className="text-5xl text-content-dim mb-4" />
                                <p className="text-content-muted font-medium">No results for "{searchQuery}"</p>
                                <p className="text-content-dim text-sm mt-1">Try a different file name or peer</p>
                            </>
                        ) : (
                            <>
                                <img src="/src/assets/images/uploading_nu4x.svg" alt="No transfers" className="h-36 mb-6 opacity-60" />
                                <p className="text-content-muted font-medium">No transfers yet</p>
                                <p className="text-content-dim text-sm mt-1">Completed file transfers will appear here</p>
                            </>
                        )}
                    </div>
                ) : (
                    mobileGroups.map(({ label, items }) => (
                        <div key={label}>
                            {/* Date group label */}
                            <div className="px-4 py-1.5 bg-raised/20 border-b border-border-subtle/40">
                                <p className="text-xs font-semibold text-content-dim uppercase tracking-widest">{label}</p>
                            </div>

                            {/* Rows for this date group */}
                            {items.map(record => (
                                <div
                                    key={record.id}
                                    className="flex items-start gap-3 px-4 py-3 border-b border-border-subtle/40 hover:bg-raised/20 transition-colors"
                                >
                                    {/* File type icon */}
                                    <div className="text-lg mt-0.5 flex-shrink-0">
                                        {getFileIcon(record.fileName)}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-content truncate">{record.fileName}</p>
                                        <p className="text-xs text-content-muted mt-0.5">
                                            {record.peerName} · {formatBytes(record.fileSize)}
                                        </p>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium capitalize ${getStatusBadge(record.status)}`}>
                                                {record.status}
                                            </span>
                                            <span className="text-xs text-content-dim">{formatDate(record.completedAt)}</span>
                                        </div>
                                    </div>

                                    {/* Direction arrow */}
                                    <div className="flex-shrink-0 mt-0.5">
                                        {record.direction === 'sent'
                                            ? <FiArrowUpRight className="text-blue-400 text-base" />
                                            : <FiArrowDownLeft className="text-green-400 text-base" />
                                        }
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))
                )}
            </div>

            {/* ── DESKTOP layout ── */}
            <div className="hidden md:flex flex-col flex-1 border border-border rounded-xl overflow-hidden shadow-lg">
                {filteredRecords.length === 0 ? (
                    <div className="flex flex-col items-center justify-center flex-1 text-center py-12 px-6">
                        {searchQuery ? (
                            <>
                                <CiSearch className="text-5xl text-content-dim mb-4" />
                                <p className="text-content-muted font-medium">No results for "{searchQuery}"</p>
                            </>
                        ) : (
                            <>
                                <img src="/src/assets/images/uploading_nu4x.svg" alt="No transfers" className="h-40 mb-6 opacity-60" />
                                <p className="text-content-muted text-lg font-medium">No transfers yet</p>
                                <p className="text-content-dim text-sm mt-1">Completed file transfers will appear here</p>
                            </>
                        )}
                    </div>
                ) : (
                    <>
                        {/* Column headers */}
                        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.4fr_1fr] px-4 py-3 bg-card/70 border-b border-border-subtle text-xs font-semibold text-content-muted uppercase tracking-wider flex-shrink-0">
                            <span>File</span>
                            <span>Direction</span>
                            <span>Size</span>
                            <span>Peer</span>
                            <span>Date</span>
                            <span>Status</span>
                        </div>

                        {/* Rows */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {filteredRecords.map(record => (
                                <div
                                    key={record.id}
                                    className="grid grid-cols-[2fr_1fr_1fr_1fr_1.4fr_1fr] px-4 py-3 items-center border-b border-border-subtle/50 hover:bg-card/40 transition-colors"
                                >
                                    <div className="flex items-center gap-2 min-w-0 pr-4">
                                        {getFileIcon(record.fileName)}
                                        <span className="text-sm text-content truncate">{record.fileName}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {record.direction === 'sent'
                                            ? <FiArrowUpRight className="text-blue-400 text-base flex-shrink-0" />
                                            : <FiArrowDownLeft className="text-green-400 text-base flex-shrink-0" />
                                        }
                                        <span className={`text-sm capitalize ${record.direction === 'sent' ? 'text-blue-300' : 'text-green-300'}`}>
                                            {record.direction}
                                        </span>
                                    </div>
                                    <span className="text-sm text-content-muted">{formatBytes(record.fileSize)}</span>
                                    <span className="text-sm text-content-muted truncate pr-2">{record.peerName}</span>
                                    <span className="text-sm text-content-muted">{formatDate(record.completedAt)}</span>
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize w-fit ${getStatusBadge(record.status)}`}>
                                        {record.status}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* Footer */}
                        <div className="flex-shrink-0 px-4 py-2 bg-card/50 border-t border-border-subtle/50 text-xs text-content-dim">
                            {filteredRecords.length} transfer{filteredRecords.length !== 1 ? 's' : ''}
                            {searchQuery && ` matching "${searchQuery}"`}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
