/**
 * StatCard — shared Stat card component
 *
 * Used in MachineDetail Overview, Dashboard, etc.
 */
import Card from './Card'

interface StatCardProps {
    label: string
    value: string
    sub?: string
    icon: React.ReactNode
}

export default function StatCard({ label, value, sub, icon }: StatCardProps) {
    return (
        <Card>
            <div className="flex items-center gap-2 mb-1.5">
                <span className="text-base flex items-center">{icon}</span>
                <span className="text-[10px] text-text-muted uppercase tracking-wide font-semibold">{label}</span>
            </div>
            <div className="text-[22px] font-bold text-text-primary tracking-tight">{value}</div>
            {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
        </Card>
    )
}
