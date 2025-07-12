import { useEffect, useState } from "react"

export type Progress = {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number; // Optional: speed calculation
}

export const ActiveTransferView: React.FC = () => {
    // Define an internal interface that extends Progress to include the display status
    interface ActiveTransferDisplayItem extends Progress {
        status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled';
    }

    const [activeTransfers, setActiveTransfers] = useState<ActiveTransferDisplayItem[]>([]);

    useEffect(() => {
        if (window.electron) {
            // Start listening for progress updates
            const unsubscribe = window.electron.onProgressUpdate((_event, progress) => {

                setActiveTransfers(prevTransfers => {
                    const existingIndex = prevTransfers.findIndex(t => t.fileId === progress.fileId);

                    let derivedStatus: ActiveTransferDisplayItem['status'] = 'in-progress';
                    if (progress.percentage === 100) {
                        derivedStatus = 'completed';
                    } else if (progress.percentage === -1) { // Assuming -1 or some specific value indicates failure
                        derivedStatus = 'failed';
                    } else if (progress.percentage === 0 && progress.transferredBytes === 0) {
                        derivedStatus = 'pending';
                    }

                    const updatedDisplayItem: ActiveTransferDisplayItem = { ...progress, status: derivedStatus };

                    if (existingIndex > -1) {
                        // Update existing transfer
                        const updatedTransfers = [...prevTransfers];
                        updatedTransfers[existingIndex] = updatedDisplayItem;
                        return updatedTransfers;
                    } else {
                        // Add new transfer
                        return [...prevTransfers, updatedDisplayItem];
                    }
                });
            });

            // Stop listening for progress updates when the component unmounts
            return () => {
                unsubscribe();
            };
        } else {
            console.warn('Electron API not available. Are you running in Electron?');
        }
    }, []);

    const getStatusColor = (status: ActiveTransferDisplayItem['status']) => {
        switch (status) {
            case 'completed': return 'text-green-500';
            case 'failed': return 'text-red-500';
            case 'in-progress': return 'text-blue-500';
            case 'pending': return 'text-yellow-500';
            case 'cancelled': return 'text-gray-400'; // Assuming a cancelled state might also be passed
            default: return 'text-gray-300';
        }
    };

    return (
        <div className="p-6 bg-gray-800 rounded-xl shadow-lg h-full flex flex-col">
            <h1 className="text-3xl font-bold text-white mb-6">Active Transfers</h1>

            {activeTransfers.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                    <p className="text-gray-400 text-lg">No active transfers at the moment.</p>
                </div>
            ) : (
                <div className="flex-grow overflow-y-auto custom-scrollbar pr-4">
                    <div className="grid grid-cols-1 gap-6"> {/* Changed to grid-cols-1 for full width */}
                        {activeTransfers.map(transfer => (
                            <div
                                key={transfer.fileId}
                                className="bg-gray-700 p-5 rounded-xl shadow-md border border-gray-600 hover:border-blue-500 transition-all duration-200 w-full" /* Added w-full */
                            >
                                <div className="flex items-start mb-3"> {/* Changed to items-start for better wrapping alignment */}
                                    <span className="text-3xl mr-3 flex-shrink-0"> {/* Added flex-shrink-0 to prevent icon from shrinking */}
                                        {transfer.status === 'completed' ? '✅' : transfer.status === 'failed' ? '❌' : '⏳'}
                                    </span>
                                    {/* Removed truncate, added whitespace-normal and break-words for wrapping */}
                                    <div className="flex-1 min-w-0"> {/* Added min-w-0 to allow content to shrink within flex container */}
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

                                {/* Progress bar already has w-full */}
                                {transfer.status === 'in-progress' && transfer.percentage !== undefined && (
                                    <div className="w-full bg-gray-600 rounded-full h-2.5 mb-3">
                                        <div
                                            className="bg-blue-500 h-2.5 rounded-full transition-all duration-500 ease-out"
                                            style={{ width: `${transfer.percentage}%` }}
                                        ></div>
                                    </div>
                                )}

                                {/* You might want to add a timestamp if available in the progress object */}
                                {/* <p className="text-gray-500 text-xs">Started: {transfer.timestamp}</p> */}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};