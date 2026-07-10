import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField } from '../../components/ui/FormField'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshNode } from './types'

function daemonLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}

interface Props {
    daemons: RepoMeshDaemonEntry[]
    /** Resolved command/view-source daemon id (derived, not user-chosen). */
    coordinatorDaemonId: string
    /**
     * First-setup only: let the operator explicitly pick which connected daemon becomes
     * the host, used when NO authoritative host signal exists yet (no pin, no role:'host'
     * node). We deliberately do not auto-seed an arbitrary peer (HOST-MISSEED-FIRSTSETUP),
     * so the operator chooses instead of a wrong node flashing in the header.
     */
    onCoordinatorDaemonIdChange: (id: string) => void
    coordinatorCliType: string
    onCoordinatorCliTypeChange: (type: string) => void
    launchingCoordinator: boolean
    launchResult: string | null
    isHostNodeAttached: boolean
    selectedHostNode: MeshNode | undefined
    /** True when this mesh already has a persisted host pinned (meshHost metadata). */
    hostPinned: boolean
    /** Stable display label for the pinned host (preserved even when offline). */
    hostLabel: string
    /** Whether the pinned host daemon is currently connected. */
    hostOnline: boolean
    /** Temporary command-routing override daemon while the host is offline ('' = none). */
    hostRebindDaemonId: string
    onHostRebindDaemonIdChange: (id: string) => void
    onLaunchCoordinator: () => void
}

/**
 * Mesh host display.
 *
 * The mesh host is a FIXED 1:1 pin decided daemon-side when the mesh is created —
 * it is never re-selected from the dashboard. This section therefore renders a
 * read-only host badge (never a daemon picker) once a host is pinned. The only
 * interactive paths are:
 *   • host offline → a temporary command-routing RE-BIND (route commands through a
 *     connected daemon until the host reconnects; this does NOT change the host).
 *   • no host pinned yet (first-time setup) → a single "Launch Host Coordinator"
 *     action whose launch establishes the host daemon-side.
 */
