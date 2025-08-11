import React, { useEffect, useState, useMemo } from 'react';
// import { ChevronDown, ChevronUp } from 'lucide-react'; // Using lucide-react for icons - REMOVED due to import issues

export interface ActiveTransferDisplayItem extends Progress {
    status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled';
}

export type Progress = {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number; // Optional: speed calculation
    parentId?: string;
}

interface ActiveTransferViewProps {
    activeTransfers: ActiveTransferDisplayItem[],
    hashingProgress: {[key: string]: number}
}

export const ActiveTransferView: React.FC<ActiveTransferViewProps> = ({ activeTransfers, hashingProgress }) => {
    // State to manage the expanded/collapsed state of parent groups
    const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

    useEffect(() => {
        if (window.electron) {
            // Start listening for progress updates
            // This part of the code remains as is, as it's external to the UI logic
        } else {
            console.warn('Electron API not available. Are you running in Electron?');
        }
    }, []); // Empty dependency array means this runs once on mount

    // Function to determine the color based on status
    const getStatusColor = (status: ActiveTransferDisplayItem['status']) => {
        switch (status) {
            case 'completed': return 'text-green-500';
            case 'failed': return 'text-red-500';
            case 'in-progress': return 'text-blue-500';
            case 'pending': return 'text-yellow-500';
            case 'cancelled': return 'text-gray-400';
            default: return 'text-gray-300';
        }
    };

    // Group transfers by parentId and calculate average percentage
    const { groupedTransfers, individualTransfers } = useMemo(() => {
        const grouped: Record<string, ActiveTransferDisplayItem[]> = {};
        const individual: ActiveTransferDisplayItem[] = [];

        activeTransfers.forEach(transfer => {
            if (transfer.parentId) {
                if (!grouped[transfer.parentId]) {
                    grouped[transfer.parentId] = [];
                }
                grouped[transfer.parentId].push(transfer);
            } else {
                individual.push(transfer);
            }
        });
        return { groupedTransfers: grouped, individualTransfers: individual };
    }, [activeTransfers]); // Recalculate when activeTransfers changes

    // Function to calculate average percentage for a group
    const getAveragePercentage = (transfers: ActiveTransferDisplayItem[]) => {
        if (transfers.length === 0) return 0;
        const totalPercentage = transfers.reduce((sum, t) => sum + (t.percentage || 0), 0);
        return Math.round(totalPercentage / transfers.length);
    };

    // Function to get the overall status of a group
    const getGroupStatus = (transfers: ActiveTransferDisplayItem[]) => {
        if (transfers.some(t => t.status === 'failed')) return 'failed';
        if (transfers.some(t => t.status === 'in-progress')) return 'in-progress';
        if (transfers.every(t => t.status === 'completed')) return 'completed';
        if (transfers.some(t => t.status === 'pending')) return 'pending';
        return 'pending'; // Default or mixed
    };

    // Toggle dropdown for a parent group
    const toggleParent = (parentId: string) => {
        setExpandedParents(prev => ({
            ...prev,
            [parentId]: !prev[parentId]
        }));
    };

    return (
        <div className="p-6 bg-gray-800 rounded-xl shadow-lg h-full flex flex-col font-inter">
            <h1 className="text-3xl font-bold text-white mb-6">Active Transfers</h1>

            {activeTransfers.length === 0 && Object.keys(hashingProgress).length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                    <p className="text-gray-400 text-lg">No active transfers at the moment.</p>
                </div>
            ) : (
                <div className="flex-grow overflow-y-auto custom-scrollbar pr-4">
                    {Object.entries(hashingProgress).length > 0 && (
                        <div className="mb-6">
                            <h2 className="text-2xl font-bold text-white mb-4">Preparing Files...</h2>
                            <div className="grid grid-cols-1 gap-6">
                                {Object.entries(hashingProgress).map(([filePath, percentage]) => (
                                    <div key={filePath} className="bg-gray-700 p-5 rounded-xl shadow-md border border-gray-600">
                                        <div className="flex items-start mb-3">
                                            <span className="text-3xl mr-3 flex-shrink-0">🧮</span>
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-xl font-semibold text-white whitespace-normal break-words">
                                                    {filePath.split('\\').pop() || filePath}
                                                </h3>
                                            </div>
                                        </div>
                                        <div className="flex items-center mb-4">
                                            <p className="text-sm font-medium text-purple-400 capitalize">
                                                Status: Hashing
                                            </p>
                                            <span className="ml-2 text-purple-400 font-bold">{percentage}%</span>
                                        </div>
                                        <div className="w-full bg-gray-600 rounded-full h-2.5 mb-3">
                                            <div
                                                className="bg-purple-500 h-2.5 rounded-full transition-all duration-500 ease-out"
                                                style={{ width: `${percentage}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="grid grid-cols-1 gap-6">
                        {/* Render Grouped Transfers */}
                        {Object.entries(groupedTransfers).map(([parentId, children]) => {
                            const averagePercentage = getAveragePercentage(children);
                            const groupStatus = getGroupStatus(children);
                            const isExpanded = expandedParents[parentId];

                            return (
                                <div key={parentId} className="bg-gray-700 p-5 rounded-xl shadow-md border border-gray-600 hover:border-blue-500 transition-all duration-200 w-full">
                                    <div className="flex items-center justify-between cursor-pointer" onClick={() => toggleParent(parentId)}>
                                        <div className="flex items-start flex-1 min-w-0">
                                            <span className="text-3xl mr-3 flex-shrink-0">
                                                {groupStatus === 'completed' ? '✅' : groupStatus === 'failed' ? '❌' : '📁'} {/* Folder icon for groups */}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-xl font-semibold text-white whitespace-normal break-words">
                                                    Group: {parentId} {/* You might want a better name for the group */}
                                                </h3>
                                                <p className={`text-sm font-medium ${getStatusColor(groupStatus)} capitalize`}>
                                                    Status: {groupStatus}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center ml-4">
                                            <span className="ml-2 text-blue-400 font-bold text-lg">{averagePercentage}%</span>
                                            {/* Replaced Lucide icons with Unicode characters */}
                                            <span className="text-white ml-2 text-xl">
                                                {isExpanded ? '▲' : '▼'}
                                            </span>
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="mt-4 border-t border-gray-600 pt-4 pl-8">
                                            <h4 className="text-lg font-semibold text-white mb-3">Files in this group:</h4>
                                            {children.map(transfer => (
                                                <div key={transfer.fileId} className="bg-gray-600 p-4 rounded-lg mb-3 last:mb-0">
                                                    <div className="flex items-start mb-2">
                                                        <span className="text-2xl mr-2 flex-shrink-0">
                                                            {transfer.status === 'completed' ? '✅' : transfer.status === 'failed' ? '❌' : '⏳'}
                                                        </span>
                                                        <div className="flex-1 min-w-0">
                                                            <h5 className="text-lg font-medium text-white whitespace-normal break-words">
                                                                {transfer.fileName}
                                                            </h5>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center">
                                                        <p className={`text-xs font-medium ${getStatusColor(transfer.status)} capitalize`}>
                                                            Status: {transfer.status}
                                                        </p>
                                                        {transfer.percentage !== undefined && (
                                                            <span className="ml-2 text-blue-300 font-bold text-sm">{transfer.percentage}%</span>
                                                        )}
                                                        {transfer.speedKbps !== undefined && transfer.status === 'in-progress' && (
                                                            <span className="ml-2 text-gray-400 text-xs">({(transfer.speedKbps / 1024).toFixed(2)} MB/s)</span>
                                                        )}
                                                    </div>
                                                    {transfer.status === 'in-progress' && transfer.percentage !== undefined && (
                                                        <div className="w-full bg-gray-500 rounded-full h-2 mt-2">
                                                            <div
                                                                className="bg-blue-400 h-2 rounded-full transition-all duration-500 ease-out"
                                                                style={{ width: `${transfer.percentage}%` }}
                                                            ></div>
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {/* Render Individual Transfers (without parentId) */}
                        {individualTransfers.map(transfer => (
                            <div
                                key={transfer.fileId}
                                className="bg-gray-700 p-5 rounded-xl shadow-md border border-gray-600 hover:border-blue-500 transition-all duration-200 w-full"
                            >
                                <div className="flex items-start mb-3">
                                    <span className="text-3xl mr-3 flex-shrink-0">
                                        {transfer.status === 'completed' ? '✅' : transfer.status === 'failed' ? '❌' : '⏳'}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-xl font-semibold text-white whitespace-normal break-words">
                                            {transfer.fileName}
                                        </h3>
                                    </div>
                                </div>
                                <div className="flex items-center mb-4">
                                    <p className={`text-sm font-medium ${getStatusColor(transfer.status)} capitalize`}>
                                        Status: {transfer.status}
                                    </p>
                                    {transfer.percentage !== undefined && (
                                        <span className="ml-2 text-blue-400 font-bold">{transfer.percentage}%</span>
                                    )}
                                    {transfer.speedKbps !== undefined && transfer.status === 'in-progress' && (
                                        <span className="ml-2 text-gray-400 text-sm">({(transfer.speedKbps / 1024).toFixed(2)} MB/s)</span>
                                    )}
                                </div>

                                {transfer.status === 'in-progress' && transfer.percentage !== undefined && (
                                    <div className="w-full bg-gray-600 rounded-full h-2.5 mb-3">
                                        <div
                                            className="bg-blue-500 h-2.5 rounded-full transition-all duration-500 ease-out"
                                            style={{ width: `${transfer.percentage}%` }}
                                        ></div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};