import React from 'react';
import { IconType } from 'react-icons';
import { SlPeople } from "react-icons/sl";
import { BiTransfer } from "react-icons/bi";
import { FaRegFolderOpen } from "react-icons/fa";
import { FaHistory } from "react-icons/fa";
import { CiSettings } from "react-icons/ci";
import { TbLayoutSidebarLeftCollapseFilled as CollapseIcon, TbLayoutSidebarRightCollapseFilled } from "react-icons/tb";

export interface SidebarItem {
    id: 'peers' | 'history' | 'active-transfers' | 'explorer' | 'settings';
    name: string;
    icon: IconType;
}

export const sidebarItems: SidebarItem[] = [
    { id: 'peers', name: 'Peers', icon: SlPeople },
    { id: 'history', name: 'Transfer History', icon: FaHistory },
    { id: 'active-transfers', name: 'Active Transfers', icon: BiTransfer },
    { id: 'explorer', name: 'Explorer', icon: FaRegFolderOpen },
    { id: 'settings', name: 'Settings', icon: CiSettings },
];

interface SidebarProps {
    isSidebarCollapsed: boolean;
    toggleSidebar: () => void;
    activeView: SidebarItem['id'];
    setActiveView: (view: SidebarItem['id']) => void;
    userName: string;
    userId: string;
    logoBb: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
    isSidebarCollapsed,
    toggleSidebar,
    activeView,
    setActiveView,
    userName,
    logoBb,
}) => {
    return (
        <aside
            className={`flex flex-col border-r border-border-faint transition-all duration-300 ease-in-out`}
            style={{
                width: isSidebarCollapsed ? '4rem' : '14rem',
                boxShadow: '2px 0 10px rgba(0,0,0,0.3)',
            }}
        >
            {/* Header */}
            {isSidebarCollapsed ? (
                /* Collapsed header — logo always visible, expand button overlays on CSS hover */
                <div className="group relative flex items-center justify-center h-14 flex-shrink-0">
                    <img src={logoBb} alt="BB" className="h-7 w-7 transition-opacity duration-150 group-hover:opacity-0" />
                    <button
                        onClick={toggleSidebar}
                        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 text-content-dim hover:text-content"
                        aria-label="Expand Sidebar"
                    >
                        <TbLayoutSidebarRightCollapseFilled size={17} />
                    </button>
                </div>
            ) : (
                /* Expanded header — logo + app name + collapse button */
                <div className="flex items-center justify-between px-3 h-14 flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <img src={logoBb} alt="BeemBridge" className="h-7 w-7 flex-shrink-0" />
                        <span className="text-base font-semibold text-content truncate">BeemBridge</span>
                    </div>
                    <button
                        onClick={toggleSidebar}
                        className="p-1.5 rounded-md text-content-dim hover:bg-raised hover:text-content transition-colors flex-shrink-0"
                        aria-label="Collapse Sidebar"
                    >
                        <CollapseIcon size={17} />
                    </button>
                </div>
            )}

            {/* Navigation */}
            <nav className="flex-1 mt-5 px-2 flex flex-col min-h-[30vh]">
                <ul className="flex-1 flex flex-col gap-10">
                    {sidebarItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeView === item.id;
                        return (
                            <li key={item.id} className="group relative">
                                <button
                                    onClick={() => setActiveView(item.id)}
                                    className={`flex items-center w-full px-3 py-2 rounded-lg text-left transition-colors duration-150
                                        ${isActive
                                            ? isSidebarCollapsed
                                                ? 'border-l-4 border-purple-600 text-content bg-purple-700/10 rounded-none'
                                                : 'bg-purple-700/80 text-content'
                                            : 'text-content-muted hover:text-content hover:bg-raised/60'
                                        }
                                        ${isSidebarCollapsed ? 'justify-center px-0' : ''}`
                                    }
                                >
                                    <span className={`text-xl flex-shrink-0 ${isActive ? 'text-content' : 'text-content-muted group-hover:text-content'}`}>
                                        <Icon className="stroke-1" />
                                    </span>
                                    {!isSidebarCollapsed && (
                                        <span className="text-sm font-medium ml-3">{item.name}</span>
                                    )}
                                </button>

                                {/* Tooltip when collapsed */}
                                {isSidebarCollapsed && (
                                    <span className="absolute left-full ml-2 px-2 py-1 min-w-max rounded-md shadow-md text-content bg-card text-xs font-medium transition-all duration-100 scale-0 group-hover:scale-100 origin-left z-50">
                                        {item.name}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </nav>

            {/* Footer — compact user info */}
            <div className="mt-auto px-3 py-3 border-t border-border-subtle/40 flex-shrink-0">
                <div className={`flex items-center gap-2 ${isSidebarCollapsed ? 'justify-center' : ''}`}>
                    <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center text-content text-xs font-bold flex-shrink-0">
                        {userName.charAt(0).toUpperCase()}
                    </div>
                    {!isSidebarCollapsed && (
                        <span className="text-sm font-medium text-content truncate">{userName}</span>
                    )}
                </div>
            </div>
        </aside >
    );
};
