/**
 * HistoryModal — Chat history modal for Dashboard
 *
 * Displays list of chat sessions, allows switching and creating new sessions.
 */

import type { DaemonData } from '../../types';
import { IconCandle, IconRefresh, IconX } from '../Icons';
import { isAcpConv, isCliConv, type ActiveConversation } from './types';
import { createPortal } from 'react-dom';
import { getConversationHistorySubtitle } from './conversation-presenters';

export interface SavedSessionHistoryEntry {
    id: string;
    providerSessionId: string;
    providerType: string;
    providerName: string;
    kind: 'cli' | 'acp';
    title: string;
    workspace?: string | null;
    currentModel?: string;
    preview?: string;
    messageCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    canResume: boolean;
}

function formatSavedSessionTime(timestamp?: number) {
    if (!timestamp) return '';
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleString();
    }
}

export interface HistoryModalProps {
    activeConv: ActiveConversation;
    ides: DaemonData[];
    isCreatingChat: boolean;
    isRefreshingHistory: boolean;
    savedSessions?: SavedSessionHistoryEntry[];
    isSavedSessionsLoading?: boolean;
    isResumingSavedSessionId?: string | null;
    onClose: () => void;
    onNewChat: () => void;
    onSwitchSession: (ideId: string, sessionId: string) => void;
    onRefreshHistory: () => void;
    onResumeSavedSession?: (session: SavedSessionHistoryEntry) => void;
}

