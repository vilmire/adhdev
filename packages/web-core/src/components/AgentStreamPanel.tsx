/**
 * AgentStreamPanel — extension chat streams on IDE detail page
 *
 * Reuses the same ChatPane + ApprovalBanner components as the main Dashboard
 * to maintain visual consistency. Each agent stream is converted to an
 * ActiveConversation and rendered through ChatPane.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import ChatPane from './dashboard/ChatPane';
import ApprovalBanner from './dashboard/ApprovalBanner';
import type { ActiveConversation } from './dashboard/types';
import type { AgentSessionStream } from '../types';
import { deriveStreamConversationStatus, formatIdeType, isGenericAgentTitle } from '../utils/daemon-utils';

type StreamTab = AgentSessionStream & {
    sessionId?: string;
    title?: string;
    parentSessionId?: string | null;
};

interface Props {
    routeId: string;
    agentStreams: StreamTab[];
    sendCommand: (commandType: string, data?: any) => Promise<void>;
}

function getStreamKey(stream: StreamTab): string {
    return stream.sessionId || stream.instanceId || stream.agentType;
}

export default function AgentStreamPanel({ routeId, agentStreams, sendCommand }: Props) {
    const [activeAgent, setActiveAgent] = useState<string | null>(null);
    const [isSending, setIsSending] = useState(false);

    // Auto-select first agent stream
    useEffect(() => {
        if (!activeAgent && agentStreams.length > 0) {
            setActiveAgent(getStreamKey(agentStreams[0]));
        }
    }, [agentStreams, activeAgent]);

    const activeStream = agentStreams.find(s => getStreamKey(s) === activeAgent);

    // Derive status matching Dashboard convention
    const derivedStatus = useMemo(() => {
        if (!activeStream) return 'idle';
        return deriveStreamConversationStatus(activeStream);
    }, [activeStream]);

    // Build ActiveConversation for ChatPane (same format as Dashboard)
    const activeConv: ActiveConversation | null = useMemo(() => {
        if (!activeStream) return null;
        const streamTitle = (activeStream.title && String(activeStream.title).trim()) || '';
        const effectiveStreamTitle = isGenericAgentTitle(streamTitle, activeStream.agentName, activeStream.agentType)
            ? ''
            : streamTitle;
        return {
            routeId,
            agentName: activeStream.agentName,
            agentType: activeStream.agentType,
            status: derivedStatus,
            title: effectiveStreamTitle,
            messages: activeStream.messages.map((m, i: number) => ({
                role: m.role,
                content: m.content,
                kind: m.kind,
                id: `${getStreamKey(activeStream)}-${i}`,
                receivedAt: m.receivedAt,
            })),
            ideType: activeStream.agentType,
            workspaceName: '',
            displayPrimary: effectiveStreamTitle || formatIdeType(activeStream.agentType),
            displaySecondary: '',
            cdpConnected: true,
            modalButtons: activeStream.activeModal?.buttons,
            modalMessage: activeStream.activeModal?.message,
            streamSource: 'agent-stream' as const,
            tabKey: `agent-stream-${getStreamKey(activeStream)}`,
        };
    }, [activeStream, routeId, derivedStatus]);

    const handleSendChat = useCallback(async (rawMessage: string): Promise<boolean> => {
        const message = rawMessage.trim();
        if (!message || !activeAgent || isSending) return false;
        setIsSending(true);
        const targetSessionId = activeStream?.sessionId;
        try {
            await sendCommand('send_chat', {
                agentType: activeAgent,
                message,
                ...(targetSessionId && { targetSessionId }),
            });
            return true;
        } catch (e) {
            console.error('Failed to send agent message', e);
            return false;
        } finally {
            setIsSending(false);
        }
    }, [activeAgent, activeStream, isSending, sendCommand]);

    const handleResolve = useCallback(async (action: 'approve' | 'reject') => {
        if (!activeAgent) return;
        const targetSessionId = activeStream?.sessionId;
        try {
            await sendCommand('resolve_action', {
                agentType: activeAgent,
                action,
                ...(targetSessionId && { targetSessionId }),
            });
        } catch (e) {
            console.error('Failed to resolve agent action', e);
        }
    }, [activeAgent, activeStream, sendCommand]);

    const handleNewSession = useCallback(async () => {
        if (!activeAgent) return;
        const targetSessionId = activeStream?.sessionId;
        try {
            await sendCommand('new_chat', {
                agentType: activeAgent,
                ...(targetSessionId && { targetSessionId }),
            });
        } catch (e) {
            console.error('Failed to start new session', e);
        }
    }, [activeAgent, activeStream, sendCommand]);

    if (agentStreams.length === 0) return null;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Agent Stream Tabs — consistent with dashboard tab style */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle bg-[var(--surface-primary)] overflow-x-auto shrink-0">
                {agentStreams.map(stream => {
                    const streamKey = getStreamKey(stream);
                    const isActive = streamKey === activeAgent;
                    const normalizedStatus = deriveStreamConversationStatus(stream);
                    const isGenerating = normalizedStatus === 'generating';
                    const needsApproval = normalizedStatus === 'waiting_approval';
                    const streamTitle = (stream.title && String(stream.title).trim()) || '';
                    const effectiveStreamTitle = isGenericAgentTitle(streamTitle, stream.agentName, stream.agentType)
                        ? ''
                        : streamTitle;

                    return (
                        <button
                            key={streamKey}
                            onClick={() => setActiveAgent(streamKey)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 border-none rounded-lg text-[12px] whitespace-nowrap cursor-pointer transition-all duration-150 ${
                                isActive
                                    ? 'bg-accent/10 text-accent font-semibold'
                                    : 'bg-transparent text-text-muted hover:bg-bg-secondary'
                            }`}
                        >
                            <span
                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{
                                    background: needsApproval ? 'var(--status-warning)' : isGenerating ? 'var(--accent-primary)' : '#64748b',
                                    boxShadow: isGenerating ? '0 0 6px var(--accent-primary)' : 'none',
                                }}
                            />
                            {effectiveStreamTitle || formatIdeType(stream.agentType)}
                            {needsApproval && (
                                <span className="text-[9px] px-1.5 py-px rounded-full bg-yellow-500/15 text-yellow-500 font-bold">
                                    !
                                </span>
                            )}
                        </button>
                    );
                })}
                <div className="flex-1" />
                <button
                    onClick={handleNewSession}
                    title="New Chat Session"
                    className="px-2.5 py-1 border border-border-subtle bg-transparent text-text-muted rounded-md cursor-pointer text-[11px] hover:bg-bg-secondary transition-colors"
                >
                    + New
                </button>
            </div>

            {/* Active Agent Content — reuses ChatPane + ApprovalBanner */}
            {activeConv ? (
                <>
                    {/* Model/Status info bar */}
                    {activeStream && (activeStream.model || activeStream.status) && (
                        <div className="flex items-center gap-2 px-3.5 py-1.5 text-[11px] text-text-muted border-b border-border-subtle bg-[var(--surface-primary)] shrink-0">
                            {activeStream.model && (
                                <span className="text-text-secondary">
                                    {activeStream.model}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Approval Banner — same as Dashboard */}
                    {activeStream?.activeModal && (
                        <ApprovalBanner
                            activeConv={activeConv}
                            onModalButton={(btn) => handleResolve(btn.toLowerCase().includes('approv') || btn.toLowerCase().includes('accept') || btn.toLowerCase().includes('allow') || btn.toLowerCase().includes('run') || btn.toLowerCase().includes('yes') ? 'approve' : 'reject')}
                        />
                    )}

                    {/* Chat — same ChatPane as Dashboard */}
                    <ChatPane
                        activeConv={activeConv}
                        ideEntry={undefined}
                        handleSendChat={handleSendChat}
                        handleFocusAgent={() => {}}
                        isFocusingAgent={false}
                        actionLogs={[]}
                    />
                </>
            ) : (
                <div className="flex-1 flex items-center justify-center text-text-muted text-[13px] opacity-50">
                    Select an agent tab to view its chat stream.
                </div>
            )}
        </div>
    );
}
