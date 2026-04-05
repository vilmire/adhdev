import { IconBell, IconSettings } from '../Icons'
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
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '48px 24px 32px',
            textAlign: 'center',
        }}>
            <div style={{ marginBottom: 8 }}>{icon}</div>
            <div style={{
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--text-primary)',
            }}>{title}</div>
            <div style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--text-secondary)',
                maxWidth: 320,
            }}>{subtitle}</div>
            {children}
        </div>
    )
}

function MobileSpinner({ size = 32, label }: { size?: number; label?: string }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{
                width: size,
                height: size,
                borderRadius: '50%',
                border: '2.5px solid color-mix(in srgb, var(--accent-primary) 18%, transparent)',
                borderTopColor: 'var(--accent-primary-light)',
                animation: 'spin 0.9s linear infinite',
            }} />
            {label && (
                <div style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--accent-primary-light)',
                    letterSpacing: '-0.01em',
                }}>{label}</div>
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
    onSectionChange,
    wsStatus = 'connected',
    isStandalone = false,
}: DashboardMobileChatInboxProps) {
    const isDisconnected = wsStatus === 'disconnected' || wsStatus === 'reconnecting' || wsStatus === 'offline' || wsStatus === 'auth_failed'
    const hasMachines = machineCards.length > 0
    const hasAnyConversation = attentionItems.length > 0 || unreadItems.length > 0 || workingItems.length > 0 || completedItems.length > 0
    const inboxTitle = section === 'machines'
        ? 'Machines'
        : section === 'settings'
        ? 'Settings'
        : 'Chats'

    return (
        <>
            <div className="dashboard-mobile-chat-inbox-header">
                <div className="dashboard-mobile-chat-inbox-title">
                    <div className="dashboard-mobile-chat-app-title">
                        <span>{inboxTitle}</span>
                    </div>
                </div>
                {section === 'chats' && (attentionItems.length > 0 || unreadItems.length > 0) && (
                    <div className="dashboard-mobile-chat-header-pill">
                        <IconBell size={13} />
                        <span>{attentionItems.length + unreadItems.length}</span>
                    </div>
                )}
            </div>

            <div className="dashboard-mobile-chat-inbox">
                {section === 'chats' && attentionItems.length > 0 && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-alert-panel">
                            <span className="dashboard-mobile-chat-alert-title">Needs attention</span>
                            <span className="dashboard-mobile-chat-alert-meta">{attentionItems.length} action needed</span>
                        </div>
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-alert-panel">
                            <span className="dashboard-mobile-chat-alert-title">Task complete</span>
                            <span className="dashboard-mobile-chat-alert-meta">{unreadItems.length} unread</span>
                        </div>
                    </section>
                )}

                {section === 'machines' && (
                    <section className="dashboard-mobile-chat-section">
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
                                        style={{
                                            width: 48,
                                            height: 48,
                                            objectFit: 'contain',
                                            animation: 'bounce 3s infinite',
                                        }}
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
                                    <div style={{ width: '100%', maxWidth: 360, marginTop: 16 }}>
                                        <InstallCommand />
                                    </div>
                                )}
                            </MobileEmptyHero>
                        ) : (
                            machineCards.map(machine => (
                                <button
                                    key={machine.id}
                                    className="dashboard-mobile-chat-card"
                                    onClick={() => onOpenMachine(machine.id)}
                                    type="button"
                                >
                                    <span className="dashboard-mobile-chat-avatar machine">
                                        {getAvatarText(machine.label)}
                                    </span>
                                    <div className="dashboard-mobile-chat-card-main">
                                        <div className="dashboard-mobile-chat-card-top">
                                            <span className="dashboard-mobile-chat-card-title">{machine.label}</span>
                                            <span className="dashboard-mobile-chat-card-time">
                                                {machine.unread > 0 ? `${machine.unread} new` : machine.total > 0 ? `${machine.total} chats` : 'Idle'}
                                            </span>
                                        </div>
                                        <div className="dashboard-mobile-chat-card-subtitle">{machine.subtitle}</div>
                                        {machine.total > 0 ? (
                                            <div className="dashboard-mobile-chat-card-preview">
                                                {machine.total} chat{machine.total !== 1 ? 's' : ''}{machine.unread > 0 ? ` · ${machine.unread} unread` : ''}
                                            </div>
                                        ) : (
                                            <div className="dashboard-mobile-chat-card-preview">
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
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title">Needs attention</div>
                        {attentionItems.map(item => (
                            <button
                                key={item.conversation.tabKey}
                                className="dashboard-mobile-chat-card is-unread"
                                onClick={() => onOpenConversation(item.conversation)}
                                type="button"
                            >
                                <span className="dashboard-mobile-chat-avatar unread">
                                    {getAvatarText(item.conversation.displayPrimary)}
                                </span>
                                <div className="dashboard-mobile-chat-card-main">
                                    <div className="dashboard-mobile-chat-card-top">
                                        <span className="dashboard-mobile-chat-card-title">{item.conversation.displayPrimary}</span>
                                        <span className="dashboard-mobile-chat-card-time">{formatRelativeTime(item.timestamp)}</span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">
                                        {item.conversation.displaySecondary}
                                        {item.conversation.machineName && (
                                            <> · 🖥 {item.conversation.machineName}</>
                                        )}
                                        {' · Action needed'}
                                    </div>
                                    <div className="dashboard-mobile-chat-card-preview">{item.preview}</div>
                                </div>
                                <span className="dashboard-mobile-chat-unread-dot" />
                            </button>
                        ))}
                    </section>
                )}

                {section === 'chats' && unreadItems.length > 0 && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title">Task complete</div>
                        {unreadItems.map(item => (
                            <button
                                key={item.conversation.tabKey}
                                className="dashboard-mobile-chat-card is-unread"
                                onClick={() => onOpenConversation(item.conversation)}
                                type="button"
                            >
                                <span className="dashboard-mobile-chat-avatar unread">
                                    {getAvatarText(item.conversation.displayPrimary)}
                                </span>
                                <div className="dashboard-mobile-chat-card-main">
                                    <div className="dashboard-mobile-chat-card-top">
                                        <span className="dashboard-mobile-chat-card-title">{item.conversation.displayPrimary}</span>
                                        <span className="dashboard-mobile-chat-card-time">{formatRelativeTime(item.timestamp)}</span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">
                                        {item.conversation.displaySecondary}
                                        {item.conversation.machineName && (
                                            <> · 🖥 {item.conversation.machineName}</>
                                        )}
                                    </div>
                                    <div className="dashboard-mobile-chat-card-preview">{item.preview}</div>
                                </div>
                                <span className="dashboard-mobile-chat-unread-dot" />
                            </button>
                        ))}
                    </section>
                )}

                {section === 'chats' && workingItems.length > 0 && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title">Working now</div>
                        {workingItems.map(item => (
                            <button
                                key={item.conversation.tabKey}
                                className="dashboard-mobile-chat-card"
                                onClick={() => onOpenConversation(item.conversation)}
                                type="button"
                            >
                                <span className="dashboard-mobile-chat-avatar working">
                                    {getAvatarText(item.conversation.displayPrimary)}
                                </span>
                                <div className="dashboard-mobile-chat-card-main">
                                    <div className="dashboard-mobile-chat-card-top">
                                        <span className="dashboard-mobile-chat-card-title">{item.conversation.displayPrimary}</span>
                                        <span className="dashboard-mobile-chat-card-time">{formatRelativeTime(item.timestamp)}</span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">
                                        {item.conversation.displaySecondary}
                                        {item.conversation.machineName && (
                                            <> · 🖥 {item.conversation.machineName}</>
                                        )}
                                    </div>
                                    <div className="dashboard-mobile-chat-card-preview">{item.preview}</div>
                                </div>
                                <span className="dashboard-mobile-chat-status-badge">Live</span>
                            </button>
                        ))}
                    </section>
                )}

                {section === 'chats' && (
                    <section className="dashboard-mobile-chat-section">
                        {completedItems.length > 0 && (
                            <div className="dashboard-mobile-chat-section-title">Earlier</div>
                        )}
                        {completedItems.length > 0 ? completedItems.map(item => (
                            <button
                                key={item.conversation.tabKey}
                                className="dashboard-mobile-chat-card is-muted"
                                onClick={() => onOpenConversation(item.conversation)}
                                type="button"
                            >
                                <span className="dashboard-mobile-chat-avatar">
                                    {getAvatarText(item.conversation.displayPrimary)}
                                </span>
                                <div className="dashboard-mobile-chat-card-main">
                                    <div className="dashboard-mobile-chat-card-top">
                                        <span className="dashboard-mobile-chat-card-title">{item.conversation.displayPrimary}</span>
                                        <span className="dashboard-mobile-chat-card-time">{formatRelativeTime(item.timestamp)}</span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">
                                        {item.conversation.displaySecondary}
                                        {item.conversation.machineName && (
                                            <> · 🖥 {item.conversation.machineName}</>
                                        )}
                                    </div>
                                    <div className="dashboard-mobile-chat-card-preview">{item.preview}</div>
                                </div>
                            </button>
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
                                            style={{ width: 40, height: 40, objectFit: 'contain', opacity: 0.7 }}
                                        />
                                    }
                                    title="No machines connected"
                                    subtitle="Switch to the Machines tab to connect your first machine and start chatting with AI agents."
                                />
                            ) : (
                                <MobileEmptyHero
                                    icon={
                                        <div style={{
                                            width: 44,
                                            height: 44,
                                            borderRadius: 14,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                                            color: 'var(--accent-primary-light)',
                                            fontSize: 20,
                                        }}>💬</div>
                                    }
                                    title="No conversations yet"
                                    subtitle="Your machines are connected. Open an IDE or launch a CLI agent to start your first conversation."
                                />
                            )
                        ) : (
                            <div className="dashboard-mobile-chat-empty">
                                All caught up.
                            </div>
                        )}
                    </section>
                )}

                {section === 'chats' && hiddenConversations.length > 0 && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title dashboard-mobile-chat-section-title-row">
                            <span>Hidden</span>
                            <button
                                type="button"
                                className="dashboard-mobile-chat-inline-action"
                                onClick={onShowAllHidden}
                            >
                                Restore all
                            </button>
                        </div>
                        {hiddenConversations.map(conversation => (
                            <button
                                key={conversation.tabKey}
                                className="dashboard-mobile-chat-card is-muted"
                                onClick={() => onShowConversation(conversation)}
                                type="button"
                            >
                                <span className="dashboard-mobile-chat-avatar">
                                    {getAvatarText(conversation.displayPrimary)}
                                </span>
                                <div className="dashboard-mobile-chat-card-main">
                                    <div className="dashboard-mobile-chat-card-top">
                                        <span className="dashboard-mobile-chat-card-title">{conversation.displayPrimary}</span>
                                        <span className="dashboard-mobile-chat-card-time">Hidden</span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">
                                        {conversation.displaySecondary}
                                        {conversation.machineName && (
                                            <> · 🖥 {conversation.machineName}</>
                                        )}
                                    </div>
                                    <div className="dashboard-mobile-chat-card-preview">
                                        Tap to restore and open
                                    </div>
                                </div>
                            </button>
                        ))}
                    </section>
                )}

                {section === 'settings' && (
                    <section className="dashboard-mobile-chat-section">
                        <button
                            className="dashboard-mobile-chat-card"
                            onClick={onOpenSettings}
                            type="button"
                        >
                            <span className="dashboard-mobile-chat-avatar settings">
                                <IconSettings size={16} />
                            </span>
                            <div className="dashboard-mobile-chat-card-main">
                                <div className="dashboard-mobile-chat-card-top">
                                    <span className="dashboard-mobile-chat-card-title">Appearance & chat settings</span>
                                </div>
                                <div className="dashboard-mobile-chat-card-subtitle">Theme, accent, chat visuals</div>
                                <div className="dashboard-mobile-chat-card-preview">
                                    Open the full settings page for theme, notifications, and provider preferences.
                                </div>
                            </div>
                        </button>
                        <div className="dashboard-mobile-chat-settings-note">
                            Notifications panel: unread and action-needed conversations are surfaced in the Chats section. Mobile workspace mode can be enabled from Settings.
                        </div>
                    </section>
                )}
            </div>

            <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
        </>
    )
}
