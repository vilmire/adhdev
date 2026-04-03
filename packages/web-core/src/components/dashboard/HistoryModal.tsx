/**
 * HistoryModal — Chat history modal for Dashboard
 *
 * Displays list of chat sessions, allows switching and creating new sessions.
 */

import type { DaemonData } from '../../types';
import { formatIdeType } from '../../utils/daemon-utils';
import { IconCandle, IconRefresh } from '../Icons';

export interface HistoryModalProps {
    activeConv: {
        ideId: string;
        ideType: string;
        displayPrimary: string;
    };
    ides: DaemonData[];
    isCreatingChat: boolean;
    isRefreshingHistory: boolean;
    onClose: () => void;
    onNewChat: () => void;
    onSwitchSession: (ideId: string, sessionId: string) => void;
    onRefreshHistory: () => void;
}

export default function HistoryModal({
    activeConv, ides, isCreatingChat, isRefreshingHistory,
    onClose, onNewChat, onSwitchSession, onRefreshHistory,
}: HistoryModalProps) {
    const ideEntry = ides.find(i => i.id === activeConv.ideId);
    const chats = ideEntry?.chats || [];
    const activeChatId = (ideEntry as any)?.activeChat?.id;

    return (
        <div className="fixed inset-0 z-[1300] flex items-center justify-center">
            <div onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="card fade-in relative w-[90%] max-w-[500px] max-h-[80vh] flex flex-col p-0 overflow-hidden shadow-[0_20px_40px_rgba(0,0,0,0.4)] rounded-[20px]">
                <div className="px-6 py-5 border-b border-border-subtle flex justify-between items-center bg-[var(--surface-primary)]">
                    <div>
                        <h3 className="m-0 text-lg font-extrabold">Chat History</h3>
                        <div className="text-xs text-text-muted mt-0.5">{activeConv.displayPrimary} — {formatIdeType(activeConv.ideType)}</div>
                    </div>
                    <button onClick={onClose} className="bg-transparent border-none text-xl text-text-muted cursor-pointer">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 bg-bg-primary">
                    <button
                        onClick={onNewChat}
                        disabled={isCreatingChat}
                        className="w-full p-3.5 rounded-xl mb-3 bg-indigo-500/10 border border-dashed border-accent text-accent font-bold text-sm cursor-pointer"
                    >
                        {isCreatingChat ? '⌛ Creating...' : '+ Start New Chat Session'}
                    </button>

                    {chats.map((chat: any) => (
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

                    {chats.length === 0 && (
                        <div className="py-10 px-5 text-center text-text-muted">
                            <div className="text-3xl mb-3 opacity-60"><IconCandle size={32} /></div>
                            <div className="text-[13px]">No recent chat sessions found.</div>
                        </div>
                    )}
                </div>

                <div className="px-5 py-4 bg-[var(--surface-tertiary)] border-t border-border-subtle text-right">
                    <button
                        onClick={onRefreshHistory}
                        disabled={isRefreshingHistory}
                        className="btn btn-secondary btn-sm rounded-[10px]"
                    >
                        {isRefreshingHistory ? '⌛ Refreshing...' : <span className="flex items-center gap-1.5"><IconRefresh size={13} /> Refresh History</span>}
                    </button>
                </div>
            </div>
        </div>
    );
}
