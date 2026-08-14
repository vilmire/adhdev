import { useTranslation } from 'react-i18next'
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
    /** True while the first-setup host pin is being persisted. */
    settingMeshHost?: boolean
    /**
     * Persist the operator's first-setup host choice (HOST-PIN-WRITER, set_mesh_host).
     * Absent on hosts (e.g. older embedders) that have not wired the action yet — the
     * section then falls back to a bare picker with no confirm action.
     */
    onSetMeshHost?: (hostDaemonId: string) => void
}

/**
 * Mesh host display.
 *
 * The mesh host is a 1:1 pin owned daemon-side. It is established ONCE — normally at
 * mesh creation, where the creating daemon is recorded as host — and is not reassigned
 * from this section afterwards. Once a host is pinned this renders a read-only badge,
 * never a daemon picker. The interactive paths are:
 *   • host offline → a temporary command-routing RE-BIND (route commands through a
 *     connected daemon until the host reconnects; this does NOT change the host).
 *   • no host pinned yet (a mesh created before hosts were pinned at creation) → the
 *     operator picks a connected daemon and confirms with an explicit "Set as host"
 *     action, which persists the pin via set_mesh_host. Establishing the host is a
 *     deliberate act, not a side effect of launching: the pin is effectively permanent,
 *     so a mis-click on a launch button must not re-home the mesh. Launching the
 *     coordinator also backfills a MISSING pin, but never overwrites an existing one.
 */
export function MeshHostDaemonSection({
    daemons,
    coordinatorDaemonId,
    onCoordinatorDaemonIdChange,
    isHostNodeAttached,
    selectedHostNode,
    hostPinned,
    hostLabel,
    hostOnline,
    hostRebindDaemonId,
    onHostRebindDaemonIdChange,
    settingMeshHost,
    onSetMeshHost,
}: Props) {
    const { t } = useTranslation('common')

    // ── Host already pinned: read-only display (never a picker) ──
    if (hostPinned) {
        return (
            <Section title={t('repoMesh.host.title')} description={t('repoMesh.host.descriptionSet')}>
                <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] text-text-primary ${hostOnline ? 'border-accent-primary/40 bg-accent-primary/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                        <span className="text-text-muted">{t('repoMesh.host.hostLabel')}</span>
                        <span className="font-medium">{hostLabel || t('repoMesh.host.unknown')}</span>
                        <span className={hostOnline ? 'text-text-muted' : 'text-amber-400'}>· {hostOnline ? t('repoMesh.host.online') : t('repoMesh.host.offline')}</span>
                    </span>
                    {selectedHostNode?.workspace && (
                        <span className="text-[12px] text-text-muted">
                            {t('repoMesh.host.hostNode')} <span className="font-mono text-text-secondary">{selectedHostNode.workspace}</span>
                        </span>
                    )}
                </div>

                {/* Host offline: temporary command-routing re-bind (NOT a host change). */}
                {!hostOnline && (
                    <div className="mt-4">
                        <AlertBanner variant="warning" className="mb-3">
                            <strong>{t('repoMesh.host.hostOffline')}</strong>{' '}
                            {t('repoMesh.host.hostOfflineText')}
                        </AlertBanner>
                        {daemons.length > 0 ? (
                            <FormField label={t('repoMesh.host.reconnectToCommand')} hint={t('repoMesh.host.reconnectToCommandHint')}>
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={hostRebindDaemonId} onChange={e => onHostRebindDaemonIdChange(e.target.value)}>
                                    <option value="">{t('repoMesh.host.waitForHost')}</option>
                                    {daemons.map(d => (
                                        <option key={d.id} value={d.id}>{daemonLabel(d)}</option>
                                    ))}
                                </select>
                            </FormField>
                        ) : (
                            <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                                {t('repoMesh.host.noDaemonsToRoute')}
                            </div>
                        )}
                    </div>
                )}
            </Section>
        )
    }

    // ── First-time setup: no host pinned yet ──
    // Reached by meshes created before the host was pinned at creation time. The
    // operator picks a connected daemon and confirms it with an explicit "Set as host"
    // action (set_mesh_host) — that is what persists the pin. When an authoritative host
    // signal already named a daemon (coordinatorDaemonId set via the pin / role:'host'
    // seed) we show it as the host-to-be and offer the same confirm. Otherwise
    // (HOST-MISSEED-FIRSTSETUP) there is NO auto-seed to an arbitrary connected peer, so
    // the header never flashes a wrong remote node on cold entry.
    const setupDaemon = daemons.find(d => d.id === coordinatorDaemonId)
    const setHostButton = onSetMeshHost && coordinatorDaemonId ? (
        <button className="btn btn-primary btn-sm" onClick={() => onSetMeshHost(coordinatorDaemonId)}
            disabled={!!settingMeshHost}>
            {settingMeshHost ? t('repoMesh.host.settingHost') : t('repoMesh.host.setHostAction')}
        </button>
    ) : null
    return (
        <Section title={t('repoMesh.host.title')} description={t('repoMesh.host.descriptionUnset')}>
            <AlertBanner variant="info" className="mb-4">
                <strong>{t('repoMesh.host.setHostBanner')}</strong>{' '}
                {t('repoMesh.host.setHostBannerText')}
            </AlertBanner>
            {daemons.length > 0 ? (
                <>
                    {coordinatorDaemonId ? (
                        // Authoritative host signal resolved (pin / role:'host' node) — the
                        // seed named a specific daemon. Show it as the host-to-be.
                        <div className="mb-3 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                            {isHostNodeAttached
                                ? <>Will host on <span className="font-medium text-text-primary">{daemonLabel(setupDaemon)}</span>{selectedHostNode?.workspace ? <> · setup node <span className="font-mono text-text-secondary">{selectedHostNode.workspace}</span></> : null}. {t('repoMesh.host.confirmSetsHost')}</>
                                : <>Will host on <span className="font-medium text-text-primary">{daemonLabel(setupDaemon)}</span>. {t('repoMesh.host.attachNodeThenSetHost')}</>}
                        </div>
                    ) : (
                        // No authoritative host signal yet. We deliberately do NOT auto-seed
                        // an arbitrary connected daemon (HOST-MISSEED-FIRSTSETUP) — that is
                        // what flashed a wrong remote node (e.g. moltbot) in the header on
                        // cold entry. Let the operator explicitly pick the host instead.
                        <FormField label={t('repoMesh.host.hostDaemon')} hint={t('repoMesh.host.hostDaemonHint')}>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value="" onChange={e => onCoordinatorDaemonIdChange(e.target.value)}>
                                <option value="">{t('repoMesh.host.resolvingHost')}</option>
                                {daemons.map(d => (
                                    <option key={d.id} value={d.id}>{daemonLabel(d)}</option>
                                ))}
                            </select>
                        </FormField>
                    )}
                    {/* Establishing the host is its own confirmed action — the pin is
                        effectively permanent, so it must not ride along on a launch click. */}
                    {setHostButton && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            {setHostButton}
                            <span className="text-[12px] text-text-muted">{t('repoMesh.host.setHostActionHint')}</span>
                        </div>
                    )}
                </>
            ) : (
                <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                    {t('repoMesh.host.noDaemonsToHost')}
                </div>
            )}
        </Section>
    )
}
