export type DashboardMobileSection = 'machines' | 'chats' | 'settings'

interface DashboardMobileBottomNavProps {
    section: DashboardMobileSection
    onSectionChange: (section: DashboardMobileSection) => void
}

export default function DashboardMobileBottomNav({
    section,
    onSectionChange,
}: DashboardMobileBottomNavProps) {
    return (
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
    )
}
