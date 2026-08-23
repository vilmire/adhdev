import type { MeshCoordinatorManualSetup } from '../utils/mesh-coordinator-setup'

interface MeshCoordinatorManualSetupPanelProps {
    setup: MeshCoordinatorManualSetup | null | undefined
    providerName?: string | null
    className?: string
}

export default function MeshCoordinatorManualSetupPanel({
    setup,
    providerName,
    className = '',
}: MeshCoordinatorManualSetupPanelProps) {
    if (!setup) return null

    return (
        <div className={`rounded-xl border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-text-primary ${className}`}>
            <div className="font-semibold">
                Manual MCP setup required{providerName ? ` for ${providerName}` : ''}
            </div>
            {setup.instructions && (
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                    {setup.instructions}
                </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2 text-2xs text-text-muted">
                {setup.serverName && <span>Server: <code>{setup.serverName}</code></span>}
                {setup.configFormat && <span>Format: <code>{setup.configFormat}</code></span>}
                {setup.configPathCommand && <span>Config path: <code>{setup.configPathCommand}</code></span>}
                {setup.requiresRestart && <span>Start a fresh CLI session after editing config.</span>}
            </div>
            {setup.template && (
                <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-border-subtle bg-bg-primary p-3 text-xs font-mono leading-relaxed text-text-primary select-all whitespace-pre-wrap">
                    {setup.template}
                </pre>
            )}
        </div>
    )
}
