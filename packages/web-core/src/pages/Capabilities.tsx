import { useState, useEffect } from 'react'
import AppPage from '../components/ui/AppPage'
import { Section } from '../components/ui/Section'
import { EmptyState } from '../components/ui/EmptyState'
import { IconMonitor, IconTerminal, IconPlug, IconClock, IconWarning, IconShield, IconBook } from '../components/Icons'
import { getProviderVerification, type ProviderVerification, type ProviderVerificationStatus } from '../constants/supported'

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
                Object.entries(data.providers || {}).forEach(([providerId, p]: [string, any]) => {
                    const verification = getProviderVerification(providerId)
                    const item = {
                        id: providerId,
                        name: p.name || 'Unknown',
                        verification,
                        registryStatus: p.status || 'Stable',
                        details: p.details || 'Community Provider'
                    }
                    if (p.category === 'ide') ide.push(item)
                    else if (p.category === 'cli') cli.push(item)
                    else if (p.category === 'extension') ext.push(item)
                    else if (p.category === 'acp') acp.push(item)
                })

                // Sort function (verified -> partial -> unverified) -> alphabetical
                const sortByStatus = (a: any, b: any) => {
                    const order: Record<ProviderVerificationStatus, number> = { verified: 1, partial: 2, unverified: 3 }
                    const valA = order[a.verification.status] || 99
                    const valB = order[b.verification.status] || 99
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

    const renderStatus = (verification: ProviderVerification) => {
        if (verification.status === 'verified') {
            return <div className="flex items-center gap-1.5 text-success"><IconShield className="w-4 h-4" /> <span>Verified</span></div>
        }
        if (verification.status === 'partial') {
            return <div className="flex items-center gap-1.5 text-warning"><IconWarning className="w-4 h-4" /> <span>Partial</span></div>
        }
        return <div className="flex items-center gap-1.5 text-text-muted"><IconClock className="w-4 h-4" /> <span>Unverified</span></div>
    }

    const renderEvidence = (verification: ProviderVerification) => {
        if (verification.status === 'unverified' && verification.validatedFlows.length === 0 && verification.testedOn.length === 0 && verification.testedVersions.length === 0 && !verification.notes) {
            return <div>No recorded validation evidence yet.</div>
        }
        return (
            <div className="space-y-1">
                {verification.notes ? <div>{verification.notes}</div> : null}
                {verification.testedOn.length > 0 ? <div className="text-[11px] text-text-muted/80">Tested on: {verification.testedOn.join(', ')}</div> : null}
                {verification.testedVersions.length > 0 ? <div className="text-[11px] text-text-muted/80">Versions: {verification.testedVersions.join(', ')}</div> : null}
                {verification.validatedFlows.length > 0 ? <div className="text-[11px] text-text-muted/80">Flows: {verification.validatedFlows.join(', ')}</div> : null}
                {verification.lastValidated ? <div className="text-[11px] text-text-muted/80">Last validated: {verification.lastValidated}</div> : null}
                {verification.evidence ? <div className="text-[11px] text-text-muted/80">Evidence: {verification.evidence}</div> : null}
            </div>
        )
    }

    const summaryCounts = Object.values(capabilities).flat().reduce((counts, item: any) => {
        counts[item.verification.status] += 1
        return counts
    }, { verified: 0, partial: 0, unverified: 0 } as Record<ProviderVerificationStatus, number>)

    const renderTable = (items: any[]) => (
        <div className="bg-bg-card border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="bg-bg-secondary border-b border-border-subtle text-xs uppercase text-text-muted font-medium tracking-wider">
                        <th className="py-3 px-4 w-1/3">Target</th>
                        <th className="py-3 px-4 w-1/4">Verification</th>
                        <th className="py-3 px-4">Details</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-sm">
                    {items.map((item, i) => (
                        <tr key={i} className="hover:bg-bg-subtle/50 transition-colors">
                            <td className="py-3 px-4 font-medium text-text-main">{item.name}</td>
                            <td className="py-3 px-4">{renderStatus(item.verification)}</td>
                            <td className="py-3 px-4 text-text-muted">
                                <div>{item.details}</div>
                                <div className="mt-1">{renderEvidence(item.verification)}</div>
                                <div className="text-[11px] text-text-muted/70 mt-1">Registry lifecycle: {item.registryStatus}</div>
                            </td>
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
                subtitle="Built-in provider inventory with verification status"
                icon={<IconBook />}
                widthClassName="max-w-5xl"
            >
                <EmptyState
                    icon={<div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto" />}
                    title="Loading provider registry"
                    description="Fetching the latest provider inventory and local verification policy."
                />
            </AppPage>
        )
    }

    return (
        <AppPage
            title="Capabilities"
            subtitle="Built-in provider inventory with conservative verification defaults"
            icon={<IconBook />}
            widthClassName="max-w-5xl"
            contentClassName="animate-fade-in"
        >
            <Section title="Verification Policy" description="Built-in does not mean supported. Providers are unverified by default until they are explicitly tested and promoted.">
                <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-secondary leading-relaxed">
                    ADHDev ships a broad provider inventory, but this page treats every provider as <strong className="text-text-primary">unverified</strong> unless it has been manually validated with recorded evidence. The upstream registry lifecycle field is shown for reference only.
                </div>
            </Section>

            <Section title="Verification Summary" description="Promotion requires an evidence record, not just registry presence or a successful launch once.">
                <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Verified</div>
                        <div className="text-2xl font-semibold text-success">{summaryCounts.verified}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Partial</div>
                        <div className="text-2xl font-semibold text-warning">{summaryCounts.partial}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Unverified</div>
                        <div className="text-2xl font-semibold text-text-primary">{summaryCounts.unverified}</div>
                    </div>
                </div>
            </Section>

            <Section title="Registry overview" description="Inventory counts loaded from the shared provider registry used across OSS and cloud surfaces.">
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

            <Section title="IDE inventory" icon={<IconMonitor className="w-4 h-4" />} description="Desktop editors and IDE surfaces with registry-backed providers.">
                {renderTable(capabilities.ide)}
            </Section>

            <Section title="CLI inventory" icon={<IconTerminal className="w-4 h-4" />} description="CLI-first agents that can participate in the standalone dashboard.">
                {renderTable(capabilities.cli)}
            </Section>

            <Section title="Extension inventory" icon={<IconPlug className="w-4 h-4" />} description="IDE extensions and companion integrations available in the registry.">
                {renderTable(capabilities.ext)}
            </Section>

            <Section title={`ACP inventory (${capabilities.acp.length} loaded)`} icon={<IconPlug className="w-4 h-4" />} description="ACP-backed providers discovered through the same shared registry.">
                {renderTable(capabilities.acp)}
            </Section>
        </AppPage>
    )
}
