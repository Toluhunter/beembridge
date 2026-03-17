import { FaFile, FaFolder, FaHashtag } from "react-icons/fa";
import { FiChevronDown, FiChevronRight, FiX } from "react-icons/fi";
import React, { useState, useMemo } from 'react';
import { useMockTransferEngine } from '../../utils/mockTransfers.js';
import { useAppContext, ActiveTransferDisplayItem } from '../../context/AppContext.js';

// Re-export for any other files that import these types from this module
export type { ActiveTransferDisplayItem, Progress } from '../../context/AppContext.js';

const formatSpeed = (kbps: number): string => {
    if (kbps >= 1024 * 1024) return `${(kbps / 1024 / 1024).toFixed(1)} GB/s`;
    if (kbps >= 1024) return `${(kbps / 1024).toFixed(2)} MB/s`;
    return `${kbps.toFixed(0)} KB/s`;
};

const STATUS_TEXT_COLOR: Record<ActiveTransferDisplayItem['status'], string> = {
    completed: 'text-green-400',
    failed: 'text-red-400',
    'in-progress': 'text-blue-400',
    pending: 'text-yellow-400',
    cancelled: 'text-content-muted',
};

const PROGRESS_BAR_COLOR: Record<ActiveTransferDisplayItem['status'], string> = {
    'in-progress': 'bg-accent',
    pending: 'bg-yellow-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    cancelled: 'bg-muted-fill',
};

// ─── Section label ────────────────────────────────────────────────────────────
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <div className="px-4 md:px-6 py-1.5 bg-raised/20 border-b border-border-subtle/40 flex-shrink-0">
        <p className="text-xs font-semibold text-content-dim uppercase tracking-widest">{children}</p>
    </div>
);

// ─── Hashing row ──────────────────────────────────────────────────────────────
const HashingRow = ({ filePath, percentage }: { filePath: string; percentage: number }) => {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    return (
        <div className="flex items-center gap-3 px-4 md:px-6 py-3 border-b border-border-subtle/50 hover:bg-raised/20 transition-colors">
            <FaHashtag className="text-purple-400 text-sm flex-shrink-0" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-content truncate">{fileName}</p>
                <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 bg-muted-fill rounded-full h-1">
                        <div
                            className="bg-purple-500 h-1 rounded-full transition-all duration-500"
                            style={{ width: `${Math.max(0, Math.min(100, percentage))}%` }}
                        />
                    </div>
                    <span className="text-xs text-content-dim whitespace-nowrap flex-shrink-0">{percentage.toFixed(0)}%</span>
                </div>
                <p className="text-xs text-purple-400 mt-0.5">Preparing…</p>
            </div>
        </div>
    );
};

// ─── Transfer row (individual or group child) ─────────────────────────────────
const TransferRow = ({
    transfer,
    indented = false,
}: {
    transfer: ActiveTransferDisplayItem;
    indented?: boolean;
}) => {
    const showProgress = transfer.status === 'in-progress' || transfer.status === 'pending';
    const canCancel = transfer.status === 'in-progress' || transfer.status === 'pending';
    const barColor = PROGRESS_BAR_COLOR[transfer.status] ?? 'bg-muted-fill';
    const textColor = STATUS_TEXT_COLOR[transfer.status] ?? 'text-content-secondary';
    const pct = Math.max(0, Math.min(100, transfer.percentage ?? 0));

    return (
        <div className={`flex items-center gap-3 ${indented ? 'pl-10 md:pl-14 pr-4 md:pr-6' : 'px-4 md:px-6'} py-3 border-b border-border-subtle/50 hover:bg-raised/20 transition-colors`}>
            <FaFile className="text-content-dim text-sm flex-shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-content truncate">{transfer.fileName}</p>
                    {transfer.speedKbps !== undefined && transfer.status === 'in-progress' && (
                        <span className="text-xs text-content-muted whitespace-nowrap flex-shrink-0">
                            {formatSpeed(transfer.speedKbps)}
                        </span>
                    )}
                </div>
                {showProgress && (
                    <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 bg-muted-fill rounded-full h-1">
                            <div
                                className={`${barColor} h-1 rounded-full transition-all duration-500`}
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <span className="text-xs text-content-dim whitespace-nowrap flex-shrink-0">{pct.toFixed(0)}%</span>
                    </div>
                )}
                <p className={`text-xs mt-0.5 capitalize ${textColor}`}>{transfer.status}</p>
            </div>
            {canCancel && (
                <button
                    onClick={() => console.log('Cancel transfer', transfer.fileId)}
                    className="flex-shrink-0 p-1.5 text-content-dim hover:text-red-400 transition-colors"
                    aria-label={`Cancel ${transfer.fileName}`}
                >
                    <FiX className="text-sm" />
                </button>
            )}
        </div>
    );
};

