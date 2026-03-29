import { useState, useEffect } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
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
        <div className="bg-bg-panel border border-border-card rounded-md overflow-hidden">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="bg-bg-subtle border-b border-border-card text-xs uppercase text-text-muted font-medium tracking-wider">
                        <th className="py-3 px-4 w-1/3">Target</th>
                        <th className="py-3 px-4 w-1/4">Status</th>
                        <th className="py-3 px-4">Details</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-card text-sm">
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
            <div className="p-8 max-w-4xl mx-auto flex flex-col items-center justify-center min-h-[50vh]">
                <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4" />
                <p className="text-text-muted">Loading providers registry...</p>
            </div>
        )
    }

    return (
        <div className="p-8 max-w-4xl mx-auto animate-fade-in pb-20">
            <PageHeader
                title="Capabilities & Provider Status"
                subtitle="Support matrix for IDEs, CLI Agents, and AI Extensions"
                icon={<IconBook />}
            />

            <div className="space-y-12 mt-8">
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-blue-500/10 text-blue-400">
                            <IconMonitor className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">IDE Support</h2>
                    </div>
                    {renderTable(capabilities.ide)}
                </section>

                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-purple-500/10 text-purple-400">
                            <IconTerminal className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">Standalone CLI Agents</h2>
                    </div>
                    {renderTable(capabilities.cli)}
                </section>

                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-green-500/10 text-green-400">
                            <IconPlug className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">AI Extensions</h2>
                    </div>
                    {renderTable(capabilities.ext)}
                </section>
                
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-orange-500/10 text-orange-400">
                            <IconPlug className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">ACP Agents ({capabilities.acp.length} loaded)</h2>
                    </div>
                    {renderTable(capabilities.acp)}
                </section>
            </div>
        </div>
    )
}
