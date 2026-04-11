import { IconBell, IconSettings, IconChat } from '../Icons'
import InstallCommand from '../InstallCommand'
import { formatRelativeTime, getConversationViewStates, type MobileConversationListItem, type MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationMetaText, getConversationStatusHint, getConversationTitle } from './conversation-presenters'

interface DashboardMobileChatInboxProps {
    section: DashboardMobileSection
    attentionItems: MobileConversationListItem[]
    unreadItems: MobileConversationListItem[]
    workingItems: MobileConversationListItem[]
    completedItems: MobileConversationListItem[]
    hiddenConversations: ActiveConversation[]
    machineCards: MobileMachineCard[]
    getAvatarText: (primary: string) => string
    onOpenConversation: (conversation: ActiveConversation) => void
    onShowConversation: (conversation: ActiveConversation) => void
    onShowAllHidden: () => void
    onOpenNewSession?: () => void
    onOpenMachine: (machineId: string) => void
    onOpenSettings: () => void
    onSectionChange: (section: DashboardMobileSection) => void
    wsStatus?: string
    isConnected?: boolean
    isStandalone?: boolean
}

function InboxSectionHeader({
    title,
    className = '',
}: {
    title: string
    className?: string
}) {
    return (
        <div className={`mx-1 flex items-center justify-between gap-2 px-1 py-1 text-xs ${className}`}>
            <span className="font-bold uppercase tracking-[0.18em] text-text-secondary">{title}</span>
        </div>
    )
}

function InboxListSection({
    children,
    className = '',
}: {
    children: React.ReactNode
    className?: string
}) {
    return (
        <div className={`w-full min-w-0 self-stretch overflow-hidden rounded-[24px] border border-border-subtle/80 bg-bg-secondary/40 shadow-[0_10px_30px_rgba(0,0,0,0.05)] ${className}`}>
            {children}
        </div>
    )
}

function MobileEmptyHero({ icon, title, subtitle, children }: {
    icon: React.ReactNode
    title: string
    subtitle: string
    children?: React.ReactNode
}) {
    return (
        <div className="flex w-full min-w-0 flex-col items-center justify-center gap-2 px-6 pt-12 pb-8 text-center">
            <div className="mb-2 rounded-2xl border border-accent-primary/10 bg-[color:color-mix(in_oklab,var(--bg-secondary)_90%,var(--accent-primary)_10%)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">{icon}</div>
            <div className="text-lg font-bold tracking-tight text-text-primary">
                {title}
            </div>
            <div className="text-[13px] leading-relaxed text-text-secondary max-w-[320px]">
                {subtitle}
            </div>
            {children}
        </div>
    )
}

