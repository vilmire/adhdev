import { useState, useEffect } from 'react'
import AppPage from '../components/ui/AppPage'
import { Section } from '../components/ui/Section'
import { EmptyState } from '../components/ui/EmptyState'
import { IconMonitor, IconTerminal, IconPlug, IconClock, IconWarning, IconShield, IconBook } from '../components/Icons'

export default function CapabilitiesPage() {
    const [capabilities, setCapabilities] = useState<{
        ide: any[],
        cli: any[],
        ext: any[],
        acp: any[]
    }>({ ide: [], cli: [], ext: [], acp: [] })
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetch('https://raw.githubusercontent.com/vilmire/adhdev-providers/main/registry.json')
            .then(res => res.json())
            .then(data => {
                const ide: any[] = [], cli: any[] = [], ext: any[] = [], acp: any[] = []
                Object.values(data.providers || {}).forEach((p: any) => {
                    const item = {
                        name: p.name || 'Unknown',
                        status: p.status || 'Stable',
                        details: p.details || 'Community Provider'
                    }
                    if (p.category === 'ide') ide.push(item)
                    else if (p.category === 'cli') cli.push(item)
                    else if (p.category === 'extension') ext.push(item)
                    else if (p.category === 'acp') acp.push(item)
                })

                // Sort function (Stable -> Beta -> WIP) -> alphabetical
                const sortByStatus = (a: any, b: any) => {
                    const order: Record<string, number> = { 'Stable': 1, 'Beta': 2, 'WIP': 3 }
                    const valA = order[a.status] || 99
                    const valB = order[b.status] || 99
                    if (valA !== valB) return valA - valB
                    return a.name.localeCompare(b.name)
                }

                setCapabilities({
                    ide: ide.sort(sortByStatus),
                    cli: cli.sort(sortByStatus),
                    ext: ext.sort(sortByStatus),
                    acp: acp.sort(sortByStatus)
                })
            })
            .catch(err => console.error('Failed to load capabilities:', err))
            .finally(() => setLoading(false))
    }, [])

    const renderStatus = (status: string) => {
        if (status === 'Stable') {
            return <div className="flex items-center gap-1.5 text-success"><IconShield className="w-4 h-4" /> <span>Stable</span></div>
        }
        if (status === 'Beta') {
            return <div className="flex items-center gap-1.5 text-warning"><IconWarning className="w-4 h-4" /> <span>Beta</span></div>
        }
        return <div className="flex items-center gap-1.5 text-text-muted"><IconClock className="w-4 h-4" /> <span>{status}</span></div>
    }

    const renderTable = (items: any[]) => (
        <div className="bg-bg-card border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="bg-bg-secondary border-b border-border-subtle text-xs uppercase text-text-muted font-medium tracking-wider">
                        <th className="py-3 px-4 w-1/3">Target</th>
                        <th className="py-3 px-4 w-1/4">Status</th>
                        <th className="py-3 px-4">Details</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-sm">
                    {items.map((item, i) => (
                        <tr key={i} className="hover:bg-bg-subtle/50 transition-colors">
                            <td className="py-3 px-4 font-medium text-text-main">{item.name}</td>
                            <td className="py-3 px-4">{renderStatus(item.status)}</td>
                            <td className="py-3 px-4 text-text-muted">{item.details}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    if (loading) {
        return (
            <AppPage
                title="Capabilities"
                subtitle="Provider registry coverage for IDEs, CLI agents, extensions, and ACPs"
                icon={<IconBook />}
                widthClassName="max-w-5xl"
            >
                <EmptyState
                    icon={<div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto" />}
                    title="Loading provider registry"
                    description="Fetching the latest support matrix from the shared provider registry."
                />
            </AppPage>
        )
    }

    return (
        <AppPage
            title="Capabilities"
            subtitle="Provider registry coverage for IDEs, CLI agents, extensions, and ACPs"
            icon={<IconBook />}
            widthClassName="max-w-5xl"
            contentClassName="animate-fade-in"
        >
            <Section title="Registry overview" description="Support status is loaded from the shared provider registry used across OSS and cloud surfaces.">
                <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">IDEs</div>
                        <div className="text-2xl font-semibold text-text-primary">{capabilities.ide.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">CLI</div>
                        <div className="text-2xl font-semibold text-text-primary">{capabilities.cli.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Extensions</div>
                        <div className="text-2xl font-semibold text-text-primary">{capabilities.ext.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">ACP</div>
                        <div className="text-2xl font-semibold text-text-primary">{capabilities.acp.length}</div>
                    </div>
                </div>
            </Section>

            <Section title="IDE support" icon={<IconMonitor className="w-4 h-4" />} description="Desktop editors and IDE surfaces with registry-backed providers.">
                {renderTable(capabilities.ide)}
            </Section>

            <Section title="Standalone CLI agents" icon={<IconTerminal className="w-4 h-4" />} description="CLI-first agents that can participate in the standalone dashboard.">
                {renderTable(capabilities.cli)}
            </Section>

            <Section title="AI extensions" icon={<IconPlug className="w-4 h-4" />} description="IDE extensions and companion integrations available in the registry.">
                {renderTable(capabilities.ext)}
            </Section>

            <Section title={`ACP agents (${capabilities.acp.length} loaded)`} icon={<IconPlug className="w-4 h-4" />} description="ACP-backed providers discovered through the same shared registry.">
                {renderTable(capabilities.acp)}
            </Section>
        </AppPage>
    )
}
