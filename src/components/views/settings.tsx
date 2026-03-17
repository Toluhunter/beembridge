import React, { useState, useEffect } from 'react';
import { FiUser, FiImage, FiHash, FiFolder, FiChevronRight, FiArrowLeft, FiCode } from 'react-icons/fi';
import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { useAppContext } from '../../context/AppContext.js';

type SubSettingId = 'username' | 'profile-picture' | 'user-id' | 'storage';

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

// ─── Mobile toggle row (no chevron, inline toggle) ────────────────────────────
interface MobileToggleRowProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}
const MobileToggleRow = ({ icon, title, description, checked, onChange }: MobileToggleRowProps) => (
    <div className="md:hidden w-full flex items-center gap-3 px-4 py-3.5">
        <IconBadge>{icon}</IconBadge>
        <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-content">{title}</p>
            <p className="text-xs text-content-muted mt-0.5">{description}</p>
        </div>
        <PillToggle checked={checked} onChange={onChange} />
    </div>
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

// ─── Pill toggle switch ────────────────────────────────────────────────────────
const PillToggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-10 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-card ${
            checked ? 'bg-accent' : 'bg-muted-fill'
        }`}
    >
        <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                checked ? 'translate-x-5' : 'translate-x-1'
            }`}
        />
    </button>
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
export const SettingsView: React.FC = () => {
    const { userName, setUserName, userId, setUserId, storagePath, setStoragePath, mockMode, setMockMode } = useAppContext();

    const [activeSubSetting, setActiveSubSetting] = useState<SubSettingId | null>(null);
    const [showUsernameModal, setShowUsernameModal] = useState(false);
    const [showUserIdConfirm, setShowUserIdConfirm] = useState(false);
    const [tempUserName, setTempUserName] = useState(userName);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const currentPlatform = platform();
    const isMobile = currentPlatform === 'android' || currentPlatform === 'ios';

    useEffect(() => {
        setTempUserName(userName);
    }, [userName]);

    const isDirty = tempUserName.trim() !== '' && tempUserName.trim() !== userName;

    const handleSaveUserName = async () => {
        const trimmed = tempUserName.trim();
        if (!trimmed || trimmed === userName) {
            setTempUserName(userName);
            setShowUsernameModal(false);
            setActiveSubSetting(null);
            return;
        }
        setIsSaving(true);
        setSaveError(null);
        try {
            const saved = await invoke<string>('set_username', { name: trimmed });
            setUserName(saved);
            setShowUsernameModal(false);
            setActiveSubSetting(null);
        } catch (err) {
            console.error('Failed to save username:', err);
            setSaveError('Failed to save. Please try again.');
            setTempUserName(userName);
        } finally {
            setIsSaving(false);
        }
    };

    const handleGenerateId = async () => {
        setIsSaving(true);
        setSaveError(null);
        try {
            const newId = await invoke<number>('generate_user_id');
            setUserId(String(newId));
        } catch (err) {
            console.error('Failed to generate user ID:', err);
            setSaveError('Failed to generate ID.');
        } finally {
            setIsSaving(false);
            setShowUserIdConfirm(false);
            setActiveSubSetting(null);
        }
    };

    const handleSetStoragePath = async () => {
        setIsSaving(true);
        setSaveError(null);
        try {
            const picked = await invoke<string | null>('pick_storage_folder');
            if (picked) {
                const saved = await invoke<string>('set_storage_path', { path: picked });
                setStoragePath(saved);
            }
        } catch (err) {
            console.error('Failed to set storage path:', err);
            setSaveError('Failed to set download location.');
        } finally {
            setIsSaving(false);
        }
    };

    // Truncated values for mobile row hints
    const userIdHint = userId ? userId.slice(0, 8) + '…' : 'Not set';
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
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveUserName(); } }}
                autoFocus
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-4 transition-colors"
                placeholder="Enter username"
            />
            <div className="flex gap-3">
                <button
                    onClick={() => { setTempUserName(userName); setShowUsernameModal(false); }}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-raised hover:bg-muted-fill text-content text-sm font-medium transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSaveUserName}
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
                    disabled={isSaving}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-content text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {isSaving ? 'Generating…' : 'Generate'}
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

                        {activeSubSetting === 'username' && (
                            <>
                                <input
                                    type="text"
                                    value={tempUserName}
                                    onChange={(e) => setTempUserName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSaveUserName(); } }}
                                    className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:ring-2 focus:ring-accent transition-colors"
                                    placeholder="Enter username"
                                    autoFocus
                                />
                                {saveError && <p className="text-xs text-red-400">{saveError}</p>}
                            </>
                        )}

                        {activeSubSetting === 'user-id' && (
                            <div className="bg-card/60 border border-border-subtle/50 rounded-xl px-4 py-3">
                                <p className="text-xs text-content-dim mb-1">Your ID</p>
                                <p className="text-xs font-mono text-content break-all">{userId || 'Not generated'}</p>
                            </div>
                        )}

                        {activeSubSetting === 'storage' && (
                            <>
                                <div className="bg-card/60 border border-border-subtle/50 rounded-xl px-4 py-3">
                                    <p className="text-xs text-content-dim mb-1">Files are saved to</p>
                                    <p className="text-xs font-mono text-content break-all">{storagePath || 'Loading…'}</p>
                                </div>
                                {saveError && <p className="text-xs text-red-400">{saveError}</p>}
                                {isMobile && (
                                    <div className="bg-card/40 border border-border-subtle/30 rounded-xl px-4 py-3">
                                        <p className="text-xs text-content-dim leading-relaxed">
                                            {currentPlatform === 'android'
                                                ? 'Find your files in the device Files app under Android → data → com.beembridge.app → files.'
                                                : 'Find your files in the iOS Files app under the BeemBridge app entry.'}
                                        </p>
                                    </div>
                                )}
                            </>
                        )}

                        {activeSubSetting === 'username' && (
                            <button
                                onClick={() => void handleSaveUserName()}
                                disabled={!isDirty || isSaving}
                                className="w-full modern-button py-3 rounded-xl text-content text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                            >
                                {isSaving ? 'Saving…' : 'Save'}
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
                                disabled={isSaving}
                                className="w-full py-3 rounded-xl border border-red-600/60 text-red-400 text-sm font-medium hover:bg-red-600/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Generate New ID
                            </button>
                        )}

                        {activeSubSetting === 'storage' && !isMobile && (
                            <button
                                onClick={() => void handleSetStoragePath()}
                                disabled={isSaving}
                                className="w-full modern-button py-3 rounded-xl text-content text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                            >
                                {isSaving ? 'Opening…' : 'Change Location'}
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
                        value={userName}
                        onClick={() => setActiveSubSetting('username')}
                    />
                    <DesktopRow icon={<FiUser />} title="Username" description="Your display name shown to peers">
                        <input
                            type="text"
                            value={tempUserName}
                            onChange={(e) => setTempUserName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveUserName(); } }}
                            className="px-3 py-1.5 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:ring-2 focus:ring-accent w-44 transition-colors"
                            placeholder="Enter username"
                        />
                        <button
                            onClick={() => void handleSaveUserName()}
                            disabled={!isDirty || isSaving}
                            className="modern-button px-3 py-1.5 text-content text-sm rounded-lg font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                        >
                            {isSaving ? 'Saving…' : 'Save'}
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
                        <p className="text-xs text-content-dim font-mono truncate max-w-[180px]">{userId || 'Not generated'}</p>
                        <button
                            onClick={() => setShowUserIdConfirm(true)}
                            disabled={isSaving}
                            className="px-3 py-1.5 text-sm rounded-lg border border-border text-content-secondary hover:bg-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                        {!isMobile && (
                            <button
                                onClick={() => void handleSetStoragePath()}
                                disabled={isSaving}
                                className="px-3 py-1.5 text-sm rounded-lg border border-border text-content-secondary hover:bg-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {isSaving ? 'Opening…' : 'Change'}
                            </button>
                        )}
                    </DesktopRow>
                </SectionCard>

                {/* Developer section */}
                <SectionLabel>Developer</SectionLabel>
                <SectionCard>
                    <MobileToggleRow
                        icon={<FiCode />}
                        title="Mock Mode"
                        description="Use simulated peers and transfers for UI testing"
                        checked={mockMode}
                        onChange={setMockMode}
                    />
                    <DesktopRow icon={<FiCode />} title="Mock Mode" description="Use simulated peers and transfers for UI testing">
                        <PillToggle checked={mockMode} onChange={setMockMode} />
                    </DesktopRow>
                </SectionCard>
            </div>

            {/* Modals — outside overflow container so they're not clipped */}
            {showUsernameModal && <UsernameModal />}
            {showUserIdConfirm && <UserIdConfirmModal />}
        </div>
    );
};
