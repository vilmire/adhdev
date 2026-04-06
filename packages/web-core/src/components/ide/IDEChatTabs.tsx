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
        <div className="flex border-b border-border-subtle bg-surface-primary shrink-0">
            <button
                className={`flex-1 py-2.5 px-4 border-b-2 text-[11px] font-bold tracking-wide cursor-pointer transition-all font-[var(--font)] ${
                    activeChatTab === 'native'
                        ? 'text-text-primary border-accent-primary bg-bg-primary'
                        : 'text-text-muted border-transparent bg-transparent hover:text-text-secondary'
                }`}
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
                        className={`flex-1 py-2.5 px-4 border-b-2 text-[11px] font-bold tracking-wide cursor-pointer transition-all font-[var(--font)] flex items-center justify-center gap-1.5 ${
                            isActive
                                ? 'text-text-primary border-accent-primary bg-bg-primary'
                                : 'text-text-muted border-transparent bg-transparent hover:text-text-secondary'
                        }`}
                        onClick={() => onSelectTab(tab.tabKey)}
                    >
                        <span
                            className="shrink-0"
                            style={{
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: needsApproval ? 'var(--status-warning)' : isGenerating ? 'var(--accent-primary)' : 'var(--text-muted)',
                                boxShadow: isGenerating ? '0 0 6px var(--accent-primary)' : 'none',
                            }}
                        />
                        {tab.title}
                        {needsApproval && (
                            <span
                                className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ml-0.5"
                                style={{ background: 'color-mix(in srgb, var(--status-warning) 13%, transparent)', color: 'var(--status-warning)' }}
                            >!</span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}
