import React, { useState, useEffect } from 'react';
import { FiUser, FiImage, FiHash, FiFolder, FiChevronRight, FiArrowLeft } from 'react-icons/fi';

type SubSettingId = 'username' | 'profile-picture' | 'user-id' | 'storage';

interface SettingsViewProps {
    currentUserName: string;
    currentUserId: string;
    storagePath: string;
    onUpdateUserNameInMainProcess: (newName: string) => Promise<boolean>;
    onGenerateNewUserId: () => Promise<void>;
    onSetStoragePath: () => Promise<void>;
}

// ─── Shared icon badge ────────────────────────────────────────────────────────
const IconBadge = ({ children }: { children: React.ReactNode }) => (
    <div className="p-2 bg-accent-dim rounded-lg text-accent-light text-xl flex-shrink-0">
        {children}
    </div>
);

// ─── Mobile-only row (hidden on md+) ─────────────────────────────────────────
interface MobileRowProps {
    icon: React.ReactNode;
    title: string;
    value: string;
    onClick: () => void;
}
const MobileRow = ({ icon, title, value, onClick }: MobileRowProps) => (
    <button
        onClick={onClick}
        className="md:hidden w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-raised/40 transition-colors"
    >
        <IconBadge>{icon}</IconBadge>
        <span className="flex-1 text-sm font-medium text-content">{title}</span>
        <span className="text-xs text-content-muted mr-1 max-w-[120px] truncate">{value}</span>
        <FiChevronRight className="text-content-dim flex-shrink-0" />
    </button>
);

// ─── Desktop-only row (hidden on <md) ────────────────────────────────────────
interface DesktopRowProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    children: React.ReactNode;
}
const DesktopRow = ({ icon, title, description, children }: DesktopRowProps) => (
    <div className="hidden md:flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-6 px-5 py-4">
        <div className="flex items-center gap-4 min-w-0">
            <IconBadge>{icon}</IconBadge>
            <div>
                <p className="text-sm font-medium text-content">{title}</p>
                <p className="text-xs text-content-muted mt-0.5">{description}</p>
            </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
            {children}
        </div>
    </div>
);

// ─── Section group label ──────────────────────────────────────────────────────
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <h2 className="text-xs font-semibold text-content-dim uppercase tracking-widest mb-2 px-1">
        {children}
    </h2>
);

// ─── Section card ─────────────────────────────────────────────────────────────
const SectionCard = ({ children }: { children: React.ReactNode }) => (
    <div className="bg-card/50 border border-border-subtle/60 rounded-xl divide-y divide-border-subtle/50 mb-6 overflow-hidden">
        {children}
    </div>
);

// ─── Modal overlay (bottom-sheet on mobile, centered on sm+) ─────────────────
const ModalOverlay = ({ children }: { children: React.ReactNode }) => (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-end sm:items-center justify-center">
        <div className="bg-card w-full rounded-t-3xl sm:rounded-2xl sm:max-w-sm p-6 shadow-2xl border border-border-subtle/40">
            {children}
        </div>
    </div>
);

// ─── Detail page titles / descriptions / meta ─────────────────────────────────
const DETAIL_META: Record<SubSettingId, { title: string; description: string }> = {
    'username': {
        title: 'Username',
        description: 'Your display name shown to other peers when they discover or connect to you.',
    },
    'profile-picture': {
        title: 'Profile Picture',
        description: 'Upload a picture to help peers recognise you. This feature is coming soon.',
    },
    'user-id': {
        title: 'User ID',
        description: 'Your unique network identifier. Generating a new ID will disconnect you from all current peers and cannot be undone.',
    },
    'storage': {
        title: 'Download Location',
        description: 'The folder where received files are saved on this device.',
    },
};

