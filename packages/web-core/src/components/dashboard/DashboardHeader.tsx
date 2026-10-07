/**
 * DashboardHeader — Top header bar for Dashboard
 *
 * Shows title, connection status indicator, and action buttons.
 * Connection state is abstract — injected by platform (cloud=P2P, standalone=local).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveConversation, CliConversationViewMode } from './types';
import { isCliConv, isCliTerminalConv } from './types';
import { IconBell, IconChat, IconEyeOff, IconX, IconPlus } from '../Icons';
import StartAssistantButton from './StartAssistantButton';
import type { AssistantLaunchTarget, AssistantMachineOption } from './assistant-session';
import { useBaseDaemons } from '../../context/BaseDaemonContext';
import CliViewModeToggle from './CliViewModeToggle';
import { getConversationMetaText, getConversationTitle } from './conversation-presenters';
import { isConversationGenerating } from './DashboardMobileChatShared';
import type { DashboardActionShortcutId } from '../../hooks/useActionShortcuts';
import { formatRelativeTime } from '../../utils/time';
import type { DashboardNotificationRecord } from '../../utils/dashboard-notifications';
import GitStatusPill from '../git/GitStatusPill';
import LoadingSpinner from '../ui/LoadingSpinner';
import ConversationActionsMenu from './ConversationActionsMenu';
import ConversationMeshGraphButton from './ConversationMeshGraphButton';
import { MeshRoleIcon } from './ConversationMeshRoleMarker';
import { Tooltip } from '../ui/InfoTip';

export interface DashboardHeaderProps {
    activeConv: ActiveConversation | undefined;
    wsStatus: string;
    /** Overall connection readiness (green=ready, yellow=partial, red=disconnected) */
    isConnected: boolean;
    conversations: ActiveConversation[];
    onOpenHistory: (conversation?: ActiveConversation) => void;
    onOpenRemote?: () => void;
    onStopCli?: (conversation?: ActiveConversation) => void;
    activeCliViewMode?: CliConversationViewMode | null;
    onSetCliViewMode?: (mode: CliConversationViewMode) => void;
    onHideConversation?: (conversation: ActiveConversation) => void;
    hiddenConversations?: ActiveConversation[];
    onShowConversation?: (conversation: ActiveConversation) => void;
    onShowAllHidden?: () => void;
    onResetPanelsToMain?: () => void;
    onClearDevHistory?: () => void;
    inboxOpen: boolean;
    onInboxOpenChange: (next: boolean) => void;
    hiddenOpen: boolean;
    onHiddenOpenChange: (next: boolean) => void;
    notifications: DashboardNotificationRecord[];
    notificationUnreadCount: number;
    onOpenNotification: (notification: DashboardNotificationRecord) => void;
    onMarkNotificationRead: (notificationId: string) => void;
    onMarkNotificationUnread: (notificationId: string) => void;
    onDeleteNotification: (notificationId: string) => void;
    onOpenNewSession?: () => void;
    /** "Start assistant" — passed only while no assistant session exists and a machine can host one. */
    onStartAssistant?: () => void;
    startAssistantPending?: boolean;
    startAssistantError?: string | null;
    /** The split button's dropdown: launch a chosen CLI/machine (remembered). */
    onStartAssistantWith?: (target: AssistantLaunchTarget) => void;
    startAssistantMachines?: AssistantMachineOption[];
    startAssistantDefault?: AssistantLaunchTarget | null;
    onOpenDashboardGuide?: () => void;
    guideNudgeVisible?: boolean;
    actionShortcuts?: Partial<Record<DashboardActionShortcutId, string>>;
    onOpenGitDialog?: (daemonId: string, workspace: string) => void;
    onOpenMeshGraph?: (conversation: ActiveConversation) => void;
}

type DashboardHeaderConnectionState = {
    tone: 'connected' | 'limited' | 'disconnected';
    /** i18n key for the connection title (translate at render). */
    titleKey: string;
    /** i18n key for the connection subtitle, or null when absent. */
    subtitleKey: string | null;
    /**
     * Interpolation values for `subtitleKey`, when the subtitle is a counter.
     * Present only on the partial-connection ('limited') tone.
     */
    subtitleParams?: { connected: number; total: number };
};

