import AppPage from '../components/ui/AppPage'
import { Section } from '../components/ui/Section'
import { IconMonitor, IconTerminal, IconPlug, IconClock, IconWarning, IconShield, IconBook } from '../components/Icons'
import {
    BUILTIN_ACP_COUNT,
    BUILTIN_CLI_AGENTS,
    BUILTIN_EXTENSIONS,
    BUILTIN_IDES,
    PROVIDER_VERIFICATION,
    getProviderVerification,
    type ProviderVerification,
    type ProviderVerificationStatus,
    type SupportedEntry,
} from '../constants/supported'

type CapabilityCategory = 'ide' | 'cli' | 'extension' | 'acp'

interface CapabilityItem {
    id: string
    name: string
    category: CapabilityCategory
    details: string
    verification: ProviderVerification
}

const CATEGORY_DETAILS: Record<CapabilityCategory, string> = {
    ide: 'Desktop IDE integration',
    cli: 'PTY-backed CLI provider',
    extension: 'Extension stream integration',
    acp: 'ACP adapter',
}

const STATUS_ORDER: Record<ProviderVerificationStatus, number> = {
    verified: 1,
    partial: 2,
    unverified: 3,
}

function providerNameFromId(providerId: string) {
    const normalized = providerId.replace(/-acp$/, '')
    const specialCases: Record<string, string> = {
        github: 'GitHub',
        vscode: 'VS Code',
        vscodium: 'VSCodium',
        qwen: 'Qwen',
        kimi: 'Kimi',
        openhands: 'OpenHands',
        opencode: 'OpenCode',
        openclaw: 'OpenClaw',
        autodev: 'AutoDev',
        autohand: 'AutoHand',
        deepagents: 'DeepAgents',
        dimcode: 'DimCode',
        vtcode: 'VT Code',
        codebuddy: 'CodeBuddy',
        qoder: 'Qoder',
    }

    const label = normalized
        .split('-')
        .map((part) => specialCases[part] || (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
        .join(' ')
        .trim()

    return providerId.endsWith('-acp') ? `${label} ACP` : label
}

function sortCapabilities(items: CapabilityItem[]) {
    return [...items].sort((a, b) => {
        const orderDiff = STATUS_ORDER[a.verification.status] - STATUS_ORDER[b.verification.status]
        if (orderDiff !== 0) return orderDiff
        return a.name.localeCompare(b.name)
    })
}

function createInventoryItem(entry: SupportedEntry, category: Exclude<CapabilityCategory, 'acp'>): CapabilityItem {
    return {
        id: entry.id,
        name: entry.name,
        category,
        details: CATEGORY_DETAILS[category],
        verification: getProviderVerification(entry.id),
    }
}

function createAcpInventory(): CapabilityItem[] {
    return sortCapabilities(
        Object.keys(PROVIDER_VERIFICATION)
            .filter((providerId) => providerId.endsWith('-acp'))
            .map((providerId) => ({
                id: providerId,
                name: providerNameFromId(providerId),
                category: 'acp' as const,
                details: CATEGORY_DETAILS.acp,
                verification: getProviderVerification(providerId),
            })),
    )
}

const IDE_CAPABILITIES = sortCapabilities(BUILTIN_IDES.map((entry) => createInventoryItem(entry, 'ide')))
const CLI_CAPABILITIES = sortCapabilities(BUILTIN_CLI_AGENTS.map((entry) => createInventoryItem(entry, 'cli')))
const EXTENSION_CAPABILITIES = sortCapabilities(BUILTIN_EXTENSIONS.map((entry) => createInventoryItem(entry, 'extension')))
const ACP_CAPABILITIES = createAcpInventory()

const SUMMARY_COUNTS = [...IDE_CAPABILITIES, ...CLI_CAPABILITIES, ...EXTENSION_CAPABILITIES, ...ACP_CAPABILITIES]
    .reduce((counts, item) => {
        counts[item.verification.status] += 1
        return counts
    }, { verified: 0, partial: 0, unverified: 0 } as Record<ProviderVerificationStatus, number>)

function renderStatus(verification: ProviderVerification) {
    if (verification.status === 'verified') {
        return <div className="flex items-center gap-1.5 text-success"><IconShield className="w-4 h-4" /> <span>Verified</span></div>
    }
    if (verification.status === 'partial') {
        return <div className="flex items-center gap-1.5 text-warning"><IconWarning className="w-4 h-4" /> <span>Partial</span></div>
    }
    return <div className="flex items-center gap-1.5 text-text-muted"><IconClock className="w-4 h-4" /> <span>Unverified</span></div>
}

function renderEvidence(verification: ProviderVerification) {
    if (
        verification.status === 'unverified'
        && verification.validatedFlows.length === 0
        && verification.testedOn.length === 0
        && verification.testedVersions.length === 0
        && !verification.notes
    ) {
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

function renderTable(items: CapabilityItem[]) {
    return (
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
                    {items.map((item) => (
                        <tr key={item.id} className="hover:bg-bg-subtle/50 transition-colors">
                            <td className="py-3 px-4 font-medium text-text-main">{item.name}</td>
                            <td className="py-3 px-4">{renderStatus(item.verification)}</td>
                            <td className="py-3 px-4 text-text-muted">
                                <div>{item.details}</div>
                                <div className="mt-1">{renderEvidence(item.verification)}</div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export default function CapabilitiesPage() {
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
                    This page is rendered from the shared provider catalog synced into web-core constants. It does not fetch live registry data at runtime, and it treats every provider as <strong className="text-text-primary">unverified</strong> unless explicit validation evidence has been recorded.
                </div>
            </Section>

            <Section title="Verification Summary" description="Promotion requires an evidence record, not just inventory presence or a successful launch once.">
                <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Verified</div>
                        <div className="text-2xl font-semibold text-success">{SUMMARY_COUNTS.verified}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Partial</div>
                        <div className="text-2xl font-semibold text-warning">{SUMMARY_COUNTS.partial}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Unverified</div>
                        <div className="text-2xl font-semibold text-text-primary">{SUMMARY_COUNTS.unverified}</div>
                    </div>
                </div>
            </Section>

            <Section title="Inventory Overview" description="Counts come from the synced built-in catalog, not a runtime registry fetch.">
                <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">IDEs</div>
                        <div className="text-2xl font-semibold text-text-primary">{IDE_CAPABILITIES.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">CLI</div>
                        <div className="text-2xl font-semibold text-text-primary">{CLI_CAPABILITIES.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Extensions</div>
                        <div className="text-2xl font-semibold text-text-primary">{EXTENSION_CAPABILITIES.length}</div>
                    </div>
                    <div className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">ACP</div>
                        <div className="text-2xl font-semibold text-text-primary">{BUILTIN_ACP_COUNT}</div>
                    </div>
                </div>
            </Section>

            <Section title="IDE Inventory" icon={<IconMonitor className="w-4 h-4" />} description="Desktop editors and IDE surfaces with built-in integrations.">
                {renderTable(IDE_CAPABILITIES)}
            </Section>

            <Section title="CLI Inventory" icon={<IconTerminal className="w-4 h-4" />} description="CLI-first agents available through the built-in PTY adapter layer.">
                {renderTable(CLI_CAPABILITIES)}
            </Section>

            <Section title="Extension Inventory" icon={<IconPlug className="w-4 h-4" />} description="Extension providers with dedicated stream or session adapters.">
                {renderTable(EXTENSION_CAPABILITIES)}
            </Section>

            <Section title={`ACP Inventory (${BUILTIN_ACP_COUNT} loaded)`} icon={<IconPlug className="w-4 h-4" />} description="ACP adapters derived from the shared verification catalog.">
                {renderTable(ACP_CAPABILITIES)}
            </Section>
        </AppPage>
    )
}