// ─── Main component ───────────────────────────────────────────────────────────
export const SettingsView: React.FC<SettingsViewProps> = ({
    currentUserName,
    currentUserId,
    storagePath,
    onUpdateUserNameInMainProcess,
    onGenerateNewUserId,
    onSetStoragePath,
}) => {
    const [activeSubSetting, setActiveSubSetting] = useState<SubSettingId | null>(null);
    const [showUsernameModal, setShowUsernameModal] = useState(false);
    const [showUserIdConfirm, setShowUserIdConfirm] = useState(false);
    const [tempUserName, setTempUserName] = useState(currentUserName);

    useEffect(() => {
        setTempUserName(currentUserName);
    }, [currentUserName]);

    const isDirty = tempUserName.trim() !== '' && tempUserName.trim() !== currentUserName;

    const handleSaveUserName = async () => {
        const trimmedName = tempUserName.trim();
        if (trimmedName !== '' && trimmedName !== currentUserName) {
            try {
                const success = await onUpdateUserNameInMainProcess(trimmedName);
                if (!success) console.error('Failed to save username.');
            } catch (error) {
                console.error('Error saving username:', error);
            }
        } else {
            setTempUserName(currentUserName);
        }
        setShowUsernameModal(false);
    };

    const handleGenerateId = async () => {
        await onGenerateNewUserId();
        setShowUserIdConfirm(false);
        setActiveSubSetting(null);
    };

    // Truncated values for mobile row hints
    const userIdHint = currentUserId ? currentUserId.slice(0, 8) + '…' : 'Not set';
    const storageHint = storagePath
        ? (storagePath.split(/[\\/]/).filter(Boolean).pop() ?? storagePath)
        : 'Not set';

    // ── Username modal ──────────────────────────────────────────────────────
    const UsernameModal = () => (
        <ModalOverlay>
            <h2 className="text-lg font-semibold text-content mb-4">Change Username</h2>
            <input
                type="text"
                value={tempUserName}
                onChange={(e) => setTempUserName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSaveUserName(); } }}
                autoFocus
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-4 transition-colors"
                placeholder="Enter username"
            />
            <div className="flex gap-3">
                <button
                    onClick={() => { setTempUserName(currentUserName); setShowUsernameModal(false); }}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-raised hover:bg-muted-fill text-content text-sm font-medium transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={() => void handleSaveUserName()}
                    disabled={!isDirty}
                    className="flex-1 modern-button px-4 py-2.5 rounded-xl text-content text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                >
                    Save
                </button>
            </div>
        </ModalOverlay>
    );

    // ── User ID confirm modal ───────────────────────────────────────────────
    const UserIdConfirmModal = () => (
        <ModalOverlay>
            <h2 className="text-lg font-semibold text-content mb-2">Generate New ID?</h2>
            <p className="text-sm text-content-muted mb-6">
                This will disconnect you from all current peers and cannot be undone.
            </p>
            <div className="flex gap-3">
                <button
                    onClick={() => setShowUserIdConfirm(false)}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-raised hover:bg-muted-fill text-content text-sm font-medium transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={() => void handleGenerateId()}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-content text-sm font-medium transition-colors"
                >
                    Generate
                </button>
            </div>
        </ModalOverlay>
    );

    // ── A: Mobile detail sub-page ───────────────────────────────────────────
    if (activeSubSetting !== null) {
        const meta = DETAIL_META[activeSubSetting];
        return (
            <>
                <div className="flex flex-col h-full bg-canvas">
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-4 border-b border-border-subtle/40 flex-shrink-0">
                        <button
                            onClick={() => setActiveSubSetting(null)}
                            className="p-1 -ml-1 rounded-lg hover:bg-raised transition-colors"
                            aria-label="Back"
                        >
                            <FiArrowLeft className="text-xl text-content" />
                        </button>
                        <h1 className="text-lg font-semibold text-content">{meta.title}</h1>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
                        <p className="text-sm text-content-muted leading-relaxed">{meta.description}</p>

                        {/* Current value display */}
                        {activeSubSetting === 'username' && (
                            <div className="bg-card/60 border border-border-subtle/50 rounded-xl px-4 py-3">
                                <p className="text-xs text-content-dim mb-1">Current</p>
                                <p className="text-base font-medium text-content">{currentUserName}</p>
                            </div>
                        )}

                        {activeSubSetting === 'user-id' && (
                            <div className="bg-card/60 border border-border-subtle/50 rounded-xl px-4 py-3">
                                <p className="text-xs text-content-dim mb-1">Your ID</p>
                                <p className="text-xs font-mono text-content break-all">{currentUserId || 'Not generated'}</p>
                            </div>
                        )}

                        {activeSubSetting === 'storage' && (
                            <div className="bg-card/60 border border-border-subtle/50 rounded-xl px-4 py-3">
                                <p className="text-xs text-content-dim mb-1">Current path</p>
                                <p className="text-xs font-mono text-content break-all">{storagePath || 'Not set'}</p>
                            </div>
                        )}

                        {/* Action button */}
                        {activeSubSetting === 'username' && (
                            <button
                                onClick={() => setShowUsernameModal(true)}
                                className="w-full modern-button py-3 rounded-xl text-content text-sm font-medium"
                            >
                                Change Username
                            </button>
                        )}

                        {activeSubSetting === 'profile-picture' && (
                            <button
                                disabled
                                className="w-full py-3 rounded-xl border border-border-subtle text-content-dim text-sm font-medium cursor-not-allowed"
                            >
                                Upload (Coming Soon)
                            </button>
                        )}

                        {activeSubSetting === 'user-id' && (
                            <button
                                onClick={() => setShowUserIdConfirm(true)}
                                className="w-full py-3 rounded-xl border border-red-600/60 text-red-400 text-sm font-medium hover:bg-red-600/10 transition-colors"
                            >
                                Generate New ID
                            </button>
                        )}

                        {activeSubSetting === 'storage' && (
                            <button
                                onClick={() => void onSetStoragePath()}
                                className="w-full modern-button py-3 rounded-xl text-content text-sm font-medium"
                            >
                                Change Location
                            </button>
                        )}
                    </div>
                </div>

                {showUsernameModal && <UsernameModal />}
                {showUserIdConfirm && <UserIdConfirmModal />}
            </>
        );
    }

    // ── B: Main settings list ───────────────────────────────────────────────
    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-4 md:p-6">
                <h1 className="text-2xl md:text-4xl font-bold text-content mb-6 md:mb-8">Settings</h1>

                {/* Profile section */}
                <SectionLabel>Profile</SectionLabel>
                <SectionCard>
                    <MobileRow
                        icon={<FiUser />}
                        title="Username"
                        value={currentUserName}
                        onClick={() => setActiveSubSetting('username')}
                    />
                    <DesktopRow icon={<FiUser />} title="Username" description="Your display name shown to peers">
                        <input
                            type="text"
                            value={tempUserName}
                            onChange={(e) => setTempUserName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSaveUserName(); } }}
                            className="px-3 py-1.5 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:ring-2 focus:ring-accent w-44 transition-colors"
                            placeholder="Enter username"
                        />
                        <button
                            onClick={() => void handleSaveUserName()}
                            disabled={!isDirty}
                            className="modern-button px-3 py-1.5 text-content text-sm rounded-lg font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                        >
                            Save
                        </button>
                    </DesktopRow>

                    <MobileRow
                        icon={<FiImage />}
                        title="Profile Picture"
                        value="Coming Soon"
                        onClick={() => setActiveSubSetting('profile-picture')}
                    />
                    <DesktopRow icon={<FiImage />} title="Profile Picture" description="Upload a picture to identify yourself to peers">
                        <button
                            disabled
                            className="px-3 py-1.5 text-sm rounded-lg border border-border-subtle text-content-dim cursor-not-allowed"
                        >
                            Upload (Coming Soon)
                        </button>
                    </DesktopRow>
                </SectionCard>

                {/* Identity section */}
                <SectionLabel>Identity</SectionLabel>
                <SectionCard>
                    <MobileRow
                        icon={<FiHash />}
                        title="User ID"
                        value={userIdHint}
                        onClick={() => setActiveSubSetting('user-id')}
                    />
                    <DesktopRow icon={<FiHash />} title="User ID" description="Your unique network identifier">
                        <p className="text-xs text-content-dim font-mono truncate max-w-[180px]">{currentUserId || 'Not generated'}</p>
                        <button
                            onClick={() => setShowUserIdConfirm(true)}
                            className="px-3 py-1.5 text-sm rounded-lg border border-border text-content-secondary hover:bg-raised transition-colors"
                        >
                            Generate New
                        </button>
                    </DesktopRow>
                </SectionCard>

                {/* Storage section */}
                <SectionLabel>Storage</SectionLabel>
                <SectionCard>
                    <MobileRow
                        icon={<FiFolder />}
                        title="Download Location"
                        value={storageHint}
                        onClick={() => setActiveSubSetting('storage')}
                    />
                    <DesktopRow icon={<FiFolder />} title="Download Location" description="Where received files are saved">
                        <p className="text-xs text-content-dim font-mono truncate max-w-[180px]">{storagePath || 'Not set'}</p>
                        <button
                            onClick={() => void onSetStoragePath()}
                            className="px-3 py-1.5 text-sm rounded-lg border border-border text-content-secondary hover:bg-raised transition-colors"
                        >
                            Change
                        </button>
                    </DesktopRow>
                </SectionCard>
            </div>

            {/* Modals — outside overflow container so they're not clipped */}
            {showUsernameModal && <UsernameModal />}
            {showUserIdConfirm && <UserIdConfirmModal />}
        </div>
    );
};
