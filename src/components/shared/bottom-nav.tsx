import React from 'react';
import { sidebarItems, SidebarItem } from './sidebar.js';

interface BottomNavProps {
    activeView: SidebarItem['id'];
    setActiveView: (view: SidebarItem['id']) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ activeView, setActiveView }) => (
    <nav className="flex md:hidden border-t border-border-faint bg-canvas flex-shrink-0 safe-bottom">
        {sidebarItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
                <button
                    key={item.id}
                    onClick={() => setActiveView(item.id)}
                    className={`flex items-center justify-center flex-1 py-3 transition-colors
                        ${isActive ? 'text-accent-light' : 'text-content-muted hover:text-content'}`}
                >
                    <Icon className="text-2xl" />
                </button>
            );
        })}
    </nav>
);