/**
 * Resolve the header connection indicator.
 *
 * Green means *every* visible machine is reachable over P2P — not "at least one
 * is". The distinction matters because the indicator is the only place the user
 * learns that a machine they expect to be usable is not: with an any-one rule, a
 * 2-machine account showed green while half the fleet was unreachable, and the
 * failure only surfaced later as a command that did not run.
 *
 * The comparison deliberately ignores whether the unconnected machines have
 * entered 'connecting' yet. The previous rule required `p2pConnecting > 0`, so a
 * machine that had not yet been dialled at all — no key in `p2pStates` — counted
 * as fine and the header went straight to green. Absence of a state is the least
 * connected a machine can be, not the most.
 *
 * "Every machine" is scoped to `daemonCount`, the daemons currently in `ides`,
 * i.e. those that have reported recently. Machines that stay offline age out of
 * that list via the server's TTL, so a long-dead machine does not pin the header
 * to yellow forever. The known trade-off is that a machine deliberately powered
 * off shows yellow while it is still within the TTL window; the N/M counter in
 * the subtitle exists so that state reads as information rather than as an error.
 *
 * `usesP2P` gates all of the above: standalone has no P2P layer, so its
 * `p2pStates` is permanently `{}` — indistinguishable in shape from cloud's own
 * transient "no daemon dialled yet" boot state. Inferring platform from the
 * empty object would either strand standalone on yellow forever or flash cloud
 * green before its first P2P attempt, so the platform passes `usesP2P`
 * explicitly instead of it being inferred from `p2pStates`. When false,
 * `isConnected` (the platform's own readiness flag) is authoritative and P2P
 * counting is skipped entirely.
 */
export function getDashboardHeaderConnectionState({
    wsStatus,
    isConnected,
    daemonCount,
    p2pStates = {},
    usesP2P = true,
}: {
    wsStatus: string;
    isConnected: boolean;
    daemonCount: number;
    p2pStates?: Record<string, string>;
    usesP2P?: boolean;
}): DashboardHeaderConnectionState {
    if (wsStatus !== 'connected') {
        return {
            tone: 'disconnected',
            titleKey: 'connection.disconnected',
            subtitleKey: null,
        };
    }

    if (daemonCount > 0 && !usesP2P) {
        // Platform has no P2P layer (standalone) — its own readiness flag is
        // the authoritative signal, same as the daemonCount===0 fallback below.
        return isConnected
            ? { tone: 'connected', titleKey: 'connection.connected', subtitleKey: null }
            : { tone: 'limited', titleKey: 'connection.connectedToDashboard', subtitleKey: null };
    }

    const p2pValues = Object.values(p2pStates);
    const p2pConnected = p2pValues.filter(state => state === 'connected').length;

    if (daemonCount > 0) {
        if (p2pConnected >= daemonCount) {
            return {
                tone: 'connected',
                titleKey: 'connection.connected',
                subtitleKey: null,
            };
        }
        return {
            tone: 'limited',
            titleKey: 'connection.connectedToDashboard',
            // Counter rather than "Connecting to machine...": the partial state can
            // persist (a machine that is simply off), so it has to say how many.
            subtitleKey: 'connection.machinesConnectedCount',
            subtitleParams: { connected: p2pConnected, total: daemonCount },
        };
    }

    // No machines visible yet — fall back to the platform's own readiness flag.
    // Standalone leaves `isConnected` at its `true` default and has no P2P layer,
    // so this keeps its header green exactly as before.
    if (isConnected) {
        return {
            tone: 'connected',
            titleKey: 'connection.connected',
            subtitleKey: null,
        };
    }

    return {
        tone: 'limited',
        titleKey: 'connection.connectedToDashboard',
        subtitleKey: null,
    };
}

function ShortcutPill({ value }: { value?: string }) {
    if (!value) return null;
    return <span className="dashboard-header-shortcut-pill">{value}</span>;
}

