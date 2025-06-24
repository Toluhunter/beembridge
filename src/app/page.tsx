'use client';
import React, { useEffect, useState } from 'react'; // Import useRef for file input
import { PeerView } from '@/components/views/peers';
import { ExplorerView, SelectedFile } from '@/components/views/explorer';
import { TransferHistoryView } from '@/components/views/transfer-history';
import { ActiveTransferView } from '@/components/views/active-transfers';
import { SettingsView } from '@/components/views/settings';

// Define an interface for a Peer object (example)
// Define an interface for the shape of a sidebar item
interface SidebarItem {
  id: 'peers' | 'history' | 'active-transfers' | 'explorer' | 'settings'; // Added 'active-transfers'
  name: string;
  icon: string; // Placeholder for icon
}


// Sidebar Items data
const sidebarItems: SidebarItem[] = [
  { id: 'peers', name: 'Peers', icon: '👥' },
  { id: 'history', name: 'Transfer History', icon: '⚡' },
  { id: 'active-transfers', name: 'Active Transfers', icon: '🔄' }, // New item for active transfers
  { id: 'explorer', name: 'Explorer', icon: '📁' },
  { id: 'settings', name: 'Settings', icon: '⚙️' }, // New settings item
];

// Main App Component
const App = () => {
  const [activeView, setActiveView] = useState<SidebarItem['id']>('peers');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false); // State for sidebar collapse
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [userName, setUserName] = useState("BeemBridge User"); // Made userName mutable
  const [userId, setUserId] = useState("BB_USER_1234567890"); // Made userId mutable

  const handleAddSelectedFiles = (newFiles: SelectedFile[]) => {
    const uniqueNewFiles = newFiles.filter(newFile =>
      !selectedFiles.some(existingFile =>
        existingFile.name === newFile.name && existingFile.size === newFile.size
      )
    );
    setSelectedFiles(prevFiles => [...prevFiles, ...uniqueNewFiles]);
  };

  const handleRemoveSelectedFile = (fileToRemove: SelectedFile) => {
    setSelectedFiles(prevFiles =>
      prevFiles.filter(file =>
        !(file.name === fileToRemove.name && file.size === fileToRemove.size)
      )
    );
  };

  const handleUpdateUserNameInMainProcess = async (newName: string) => {
    if (window.electron) {
      try {
        const success = await window.electron.setUsername(newName);
        if (success) {
          setUserName(newName); // Update local state only if main process confirms success
          console.log("Username updated in store via IPC:", newName);
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to set username via IPC:', error);
        return false;
      }
    }
    console.warn('Electron API not available for setting username.');
    return false;
  };

  const handleGenerateNewUserIdInMainProcess = async () => {
    if (window.electron) {
      try {
        // Assuming you'll add an IPC handler for this in main.ts
        // For now, let's generate client-side and just update the state
        const newId = await window.electron.generateNewUserId(); // This would trigger the main process to generate a new ID
        // const newId = `BB_USER_${crypto.randomUUID().replace(/-/g, '').substring(0, 10).toUpperCase()}`;
        setUserId(newId); // Update local state
        // You'll need to add window.electron.setUserId(newId) and an ipcMain.handle in main.ts
        console.log("New User ID generated locally (add IPC for persistence):", newId);
      } catch (error) {
        console.error('Failed to generate new user ID:', error);
      }
    } else {
      console.warn('Electron API not available for generating user ID.');
    }
  };

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  useEffect(() => {
    // Check if the 'electron' API is available
    if (window.electron) {
      console.log('Electron API is available in the renderer!');
      const loadUsername = async () => {
        try {
          const loadedUsername = await window.electron.getUsername();
          const loadedUserId = await window.electron.getUserId();
          setUserId(loadedUserId);
          setUserName(loadedUsername);
        } catch (error) {
          console.error('Failed to get username:', error);
          setUserName('DefaultUser'); // Fallback
        }
      };
      loadUsername();

      // Start peer discovery when the app loads
    } else {
      console.warn('Electron API is NOT available in the renderer. Are you running in Electron?');
    }
  }, []); // Empty dependency array to run only once on mount

  // Function to simulate opening file explorer
  return (
    <div className="flex h-screen w-screen bg-gray-950 text-white font-inter overflow-hidden">
      {/* Global styles for Inter font and modern aesthetics */}
      {/* Sidebar */}
      <aside
        className={`bg-gray-800 flex flex-col border-r border-gray-800 py-6 px-4 transition-all duration-300 ease-in-out relative
          ${isSidebarCollapsed ? 'w-20 items-center' : 'w-1/5 min-w-[200px] max-w-[250px]'}`
        }
        style={{ boxShadow: '2px 0 10px rgba(0,0,0,0.3)' }} /* Subtle shadow for depth */
      >
        <div className="flex-grow flex flex-col">
          {/* Logo/App Name */}
          <div className={`mb-8 flex ${isSidebarCollapsed ? 'justify-center' : 'justify-between items-center'}`}>
            <h2 className="text-3xl font-extrabold text-white">
              {isSidebarCollapsed ? 'BB' : 'BeemBridge'}
            </h2>
            {/* Sidebar Toggle Button - Moved inside and adjusted positioning */}
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-full shadow-lg text-gray-300 hover:bg-gray-700 focus:outline-none transition-transform duration-300 z-10 bg-gray-800"
              aria-label="Toggle Sidebar"
            >
              {isSidebarCollapsed ? (
                <svg className="w-5 h-5 transform rotate-180" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"></path></svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"></path></svg>
              )}
            </button>
          </div>

          {/* Navigation */}
          <nav className="mt-8">
            <ul>
              {sidebarItems.map((item) => (
                <li key={item.id} className="mb-2">
                  <button
                    onClick={() => setActiveView(item.id)}
                    className={`flex items-center w-full px-4 py-3 rounded-xl text-left transition-colors duration-200
                      ${activeView === item.id
                        ? 'bg-gray-700 text-white border-l-4 border-blue-500'
                        : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                      }
                      ${isSidebarCollapsed ? 'justify-center px-2' : ''}`
                    }
                  >
                    <span className="text-2xl mr-3">{item.icon}</span>
                    {!isSidebarCollapsed && (
                      <span className="font-medium text-lg">{item.name}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* User Profile Info */}
        <div className={`mt-auto pt-6 border-t border-gray-700 ${isSidebarCollapsed ? 'flex flex-col items-center' : ''}`}>
          <div className={`flex items-center ${isSidebarCollapsed ? 'flex-col' : ''}`}>
            {/* Avatar Placeholder */}
            <div className={`w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white text-xl font-bold ${isSidebarCollapsed ? 'mb-2' : 'mr-3'}`}>
              {userName.charAt(0).toUpperCase()}
            </div>
            {!isSidebarCollapsed && (
              <div>
                <p className="text-white font-semibold">{userName}</p>
                <p className="text-gray-400 text-sm break-all">ID: {userId}</p>
              </div>
            )}
            {isSidebarCollapsed && (
              <p className="text-gray-400 text-xs text-center break-all mt-1">{userId.substring(0, 5)}...</p>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 bg-gray-900 p-8 overflow-auto rounded-l-3xl">
        {activeView === 'peers' && (
          <PeerView />
        )}

        {activeView === 'history' && (
          <TransferHistoryView />
        )}

        {activeView === 'active-transfers' && ( // New view for Active Transfers
          <ActiveTransferView />
        )}

        {activeView === 'explorer' && (
          <ExplorerView
            selectedFiles={selectedFiles}
            onAddFiles={handleAddSelectedFiles}
            onRemoveFile={handleRemoveSelectedFile}
          />
        )}

        {activeView === 'settings' && (
          <SettingsView
            currentUserName={userName}
            currentUserId={userId}
            onUpdateUserNameInMainProcess={handleUpdateUserNameInMainProcess}
            onGenerateNewUserId={handleGenerateNewUserIdInMainProcess}
          />
        )}
      </main>
    </div>
  );
};

export default App;
