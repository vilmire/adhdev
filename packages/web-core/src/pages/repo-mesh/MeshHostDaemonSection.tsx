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
    coordinatorDaemonId: string
    onCoordinatorDaemonIdChange: (id: string) => void
    coordinatorCliType: string
    onCoordinatorCliTypeChange: (type: string) => void
    launchingCoordinator: boolean
    launchResult: string | null
    attachedDaemonIds: Set<string>
    isHostNodeAttached: boolean
    selectedHostNode: MeshNode | undefined
    onLaunchCoordinator: () => void
    onAttachSelectedHost: () => void
}

export function MeshHostDaemonSection({
    daemons,
    coordinatorDaemonId,
    onCoordinatorDaemonIdChange,
    coordinatorCliType,
    onCoordinatorCliTypeChange,
    launchingCoordinator,
    launchResult,
    attachedDaemonIds,
    isHostNodeAttached,
    selectedHostNode,
    onLaunchCoordinator,
    onAttachSelectedHost,
}: Props) {
    return (
        <Section title="Mesh Host daemon" description="Choose the daemon that will own the coordinator. Host-owned live truth is required before cloud renders status, queue, graph, or node detail.">
            <AlertBanner variant="info" className="mb-4">
                <strong>Start with one host workspace.</strong>{' '}
                Create a mesh on a connected daemon, then attach additional machine workspaces below. Live status, queue, and graph data come from the selected host daemon.
            </AlertBanner>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] items-end">
                <FormField label="Mesh Host daemon" hint="Cloud selects the connected daemon to command over P2P; the host must be attached before it can own a coordinator.">
                    <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                        value={coordinatorDaemonId} onChange={e => onCoordinatorDaemonIdChange(e.target.value)}>
                        <option value="">Select a Mesh Host...</option>
                        {daemons.map(d => (
                            <option key={d.id} value={d.id}>
                                {daemonLabel(d)} · {attachedDaemonIds.has(d.id) ? 'attached' : 'not attached'}
                            </option>
                        ))}
                    </select>
                </FormField>
                <FormField label="CLI provider">
                    <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                        value={coordinatorCliType} onChange={e => onCoordinatorCliTypeChange(e.target.value)}>
                        <option value="">Use node provider priority</option>
                        <option value="claude-cli">Claude Code</option>
                        <option value="codex-cli">Codex</option>
                        <option value="gemini-cli">Gemini</option>
                        <option value="hermes-cli">Hermes</option>
                    </select>
                </FormField>
                <button className="btn btn-primary btn-sm" onClick={onLaunchCoordinator}
                    disabled={!coordinatorDaemonId || !isHostNodeAttached || launchingCoordinator}
                    title={!isHostNodeAttached && coordinatorDaemonId ? 'Attach this Mesh Host daemon first.' : undefined}>
                    {launchingCoordinator ? 'Launching...' : 'Launch Host Coordinator'}
                </button>
            </div>
            <div className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                {coordinatorDaemonId
                    ? isHostNodeAttached
                        ? <>Host setup node: <span className="font-mono text-text-primary">{selectedHostNode?.workspace}</span>. Live graph/status/detail renders only from this daemon.</>
                        : <>Selected host is not attached yet. Attach one of its workspaces below before launching.</>
                    : 'Select a connected daemon to become the Mesh Host.'}
            </div>
            {!isHostNodeAttached && coordinatorDaemonId && (
                <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={onAttachSelectedHost}>
                    Attach selected host daemon
                </button>
            )}
            {launchResult && (
                <div className="mt-3 text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{launchResult}</div>
            )}
        </Section>
    )
}
