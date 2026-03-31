
/**
 * ChatPane — Non-CLI chat view: message list, model/mode bar, and input area.
 */
import { useRef, useState, useCallback } from 'react';
import ChatMessageList from '../ChatMessageList';
import DashboardModelModeBar from './ModelModeBar';
import { isCliConv, isAcpConv } from './types';
import type { ActiveConversation } from './types';
import type { DaemonData } from '../../types';
import { useTransport } from '../../context/TransportContext';
import { IconPlug, IconEye, IconFolder } from '../Icons';

export interface ChatPaneProps {
    activeConv: ActiveConversation;
    ides: DaemonData[];
    agentInput: string;
    setAgentInput: (v: string | ((prev: string) => string)) => void;
    handleSendChat: () => void;
    handleFocusAgent: () => void;
    isFocusingAgent: boolean;
    messageReceivedAt: Record<string, number>;
    actionLogs: { ideId: string; text: string; timestamp: number }[];
    /** Display name for user messages */
    userName?: string;
}

export default function ChatPane({
    activeConv, ides, agentInput, setAgentInput, handleSendChat,
    handleFocusAgent, isFocusingAgent, messageReceivedAt, actionLogs, userName,
}: ChatPaneProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const { sendCommand } = useTransport();

    // Per-tab history cache — survives tab switches
    interface TabHistoryState { messages: any[]; offset: number; hasMore: boolean; error: string | null }
    const historyCache = useRef<Map<string, TabHistoryState>>(new Map());

    const getTabHistory = useCallback((tabKey: string): TabHistoryState => {
        if (!historyCache.current.has(tabKey)) {
            historyCache.current.set(tabKey, { messages: [], offset: 0, hasMore: true, error: null });
        }
        return historyCache.current.get(tabKey)!;
    }, []);

    const updateTabHistory = useCallback((tabKey: string, patch: Partial<TabHistoryState>) => {
        const prev = getTabHistory(tabKey);
        historyCache.current.set(tabKey, { ...prev, ...patch });
        // Force re-render
        setHistoryTick(t => t + 1);
    }, [getTabHistory]);

    const [, setHistoryTick] = useState(0);

    // Derive current tab state
    const tabKey = activeConv.tabKey;
    const tabHistory = getTabHistory(tabKey);
    const historyMessages = tabHistory.messages;
    const hasMoreHistory = tabHistory.hasMore;
    const loadError = tabHistory.error;

    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore) return;
        const tk = activeConv.tabKey;
        const currentState = getTabHistory(tk);
        setIsLoadingMore(true);
        updateTabHistory(tk, { error: null });
        try {
            const ideEntry = ides.find(i => i.id === activeConv.ideId);
            const daemonId = (ideEntry as any)?.daemonId || activeConv.ideId?.split(':')[0] || '';
            if (!daemonId) {
                updateTabHistory(tk, { hasMore: false });
                return;
            }

            const agentType = activeConv.ideType || activeConv.agentType || '';
            const ideParts = (activeConv.ideId || '').split(':');
            const instanceId = ideParts.length >= 3 ? ideParts.slice(2).join(':') : undefined;

            const raw = await sendCommand(daemonId, 'chat_history', {
                agentType,
                offset: currentState.offset,
                limit: 30,
                instanceId,
            });

            const result = (raw as any)?.result ?? raw;

            if (result.messages?.length > 0) {
                const fresh = getTabHistory(tk);
                updateTabHistory(tk, {
                    messages: [...result.messages, ...fresh.messages],
                    offset: fresh.offset + result.messages.length,
                    hasMore: !!result.hasMore,
                });
            } else {
                updateTabHistory(tk, { hasMore: !!result.hasMore });
            }

        } catch (e: any) {
            const msg = e?.message || '';
            const isTransient = msg.includes('P2P not available')
                || msg.includes('channel not open')
                || msg.includes('P2P not connected')
                || msg.includes('timeout');
            if (!isTransient) {
                updateTabHistory(tk, { hasMore: false, error: 'Failed to load history' });
            } else {
                updateTabHistory(tk, { error: 'Connection not ready — tap to retry' });
            }
        } finally {
            setIsLoadingMore(false);
        }
    }, [isLoadingMore, ides, activeConv, sendCommand, getTabHistory, updateTabHistory]);

    // Merge history + live messages (dedup by content hash)
    const allMessages = (() => {
        const live = activeConv.messages.map((m: any, i: number) => {
            const timeKey = `${activeConv.ideId}-${m.id ?? `i-${i}`}`;
            return { ...m, receivedAt: m.receivedAt || messageReceivedAt[timeKey] || 0 };
        });
        if (historyMessages.length === 0) return live;

        // Dedup: exclude history messages already visible in live feed
        const liveHashes = new Set(live.map((m: any) => `${m.role}:${(m.content || '').slice(0, 100)}`));
        const uniqueHistory = historyMessages.filter(
            m => !liveHashes.has(`${m.role}:${(m.content || '').slice(0, 100)}`)
        );
        return [...uniqueHistory, ...live];
    })();

    return (
        <>
            {/* Message Stream */}
            <ChatMessageList
                messages={allMessages}
                actionLogs={actionLogs
                    .filter(l => l.ideId === activeConv.tabKey)
                    .sort((a, b) => a.timestamp - b.timestamp)}
                agentName={activeConv.agentName || activeConv.displayPrimary || 'Agent'}
                userName={userName}
                isCliMode={isCliConv(activeConv) || isAcpConv(activeConv)}
                isWorking={activeConv.status === 'generating'}
                contextKey={activeConv.tabKey}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                hasMoreHistory={hasMoreHistory}
                loadError={loadError ?? undefined}
                emptyState={
                    activeConv.messages.length === 0 ? (
                        (activeConv.connectionState === 'connecting' || activeConv.connectionState === 'new') ? (
                            <div className="text-center mt-16 flex flex-col items-center gap-4">
                                <div className="connecting-logo-float">
                                    <div style={{
                                        width: 64, height: 64, borderRadius: '50%',
                                        background: 'radial-gradient(circle, rgba(96,165,250,0.12), transparent 70%)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        boxShadow: '0 0 40px rgba(96,165,250,0.08)',
                                    }}>
                                        <img src="/otter-logo.png" alt="ADHDev" style={{ width: 40, height: 40, borderRadius: '50%', opacity: 0.85 }} />
                                    </div>
                                </div>
                                <div className="flex flex-col items-center gap-1.5">
                                    <div className="text-[13px] text-blue-400 font-medium">Connecting to your machine<span className="connecting-dots"></span></div>
                                    <div className="text-[11px] opacity-35">Establishing P2P connection</div>
                                </div>
                            </div>
                        ) : activeConv.status === 'not_monitored' ? (
                            <div className="text-center mt-16 flex flex-col items-center gap-3">
                                <div className="text-3xl opacity-60"><IconPlug size={28} /></div>
                                <div className="text-[13px] opacity-50">Agent not monitored</div>
                                <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                                    {isFocusingAgent ? '⌛ Switching...' : <span className="flex items-center gap-1.5"><IconFolder size={14} /> Open {activeConv.displayPrimary} Panel</span>}
                                </button>
                                <div className="text-[11px] opacity-35 max-w-[280px]">Click to switch monitoring to this agent</div>
                            </div>
                        ) : activeConv.status === 'panel_hidden' ? (
                            <div className="text-center mt-16 flex flex-col items-center gap-3">
                                <div className="text-3xl opacity-60"><IconEye size={28} /></div>
                                <div className="text-[13px] opacity-50">Agent panel is not visible yet</div>
                                <button onClick={handleFocusAgent} disabled={isFocusingAgent} className="btn btn-primary">
                                    {isFocusingAgent ? '⌛ Opening...' : <span className="flex items-center gap-1.5"><IconFolder size={14} /> Open {activeConv.displayPrimary} Panel</span>}
                                </button>
                                <div className="text-[11px] opacity-35 max-w-[280px]">Open the agent panel or chat view in the app you are using to start viewing messages</div>
                            </div>
                        ) : activeConv.status === 'idle' && !isLoadingMore ? (
                            <div className="text-center mt-16 flex flex-col items-center gap-3">
                                <div className="text-2xl opacity-40 animate-pulse">💬</div>
                                <div className="text-[13px] opacity-40">Loading chat...</div>
                            </div>
                        ) : undefined
                    ) : undefined
                }
            />

            {/* Model/Mode Bar */}
            {!isCliConv(activeConv) && (() => {
                const ideEntry = ides.find(i => i.id === activeConv.ideId);
                return (
                    <DashboardModelModeBar
                        ideId={activeConv.ideId}
                        ideType={activeConv.ideType}
                        agentType={activeConv.streamSource === 'agent-stream' ? activeConv.agentType : ((ideEntry as any)?.agents?.[0]?.type || activeConv.ideType)}
                        agentName={activeConv.streamSource === 'agent-stream' ? activeConv.agentName : ((ideEntry as any)?.agents?.[0]?.name || activeConv.agentName)}
                        serverModel={(ideEntry as any)?.currentModel || undefined}
                        serverMode={(ideEntry as any)?.currentPlan || undefined}
                        acpConfigOptions={isAcpConv(activeConv) ? (ideEntry as any)?.acpConfigOptions : undefined}
                        acpModes={isAcpConv(activeConv) ? (ideEntry as any)?.acpModes : undefined}
                    />
                );
            })()}

            {/* Input Area */}
            <div className="dashboard-input-area px-3 py-2.5 bg-[var(--surface-primary)] border-t border-border-subtle shrink-0">
                <div className="flex gap-2.5 items-center">
                    <div className="flex-1 relative">
                        <input
                            ref={chatInputRef}
                            type="text"
                            placeholder={`Send message to ${activeConv.displayPrimary}...`}
                            value={agentInput}
                            onChange={e => setAgentInput(e.target.value)}
                            onPaste={e => {
                                const pasted = e.clipboardData.getData('text');
                                if (pasted) setAgentInput((prev: string) => prev + pasted);
                                e.preventDefault();
                            }}
                            onKeyDown={e => {
                                if (e.key !== 'Enter') return;
                                if (e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    return;
                                }
                                e.preventDefault();
                                handleSendChat();
                            }}
                            onBlur={(e) => {
                                if (window.innerWidth < 768) {
                                    const related = e.relatedTarget as HTMLElement | null;
                                    if (related?.tagName === 'BUTTON') return;
                                    setTimeout(() => {
                                        document.documentElement.scrollTop = 0;
                                    }, 300);
                                }
                            }}
                            className="w-full h-10 rounded-[20px] px-4 bg-bg-secondary text-sm text-text-primary"
                            style={{ border: '1px solid var(--chat-input-border, var(--border-subtle))' }}
                        />
                    </div>
                    <button
                        onClick={handleSendChat}
                        disabled={!agentInput.trim()}
                        className={`w-10 h-10 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                            agentInput.trim() ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                        }`}
                        style={agentInput.trim() ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={agentInput.trim() ? 'text-white' : 'text-text-muted'}>
                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                    </button>
                </div>
            </div>
        </>
    );
}
