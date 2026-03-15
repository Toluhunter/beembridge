import React from 'react';
import { FaFile } from 'react-icons/fa';

type Status = 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'hashing';

interface TransferProgressItemProps {
    title: string;
    percentage?: number;
    status?: Status;
    speedKbps?: number;
    icon?: React.ReactNode;
    showCancel?: boolean;
    onCancel?: () => void;
    className?: string;
}

export const TransferProgressItem: React.FC<TransferProgressItemProps> = ({
    title,
    percentage,
    status = 'in-progress',
    speedKbps,
    icon,
    showCancel = false,
    onCancel,
    className = '',
}) => {
    const renderIcon = () => (
        <span className="text-3xl mr-3 flex-shrink-0 text-content-muted">
            {icon ?? <FaFile />}
        </span>
    );

    const showProgressBar = typeof percentage === 'number' && (status === 'in-progress' || status === 'hashing' || status === 'pending');

    return (
        <div className={`group relative p-5 border-b border-border shadow-md transition-all duration-200 w-full ${className}`}>
            <div className="flex items-center justify-between mb-3 w-full">
                <div className="flex items-start min-w-0 flex-1">
                    {renderIcon()}
                    <div className="flex-1 min-w-0">
                        <h3 className="text-xl font-semibold text-content whitespace-normal break-words">
                            {title}
                        </h3>
                        {status === 'hashing' && (
                            <p className="text-xs text-purple-400 mt-1">Status: Hashing</p>
                        )}
                    </div>
                </div>

                {typeof percentage === 'number' && (
                    <div className="ml-4 flex items-center">
                        <span className="font-bold transition-opacity duration-200 group-hover:opacity-0">{Math.round(percentage)}%</span>
                        {showCancel && (
                            <button
                                onClick={onCancel}
                                className="hidden group-hover:inline-flex ml-2 bg-red-600 text-content rounded px-2 py-0.5 text-sm"
                                aria-label={`Cancel ${title}`}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                )}
            </div>

            {typeof speedKbps === 'number' && status === 'in-progress' && (
                <span className="ml-2 text-content-muted text-sm">({(speedKbps / 1024).toFixed(2)} MB/s)</span>
            )}

            {showProgressBar && (
                <div className="w-full bg-muted-fill rounded-full h-2.5 mb-3">
                    <div
                        className={`${status === 'hashing' ? 'bg-purple-500' : 'bg-blue-500'} h-2.5 rounded-full transition-all duration-500 ease-out`}
                        style={{ width: `${Math.max(0, Math.min(100, Math.round(percentage!)))}%` }}
                    ></div>
                </div>
            )}
        </div>
    );
};

export default TransferProgressItem;
