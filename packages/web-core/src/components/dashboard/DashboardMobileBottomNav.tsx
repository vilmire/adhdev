export type DashboardMobileSection = 'machines' | 'chats'

interface DashboardMobileBottomNavProps {
    section: DashboardMobileSection
    onSectionChange: (section: DashboardMobileSection) => void
}

export default function DashboardMobileBottomNav({
    section,
    onSectionChange,
}: DashboardMobileBottomNavProps) {
    return (
        <div className="grid grid-cols-2 gap-2 px-3 py-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))] border-t border-[#ffffff0a] bg-bg-secondary/90 backdrop-blur-md shrink-0">
            {([
                ['machines', 'Machines'],
                ['chats', 'Chats'],
            ] as const).map(([key, label]) => {
                const isActive = section === key
                return (
                    <button
                        key={key}
                        className={`min-h-[42px] rounded-xl text-[13px] font-bold tracking-tight transition-all border ${
                            isActive 
                                ? 'bg-accent-primary border-transparent text-white shadow-glow' 
                                : 'bg-bg-primary border border-[#ffffff10] text-text-secondary hover:bg-bg-secondary hover:text-text-primary shadow-sm'
                        }`}
                        onClick={() => onSectionChange(key)}
                        type="button"
                    >
                        {label}
                    </button>
                )
            })}
        </div>
    )
}