function DashboardHeaderNotificationItem({
    notification,
    shortcutIndex,
    onOpen,
    onMarkRead,
    onMarkUnread,
    onDelete,
}: {
    notification: DashboardNotificationRecord;
    shortcutIndex?: number;
    onOpen: () => void;
    onMarkRead: () => void;
    onMarkUnread: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation()
    const timeLabel = formatRelativeTime(notification.updatedAt)
    const isUnread = !notification.readAt

    return (
        <div className={`dashboard-header-inbox-item ${isUnread ? 'is-attention' : ''}`.trim()}>
            <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start text-left"
                onClick={onOpen}
            >
                <span className="dashboard-header-inbox-item-title">{notification.title}</span>
                <span className="dashboard-header-inbox-item-meta">
                    {shortcutIndex ? <span className="dashboard-header-item-shortcut">⌥{shortcutIndex}</span> : null}
                    {[notification.type === 'needs_attention' ? t('notification.actionNeeded') : t('notification.taskComplete'), timeLabel].filter(Boolean).join(' · ')}
                </span>
                {notification.preview ? (
                    <span className="dashboard-header-inbox-item-meta dashboard-header-inbox-item-preview">{notification.preview}</span>
                ) : null}
            </button>
            <div className="ml-3 flex shrink-0 items-center gap-1.5">
                {isUnread ? (
                    <button type="button" className="dashboard-header-hidden-secondary" onClick={(event) => { event.stopPropagation(); onMarkRead(); }}>
                        {t('notification.markRead')}
                    </button>
                ) : (
                    <button type="button" className="dashboard-header-hidden-secondary" onClick={(event) => { event.stopPropagation(); onMarkUnread(); }}>
                        {t('notification.markUnread')}
                    </button>
                )}
                <button type="button" className="dashboard-header-hidden-secondary" onClick={(event) => { event.stopPropagation(); onDelete(); }}>
                    {t('notification.delete')}
                </button>
            </div>
        </div>
    );
}

export default function DashboardHeader({
    activeConv,
    wsStatus,
    isConnected,
    conversations,
    onOpenHistory,
    onOpenRemote,
    onStopCli,
    activeCliViewMode,
    onSetCliViewMode,
    onHideConversation,
    hiddenConversations = [],
    onShowConversation,
    onShowAllHidden,
    onResetPanelsToMain,
    inboxOpen,
    onInboxOpenChange,
    hiddenOpen,
    onHiddenOpenChange,
    onOpenNewSession,
    onStartAssistant,
    startAssistantPending = false,
    startAssistantError = null,
    onStartAssistantWith,
    startAssistantMachines,
    startAssistantDefault = null,
    onOpenDashboardGuide,
    guideNudgeVisible = false,
    actionShortcuts,
    notifications,
    notificationUnreadCount,
    onOpenNotification,
    onMarkNotificationRead,
    onMarkNotificationUnread,
    onDeleteNotification,
    onOpenGitDialog,
    onOpenMeshGraph,
}: DashboardHeaderProps) {
    const { t } = useTranslation();
    const { ides, p2pStates = {}, usesP2P = true } = useBaseDaemons();
    const isCliActive = !!activeConv && isCliConv(activeConv);
    const effectiveCliViewMode = activeCliViewMode || (activeConv ? (isCliTerminalConv(activeConv) ? 'terminal' : 'chat') : null);
    const [isHiddenDropTarget, setIsHiddenDropTarget] = useState(false);
    const [hiddenSpawnAnim, setHiddenSpawnAnim] = useState(false);
    const prevHiddenCountRef = useRef<number | null>(null);
    const inboxRef = useRef<HTMLDivElement | null>(null);
    const hiddenRef = useRef<HTMLDivElement | null>(null);

    const daemons = ides.filter(i => i.type === 'adhdev-daemon');
    const connectionState = getDashboardHeaderConnectionState({
        wsStatus,
        isConnected,
        daemonCount: daemons.length,
        p2pStates,
        usesP2P,
    });
    const connectionTitle = t(connectionState.titleKey);
    const statusText = connectionState.subtitleKey
        ? t(connectionState.subtitleKey, connectionState.subtitleParams)
        : null;
    const dotColor = connectionState.tone === 'connected'
        ? '#22c55e'
        : connectionState.tone === 'limited'
            ? '#eab308'
            : '#ef4444';
    const dotGlow = connectionState.tone === 'connected'
        ? '0 0 4px #22c55e80'
        : connectionState.tone === 'limited'
            ? '0 0 4px #eab30880'
            : '0 0 4px #ef444480';
    const unreadNotifications = useMemo(
        () => notifications.filter(notification => !notification.readAt),
        [notifications],
    );
    const readNotifications = useMemo(
        () => notifications.filter(notification => !!notification.readAt),
        [notifications],
    );
    const inboxShortcutTargets = useMemo(
        () => unreadNotifications.slice(0, 9),
        [unreadNotifications],
    )
    const inboxCount = notificationUnreadCount;

    useEffect(() => {
        if (!inboxOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!inboxRef.current?.contains(event.target as Node)) onInboxOpenChange(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [inboxOpen, onInboxOpenChange]);

    useEffect(() => {
        if (!hiddenOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!hiddenRef.current?.contains(event.target as Node)) onHiddenOpenChange(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [hiddenOpen, onHiddenOpenChange]);

    useEffect(() => {
        if (!hiddenOpen && !inboxOpen) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!event.altKey) return
            const match = event.code.match(/^Digit([1-9])$/)
            if (!match) return
            const index = Number(match[1]) - 1
            const hiddenTarget = hiddenOpen ? hiddenConversations[index] : undefined
            const inboxTarget = inboxOpen ? inboxShortcutTargets[index] : undefined
            if (!hiddenTarget && !inboxTarget) return

            event.preventDefault()
            event.stopPropagation()

            if (hiddenTarget) {
                onShowConversation?.(hiddenTarget)
                onHiddenOpenChange(false)
                return
            }

            if (inboxTarget) {
                onOpenNotification(inboxTarget)
                onInboxOpenChange(false)
            }
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => window.removeEventListener('keydown', handleKeyDown, true)
    }, [
        hiddenConversations,
        hiddenOpen,
        inboxOpen,
        inboxShortcutTargets,
        onHiddenOpenChange,
        onInboxOpenChange,
        onOpenNotification,
        onShowConversation,
    ])

    useEffect(() => {
        const count = hiddenConversations.length;
        if (prevHiddenCountRef.current === null) {
            // Initial mount: seed ref without firing animation
            prevHiddenCountRef.current = count;
            return;
        }
        if (count > prevHiddenCountRef.current) {
            setHiddenSpawnAnim(true);
        }
        prevHiddenCountRef.current = count;
    }, [hiddenConversations.length]);

    const handleHiddenSpawnAnimEnd = () => setHiddenSpawnAnim(false);

    const handleHideDrop = (tabKey: string | null | undefined) => {
        if (!tabKey) return
        const conversation = conversations.find(item => item.tabKey === tabKey)
        if (!conversation) return
        onHideConversation?.(conversation)
    }

    return (
        <div className="dashboard-header">
            <div className="flex items-center gap-3">
                <div className="header-title-block">
                    <div className="header-title-row">
                        <h1 className="header-title m-0 flex items-center gap-1.5">
                        <IconChat size={18} />
                        {/* Mobile: show active tab title; Desktop: "Dashboard" */}
                        <span className="header-title-desktop">{t('dashboard.header.title')}</span>
                        {activeConv && <MeshRoleIcon conversation={activeConv} size={14} className="header-title-mobile-role" />}
                        <span className="header-title-mobile">
                            {activeConv ? getConversationTitle(activeConv) : t('dashboard.header.title')}
                        </span>
                        <Tooltip content={statusText ? `${connectionTitle} · ${statusText}` : connectionTitle} className="ml-0.5">
                            <span
                                role="img"
                                aria-label={connectionTitle}
                                data-connection-tone={connectionState.tone}
                                className="header-title-status-dot"
                                style={{ background: dotColor, boxShadow: dotGlow }}
                            />
                        </Tooltip>
                        </h1>
                        <div className="header-subtitle flex items-center">
                            {onOpenNewSession && (
                                <button
                                    type="button"
                                    onClick={onOpenNewSession}
                                    className="btn btn-secondary btn-sm ml-2"
                                    title={`${t('paneGroup.newSession')}${actionShortcuts?.openNewSession ? ` (${actionShortcuts.openNewSession})` : ''}`}
                                    aria-label={t('paneGroup.newSession')}
                                >
                                    <IconPlus size={14} />
                                </button>
                            )}
                            {onStartAssistant && (
                                <StartAssistantButton
                                    onStart={onStartAssistant}
                                    onStartWith={onStartAssistantWith}
                                    machines={startAssistantMachines}
                                    defaultTarget={startAssistantDefault}
                                    pending={startAssistantPending}
                                    error={startAssistantError}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex gap-2 items-center">
                {onOpenDashboardGuide && (
                    <button
                        type="button"
                        onClick={onOpenDashboardGuide}
                        className="btn btn-secondary btn-sm hidden md:inline-flex items-center gap-1.5 dashboard-header-guide-button"
                        title={t('dashboard.header.guide')}
                        aria-label={t('dashboard.header.guideOpen')}
                    >
                        <span className="font-semibold leading-none">?</span>
                        {guideNudgeVisible && <span>{t('dashboard.header.guideShort')}</span>}
                    </button>
                )}
                {activeConv && (
                    /* One pane toolbar: the git state (glanceable), the CLI view
                       toggle, Stop, the Mesh graph button for a coordinator
                       (its own button — opened often, and the cue that this is
                       a coordinator), and every other per-conversation action
                       in the "…" overflow. The conversation title is not
                       repeated here — the active tab already names it. */
                    <div className="dashboard-header-actions-group" data-testid="dashboard-pane-toolbar">
                        <GitStatusPill git={activeConv.git} compact className="max-w-[8rem] shrink-0" />
                        {isCliActive && onSetCliViewMode && effectiveCliViewMode && (
                            <CliViewModeToggle mode={effectiveCliViewMode} onChange={onSetCliViewMode} compact />
                        )}
                        {isCliActive && onStopCli && (
                            <button
                                type="button"
                                onClick={() => onStopCli(activeConv)}
                                className="btn btn-secondary btn-sm"
                                title={t('dashboard.header.stopCliProcess')}
                                aria-label={t('dashboard.header.stopCliProcess')}
                                data-testid="dashboard-pane-stop"
                                style={{
                                    color: 'var(--status-error, #ef4444)',
                                    borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, transparent)',
                                }}
                            >
                                <IconX size={14} />
                            </button>
                        )}
                        <ConversationMeshGraphButton
                            conversation={activeConv}
                            onOpenMeshGraph={onOpenMeshGraph}
                            showLabel
                        />
                        <ConversationActionsMenu
                            conversation={activeConv}
                            onOpenHistory={onOpenHistory}
                            onOpenRemote={onOpenRemote ? () => onOpenRemote() : undefined}
                            onOpenGit={onOpenGitDialog}
                            iconSize={14}
                        />
                    </div>
                )}
                <div className="dashboard-header-inbox" ref={inboxRef}>
                    <div
                        className={`dashboard-header-hidden${isHiddenDropTarget ? ' is-drop-target' : ''}${hiddenSpawnAnim ? ' hidden-spawn-flash' : ''}${(hiddenConversations ?? []).some(isConversationGenerating) ? ' hidden-generating-spin' : ''}`}
                        onAnimationEnd={handleHiddenSpawnAnimEnd}
                        ref={hiddenRef}
                        onDragEnter={event => {
                            if (!event.dataTransfer.types.includes('text/tab-key')) return
                            event.preventDefault()
                            setIsHiddenDropTarget(true)
                        }}
                        onDragOver={event => {
                            if (!event.dataTransfer.types.includes('text/tab-key')) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                            setIsHiddenDropTarget(true)
                        }}
                        onDragLeave={event => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                setIsHiddenDropTarget(false)
                            }
                        }}
                        onDrop={event => {
                            const tabKey = event.dataTransfer.getData('text/tab-key')
                            event.preventDefault()
                            setIsHiddenDropTarget(false)
                            handleHideDrop(tabKey)
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => onHiddenOpenChange(!hiddenOpen)}
                            className="btn btn-secondary btn-sm dashboard-header-hidden-button"
                            title={`${t('dashboard.hidden.title')}${actionShortcuts?.toggleHiddenTabs ? ` (${actionShortcuts.toggleHiddenTabs})` : ''}. ${t('dashboard.hidden.dragHint')}`}
                        >
                            <IconEyeOff size={16} />
                            {hiddenConversations.length > 0 && <span className={`dashboard-header-hidden-badge${hiddenSpawnAnim ? ' hidden-badge-pop' : ''}`}>{hiddenConversations.length}</span>}
                        </button>
                        {hiddenOpen && (
                            <div className="dashboard-header-hidden-popover">
                                <div className="dashboard-header-hidden-topbar">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className="dashboard-header-inbox-section-title mb-0">{t('dashboard.hidden.title')}</div>
                                        <ShortcutPill value={actionShortcuts?.toggleHiddenTabs} />
                                    </div>
                                    <div className="dashboard-header-hidden-actions">
                                        {onResetPanelsToMain && (
                                            <button
                                                type="button"
                                                className="dashboard-header-hidden-secondary"
                                                onClick={onResetPanelsToMain}
                                            >
                                                {t('dashboard.hidden.resetPanels')}
                                            </button>
                                        )}
                                        {hiddenConversations.length > 0 && onShowAllHidden && (
                                            <button
                                                type="button"
                                                className="dashboard-header-hidden-restore-all"
                                                onClick={() => {
                                                    onShowAllHidden();
                                                    onHiddenOpenChange(false);
                                                }}
                                            >
                                                {t('dashboard.hidden.restoreAll')}
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {activeConv && onHideConversation && (
                                    <button
                                        type="button"
                                        className="dashboard-header-hidden-current"
                                        onClick={() => onHideConversation(activeConv)}
                                    >
                                        <span className="dashboard-header-hidden-current-leading">
                                            <span className="dashboard-header-hidden-current-label">{t('dashboard.hidden.hideCurrentTab')}</span>
                                            <ShortcutPill value={actionShortcuts?.hideCurrentTab} />
                                        </span>
                                        <span className="dashboard-header-hidden-current-title">{getConversationTitle(activeConv)}</span>
                                    </button>
                                )}
                                {hiddenConversations.length > 0 ? (
                                    <div className="dashboard-header-hidden-list">
                                        {hiddenConversations.map(conversation => (
                                            <button
                                                key={conversation.tabKey}
                                                type="button"
                                                className="dashboard-header-inbox-item"
                                                onClick={() => {
                                                    onShowConversation?.(conversation);
                                                    onHiddenOpenChange(false);
                                                }}
                                            >
                                                <span className="dashboard-header-inbox-item-title">
                                                    {isConversationGenerating(conversation) && (
                                                        <LoadingSpinner size={12} thickness={2} color="success" label={t('dashboard.header.generating')} />
                                                    )}
                                                    <MeshRoleIcon conversation={conversation} size={12} />
                                                    {getConversationTitle(conversation)}
                                                </span>
                                                <span className="dashboard-header-inbox-item-meta">
                                                    {hiddenConversations.indexOf(conversation) < 9 ? (
                                                        <span className="dashboard-header-item-shortcut">⌥{hiddenConversations.indexOf(conversation) + 1}</span>
                                                    ) : null}
                                                    {getConversationMetaText(conversation)}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="dashboard-header-inbox-empty">{t('dashboard.hidden.empty')}</div>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => onInboxOpenChange(!inboxOpen)}
                        className="btn btn-secondary btn-sm dashboard-header-inbox-button"
                        title={t('dashboard.header.activityInbox')}
                    >
                        <IconBell size={16} />
                        {inboxCount > 0 && <span className="dashboard-header-inbox-badge">{inboxCount}</span>}
                    </button>
                    {inboxOpen && (
                        <div className="dashboard-header-inbox-popover">
                            {unreadNotifications.length > 0 && (
                                <div className="dashboard-header-inbox-section">
                                    <div className="dashboard-header-inbox-section-title">{t('dashboard.inbox.unread')}</div>
                                    {unreadNotifications.map(notification => (
                                        <DashboardHeaderNotificationItem
                                            key={notification.id}
                                            notification={notification}
                                            shortcutIndex={inboxShortcutTargets.indexOf(notification) >= 0 ? inboxShortcutTargets.indexOf(notification) + 1 : undefined}
                                            onOpen={() => onOpenNotification(notification)}
                                            onMarkRead={() => onMarkNotificationRead(notification.id)}
                                            onMarkUnread={() => onMarkNotificationUnread(notification.id)}
                                            onDelete={() => onDeleteNotification(notification.id)}
                                        />
                                    ))}
                                </div>
                            )}
                            {readNotifications.length > 0 && (
                                <div className="dashboard-header-inbox-section">
                                    <div className="dashboard-header-inbox-section-title">{t('dashboard.inbox.read')}</div>
                                    {readNotifications.map(notification => (
                                        <DashboardHeaderNotificationItem
                                            key={notification.id}
                                            notification={notification}
                                            onOpen={() => onOpenNotification(notification)}
                                            onMarkRead={() => onMarkNotificationRead(notification.id)}
                                            onMarkUnread={() => onMarkNotificationUnread(notification.id)}
                                            onDelete={() => onDeleteNotification(notification.id)}
                                        />
                                    ))}
                                </div>
                            )}
                            {notifications.length === 0 && (
                                <div className="dashboard-header-inbox-empty">{t('dashboard.inbox.empty')}</div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