export function MeshHostDaemonSection({
    daemons,
    coordinatorDaemonId,
    onCoordinatorDaemonIdChange,
    coordinatorCliType,
    onCoordinatorCliTypeChange,
    launchingCoordinator,
    launchResult,
    isHostNodeAttached,
    selectedHostNode,
    hostPinned,
    hostLabel,
    hostOnline,
    hostRebindDaemonId,
    onHostRebindDaemonIdChange,
    onLaunchCoordinator,
}: Props) {
    const cliProviderField = (
        <FormField label="Coordinator CLI provider" hint="Tool launched for the host coordinator session.">
            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                value={coordinatorCliType} onChange={e => onCoordinatorCliTypeChange(e.target.value)}>
                <option value="">Use node provider priority</option>
                <option value="claude-cli">Claude Code</option>
                <option value="codex-cli">Codex</option>
                <option value="gemini-cli">Gemini</option>
                <option value="hermes-cli">Hermes</option>
            </select>
        </FormField>
    )

    const launchResultBanner = launchResult && (
        <div className="mt-3 text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{launchResult}</div>
    )

    // ── Host already pinned: read-only display (never a picker) ──
    if (hostPinned) {
        return (
            <Section title="Mesh Host daemon" description="The daemon that owns this mesh's coordinator and live truth (status, queue, graph, node detail). Fixed when the mesh is created — it cannot be reassigned here.">
                <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] text-text-primary ${hostOnline ? 'border-accent-primary/40 bg-accent-primary/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                        <span className="text-text-muted">Host:</span>
                        <span className="font-medium">{hostLabel || 'Unknown'}</span>
                        <span className={hostOnline ? 'text-text-muted' : 'text-amber-400'}>· {hostOnline ? 'online' : 'offline'}</span>
                    </span>
                    {selectedHostNode?.workspace && (
                        <span className="text-[12px] text-text-muted">
                            Host node: <span className="font-mono text-text-secondary">{selectedHostNode.workspace}</span>
                        </span>
                    )}
                </div>

                {/* Host offline: temporary command-routing re-bind (NOT a host change). */}
                {!hostOnline && (
                    <div className="mt-4">
                        <AlertBanner variant="warning" className="mb-3">
                            <strong>Host offline.</strong>{' '}
                            The pinned host daemon is not connected. Live status/queue/graph will not load until it reconnects.
                            You can temporarily route commands through another connected daemon below — this is a routing fallback,
                            not a host reassignment.
                        </AlertBanner>
                        {daemons.length > 0 ? (
                            <FormField label="Reconnect to command" hint="Route commands through this connected daemon until the host is back. Does not change the mesh host.">
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={hostRebindDaemonId} onChange={e => onHostRebindDaemonIdChange(e.target.value)}>
                                    <option value="">Wait for host to reconnect</option>
                                    {daemons.map(d => (
                                        <option key={d.id} value={d.id}>{daemonLabel(d)}</option>
                                    ))}
                                </select>
                            </FormField>
                        ) : (
                            <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                                No connected daemons available to route commands through. Bring the host (or another daemon) online.
                            </div>
                        )}
                    </div>
                )}

                <div className="mt-3 grid gap-3 sm:grid-cols-[180px_auto] items-end">
                    {cliProviderField}
                    <button className="btn btn-primary btn-sm" onClick={onLaunchCoordinator}
                        disabled={launchingCoordinator || !coordinatorDaemonId}
                        title={!coordinatorDaemonId ? 'No command target available — bring the host or a daemon online.' : undefined}>
                        {launchingCoordinator ? 'Launching...' : 'Launch Host Coordinator'}
                    </button>
                </div>
                {launchResultBanner}
            </Section>
        )
    }

    // ── First-time setup: no host pinned yet ──
    // The host is established by launching the coordinator on a connected daemon —
    // that launch pins it daemon-side. When an authoritative host signal already named
    // a daemon (coordinatorDaemonId set via the pin / role:'host' seed), we just show it
    // as the host-to-be. Otherwise (HOST-MISSEED-FIRSTSETUP) there is NO auto-seed to an
    // arbitrary connected peer — the operator explicitly picks the host from a select,
    // so the header never flashes a wrong remote node on cold entry.
    const setupDaemon = daemons.find(d => d.id === coordinatorDaemonId)
    return (
        <Section title="Mesh Host daemon" description="This mesh has no host yet. Launching the coordinator on a connected daemon fixes that daemon as the mesh host (a 1:1 pin); it owns live truth thereafter.">
            <AlertBanner variant="info" className="mb-4">
                <strong>Set the mesh host.</strong>{' '}
                The host is the daemon that owns this mesh's coordinator and live truth. Launch the host coordinator below to set it — the host is fixed once established.
            </AlertBanner>
            {daemons.length > 0 ? (
                <>
                    {coordinatorDaemonId ? (
                        // Authoritative host signal resolved (pin / role:'host' node) — the
                        // seed named a specific daemon. Show it as the host-to-be.
                        <div className="mb-3 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                            {isHostNodeAttached
                                ? <>Will host on <span className="font-medium text-text-primary">{daemonLabel(setupDaemon)}</span>{selectedHostNode?.workspace ? <> · setup node <span className="font-mono text-text-secondary">{selectedHostNode.workspace}</span></> : null}. Launching sets this daemon as the mesh host.</>
                                : <>Will host on <span className="font-medium text-text-primary">{daemonLabel(setupDaemon)}</span>. Attach one of its workspaces as a node first, then launch to set the host.</>}
                        </div>
                    ) : (
                        // No authoritative host signal yet. We deliberately do NOT auto-seed
                        // an arbitrary connected daemon (HOST-MISSEED-FIRSTSETUP) — that is
                        // what flashed a wrong remote node (e.g. moltbot) in the header on
                        // cold entry. Let the operator explicitly pick the host instead.
                        <FormField label="Host daemon" hint="Pick the daemon that will host this mesh. Launching the coordinator on it fixes it as the host.">
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value="" onChange={e => onCoordinatorDaemonIdChange(e.target.value)}>
                                <option value="">Resolving host… (or pick a daemon to host)</option>
                                {daemons.map(d => (
                                    <option key={d.id} value={d.id}>{daemonLabel(d)}</option>
                                ))}
                            </select>
                        </FormField>
                    )}
                    <div className="grid gap-3 sm:grid-cols-[180px_auto] items-end mt-3">
                        {cliProviderField}
                        <button className="btn btn-primary btn-sm" onClick={onLaunchCoordinator}
                            disabled={!coordinatorDaemonId || !isHostNodeAttached || launchingCoordinator}
                            title={!coordinatorDaemonId ? 'Pick a host daemon (or wait for the host pin to resolve) first.' : !isHostNodeAttached ? 'Attach a workspace from this daemon as a node first.' : undefined}>
                            {launchingCoordinator ? 'Launching...' : 'Launch Host Coordinator (sets host)'}
                        </button>
                    </div>
                </>
            ) : (
                <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                    No connected daemons. Bring a daemon online to host this mesh.
                </div>
            )}
            {launchResultBanner}
        </Section>
    )
}
