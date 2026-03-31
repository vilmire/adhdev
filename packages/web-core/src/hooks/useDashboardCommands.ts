/**
 * useDashboardCommands — Dashboard business logic (command handlers)
 *
 * Extracted from Dashboard.tsx to reduce component complexity.
 * All daemon command handlers: sendChat, newChat, switchSession, etc.
 */
import { useState, useCallback, useRef } from 'react'
import type { DaemonData } from '../types'
import type { ActiveConversation } from '../components/dashboard/types'
import { isCliConv, isAcpConv } from '../components/dashboard/types'


type Toast = { id: number; message: string; type: 'success' | 'info' | 'warning'; timestamp: number; targetKey?: string }

interface UseDashboardCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    ides: DaemonData[]
    updateIdeChats: (ideId: string, chats: DaemonData['chats']) => void
    setToasts: React.Dispatch<React.SetStateAction<Toast[]>>
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, any[]>>>
    setClearedTabs: React.Dispatch<React.SetStateAction<Record<string, number>>>
    setActionLogs: React.Dispatch<React.SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    pinTab: (tabKey: string, delays: number[]) => void
    isStandalone: boolean
}

export function useDashboardCommands({
    sendDaemonCommand,
    activeConv,
    ides: _ides,
    updateIdeChats,
    setToasts,
    setLocalUserMessages,
    setClearedTabs,
    setActionLogs,
    pinTab,
    isStandalone,
}: UseDashboardCommandsOptions) {
    const [agentInput, setAgentInput] = useState('')
    const [isCreatingChat, setIsCreatingChat] = useState(false)
    const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)
    const [isFocusingAgent, setIsFocusingAgent] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const sendInFlightRef = useRef(false)

    const getProviderArgs = useCallback((conv: ActiveConversation | undefined) => {
        if (!conv) return {};
        const targetSessionId = conv.sessionId ? { targetSessionId: conv.sessionId } : {};
        if (isCliConv(conv) || isAcpConv(conv)) {
            return { ...targetSessionId, agentType: conv.agentType || conv.ideType };
        }
        if (conv.streamSource === 'agent-stream') {
            return { ...targetSessionId, agentType: conv.agentType };
        }
        return targetSessionId;
    }, [])

    const handleSendChat = useCallback(async () => {
        if (!activeConv) return
        const message = agentInput.trim()
        if (!message || sendInFlightRef.current) return
        const targetIde = activeConv.ideId
        const tabKey = activeConv.tabKey
        sendInFlightRef.current = true
        setIsSendingChat(true)
        setAgentInput('')

        // Prevent tab reset from WS/P2P updates during message send
        pinTab(tabKey, [100, 500, 1500, 3000]);

        // Optimistic: Add user message
        const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const userMsg = { role: 'user', content: message, timestamp: Date.now(), _localId: localId };
        setLocalUserMessages(prev => ({
            ...prev,
            [tabKey]: [...(prev[tabKey] || []), userMsg],
        }));

        try {
            const routeTarget = targetIde || activeConv.daemonId || ''
            if (!routeTarget) return
            await sendDaemonCommand(routeTarget, 'send_chat', {
                message,
                text: message,
                ...getProviderArgs(activeConv),
            })
            // Cleanup stale local messages after 60s
            setTimeout(() => {
                const cutoff = Date.now() - 60000;
                setLocalUserMessages(prev => {
                    const msgs = prev[tabKey];
                    if (!msgs) return prev;
                    const filtered = msgs.filter(m => m.timestamp > cutoff);
                    if (filtered.length === msgs.length) return prev;
                    return { ...prev, [tabKey]: filtered };
                });
            }, 60000);
        } catch (e) {
            console.error('Send failed', e)
            setAgentInput(message)
            setLocalUserMessages(prev => ({
                ...prev,
                [tabKey]: (prev[tabKey] || []).filter(m => m._localId !== localId),
            }));
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, agentInput, sendDaemonCommand, setLocalUserMessages, pinTab, getProviderArgs])

    const handleRelaunch = useCallback(async () => {
        if (!activeConv) return;
        try {
            if (isStandalone) {
                await sendDaemonCommand(activeConv.ideId, 'launch_ide', {
                    ideType: activeConv.ideType,
                    enableCdp: true,
                });
            } else {
                await sendDaemonCommand(activeConv.ideId, 'vscode_command_exec', {
                    commandId: 'adhdev.relaunchWithCdp',
                    args: [{ force: true }]
                });
            }
        } catch (e) {
            console.error('Relaunch failed', e);
        }
    }, [activeConv, isStandalone, sendDaemonCommand])

    const handleLaunchIde = useCallback(async (ideType: string) => {
        try {
            await sendDaemonCommand('standalone', 'launch_ide', {
                ideType,
                enableCdp: true,
            });
        } catch (e) {
            console.error('Launch failed', e);
        }
    }, [sendDaemonCommand])

    const handleModalButton = useCallback(async (buttonText: string) => {
        if (!activeConv) return
        console.log('[ModalButton] ideId:', activeConv.ideId, 'button:', buttonText);
        setActionLogs(prev => [...prev, {
            ideId: activeConv.tabKey,
            text: `🖱️ **${buttonText}** clicked`,
            timestamp: Date.now(),
        }])
        try {
            const buttons = activeConv.modalButtons || [];
            const buttonIndex = buttons.indexOf(buttonText);
            const clean = buttonText.replace(/[⌥⏎⇧⌫⌘⌃]/g, '').trim().toLowerCase();
            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean);
            const routeTarget = activeConv.ideId || activeConv.daemonId || '';
            const res = await sendDaemonCommand(routeTarget, 'resolve_action', {
                button: buttonText,
                action: isApprove ? 'approve' : 'reject',
                ...(buttonIndex >= 0 && { buttonIndex }),
                ...getProviderArgs(activeConv),
            });
            if (!res.success) {
                setActionLogs(prev => [...prev, {
                    ideId: activeConv.tabKey,
                    text: `⚠️ **${buttonText}** failed — button not found`,
                    timestamp: Date.now(),
                }])
            }
        } catch (e) {
            console.error('[ModalButton] Error:', e)
            setActionLogs(prev => [...prev, {
                ideId: activeConv.tabKey,
                text: `❌ **${buttonText}** error`,
                timestamp: Date.now(),
            }])
        }
    }, [activeConv, sendDaemonCommand, setActionLogs, getProviderArgs])

    const handleSwitchSession = useCallback(async (ideId: string, sessionId: string) => {
        try {
            const routeTarget = ideId || activeConv?.daemonId || '';
            const res: any = await sendDaemonCommand(routeTarget, 'switch_chat', {
                id: sessionId,
                sessionId,
                ...getProviderArgs(activeConv),
            });
            const scriptResult = res?.result;
            const ok = res?.success === true || scriptResult === 'switched' || scriptResult === 'switched-by-title';
            if (!ok) {
                if (scriptResult === false || scriptResult === 'not_found') {
                    setToasts(prev => [...prev, { id: Date.now(), message: '⚠️ Session tab not found — try refreshing history', type: 'warning', timestamp: Date.now() }]);
                } else if (typeof scriptResult === 'string' && scriptResult.startsWith('error:')) {
                    setToasts(prev => [...prev, { id: Date.now(), message: `⚠️ Switch error: ${scriptResult}`, type: 'warning', timestamp: Date.now() }]);
                } else {
                    setToasts(prev => [...prev, { id: Date.now(), message: '⚠️ Session switch failed', type: 'warning', timestamp: Date.now() }]);
                }
            }
        } catch (e: any) {
            console.error('Switch failed', e);
            setToasts(prev => [...prev, { id: Date.now(), message: `❌ Switch failed: ${e.message || 'connection error'}`, type: 'warning', timestamp: Date.now() }]);
        }
    }, [activeConv, sendDaemonCommand, setToasts, getProviderArgs])

    const handleNewChat = useCallback(async () => {
        if (!activeConv || isCreatingChat) return;
        setIsCreatingChat(true);
        try {
            const routeTarget = activeConv.ideId || activeConv.daemonId || '';
            await sendDaemonCommand(routeTarget, 'new_chat', {
                ...getProviderArgs(activeConv),
            });
            setClearedTabs(prev => ({ ...prev, [activeConv.tabKey]: Date.now() }));
            setLocalUserMessages(prev => ({ ...prev, [activeConv.tabKey]: [] }));
        } catch (e) {
            console.error('New chat failed', e);
        } finally {
            setIsCreatingChat(false);
        }
    }, [activeConv, isCreatingChat, sendDaemonCommand, setClearedTabs, setLocalUserMessages, getProviderArgs])

    const handleFocusAgent = useCallback(async () => {
        if (!activeConv || isFocusingAgent) return;
        setIsFocusingAgent(true);
        const savedTabKey = activeConv.tabKey;
        try {
            await sendDaemonCommand(activeConv.ideId, 'focus_session', {
                agentType: activeConv.agentType,
                ...(activeConv.sessionId && { targetSessionId: activeConv.sessionId }),
            });
            pinTab(savedTabKey, [200, 1500, 3000]);
        } catch (e) {
            console.error('Focus agent failed', e);
        } finally {
            setIsFocusingAgent(false);
        }
    }, [activeConv, isFocusingAgent, sendDaemonCommand, pinTab])

    const handleRefreshHistory = useCallback(async () => {
        if (!activeConv || isRefreshingHistory) return;
        setIsRefreshingHistory(true);
        try {
            const routeTarget = activeConv.ideId || activeConv.daemonId || '';
            const res: any = await sendDaemonCommand(routeTarget, 'list_chats', {
                forceExpand: true,
                ...getProviderArgs(activeConv),
            });
            const chats = res?.chats || res?.result?.chats;
            if (res?.success && Array.isArray(chats)) {
                updateIdeChats(activeConv.ideId, chats);
            }
        } catch (e) { console.error('Refresh history failed', e); }
        finally { setIsRefreshingHistory(false); }
    }, [activeConv, isRefreshingHistory, sendDaemonCommand, updateIdeChats, getProviderArgs])

    return {
        agentInput,
        setAgentInput,
        isSendingChat,
        isCreatingChat,
        isRefreshingHistory,
        isFocusingAgent,
        handleSendChat,
        handleRelaunch,
        handleLaunchIde,
        handleModalButton,
        handleSwitchSession,
        handleNewChat,
        handleFocusAgent,
        handleRefreshHistory,
    }
}
