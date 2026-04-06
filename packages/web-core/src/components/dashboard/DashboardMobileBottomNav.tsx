import { IconChat, IconMonitor } from '../Icons'

export type DashboardMobileSection = 'machines' | 'chats'

interface DashboardMobileBottomNavProps {
    section: DashboardMobileSection
    onSectionChange: (section: DashboardMobileSection) => void
}

export default function DashboardMobileBottomNav({
    section,
    onSectionChange,
}: DashboardMobileBottomNavProps) {
    const items: Array<{
        key: DashboardMobileSection
        label: string
        icon: typeof IconChat
    }> = [
        { key: 'machines', label: 'Machines', icon: IconMonitor },
        { key: 'chats', label: 'Chats', icon: IconChat },
    ]

    return (
        <div className="px-3 py-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))] border-t border-border-subtle/70 bg-bg-secondary/88 backdrop-blur-md shrink-0">
            <div
                className="grid grid-cols-2 gap-1.5 rounded-[20px] border p-1 shadow-[0_10px_28px_rgba(15,23,42,0.08)]"
                style={{
                    background: 'color-mix(in srgb, var(--bg-glass) 82%, var(--surface-primary))',
                    borderColor: 'color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)',
                }}
            >
                {items.map(({ key, label, icon: Icon }) => {
                const isActive = section === key
                return (
                    <button
                        key={key}
                        className={`min-h-[46px] rounded-[16px] px-3 flex items-center justify-center gap-2.5 text-[13px] font-semibold tracking-tight transition-all border ${
                            isActive 
                                ? 'bg-surface-primary border-border-default/90 text-text-primary shadow-[0_4px_14px_rgba(15,23,42,0.08)]'
                                : 'bg-transparent border-transparent text-text-muted hover:text-text-primary'
                        }`}
                        style={isActive ? {
                            background: 'color-mix(in srgb, var(--accent-primary) 10%, var(--surface-primary))',
                            borderColor: 'color-mix(in srgb, var(--accent-primary) 24%, var(--border-default))',
                            boxShadow: '0 8px 22px color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                        } : undefined}
                        onClick={() => onSectionChange(key)}
                        type="button"
                        aria-pressed={isActive}
                    >
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors ${
                            isActive
                                ? 'text-accent-primary'
                                : 'bg-transparent text-current'
                        }`}
                        style={isActive ? {
                            background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)',
                        } : undefined}>
                            <Icon size={15} />
                        </span>
                        <span>{label}</span>
                    </button>
                )
                })}
            </div>
        </div>
    )
}
