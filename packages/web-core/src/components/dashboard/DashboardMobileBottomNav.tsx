import { useTranslation } from 'react-i18next'
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
    const { t } = useTranslation('common')
    // Shared nav.* namespace — the same labels the sidebar uses, so the
    // standalone and cloud shells can't drift apart again.
    const items: Array<{
        key: DashboardMobileSection
        label: string
        icon: typeof IconChat
    }> = [
        { key: 'machines', label: t('nav.machines'), icon: IconMonitor },
        { key: 'chats', label: t('nav.chats'), icon: IconChat },
    ]

    // `max(10px, inset)` (previous revision) kept the notched reservation pinned
    // to the 34px home-indicator inset alone, with no design padding added on top.
    // Owner-reported this read as too tight against the status-bar side: the
    // standalone top total is inset-top (59px) + the header's own top padding
    // (10px, `.dashboard-header` mobile rule) = 69px, and the bottom pill sat
    // right on the indicator with none of that margin. `calc(20px + inset)`
    // restores an additive design pad — chosen to bring the notched total (54px)
    // closer to the 69px top reference — while the flat-device case
    // (desktop, Android without a gesture bar, non-notched iPads, browser tabs)
    // still gets exactly the 20px design padding and nothing more.
    return (
        <div className="px-3 py-2.5 pb-[calc(20px+env(safe-area-inset-bottom,0px))] border-t border-border-subtle/70 bg-bg-secondary/88 backdrop-blur-md shrink-0">
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
                        className={`min-h-[46px] rounded-[16px] px-3 flex items-center justify-center gap-2.5 text-xxs font-semibold tracking-tight transition-all border ${
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