export default function HistoryModal({
    activeConv, ides, isCreatingChat, isRefreshingHistory,
    savedSessions = [], isSavedSessionsLoading = false, isResumingSavedSessionId = null,
    onClose, onNewChat, onSwitchSession, onRefreshHistory, onResumeSavedSession,
}: HistoryModalProps) {
    const ideEntry = ides.find(i => i.id === activeConv.ideId);
    const chats = ideEntry?.chats || [];
    const activeChatId = ideEntry?.activeChat?.id;
    const isSavedSessionMode = isCliConv(activeConv) && !isAcpConv(activeConv);

    const content = (
        <div className="fixed inset-0 z-[1300] flex items-center justify-center">
            <div onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="card fade-in relative w-[90%] max-w-[500px] max-h-[80vh] flex flex-col p-0 overflow-hidden shadow-[0_20px_40px_rgba(0,0,0,0.4)] rounded-[20px]">
                <div className="px-6 py-5 border-b border-border-subtle flex justify-between items-center bg-[var(--surface-primary)]">
                    <div>
                        <h3 className="m-0 text-lg font-extrabold">{isSavedSessionMode ? 'Saved Sessions' : 'Chat History'}</h3>
                        <div className="text-xs text-text-muted mt-0.5">{getConversationHistorySubtitle(activeConv)}</div>
                    </div>
                    <button onClick={onClose} className="btn btn-secondary btn-sm rounded-md px-1.5 py-1.5 border-transparent bg-transparent hover:bg-bg-secondary"><IconX size={16} /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 bg-bg-primary">
                    {!isSavedSessionMode && (
                        <button
                            onClick={onNewChat}
                            disabled={isCreatingChat}
                            className="w-full p-3.5 rounded-xl mb-3 bg-indigo-500/10 border border-dashed border-accent text-accent font-bold text-sm cursor-pointer"
                        >
                            {isCreatingChat ? '⌛ Creating...' : '+ Start New Chat Session'}
                        </button>
                    )}

                    {isSavedSessionMode ? (
                        <>
                            {savedSessions.map((session) => {
                                const isActive = activeConv.providerSessionId === session.providerSessionId;
                                const isDisabled = isActive || !session.canResume || !!isResumingSavedSessionId;
                                return (
                                    <button
                                        key={session.id}
                                        type="button"
                                        onClick={() => {
                                            if (isDisabled || !onResumeSavedSession) return;
                                            onResumeSavedSession(session);
                                        }}
                                        disabled={isDisabled}
                                        className={`w-full text-left p-4 rounded-xl mb-2 border transition-all ${
                                            isActive
                                                ? 'bg-[var(--bg-glass-hover)] border-accent'
                                                : 'bg-[var(--surface-secondary)] border-border-subtle'
                                        } ${isDisabled ? 'opacity-70 cursor-default' : 'cursor-pointer hover:border-[var(--accent-primary-light)]'}`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className={`font-bold text-sm mb-1 truncate ${
                                                    isActive ? 'text-[var(--accent-primary-light)]' : 'text-text-primary'
                                                }`}>
                                                    {session.title || 'Untitled Session'}
                                                </div>
                                                <div className="text-[11px] text-text-muted font-mono truncate">
                                                    {session.providerSessionId}
                                                </div>
                                            </div>
                                            <div className="text-[11px] text-text-muted shrink-0">
                                                {formatSavedSessionTime(session.lastMessageAt)}
                                            </div>
                                        </div>
                                        <div className="mt-2 text-[12px] text-text-muted line-clamp-2">
                                            {session.preview || 'No saved preview yet'}
                                        </div>
                                        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-text-muted">
                                            <div className="truncate">
                                                {session.workspace || 'Workspace unknown'}
                                                {session.currentModel ? ` · ${session.currentModel}` : ''}
                                                {session.messageCount > 0 ? ` · ${session.messageCount} msgs` : ''}
                                            </div>
                                            <div className="shrink-0">
                                                {isActive
                                                    ? 'ACTIVE'
                                                    : !session.canResume
                                                        ? 'MISSING WORKSPACE'
                                                        : isResumingSavedSessionId === session.providerSessionId
                                                            ? 'RESUMING...'
                                                            : 'RESUME'}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </>
                    ) : chats.map((chat: any) => (
                        <div
                            key={chat.id}
                            onClick={() => { onSwitchSession(activeConv.ideId, chat.id); onClose(); }}
                            className={`p-4 rounded-xl mb-2 cursor-pointer border transition-all ${
                                activeChatId === chat.id
                                    ? 'bg-[var(--bg-glass-hover)] border-accent'
                                    : 'bg-[var(--surface-secondary)] border-border-subtle'
                            }`}
                        >
                            <div className={`font-bold text-sm mb-1 ${
                                activeChatId === chat.id ? 'text-[var(--accent-primary-light)]' : 'text-text-primary'
                            }`}>
                                {chat.title || 'Untitled Session'}
                            </div>
                            <div className="flex justify-between items-center">
                                <div className="text-[11px] text-text-muted font-mono">{chat.id.substring(0, 12)}...</div>
                                {activeChatId === chat.id && (
                                    <span className="text-[10px] bg-accent text-white px-2 py-0.5 rounded-[10px] font-extrabold">ACTIVE</span>
                                )}
                            </div>
                        </div>
                    ))}

                    {((isSavedSessionMode && !isSavedSessionsLoading && savedSessions.length === 0) || (!isSavedSessionMode && chats.length === 0)) && (
                        <div className="py-10 px-5 text-center text-text-muted">
                            <div className="text-3xl mb-3 opacity-60"><IconCandle size={32} /></div>
                            <div className="text-[13px]">
                                {isSavedSessionMode ? 'No saved sessions found yet.' : 'No recent chat sessions found.'}
                            </div>
                        </div>
                    )}
                    {isSavedSessionMode && isSavedSessionsLoading && (
                        <div className="py-10 px-5 text-center text-text-muted">
                            <div className="text-[13px]">Refreshing saved sessions…</div>
                        </div>
                    )}
                </div>

                <div className="px-5 py-4 bg-[var(--surface-tertiary)] border-t border-border-subtle text-right">
                    <button
                        onClick={onRefreshHistory}
                        disabled={isRefreshingHistory || isSavedSessionsLoading}
                        className="btn btn-secondary btn-sm rounded-[10px]"
                    >
                        {(isRefreshingHistory || isSavedSessionsLoading)
                            ? '⌛ Refreshing...'
                            : <span className="flex items-center gap-1.5"><IconRefresh size={13} /> {isSavedSessionMode ? 'Refresh Sessions' : 'Refresh History'}</span>}
                    </button>
                </div>
            </div>
        </div>
    );

    if (typeof document === 'undefined') return content;
    return createPortal(content, document.body);
}
