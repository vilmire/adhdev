import { IconBell, IconSettings, IconUser, IconMonitor, IconChat } from '../Icons'
import InstallCommand from '../InstallCommand'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'

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
    onOpenMachine: (machineId: string) => void
    onOpenSettings: () => void
    onOpenAccount?: () => void
    onSectionChange: (section: DashboardMobileSection) => void
    wsStatus?: string
    isConnected?: boolean
    isStandalone?: boolean
}

function MobileEmptyHero({ icon, title, subtitle, children }: {
    icon: React.ReactNode
    title: string
    subtitle: string
    children?: React.ReactNode
}) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 pt-12 pb-8 px-6 text-center">
            <div className="mb-2">{icon}</div>
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
    
    return (
        <button
            key={item.conversation.tabKey}
            className={`flex items-start gap-3.5 p-3.5 w-full bg-bg-secondary/40 border border-[#ffffff0a] rounded-xl text-left relative overflow-hidden transition-all active:scale-[0.98] ${
                isUnread ? 'bg-bg-secondary shadow-glow border-[#ffffff14]' : 
                isEarlier ? 'opacity-70 saturate-50' : ''
            }`}
            onClick={() => onOpenConversation(item.conversation)}
            type="button"
        >
            <span className={`w-10 h-10 rounded-[10px] flex items-center justify-center text-sm font-bold shrink-0 ${
                isUnread ? 'bg-accent-primary text-white shadow-glow' :
                isWorking ? 'bg-bg-primary border border-accent-primary text-text-primary' :
                'bg-bg-primary border border-[#ffffff1a] text-text-secondary'
            }`}>
                {getAvatarText(item.conversation.displayPrimary)}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-bold text-text-primary truncate tracking-tight">{item.conversation.displayPrimary}</span>
                    <span className="text-[11px] font-medium text-text-muted shrink-0">{formatRelativeTime(item.timestamp)}</span>
                </div>
                <div className="text-[12px] font-medium text-text-secondary truncate flex items-center">
                    {item.conversation.displaySecondary}
                    {item.conversation.machineName && (
                        <>
                            <span className="mx-1 opacity-50">·</span>
                            <span className="flex items-center gap-1 opacity-80"><IconMonitor size={11} /> {item.conversation.machineName}</span>
                        </>
                    )}
                    {type === 'needs_attention' && (
                        <>
                            <span className="mx-1 opacity-50">·</span>
                            <span className="text-orange-400">Action needed</span>
                        </>
                    )}
                </div>
                <div className="text-[13px] text-text-muted truncate mt-0.5 opacity-90">{item.preview}</div>
            </div>
            {isUnread && <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-accent-primary shadow-glow" />}
            {isWorking && <span className="absolute top-3.5 right-3 px-1.5 py-0.5 rounded-[4px] bg-accent-primary/20 text-accent-primary text-[10px] font-extrabold uppercase tracking-wide">Live</span>}
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
    onOpenMachine,
    onOpenSettings,
    onOpenAccount,
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

    return (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-bg-primary">
            <div className="flex items-center justify-between px-5 pt-[calc(16px+env(safe-area-inset-top,0px))] pb-4 shrink-0 bg-bg-primary z-10">
                <div className="text-2xl font-black tracking-tight text-text-primary px-1">
                    {inboxTitle}
                </div>
                <div className="flex items-center gap-3">
                    {section === 'chats' && (attentionItems.length > 0 || unreadItems.length > 0) && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-primary/20 text-accent-primary text-[11px] font-bold">
                            <IconBell size={13} />
                            <span>{attentionItems.length + unreadItems.length}</span>
                        </div>
                    )}
                    <button onClick={onOpenSettings} className="w-8 h-8 flex items-center justify-center rounded-full bg-[#ffffff0a] text-text-secondary hover:text-text-primary hover:bg-[#ffffff14] transition-colors">
                        <IconSettings size={18} />
                    </button>
                    {onOpenAccount && (
                        <button onClick={onOpenAccount} className="w-8 h-8 flex items-center justify-center rounded-full bg-[#ffffff0a] text-text-secondary hover:text-text-primary hover:bg-[#ffffff14] transition-colors">
                            <IconUser size={18} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] flex flex-col gap-3 -webkit-overflow-scrolling-touch">
                {section === 'chats' && attentionItems.length > 0 && (
                    <section className="flex flex-col gap-0">
                        <div className="mx-2 mb-2 p-3 rounded-2xl bg-accent-primary/10 text-text-secondary flex items-center justify-between gap-2.5 text-xs">
                            <span className="font-bold text-text-primary">Needs attention</span>
                            <span className="font-bold text-accent-primary">{attentionItems.length} action needed</span>
                        </div>
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="flex flex-col gap-0">
                        <div className="mx-2 mb-2 p-3 rounded-2xl bg-accent-primary/10 text-text-secondary flex items-center justify-between gap-2.5 text-xs">
                            <span className="font-bold text-text-primary">Task complete</span>
                            <span className="font-bold text-accent-primary">{unreadItems.length} unread</span>
                        </div>
                    </section>
                )}

                {section === 'machines' && (
                    <section className="flex flex-col gap-2">
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
                                title={isStandalone ? 'Waiting for your IDE' : 'Connect your first machine'}
                                subtitle={
                                    isStandalone
                                        ? 'Launch any supported IDE or CLI agent — it will appear here automatically.'
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
                            machineCards.map(machine => (
                                <button
                                    key={machine.id}
                                    className="flex items-start gap-3.5 p-3.5 w-full bg-bg-secondary/40 border border-[#ffffff0a] rounded-xl text-left transition-all active:scale-[0.98]"
                                    onClick={() => onOpenMachine(machine.id)}
                                    type="button"
                                >
                                    <span className="w-10 h-10 rounded-[10px] flex items-center justify-center text-sm font-bold shrink-0 bg-bg-secondary border border-[#ffffff14] text-text-primary shadow-[0_2px_8px_rgba(0,0,0,0.2)]">
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
                            ))
                        )}
                    </section>
                )}

                {section === 'chats' && attentionItems.length > 0 && (
                    <section className="flex flex-col gap-2">
                        <div className="text-[12px] font-bold uppercase tracking-wider text-text-secondary px-1 mb-1">Needs attention</div>
                        {attentionItems.map(item => (
                            <DashboardMobileChatItem
                                key={item.conversation.tabKey}
                                item={item}
                                type="needs_attention"
                                getAvatarText={getAvatarText}
                                onOpenConversation={onOpenConversation}
                            />
                        ))}
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="flex flex-col gap-2">
                        <div className="text-[12px] font-bold uppercase tracking-wider text-text-secondary px-1 mb-1 mt-2">Task complete</div>
                        {unreadItems.map(item => (
                            <DashboardMobileChatItem
                                key={item.conversation.tabKey}
                                item={item}
                                type="task_complete"
                                getAvatarText={getAvatarText}
                                onOpenConversation={onOpenConversation}
                            />
                        ))}
                    </section>
                )}

                {section === 'chats' && workingItems.length > 0 && (
                    <section className="flex flex-col gap-2">
                        <div className="text-[12px] font-bold uppercase tracking-wider text-text-secondary px-1 mb-1 mt-2">Working now</div>
                        {workingItems.map(item => (
                            <DashboardMobileChatItem
                                key={item.conversation.tabKey}
                                item={item}
                                type="working"
                                getAvatarText={getAvatarText}
                                onOpenConversation={onOpenConversation}
                            />
                        ))}
                    </section>
                )}

                {section === 'chats' && (
                    <section className="flex flex-col gap-2">
                        {completedItems.length > 0 && (
                            <div className="text-[12px] font-bold uppercase tracking-wider text-text-secondary px-1 mb-1 mt-2">Earlier</div>
                        )}
                        {completedItems.length > 0 ? completedItems.map(item => (
                            <DashboardMobileChatItem
                                key={item.conversation.tabKey}
                                item={item}
                                type="earlier"
                                getAvatarText={getAvatarText}
                                onOpenConversation={onOpenConversation}
                            />
                        )) : !hasAnyConversation ? (
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
                                    subtitle="Your machines are connected. Open an IDE or launch a CLI agent to start your first conversation."
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
                    <section className="flex flex-col gap-2">
                        <div className="flex items-center justify-between text-[12px] font-bold uppercase tracking-wider text-text-secondary px-1 mb-1 mt-4">
                            <span>Hidden</span>
                            <button
                                type="button"
                                className="text-accent-primary normal-case font-semibold hover:underline"
                                onClick={onShowAllHidden}
                            >
                                Restore all
                            </button>
                        </div>
                        {hiddenConversations.map(conversation => (
                            <button
                                key={conversation.tabKey}
                                className="flex items-start gap-3.5 p-3.5 w-full bg-bg-secondary/20 border border-[#ffffff05] rounded-xl text-left transition-all active:scale-[0.98] opacity-50 saturate-0"
                                onClick={() => onShowConversation(conversation)}
                                type="button"
                            >
                                <span className="w-10 h-10 rounded-[10px] flex items-center justify-center text-sm font-bold shrink-0 bg-bg-primary border border-[#ffffff1a] text-text-secondary">
                                    {getAvatarText(conversation.displayPrimary)}
                                </span>
                                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[15px] font-bold text-text-primary truncate tracking-tight">{conversation.displayPrimary}</span>
                                        <span className="text-[11px] font-medium text-text-muted shrink-0">Hidden</span>
                                    </div>
                                    <div className="text-[12px] font-medium text-text-secondary truncate flex items-center">
                                        {conversation.displaySecondary}
                                        {conversation.machineName && (
                                            <>
                                                <span className="mx-1 opacity-50">·</span>
                                                <span className="flex items-center gap-1 opacity-80"><IconMonitor size={11} /> {conversation.machineName}</span>
                                            </>
                                        )}
                                    </div>
                                    <div className="text-[13px] text-text-muted truncate mt-0.5 opacity-90">
                                        Tap to restore and open
                                    </div>
                                </div>
                            </button>
                        ))}
                    </section>
                )}
            </div>

            <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
        </div>
    )
}
