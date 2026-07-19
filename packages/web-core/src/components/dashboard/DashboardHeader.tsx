/**
 * DashboardHeader — Top header bar for Dashboard
 *
 * Shows title, connection status indicator, and action buttons.
 * Connection state is abstract — injected by platform (cloud=P2P, standalone=local).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveConversation, CliConversationViewMode } from './types';
import { isCliConv, isCliTerminalConv, isAcpConv } from './types';
import { IconBell, IconChat, IconScroll, IconMonitor, IconEyeOff, IconX, IconPlus, IconMesh } from '../Icons';
import { useBaseDaemons } from '../../context/BaseDaemonContext';
import CliViewModeToggle from './CliViewModeToggle';
import { getConversationMetaText, getConversationTitle } from './conversation-presenters';
import { DASHBOARD_NEW_SESSION_LABEL } from './dashboard-session-cta';
import type { DashboardActionShortcutId } from '../../hooks/useActionShortcuts';
import { formatRelativeTime } from '../../utils/time';
import type { DashboardNotificationRecord } from '../../utils/dashboard-notifications';
import GitStatusPill from '../git/GitStatusPill';

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
};

export function getDashboardHeaderConnectionState({
    wsStatus,
    isConnected,
    daemonCount,
    p2pStates = {},
}: {
    wsStatus: string;
    isConnected: boolean;
    daemonCount: number;
    p2pStates?: Record<string, string>;
}): DashboardHeaderConnectionState {
    if (wsStatus !== 'connected') {
        return {
            tone: 'disconnected',
            titleKey: 'connection.disconnected',
            subtitleKey: null,
        };
    }

    const p2pValues = Object.values(p2pStates);
    const p2pConnected = p2pValues.filter(state => state === 'connected').length;
    const p2pConnecting = p2pValues.filter(state => state === 'connecting' || state === 'new' || state === 'checking').length;

    if (daemonCount > 0 && p2pConnecting > 0 && p2pConnected === 0) {
        return {
            tone: 'limited',
            titleKey: 'connection.connectedToDashboard',
            subtitleKey: 'connection.connectingToMachine',
        };
    }

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
    const { ides, p2pStates = {} } = useBaseDaemons();
    const isCliActive = !!activeConv && isCliConv(activeConv) && !isAcpConv(activeConv);
    const isAcpActive = !!activeConv && isAcpConv(activeConv);
    const meshGraphAvailable = !!activeConv?.daemonId && !!activeConv?.coordinator?.meshId
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
    });
    const connectionTitle = t(connectionState.titleKey);
    const statusText = connectionState.subtitleKey ? t(connectionState.subtitleKey) : null;
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
                        <span className="header-title-mobile">
                            {activeConv ? getConversationTitle(activeConv) : t('dashboard.header.title')}
                        </span>
                        <span
                            title={connectionTitle}
                            aria-label={connectionTitle}
                            className="header-title-status-dot"
                            style={{ background: dotColor, boxShadow: dotGlow }}
                        />
                        <span className="header-count-mobile text-[10px] font-semibold opacity-60 ml-2 tracking-wide">
                            <span
                                className="inline-block w-[6px] h-[6px] rounded-full align-middle"
                                style={{ background: dotColor, boxShadow: dotGlow }}
                            />
                        </span>
                        </h1>
                        <div className="header-subtitle flex items-center">
                            {statusText && (
                                <span className="header-subtitle-status mr-2">
                                    · {statusText}
                                </span>
                            )}
                            {onOpenNewSession && (
                                <button
                                    type="button"
                                    onClick={onOpenNewSession}
                                    className="btn btn-secondary btn-sm ml-2"
                                    title={`${DASHBOARD_NEW_SESSION_LABEL}${actionShortcuts?.openNewSession ? ` (${actionShortcuts.openNewSession})` : ''}`}
                                    aria-label={DASHBOARD_NEW_SESSION_LABEL}
                                >
                                    <IconPlus size={14} />
                                </button>
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
                {activeConv && (isCliActive || isAcpActive || !isAcpConv(activeConv)) && (
                    <div className="dashboard-header-actions-group">
                        <span
                            className="dashboard-header-action-target"
                            title={getConversationMetaText(activeConv) || getConversationTitle(activeConv)}
                        >
                            {getConversationTitle(activeConv)}
                        </span>
                        {onOpenGitDialog && activeConv.git && activeConv.daemonId && activeConv.workspacePath ? (
                            <button
                                type="button"
                                className="appearance-none bg-transparent border-0 p-0 cursor-pointer"
                                title={t('dashboard.header.openGitStatus')}
                                onClick={() => onOpenGitDialog(activeConv.daemonId!, activeConv.workspacePath!)}
                            >
                                <GitStatusPill git={activeConv.git} compact className="max-w-[8rem] shrink-0" />
                            </button>
                        ) : (
                            <GitStatusPill git={activeConv.git} compact className="max-w-[8rem] shrink-0" />
                        )}
                        {meshGraphAvailable && onOpenMeshGraph && (
                            <button
                                type="button"
                                onClick={() => onOpenMeshGraph(activeConv)}
                                className="btn btn-secondary btn-sm dashboard-header-mesh-button"
                                title={t('dashboard.header.openMeshGraph')}
                            >
                                <IconMesh size={14} />
                                <span className="hidden lg:inline">{t('dashboard.header.meshGraph')}</span>
                            </button>
                        )}

                        {(isCliActive || isAcpActive) && onStopCli && (
                            <>
                                {isCliActive && onSetCliViewMode && effectiveCliViewMode && (
                                    <CliViewModeToggle mode={effectiveCliViewMode} onChange={onSetCliViewMode} compact />
                                )}
                                <button
                                    onClick={() => onStopCli(activeConv)}
                                    className="btn btn-secondary btn-sm"
                                    title={isAcpActive ? t('dashboard.header.stopAcpSession') : t('dashboard.header.stopCliProcess')}
                                    style={{
                                        color: 'var(--status-error, #ef4444)',
                                        borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, transparent)',
                                    }}
                                >
                                    <IconX size={14} />
                                </button>
                            </>
                        )}

                        {!isAcpConv(activeConv) && (
                            <button
                                onClick={() => onOpenHistory(activeConv)}
                                className="btn btn-secondary btn-sm"
                                title={t('dashboard.header.chatHistory')}
                            >
                                <IconScroll size={14} />
                            </button>
                        )}
                        {!isCliActive && !isAcpConv(activeConv) && (
                            <button
                                onClick={onOpenRemote}
                                className="btn btn-secondary btn-sm"
                                title={t('dashboard.header.remoteControl')}
                            >
                                <IconMonitor size={14} />
                            </button>
                        )}
                    </div>
                )}
                <div className="dashboard-header-inbox" ref={inboxRef}>
                    <div
                        className={`dashboard-header-hidden${isHiddenDropTarget ? ' is-drop-target' : ''}${hiddenSpawnAnim ? ' hidden-spawn-flash' : ''}${(hiddenConversations ?? []).some(c => c.status === 'generating') ? ' hidden-generating-spin' : ''}`}
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
                                                    {conversation.status === 'generating' && (
                                                        <span className="tab-spinner dashboard-header-inbox-item-spinner" aria-label={t('dashboard.header.generating')} />
                                                    )}
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
