import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutoApproveMode, AutoApproveModesConfig } from '@adhdev/daemon-core'
import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import {
    AutoApproveModeSelector,
    AutoApproveRiskBadge,
    DangerousAutoApproveModeDialog,
} from '../../components/dashboard/AutoApproveModeSelector'
import LaunchConfirmDialog from '../../components/machine/LaunchConfirmDialog'
import { deriveAutoApproveModeRisk } from '../../utils/auto-approve-modes'
import {
    resolveEffectiveAutoApprove,
    type EffectiveAutoApproveResult,
} from '../../utils/provider-auto-approve-defaults'

/** A provider that advertises auto-approve modes (from the host daemon inventory). */
interface ProviderWithModes {
    type: string
    label: string
    autoApproveModes: AutoApproveModesConfig
}

interface Props {
    /** Mesh host daemon id — commands (read/write mesh.json) route here. */
    hostDaemonId: string
    /** Whether the host daemon is currently reachable. */
    hostOnline: boolean
    /** Host node workspace — the repo root that carries .adhdev/mesh.json. */
    hostWorkspace: string
    /**
     * Raw provider inventory for the WHOLE mesh — the union across its nodes'
     * daemons, de-duplicated by type (carries autoApproveModes per provider).
     *
     * Not the host daemon's inventory alone: auto-approve defaults are written to the
     * repo's mesh.json and apply to whichever node runs a delegated worker, so a
     * provider installed only on a member machine must still be configurable here.
     * (It is scoped through this mesh's nodes, so daemons outside the mesh never
     * contribute — see collectMeshProviderInventory.)
     */
    meshProviders: any[]
    /**
     * Nodes bound to a daemon that has not reported its inventory yet (offline, or
     * P2P/status metadata still in flight). Non-zero means the list above may be
     * INCOMPLETE — rendered as such rather than being silently presented as final.
     */
    unreportedNodeCount?: number
    /** Machine-local ENABLE gate (mesh policy delegatedWorkerAutoApprove; default true). */
    machineAutoApproveEnabled: boolean
    /** Machine-local dangerous opt-in (delegatedWorkerDangerousModeAllow; default false). */
    machineDangerousAllowed: boolean
    /** Mesh-policy patch writer (update_mesh). When present, the machine-authorization card becomes editable. */
    onUpdatePolicy?: (patch: Record<string, unknown>) => void
    /** True while a mesh-policy save is in flight. */
    savingPolicy?: boolean
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

function readProvidersWithModes(meshProviders: any[]): ProviderWithModes[] {
    const out: ProviderWithModes[] = []
    for (const p of meshProviders || []) {
        if (!p || p.category !== 'cli') continue
        const config = p.autoApproveModes
        if (!config || !Array.isArray(config.modes) || config.modes.length === 0) continue
        const type = String(p.type || p.id || '').trim()
        if (!type) continue
        out.push({
            type,
            label: String(p.displayName || p.name || type),
            autoApproveModes: config as AutoApproveModesConfig,
        })
    }
    return out
}

/**
 * MAGI three-section surface for per-provider default auto-approve modes:
 *   1. Repository default — committed to .adhdev/mesh.json (team-shared REQUEST).
 *   2. This machine authorization — local meshes.json ENABLE + dangerous opt-in.
 *   3. Effective result — repo default ⊕ machine authorization, WITH downgrade
 *      reasons surfaced (a repo-requested dangerous mode is not silently shown as
 *      "selected" when this machine downgrades it).
 */
export function MeshProviderAutoApproveSection({
    hostDaemonId,
    hostOnline,
    hostWorkspace,
    meshProviders,
    unreportedNodeCount = 0,
    machineAutoApproveEnabled,
    machineDangerousAllowed,
    onUpdatePolicy,
    savingPolicy,
    sendCommand,
}: Props) {
    const { t } = useTranslation('common')
    const providers = useMemo(() => readProvidersWithModes(meshProviders), [meshProviders])

    // Committed repo defaults, keyed by providerType → requested mode id.
    const [repoDefaults, setRepoDefaults] = useState<Record<string, string>>({})
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    // Pending dangerous selection awaiting confirmation: {type, mode}.
    const [pendingDangerous, setPendingDangerous] = useState<{ type: string; mode: AutoApproveMode } | null>(null)
    // Dangerous machine opt-in awaiting confirmation (turning OFF needs none — it is
    // the fail-closed direction).
    const [confirmDangerousOptIn, setConfirmDangerousOptIn] = useState(false)

    const canConfigure = !!hostDaemonId && hostOnline && !!hostWorkspace
    // Machine-authorization toggles write the machine-local mesh policy via the
    // update_mesh seam the parent already owns; the saved policy flows back down as
    // the machineAutoApproveEnabled/machineDangerousAllowed props after reload.
    const canEditPolicy = !!onUpdatePolicy && !savingPolicy

    const loadDefaults = useCallback(async () => {
        if (!canConfigure) return
        setLoading(true)
        setLoadError(null)
        try {
            const res = await sendCommand(hostDaemonId, 'read_mesh_json_config', { workspace: hostWorkspace })
            // Cloud transport wraps the daemon response once as { success, result: <daemonResponse> }
            // while standalone returns it raw; unwrap so both shapes read the same fields.
            const body = res?.result ?? res
            const modes = body?.providerDefaults?.autoApproveModes
                || body?.config?.providerDefaults?.autoApproveModes
            const next: Record<string, string> = {}
            if (modes && typeof modes === 'object') {
                for (const [type, id] of Object.entries(modes)) {
                    if (typeof id === 'string' && id.trim()) next[type] = id.trim()
                }
            }
            setRepoDefaults(next)
        } catch (e: any) {
            setLoadError(e?.message || t('repoMesh.providerAutoApprove.loadError'))
        } finally {
            setLoading(false)
        }
    }, [canConfigure, hostDaemonId, hostWorkspace, sendCommand, t])

    // Read current committed value on mount / when the host target changes — the UI
    // reflects the saved state, it is never write-only.
    useEffect(() => {
        void loadDefaults()
    }, [loadDefaults])

    const applyDefault = useCallback((type: string, modeId: string | undefined) => {
        setSaved(false)
        setRepoDefaults(prev => {
            const next = { ...prev }
            if (modeId && modeId.trim()) next[type] = modeId.trim()
            else delete next[type]
            return next
        })
    }, [])

    const onSelectMode = useCallback((type: string, mode: AutoApproveMode) => {
        // A dangerous repo default requires an explicit confirmation (with the extra
        // team-share warning), mirroring the launch dialog.
        if (deriveAutoApproveModeRisk(mode) === 'dangerous') {
            setPendingDangerous({ type, mode })
            return
        }
        applyDefault(type, mode.id)
    }, [applyDefault])

    const confirmDangerous = useCallback(() => {
        if (pendingDangerous) applyDefault(pendingDangerous.type, pendingDangerous.mode.id)
        setPendingDangerous(null)
    }, [applyDefault, pendingDangerous])

    const save = useCallback(async () => {
        if (!canConfigure) return
        setSaving(true)
        setSaveError(null)
        setSaved(false)
        try {
            // Full replace of the autoApproveModes map with the current UI state via the
            // read-modify-write command (other mesh.json zones are preserved daemon-side).
            const res = await sendCommand(hostDaemonId, 'set_mesh_provider_defaults', {
                workspace: hostWorkspace,
                autoApproveModes: repoDefaults,
                merge: false,
                write: true,
            })
            // Unwrap the cloud { success, result } wrapper (standalone returns raw) so a real
            // write failure on the daemon surfaces instead of being masked by the outer success.
            const body = res?.result ?? res
            if (body?.success === false) throw new Error(body?.error || t('repoMesh.providerAutoApprove.saveError'))
            setSaved(true)
            // Re-read so the UI reflects exactly what landed on disk (normalized).
            await loadDefaults()
        } catch (e: any) {
            setSaveError(e?.message || t('repoMesh.providerAutoApprove.saveError'))
        } finally {
            setSaving(false)
        }
    }, [canConfigure, hostDaemonId, hostWorkspace, loadDefaults, repoDefaults, sendCommand, t])

    return (
        <Section
            title={t('repoMesh.providerAutoApprove.title')}
            description={t('repoMesh.providerAutoApprove.subtitle')}
            collapsible
            defaultOpen={false}
        >
            {/* ── Section 2: machine authorization (mesh policy, editable) ──
                Rendered unconditionally: this machine's opt-in must stay reachable
                even when the host is offline or advertises no providers. */}
            <div className="rounded-xl border border-border-subtle bg-bg-secondary/40 p-3.5">
                <div className="text-sm font-semibold text-text-primary">{t('repoMesh.providerAutoApprove.machineSection.title')}</div>
                <div className="mt-1 text-[11px] text-text-muted">{t('repoMesh.providerAutoApprove.machineSection.hint')}</div>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <span className={`rounded-full border px-2 py-0.5 font-semibold ${machineAutoApproveEnabled ? 'border-status-online/25 bg-status-online/10 text-status-online' : 'border-border-subtle bg-surface-secondary/40 text-text-muted'}`}>
                        {machineAutoApproveEnabled
                            ? t('repoMesh.providerAutoApprove.machineSection.autoApproveOn')
                            : t('repoMesh.providerAutoApprove.machineSection.autoApproveOff')}
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 font-semibold ${machineDangerousAllowed ? 'border-status-error/30 bg-status-error/10 text-status-error' : 'border-border-subtle bg-surface-secondary/40 text-text-muted'}`}>
                        {machineDangerousAllowed
                            ? t('repoMesh.providerAutoApprove.machineSection.dangerousOn')
                            : t('repoMesh.providerAutoApprove.machineSection.dangerousOff')}
                    </span>
                </div>
                <div className="mt-3 space-y-2">
                    <MachinePolicyToggle
                        label={t('repoMesh.providerAutoApprove.machineSection.autoApproveToggleLabel')}
                        hint={t('repoMesh.providerAutoApprove.machineSection.autoApproveToggleHint')}
                        checked={machineAutoApproveEnabled}
                        disabled={!canEditPolicy}
                        onChange={next => onUpdatePolicy?.({ delegatedWorkerAutoApprove: next })}
                    />
                    <MachinePolicyToggle
                        label={t('repoMesh.providerAutoApprove.machineSection.dangerousToggleLabel')}
                        hint={machineAutoApproveEnabled
                            ? t('repoMesh.providerAutoApprove.machineSection.dangerousToggleHint')
                            : t('repoMesh.providerAutoApprove.machineSection.dangerousDisabledHint')}
                        checked={machineDangerousAllowed}
                        disabled={!canEditPolicy || !machineAutoApproveEnabled}
                        onChange={next => {
                            // Opting IN opens a confirmation; opting out applies immediately.
                            if (next) setConfirmDangerousOptIn(true)
                            else onUpdatePolicy?.({ delegatedWorkerDangerousModeAllow: false })
                        }}
                    />
                </div>
            </div>

            {!canConfigure ? (
                <div className="text-[13px] text-text-muted">{t('repoMesh.providerAutoApprove.noHostDaemon')}</div>
            ) : loading ? (
                <div className="text-[13px] text-text-muted">{t('repoMesh.providerAutoApprove.loading')}</div>
            ) : providers.length === 0 ? (
                // An empty list is only "no providers" once every node has actually
                // reported. While any node's inventory is still outstanding, say so
                // instead of asserting none exist — the reading isn't in yet.
                <div className="text-[13px] text-text-muted">
                    {unreportedNodeCount > 0
                        ? t('repoMesh.providerAutoApprove.awaitingNodes', { count: unreportedNodeCount })
                        : t('repoMesh.providerAutoApprove.noProviders')}
                </div>
            ) : (
                <div className="space-y-6">
                    {loadError && <AlertBanner variant="error" onDismiss={() => setLoadError(null)}>{loadError}</AlertBanner>}
                    {/* The union is complete only when every node has reported. */}
                    {unreportedNodeCount > 0 && (
                        <div className="text-[11px] text-text-muted">
                            {t('repoMesh.providerAutoApprove.partialInventory', { count: unreportedNodeCount })}
                        </div>
                    )}

                    {/* ── Section 1: repository default (editable) + Section 3 per provider ── */}
                    <div className="space-y-1">
                        <div className="text-sm font-semibold text-text-primary">{t('repoMesh.providerAutoApprove.repoSection.title')}</div>
                        <div className="text-[11px] text-text-muted">{t('repoMesh.providerAutoApprove.repoSection.hint')}</div>
                    </div>

                    <div className="space-y-5">
                        {providers.map(provider => {
                            const requestedModeId = repoDefaults[provider.type]
                            const effective = resolveEffectiveAutoApprove({
                                config: provider.autoApproveModes,
                                requestedModeId,
                                machineAutoApproveEnabled,
                                machineDangerousAllowed,
                            })
                            return (
                                <div key={provider.type} className="rounded-xl border border-border-subtle p-3.5">
                                    <div className="mb-2 flex items-center justify-between gap-2">
                                        <span className="text-sm font-semibold text-text-primary">{provider.label}</span>
                                        <button
                                            type="button"
                                            className="text-[11px] text-text-muted underline decoration-dotted hover:text-text-primary disabled:opacity-40"
                                            onClick={() => applyDefault(provider.type, undefined)}
                                            disabled={!requestedModeId || saving}
                                        >
                                            {t('repoMesh.providerAutoApprove.repoSection.clear')}
                                        </button>
                                    </div>

                                    <AutoApproveModeSelector
                                        config={provider.autoApproveModes}
                                        selectedModeId={requestedModeId || ''}
                                        disabled={saving}
                                        onSelectMode={mode => onSelectMode(provider.type, mode)}
                                    />
                                    {!requestedModeId && (
                                        <div className="mt-1.5 text-[11px] text-text-muted">
                                            {t('repoMesh.providerAutoApprove.repoSection.usesProviderDefault')}
                                        </div>
                                    )}

                                    {/* Section 3: effective result on THIS machine, downgrade reason surfaced. */}
                                    <EffectiveResultRow effective={effective} config={provider.autoApproveModes} />
                                </div>
                            )
                        })}
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm font-semibold text-text-primary">{t('repoMesh.providerAutoApprove.effectiveSection.title')}</div>
                        <div className="text-[11px] text-text-muted">{t('repoMesh.providerAutoApprove.effectiveSection.hint')}</div>
                    </div>

                    {saveError && <AlertBanner variant="error" onDismiss={() => setSaveError(null)}>{saveError}</AlertBanner>}
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                            onClick={() => void save()}
                            disabled={saving}
                        >
                            {saving ? t('repoMesh.providerAutoApprove.saving') : t('repoMesh.providerAutoApprove.save')}
                        </button>
                        {saved && <span className="text-[12px] text-status-online">{t('repoMesh.providerAutoApprove.saved')}</span>}
                    </div>
                </div>
            )}

            {confirmDangerousOptIn && (
                // Same confirm shell DangerousAutoApproveModeDialog wraps, but with
                // opt-in copy: the machine-wide opt-in is not tied to one provider
                // mode, so the mode-specific dialog (warning + launchArgs) does not fit.
                <LaunchConfirmDialog
                    title={t('repoMesh.providerAutoApprove.machineSection.confirmTitle')}
                    description={t('repoMesh.providerAutoApprove.machineSection.confirmDescription')}
                    details={[
                        {
                            label: t('repoMesh.providerAutoApprove.machineSection.confirmScopeLabel'),
                            value: t('repoMesh.providerAutoApprove.machineSection.confirmScopeValue'),
                        },
                        {
                            label: t('repoMesh.providerAutoApprove.machineSection.confirmEffectLabel'),
                            value: t('repoMesh.providerAutoApprove.machineSection.confirmEffectValue'),
                        },
                    ]}
                    confirmLabel={t('repoMesh.providerAutoApprove.machineSection.confirmConfirm')}
                    onConfirm={() => {
                        setConfirmDangerousOptIn(false)
                        onUpdatePolicy?.({ delegatedWorkerDangerousModeAllow: true })
                    }}
                    onCancel={() => setConfirmDangerousOptIn(false)}
                />
            )}
            {pendingDangerous && (
                <DangerousAutoApproveModeDialog
                    mode={pendingDangerous.mode}
                    onConfirm={confirmDangerous}
                    onCancel={() => setPendingDangerous(null)}
                />
            )}
            {pendingDangerous && (
                // Extra team-share warning layered on top of the launch-style dialog:
                // committing a dangerous mode to the repo does NOT bypass each machine's
                // opt-in — non-opted-in machines still downgrade to pty-parse.
                <div className="fixed inset-x-0 bottom-6 z-[60] mx-auto max-w-lg px-4">
                    <div className="rounded-xl border border-status-error/40 bg-bg-primary p-3.5 shadow-lg">
                        <div className="text-sm font-semibold text-status-error">{t('repoMesh.providerAutoApprove.dangerous.sharedWarningTitle')}</div>
                        <div className="mt-1 text-[12px] text-text-muted">{t('repoMesh.providerAutoApprove.dangerous.sharedWarning')}</div>
                    </div>
                </div>
            )}
        </Section>
    )
}

function EffectiveResultRow({
    effective,
    config,
}: {
    effective: EffectiveAutoApproveResult
    config: AutoApproveModesConfig
}) {
    const { t } = useTranslation('common')
    const modeLabel = (id: string | undefined) =>
        (id ? config.modes.find(m => m.id === id)?.label : undefined) || id || ''

    let text: string
    let tone: 'ok' | 'warn' | 'muted' = 'ok'
    switch (effective.status) {
        case 'requested':
            text = t('repoMesh.providerAutoApprove.effectiveSection.statusRequested', { mode: effective.effectiveMode?.label || '' })
            break
        case 'invalid_fallback':
            text = t('repoMesh.providerAutoApprove.effectiveSection.statusInvalidFallback', { mode: effective.effectiveMode?.label || '' })
            tone = 'warn'
            break
        case 'downgraded':
            text = t('repoMesh.providerAutoApprove.effectiveSection.statusDowngraded', {
                requested: modeLabel(effective.requestedModeId) || modeLabel(effective.providerDefaultModeId),
                mode: effective.effectiveMode?.label || '',
            })
            tone = 'warn'
            break
        case 'disabled':
            text = t('repoMesh.providerAutoApprove.effectiveSection.statusDisabled')
            tone = 'muted'
            break
        default:
            text = t('repoMesh.providerAutoApprove.effectiveSection.statusNone')
            tone = 'muted'
    }

    const toneClass = tone === 'ok'
        ? 'border-status-online/25 bg-status-online/5 text-text-secondary'
        : tone === 'warn'
            ? 'border-status-warning/30 bg-status-warning/5 text-status-warning'
            : 'border-border-subtle bg-surface-secondary/30 text-text-muted'

    return (
        <div className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${toneClass}`}>
            {effective.effectiveMode && (
                <AutoApproveRiskBadge risk={deriveAutoApproveModeRisk(effective.effectiveMode)} />
            )}
            <span className="min-w-0">{text}</span>
        </div>
    )
}

/** Switch row for a machine-authorization policy flag (same switch idiom as LegacyAutoApproveToggle). */
function MachinePolicyToggle({
    label,
    hint,
    checked,
    disabled = false,
    onChange,
}: {
    label: string
    hint: string
    checked: boolean
    disabled?: boolean
    onChange: (checked: boolean) => void
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-primary/60 px-3.5 py-2.5 text-left disabled:opacity-50"
            onClick={() => onChange(!checked)}
            disabled={disabled}
        >
            <span>
                <span className="block text-[13px] font-semibold text-text-primary">{label}</span>
                <span className="mt-0.5 block text-[11px] text-text-muted">{hint}</span>
            </span>
            <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent-primary' : 'bg-surface-secondary'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </span>
        </button>
    )
}
