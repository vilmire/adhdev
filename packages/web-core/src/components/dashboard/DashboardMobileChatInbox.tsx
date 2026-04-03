import { IconBell, IconSettings } from '../Icons'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineCard } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'

interface DashboardMobileChatInboxProps {
    section: 'machines' | 'chats' | 'settings'
    attentionItems: MobileConversationListItem[]
    unreadItems: MobileConversationListItem[]
    workingItems: MobileConversationListItem[]
    completedItems: MobileConversationListItem[]
    machineCards: MobileMachineCard[]
    getAvatarText: (primary: string) => string
    getConversationPreview: (conversation: ActiveConversation) => string
    onOpenConversation: (conversation: ActiveConversation) => void
    onOpenMachine: (machineId: string) => void
    onOpenSettings: () => void
    onSectionChange: (section: 'machines' | 'chats' | 'settings') => void
}

export default function DashboardMobileChatInbox({
    section,
    attentionItems,
    unreadItems,
    workingItems,
    completedItems,
    machineCards,
    getAvatarText,
    getConversationPreview,
    onOpenConversation,
    onOpenMachine,
    onOpenSettings,
    onSectionChange,
}: DashboardMobileChatInboxProps) {
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
                        {machineCards.map(machine => (
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
                                            {machine.unread > 0 ? `${machine.unread} new` : `${machine.total} chats`}
                                        </span>
                                    </div>
                                    <div className="dashboard-mobile-chat-card-subtitle">{machine.subtitle}</div>
                                    <div className="dashboard-mobile-chat-card-preview">
                                        {machine.latestConversation.displayPrimary} · {getConversationPreview(machine.latestConversation)}
                                    </div>
                                </div>
                            </button>
                        ))}
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
                                    <div className="dashboard-mobile-chat-card-subtitle">{item.conversation.displaySecondary}</div>
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
                                    <div className="dashboard-mobile-chat-card-subtitle">{item.conversation.displaySecondary}</div>
                                    <div className="dashboard-mobile-chat-card-preview">{item.preview}</div>
                                </div>
                            </button>
                        )) : (
                            <div className="dashboard-mobile-chat-empty">
                                No completed conversations yet.
                            </div>
                        )}
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

            <div className="dashboard-mobile-chat-nav">
                {([
                    ['machines', 'Machines'],
                    ['chats', 'Chats'],
                    ['settings', 'Settings'],
                ] as const).map(([key, label]) => (
                    <button
                        key={key}
                        className={`dashboard-mobile-chat-nav-tab${section === key ? ' is-active' : ''}`}
                        onClick={() => onSectionChange(key)}
                        type="button"
                    >
                        {label}
                    </button>
                ))}
            </div>
        </>
    )
}
