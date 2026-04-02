interface IDEChatTabsProps {
    hasExtensions: boolean
    ideName: string
    activeChatTab: string
    extensionTabs: { tabKey: string; title: string; status: string }[]
    onSelectTab: (tabKey: string) => void
}

export default function IDEChatTabs({
    hasExtensions,
    ideName,
    activeChatTab,
    extensionTabs,
    onSelectTab,
}: IDEChatTabsProps) {
    if (!hasExtensions) return null

    return (
        <div className="ide-chat-tabs">
            <button
                className={`ide-chat-tab ${activeChatTab === 'native' ? 'active' : ''}`}
                onClick={() => onSelectTab('native')}
            >
                {ideName}
            </button>
            {extensionTabs.map(tab => {
                const isActive = activeChatTab === tab.tabKey
                const needsApproval = tab.status === 'waiting_approval'
                const isGenerating = tab.status === 'generating'

                return (
                    <button
                        key={tab.tabKey}
                        className={`ide-chat-tab ${isActive ? 'active' : ''}`}
                        onClick={() => onSelectTab(tab.tabKey)}
                    >
                        <span
                            style={{
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                marginRight: 5,
                                background: needsApproval ? 'var(--status-warning)' : isGenerating ? 'var(--accent-primary)' : '#64748b',
                                boxShadow: isGenerating ? '0 0 6px var(--accent-primary)' : 'none',
                            }}
                        />
                        {tab.title}
                        {needsApproval && (
                            <span className="ide-ext-badge" style={{ background: 'color-mix(in srgb, var(--status-warning) 13%, transparent)', color: 'var(--status-warning)', marginLeft: 4 }}>!</span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}
