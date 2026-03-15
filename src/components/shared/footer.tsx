import React from 'react';
import { CiBellOn } from "react-icons/ci";

export const Footer = () => {
    return (
        <footer className="flex items-center justify-between px-4 py-2 text-content border-t border-border-faint">
            <div className="flex items-center">
                <span className="h-3 w-3 bg-red-500 rounded-full mr-2"></span>
                <span className="text-sm font-medium text-content-muted">Offline</span>
            </div>
            <div className="flex items-center">
                <button className="text-content-muted hover:text-content">
                    <CiBellOn size={24} />
                </button>
            </div>
        </footer>
    );
};