// ─── Main view ────────────────────────────────────────────────────────────────
export const ActiveTransferView: React.FC = () => {
    const { activeTransfers, hashingProgress, mockMode } = useAppContext();
    const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

    const { mockActiveTransfers, mockHashingProgress } = useMockTransferEngine(mockMode);

    const renderActiveTransfers = mockMode ? mockActiveTransfers : activeTransfers;
    const renderHashingProgress = mockMode ? mockHashingProgress : hashingProgress;

    const { groupedTransfers, individualTransfers } = useMemo(() => {
        const grouped: Record<string, ActiveTransferDisplayItem[]> = {};
        const individual: ActiveTransferDisplayItem[] = [];

        renderActiveTransfers.forEach(transfer => {
            if (transfer.parentId && transfer.rootDir) {
                if (!grouped[transfer.rootDir]) {
                    grouped[transfer.rootDir] = [];
                }
                grouped[transfer.rootDir].push(transfer);
            } else {
                individual.push(transfer);
            }
        });
        return { groupedTransfers: grouped, individualTransfers: individual };
    }, [renderActiveTransfers]);

    const getAveragePercentage = (transfers: ActiveTransferDisplayItem[]) => {
        if (transfers.length === 0) return 0;
        return Math.round(transfers.reduce((sum, t) => sum + (t.percentage || 0), 0) / transfers.length);
    };

    const getGroupStatus = (transfers: ActiveTransferDisplayItem[]): ActiveTransferDisplayItem['status'] => {
        if (transfers.some(t => t.status === 'failed')) return 'failed';
        if (transfers.some(t => t.status === 'in-progress')) return 'in-progress';
        if (transfers.every(t => t.status === 'completed')) return 'completed';
        if (transfers.some(t => t.status === 'pending')) return 'pending';
        return 'pending';
    };

    const toggleParent = (parentId: string) => {
        setExpandedParents(prev => ({ ...prev, [parentId]: !prev[parentId] }));
    };

    const hashingEntries = Object.entries(renderHashingProgress);
    const groupEntries = Object.entries(groupedTransfers);
    const hasContent = renderActiveTransfers.length > 0 || hashingEntries.length > 0;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 px-4 pt-4 pb-3 md:px-6 md:pt-6">
                <h1 className="text-xl md:text-3xl font-bold text-content">Active Transfers</h1>
            </div>

            {/* Empty state */}
            {!hasContent && (
                <div className="flex flex-col items-center justify-center flex-1 text-center px-6">
                    <img
                        src="/src/assets/images/uploading_nu4x.svg"
                        alt="No active transfers"
                        className="max-w-xs w-full mb-6 opacity-70"
                    />
                    <p className="text-content-muted text-base">No active transfers at the moment.</p>
                </div>
            )}

            {/* Transfer list — single scrollable area */}
            {hasContent && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                    {/* Hashing / preparing */}
                    {hashingEntries.length > 0 && (
                        <>
                            <SectionLabel>Preparing</SectionLabel>
                            {hashingEntries.map(([filePath, percentage]) => (
                                <HashingRow key={filePath} filePath={filePath} percentage={percentage} />
                            ))}
                        </>
                    )}

                    {/* Grouped (folder) transfers */}
                    {groupEntries.map(([rootDir, children]) => {
                        const avg = getAveragePercentage(children);
                        const groupStatus = getGroupStatus(children);
                        const isExpanded = expandedParents[rootDir] ?? false;
                        const barColor = PROGRESS_BAR_COLOR[groupStatus] ?? 'bg-accent';
                        const textColor = STATUS_TEXT_COLOR[groupStatus] ?? 'text-content-secondary';

                        return (
                            <React.Fragment key={rootDir}>
                                {/* Group header */}
                                <button
                                    onClick={() => toggleParent(rootDir)}
                                    className="w-full flex items-center gap-3 px-4 md:px-6 py-3 border-b border-border-subtle/50 bg-raised/10 hover:bg-raised/25 text-left transition-colors"
                                >
                                    <FaFolder className="text-content-muted text-base flex-shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-content truncate">{rootDir}</p>
                                        <div className="flex items-center gap-2 mt-1">
                                            <div className="flex-1 bg-muted-fill rounded-full h-1">
                                                <div
                                                    className={`${barColor} h-1 rounded-full transition-all duration-500`}
                                                    style={{ width: `${avg}%` }}
                                                />
                                            </div>
                                            <span className="text-xs text-content-dim whitespace-nowrap flex-shrink-0">{avg}%</span>
                                        </div>
                                        <p className={`text-xs mt-0.5 capitalize ${textColor}`}>
                                            {children.length} file{children.length !== 1 ? 's' : ''} · {groupStatus}
                                        </p>
                                    </div>
                                    {isExpanded
                                        ? <FiChevronDown className="text-content-dim text-base flex-shrink-0" />
                                        : <FiChevronRight className="text-content-dim text-base flex-shrink-0" />
                                    }
                                </button>

                                {/* Children (when expanded) */}
                                {isExpanded && children.map(transfer => (
                                    <TransferRow key={transfer.fileId} transfer={transfer} indented />
                                ))}
                            </React.Fragment>
                        );
                    })}

                    {/* Individual transfers */}
                    {individualTransfers.map(transfer => (
                        <TransferRow key={transfer.fileId} transfer={transfer} />
                    ))}
                </div>
            )}
        </div>
    );
};