function DashboardMobileChatItem({
    item,
    type,
    getAvatarText,
    onOpenConversation,
}: {
    item: MobileConversationListItem
    type: 'needs_attention' | 'task_complete' | 'working' | 'earlier'
    getAvatarText: (primary: string) => string
    onOpenConversation: (c: ActiveConversation) => void
}) {
    const isUnread = type === 'needs_attention' || type === 'task_complete'
    const isWorking = type === 'working'
    const isEarlier = type === 'earlier'
    const isTaskComplete = type === 'task_complete'
    const { isReconnecting, isConnecting } = getConversationViewStates(item.conversation)
    const title = getConversationTitle(item.conversation)
    const metaText = getConversationMetaText(item.conversation)
    const statusHint = getConversationStatusHint(item.conversation, { requiresAction: type === 'needs_attention' })
    const rowClassName = isUnread
        ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_92%,var(--accent-primary)_8%)]'
        : isWorking
            ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_94%,var(--accent-primary)_6%)]'
            : isEarlier
                ? 'bg-[color:color-mix(in_oklab,var(--bg-secondary)_97%,var(--text-muted)_3%)]'
                : 'bg-transparent'
    const avatarClassName = isUnread
        ? 'bg-accent-primary shadow-glow'
        : isWorking
            ? 'bg-[color:color-mix(in_oklab,var(--bg-primary)_82%,var(--accent-primary)_18%)] border border-accent-primary/22 text-accent-primary'
            : isEarlier
                ? 'bg-[color:color-mix(in_oklab,var(--bg-primary)_95%,var(--text-muted)_5%)] border border-border-subtle/80 text-text-muted'
                : 'bg-bg-primary border border-border-subtle text-text-secondary'
    const titleClassName = isEarlier ? 'text-text-secondary' : 'text-text-primary'
    const metaClassName = isEarlier ? 'text-text-muted' : 'text-text-secondary'
    const previewClassName = isEarlier ? 'text-text-secondary opacity-80' : 'text-text-muted'
    const timestampClassName = isEarlier ? 'text-text-muted opacity-80' : 'text-text-muted'
    const warningTextClassName = 'text-[color:var(--status-warning)]'
    
    return (
        <button
            key={item.conversation.tabKey}
            className={`group flex items-start gap-3.5 px-4 py-3.5 w-full text-left relative overflow-hidden transition-colors active:scale-[0.995] ${rowClassName}`}
            onClick={() => onOpenConversation(item.conversation)}
            type="button"
        >
            {(isUnread || isWorking) ? (
                <span className="pointer-events-none absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full bg-accent-primary/80" />
            ) : null}
            <span
                className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarClassName}`}
                style={isUnread ? { color: 'var(--accent-on-primary)' } : undefined}
            >
                {getAvatarText(title)}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                    <span className={`text-[15px] font-bold truncate tracking-tight ${titleClassName}`}>{title}</span>
                    {!isWorking && <span className={`text-[11px] font-medium shrink-0 ${timestampClassName}`}>{formatRelativeTime(item.timestamp)}</span>}
                </div>
                <div className={`text-[12px] font-medium truncate flex items-center ${metaClassName}`}>
                    {metaText}
                    {isReconnecting ? (
                        <>
                            <span className="mx-1 opacity-50">·</span>
                            <span className={`${warningTextClassName} animate-pulse`}>Reconnecting…</span>
                        </>
                    ) : isConnecting ? (
                        <>
                            <span className="mx-1 opacity-50">·</span>
                            <span className="text-text-muted">Connecting…</span>
                        </>
                    ) : statusHint === 'Action needed' && (
                        <>
                            <span className="mx-1 opacity-50">·</span>
                            <span className={warningTextClassName}>Action needed</span>
                        </>
                    )}
                </div>
                <div className={`mt-0.5 truncate text-[13px] ${previewClassName}`}>
                    {item.preview}
                </div>
            </div>
            {isUnread && !isTaskComplete && <span className="absolute top-5 right-4 w-2 h-2 rounded-full bg-accent-primary shadow-glow" />}
            {isTaskComplete && (
                <span className="absolute top-4 right-4 rounded-full border border-accent-primary/16 bg-accent-primary/10 px-2 py-0.5 text-[10px] font-bold text-accent-primary">
                    Done
                </span>
            )}
            {isWorking && <span className="absolute top-4 right-4 rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] font-bold text-accent-primary">Live</span>}
        </button>
    )
}

function MobileSpinner({ size = 32, label }: { size?: number; label?: string }) {
    return (
        <div className="flex flex-col items-center gap-2.5">
            <div 
                className="rounded-full animate-spin border-[2.5px] border-accent-primary/20 border-t-accent-primary-light"
                style={{ width: size, height: size }}
            />
            {label && (
                <div className="text-xs font-semibold text-accent-primary-light tracking-tight">
                    {label}
                </div>
            )}
        </div>
    )
}

export default function DashboardMobileChatInbox({
    section,
    attentionItems,
    unreadItems,
    workingItems,
    completedItems,
    hiddenConversations,
    machineCards,
    getAvatarText,
    onOpenConversation,
    onShowConversation,
    onShowAllHidden,
    onOpenNewSession,
    onOpenMachine,
    onOpenSettings,
    onSectionChange,
    wsStatus = 'connected',
    isStandalone = false,
}: DashboardMobileChatInboxProps) {
    const isDisconnected = wsStatus === 'disconnected' || wsStatus === 'reconnecting' || wsStatus === 'offline' || wsStatus === 'auth_failed'
    const hasMachines = machineCards.length > 0
    const hasAnyConversation = attentionItems.length > 0 || unreadItems.length > 0 || workingItems.length > 0 || completedItems.length > 0
    const inboxTitle = section === 'machines'
        ? 'Machines'
        : 'Chats'
    const headerPaddingClass = isStandalone
        ? 'px-5 pt-4 pb-4'
        : 'px-5 pt-[calc(16px+env(safe-area-inset-top,0px))] pb-4'
    const contentPaddingClass = isStandalone
        ? 'px-3 pb-3'
        : 'px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))]'

    return (
        <div className="flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
            <div className={`z-10 shrink-0 bg-bg-primary ${headerPaddingClass}`}>
                <div className="flex items-center justify-between gap-3">
                    <div className="text-2xl font-black tracking-tight text-text-primary px-1">
                        {inboxTitle}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {section === 'chats' && (attentionItems.length > 0 || unreadItems.length > 0) && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-accent-primary/16 bg-accent-primary/10 text-accent-primary text-[11px] font-bold shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
                                <IconBell size={13} />
                                <span>{attentionItems.length + unreadItems.length}</span>
                            </div>
                        )}
                        <button onClick={onOpenSettings} className="w-8 h-8 flex items-center justify-center rounded-full border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:text-text-primary hover:border-border-default transition-colors">
                            <IconSettings size={18} />
                        </button>
                    </div>
                </div>
            </div>

            <div className={`flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] ${contentPaddingClass}`}>
                {section === 'machines' && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        {isDisconnected ? (
                            <MobileEmptyHero
                                icon={<MobileSpinner label="Reconnecting…" />}
                                title="Connecting to server"
                                subtitle={
                                    wsStatus === 'offline'
                                        ? 'Your device appears to be offline. Waiting for network…'
                                        : wsStatus === 'auth_failed'
                                            ? 'Session expired. Please log in again.'
                                            : 'Establishing connection to the server. This usually takes a moment.'
                                }
                            />
                        ) : machineCards.length === 0 ? (
                            <MobileEmptyHero
                                icon={
                                    <img
                                        src="/otter-logo.png"
                                        alt="ADHDev"
                                        className="w-12 h-12 object-contain animate-bounce"
                                        style={{ animationDuration: '3s' }}
                                    />
                                }
                                title={isStandalone ? 'Waiting for your daemon' : 'Connect your first machine'}
                                subtitle={
                                    isStandalone
                                        ? 'Start the ADHDev daemon to connect this dashboard. Once it is online, you can open an IDE or launch CLI and ACP sessions.'
                                        : 'Install the ADHDev daemon on your machine, then it will show up here.'
                                }
                            >
                                {!isStandalone && (
                                    <div className="w-full max-w-[360px] mt-4">
                                        <InstallCommand />
                                    </div>
                                )}
                            </MobileEmptyHero>
                        ) : (
                            <InboxListSection>
                                {machineCards.map((machine, index) => (
                                    <button
                                        key={machine.id}
                                        className={`flex items-start gap-3.5 px-4 py-3.5 w-full text-left transition-colors active:scale-[0.995] ${index > 0 ? 'border-t border-border-subtle/70' : ''}`}
                                        onClick={() => onOpenMachine(machine.id)}
                                        type="button"
                                    >
                                        <span className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 bg-[color:color-mix(in_oklab,var(--bg-primary)_82%,var(--accent-primary)_18%)] border border-accent-primary/16 text-text-primary shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                                            {getAvatarText(machine.label)}
                                        </span>
                                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-[15px] font-bold text-text-primary truncate tracking-tight">{machine.label}</span>
                                                <span className="text-[11px] font-medium text-text-muted shrink-0">
                                                    {machine.unread > 0 ? <span className="text-accent-primary">{machine.unread} new</span> : machine.total > 0 ? `${machine.total} chats` : 'Idle'}
                                                </span>
                                            </div>
                                            <div className="text-[12px] font-medium text-text-secondary truncate">{machine.subtitle}</div>
                                            {machine.total > 0 ? (
                                                <div className="text-[13px] text-text-muted mt-0.5">
                                                    {machine.total} chat{machine.total !== 1 ? 's' : ''}{machine.unread > 0 ? ` · ${machine.unread} unread` : ''}
                                                </div>
                                            ) : (
                                                <div className="text-[13px] text-text-muted mt-0.5 italic opacity-70">
                                                    No active chats
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </InboxListSection>
                        )}
                    </section>
                )}

                {section === 'chats' && attentionItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title="Needs attention" className="mb-0" />
                        <InboxListSection>
                            {attentionItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="needs_attention"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title="Task complete" className="mb-0 mt-2" />
                        <InboxListSection>
                            {unreadItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="task_complete"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && workingItems.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <InboxSectionHeader title="Working now" className="mb-0 mt-2" />
                        <InboxListSection>
                            {workingItems.map((item, index) => (
                                <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                    <DashboardMobileChatItem
                                        item={item}
                                        type="working"
                                        getAvatarText={getAvatarText}
                                        onOpenConversation={onOpenConversation}
                                    />
                                </div>
                            ))}
                        </InboxListSection>
                    </section>
                )}

                {section === 'chats' && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        {completedItems.length > 0 && (
                            <InboxSectionHeader title="Earlier" className="mb-0 mt-2 border-border-subtle/80 bg-bg-secondary/35" />
                        )}
                        {completedItems.length > 0 ? (
                            <InboxListSection>
                                {completedItems.map((item, index) => (
                                    <div key={item.conversation.tabKey} className={index > 0 ? 'border-t border-border-subtle/70' : ''}>
                                        <DashboardMobileChatItem
                                            item={item}
                                            type="earlier"
                                            getAvatarText={getAvatarText}
                                            onOpenConversation={onOpenConversation}
                                        />
                                    </div>
                                ))}
                            </InboxListSection>
                        ) : !hasAnyConversation ? (
                            isDisconnected ? (
                                <MobileEmptyHero
                                    icon={<MobileSpinner size={28} />}
                                    title="Connecting…"
                                    subtitle="Waiting for server connection before loading conversations."
                                />
                            ) : !hasMachines ? (
                                <MobileEmptyHero
                                    icon={
                                        <img
                                            src="/otter-logo.png"
                                            alt="ADHDev"
                                            className="w-10 h-10 object-contain opacity-70"
                                        />
                                    }
                                    title="No machines connected"
                                    subtitle="Switch to the Machines tab to connect your first machine and start chatting with AI agents."
                                />
                            ) : (
                                <MobileEmptyHero
                                    icon={
                                        <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-accent-primary/10 text-accent-primary-light">
                                            <IconChat size={20} />
                                        </div>
                                    }
                                    title="No conversations yet"
                                    subtitle="Your machines are available. Open a machine, wait for P2P to connect, then launch your first IDE, CLI, or ACP session."
                                />
                            )
                        ) : (
                            <div className="py-8 text-center text-sm font-medium text-text-muted">
                                All caught up.
                            </div>
                        )}
                    </section>
                )}

                {section === 'chats' && hiddenConversations.length > 0 && (
                    <section className="flex w-full min-w-0 flex-col gap-2 self-stretch">
                        <div className="mx-1 mt-4 mb-1 flex items-center justify-between gap-2 px-1 py-1 text-[12px] font-bold uppercase tracking-wider text-text-secondary">
                            <span>Hidden</span>
                            <button
                                type="button"
                                className="text-accent-primary normal-case font-semibold hover:underline"
                                onClick={onShowAllHidden}
                            >
                                Restore all
                            </button>
                        </div>
                        <InboxListSection className="bg-bg-secondary/25">
                            {hiddenConversations.map((conversation, index) => (
                                <button
                                    key={conversation.tabKey}
                                    className={`flex items-start gap-3.5 px-4 py-3.5 w-full text-left transition-colors active:scale-[0.995] opacity-50 saturate-0 ${index > 0 ? 'border-t border-border-subtle/70' : ''}`}
                                    onClick={() => onShowConversation(conversation)}
                                    type="button"
                                >
                                    <span className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 bg-bg-primary border border-border-subtle text-text-secondary">
                                        {getAvatarText(getConversationTitle(conversation))}
                                    </span>
                                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[15px] font-bold text-text-primary truncate tracking-tight">{getConversationTitle(conversation)}</span>
                                            <span className="text-[11px] font-medium text-text-muted shrink-0">Hidden</span>
                                        </div>
                                        <div className="text-[12px] font-medium text-text-secondary truncate flex items-center">{getConversationMetaText(conversation)}</div>
                                        <div className="text-[13px] text-text-muted truncate mt-0.5 opacity-90">
                                            Tap to restore and open
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </InboxListSection>
                    </section>
                )}
            </div>

            {section === 'chats' && onOpenNewSession && (
                <button
                    className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom,0px)+64px+20px)] z-50 flex items-center justify-center w-14 h-14 rounded-full hover:scale-105 active:scale-95 transition-transform"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)', boxShadow: 'var(--shadow-md)' }}
                    onClick={onOpenNewSession}
                    aria-label="Start new session"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
            )}

            <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
        </div>
    )
}
