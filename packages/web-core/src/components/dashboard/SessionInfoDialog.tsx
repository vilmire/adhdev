/**
 * SessionInfoDialog
 *
 * Modal that surfaces everything the daemon knows about a single live session:
 * session id, provider, workspace, when it spawned, and — for mesh coordinator
 * sessions — the actual system prompt that was injected, where it landed, and
 * any per-launch extra instructions.
 *
 * Opened from the pane toolbar's "…" menu (ConversationActionsMenu). The
 * default view is short (provider, workspace, machine, started, git, quota,
 * coordinator jump); ids, launch args, runtime JSON and the injected prompt sit
 * in one "Technical details" disclosure plus "Copy diagnostics". Loads the
 * payload on open via daemon's `get_session_info` command, so it's free for
 * non-coordinator sessions and only pays the round-trip when a user opens it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAbsoluteTime } from '../../utils/time'
import { Tooltip } from '../ui/InfoTip'
import { RelativeTime } from '../ui/RelativeTime'
import { writeClipboard } from '../ui/TechnicalDetails'
import { pathBasename } from '../../utils/path-basename'
import { useTransport } from '../../context/TransportContext'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import {
    joinMeshNodeForSession,
    resolveSessionMeshCoordinatorDaemonId,
    resolveSessionMeshId,
    resolveSessionMeshNodeId,
    type JoinedMeshNode,
    type SessionInfoConversation,
} from './session-info-data'
import Dialog from '../ui/Dialog'
import { getCoordinatorMeshStatusSnapshot, loadCoordinatorMeshStatus } from '../../utils/coordinator-mesh-status-store'
import { requestOpenSessionChat } from '../../utils/session-nav'
import {
    bindQuotaDisplayModel,
    createQuotaTextFormatter,
    collectQuotaEntries,
    formatQuotaAccount,
    quotaProviderLabel,
} from '../../utils/quota-format'
// Type-only, from the dependency-free mesh-shared leaf.
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'

export type { SessionInfoConversation } from './session-info-data'

export interface SessionInjection {
    mode: string
    target?: string
}

export interface SessionInfoCoordinator {
    meshId?: string
    startedAt?: number
    cliType?: string
    systemPrompt?: string
    extraSystemPrompt?: string
    injection?: SessionInjection
    mcpConfigPath?: string
}

/** Launch metadata mirrored from daemon-core CliLaunchInfo (get_session_info). */
export interface SessionLaunchInfo {
    command?: string
    args?: string[]
    extraArgs?: string[]
    cwd?: string
    extraEnvKeys?: string[]
    providerSessionId?: string
}

export interface SessionInfoSession {
    sessionId: string
    providerType: string
    providerName?: string
    transport?: string
    workspace?: string
    spawnedAtMs?: number
    providerSessionId?: string
    runtimeMetadata?: unknown
    launch?: SessionLaunchInfo
}

/** Coordinator-spawn linkage for WORKER sessions (get_session_info.meshWorker):
 *  the daemon joins the session's mesh stamps with its registered coordinator
 *  so the dialog can say who spawned this session and jump to that chat. */
export interface SessionInfoMeshWorker {
    meshId?: string
    nodeId?: string
    taskId?: string
    coordinatorSessionId?: string
    coordinatorCliType?: string
    /**
     * Three states: true = coordinator session confirmed live (local registry
     * hit), false = confirmed dead (renders "gone", no jump), undefined =
     * unknown — the coordinator lives on a remote node whose liveness this
     * daemon cannot see (stamp fallback). Unknown renders the jump button
     * optimistically; a miss is answered by the chatNotFound toast.
     */
    coordinatorAlive?: boolean
    /** Daemon hosting the coordinator, when the stamp carried it. */
    coordinatorDaemonId?: string
}

export interface SessionInfoResponse {
    success: boolean
    error?: string
    session?: SessionInfoSession
    meshWorker?: SessionInfoMeshWorker | null
    coordinator?: SessionInfoCoordinator | null
    /**
     * Plan quota of the MACHINE hosting this session — the daemon this dialog
     * already queries owns the session, so no join is needed. Absent until that
     * machine's 15-minute quota refresh has ticked, in which case no quota rows
     * render at all.
     */
    quota?: Record<string, MeshNodeFactsProviderQuota>
    machineNickname?: string | null
}

interface Props {
    sessionId: string
    daemonId: string
    conv?: SessionInfoConversation
    onClose: () => void
}

function formatTimestamp(ms?: number): string {
    return formatAbsoluteTime(ms, { seconds: true }) || '—'
}

export default function SessionInfoDialog({ sessionId, daemonId, conv, onClose }: Props) {
    const { t } = useTranslation('common')
    // Localized binding; keeps the one-argument model call the drift guard pins.
    const buildQuotaDisplayModel = bindQuotaDisplayModel(createQuotaTextFormatter(t))
    const { sendCommand } = useTransport()
    const meshOverrides = useDashboardMeshOverrides()
    const [loading, setLoading] = useState(true)
    const [data, setData] = useState<SessionInfoResponse | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [meshNode, setMeshNode] = useState<JoinedMeshNode | null>(null)
    const [meshNodeError, setMeshNodeError] = useState<string | null>(null)

    const meshId = useMemo(() => resolveSessionMeshId(conv), [conv])
    const meshNodeId = useMemo(() => resolveSessionMeshNodeId(conv), [conv])

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const raw = await sendCommand(daemonId, 'get_session_info', { targetSessionId: sessionId })
            // Cloud transport wraps the daemon response once
            // ({ success, result: { success, ... } }) while standalone returns
            // the daemon body directly. TransportContext's jsdoc warns about
            // this; reading top-level `.success` only worked for standalone,
            // so the cloud path rendered "no coordinator" even when the daemon
            // returned coordinator metadata.
            const envelope = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const inner = (envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope) as SessionInfoResponse
            if (!inner?.success) {
                setError(inner?.error || t('sessionInfo.failedToLoad'))
                setData(null)
            } else {
                setData(inner)
            }
        } catch (e: any) {
            setError(e?.message || String(e))
            setData(null)
        } finally {
            setLoading(false)
        }
    }, [sendCommand, daemonId, sessionId, t])

    useEffect(() => { void load() }, [load])

    // The mesh's COORDINATOR — never this session's own (member) daemon — answers
    // for its node: the coordinator holds every node's latest state.
    const coordinatorDaemonId = useMemo(() => resolveSessionMeshCoordinatorDaemonId({
        conv,
        sessionDaemonId: daemonId,
        heldCoordinatorDaemonId: meshId ? getCoordinatorMeshStatusSnapshot(meshId)?.daemonId : null,
        reportedCoordinatorDaemonId: data?.meshWorker?.coordinatorDaemonId,
    }), [conv, daemonId, meshId, data?.meshWorker?.coordinatorDaemonId])

    // Join the live mesh node this session belongs to, from the SHARED coordinator
    // status (utils/coordinator-mesh-status-store — the same answer the /mesh page
    // and the graph dialog hold). Best-effort: a session that isn't a mesh member,
    // no known coordinator, or a failed/empty mesh_status all leave the Mesh node
    // section hidden rather than blocking the whole panel.
    const loadMeshNode = useCallback(async () => {
        setMeshNode(null)
        setMeshNodeError(null)
        if (!meshId || !meshNodeId || !coordinatorDaemonId) return
        const held = getCoordinatorMeshStatusSnapshot(meshId)?.status ?? null
        const status = held ?? await loadCoordinatorMeshStatus({
            meshId,
            daemonId: coordinatorDaemonId,
            refresh: false,
            load: (targetDaemonId, targetMeshId, options) => (meshOverrides?.loadMeshStatus
                ? meshOverrides.loadMeshStatus(targetDaemonId, targetMeshId, { refresh: options.refresh })
                : sendCommand(targetDaemonId, 'mesh_status', { meshId: targetMeshId })),
        })
        if (!status) {
            setMeshNodeError(getCoordinatorMeshStatusSnapshot(meshId)?.error || t('sessionInfo.meshNodeUnavailable'))
            return
        }
        const node = joinMeshNodeForSession(status, meshNodeId)
        if (!node) {
            setMeshNodeError(t('sessionInfo.stampedToNode'))
            return
        }
        setMeshNode(node)
    }, [meshOverrides, sendCommand, coordinatorDaemonId, meshId, meshNodeId, t])

    useEffect(() => { void loadMeshNode() }, [loadMeshNode])

    const [copied, setCopied] = useState(false)
    const copyDiagnostics = useCallback(async () => {
        const ok = await writeClipboard(buildSessionDiagnostics({ sessionId, daemonId, conv, data, meshNode, meshNodeError }))
        if (!ok) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }, [conv, daemonId, data, meshNode, meshNodeError, sessionId])

    const footer = (
        <>
            {(data || error) && (
                <button
                    type="button"
                    onClick={() => void copyDiagnostics()}
                    data-testid="session-info-copy-diagnostics"
                    className="px-3 py-1 text-sm rounded border border-border-default hover:bg-surface-secondary"
                >
                    <span aria-live="polite">{copied ? t('common.copied') : t('sessionInfo.copyDiagnostics')}</span>
                </button>
            )}
            <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-sm rounded bg-accent text-white hover:opacity-90"
            >{t('sessionInfo.close')}</button>
        </>
    )

    const yesNo = (value: boolean) => (value ? t('common.yes') : t('common.no'))
    const session = data?.session
    const workspacePath = session?.workspace || conv?.workspacePath || ''
    const machineName = conv?.machineName || data?.machineNickname || ''
    const worker = data?.meshWorker
    const quotaEntries = collectQuotaEntries(meshNode?.quota ?? data?.quota)

    return (
        <Dialog open onClose={onClose} title={t('sessionInfo.title')} size="lg" footer={footer}>
            <div className="text-sm space-y-4">
                    {loading && <div className="text-text-secondary">{t('sessionInfo.loading')}</div>}
                    {error && <div className="text-red-500">{t('sessionInfo.failedToLoad')}</div>}
                    {/* Default view: what a person asks about a session. Ids, launch
                        arguments, runtime internals and the injected prompt live in
                        the single "Technical details" disclosure below (and in
                        Copy diagnostics), so nothing is lost. */}
                    {session && (
                        <div className="space-y-1.5" data-testid="session-info-summary">
                            <Row k={t('sessionInfo.rowProvider')} v={session.providerName || session.providerType} />
                            {workspacePath && (
                                <Row
                                    k={t('sessionInfo.rowWorkspace')}
                                    v={<Tooltip content={workspacePath}><span className="truncate">{pathBasename(workspacePath)}</span></Tooltip>}
                                />
                            )}
                            {machineName && <Row k={t('sessionInfo.rowMachine')} v={machineName} />}
                            {session.spawnedAtMs ? (
                                <Row k={t('sessionInfo.rowStarted')} v={<RelativeTime value={session.spawnedAtMs} />} />
                            ) : null}
                            {conv?.git && (
                                <Row
                                    k={t('sessionInfo.rowGit')}
                                    v={
                                        <span>
                                            {conv.git.branch || t('sessionInfo.gitDetached')}
                                            {conv.git.ahead ? ` ↑${conv.git.ahead}` : ''}
                                            {conv.git.behind ? ` ↓${conv.git.behind}` : ''}
                                            {conv.git.dirty ? ` · ${t('sessionInfo.gitDirty')}` : ` · ${t('sessionInfo.gitClean')}`}
                                        </span>
                                    }
                                />
                            )}
                            {data?.coordinator && <Row k={t('sessionInfo.rowRole')} v={t('sessionInfo.roleCoordinator')} />}
                            {/* Plan quota of the host machine — one Row per provider,
                                deliberately WITHOUT the freshness stamp or the card
                                chrome the mesh Status tab uses. */}
                            {quotaEntries.map(({ provider, quota }) => {
                                // Content assembly (cue, buckets-replace-axes,
                                // monthly, usage fallback, ok-without-windows vs
                                // failure) is the shared view-model's job; this
                                // dialog only picks the compact Row styling.
                                const model = buildQuotaDisplayModel(quota)
                                return (
                                    <Row
                                        key={provider}
                                        k={[quotaProviderLabel(provider), formatQuotaAccount(quota)].filter(Boolean).join(' · ')}
                                        v={
                                            model.kind === 'chips' ? (
                                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                                    {model.chips.map(chip => (
                                                        <QuotaChip key={chip.key} label={chip.label} tone={chip.tone} />
                                                    ))}
                                                </span>
                                            ) : model.kind === 'usage' ? (
                                                <QuotaChip label={model.usageLabel!} tone="info" />
                                            ) : model.kind === 'okNoWindows' ? (
                                                <span className="text-text-secondary">{model.message ?? t('sessionInfo.quotaOkNoWindows')}</span>
                                            ) : (
                                                <span className="text-text-secondary">{model.message}</span>
                                            )
                                        }
                                    />
                                )
                            })}
                            {/* Coordinator-spawned worker: name the spawning coordinator and
                                offer the jump, so spawned sessions stop reading as plain
                                workspace CLI sessions. */}
                            {worker?.coordinatorSessionId && (
                                <Row
                                    k={t('sessionInfo.sectionMeshWorker')}
                                    v={
                                        <span className="inline-flex flex-wrap items-center gap-2">
                                            {worker.coordinatorCliType && <span className="text-text-secondary">{worker.coordinatorCliType}</span>}
                                            {worker.coordinatorAlive === false ? (
                                                <span className="text-text-secondary">{t('sessionNav.coordinatorGone')}</span>
                                            ) : (
                                                // true (local, confirmed live) or undefined (remote
                                                // stamp — liveness unknowable): render the jump
                                                // optimistically. A miss lands on the existing
                                                // chatNotFound toast.
                                                <button
                                                    type="button"
                                                    className="rounded border border-border-default px-2 py-0.5 text-xs hover:bg-surface-secondary"
                                                    onClick={() => {
                                                        requestOpenSessionChat({ sessionId: worker.coordinatorSessionId!, source: 'session-info-dialog' })
                                                        onClose()
                                                    }}
                                                >
                                                    {t('sessionNav.openCoordinatorChat')}
                                                </button>
                                            )}
                                        </span>
                                    }
                                />
                            )}
                        </div>
                    )}
                    {(session || meshNode || data?.coordinator || (meshNodeError && (meshId || meshNodeId))) && (
                        <details className="group rounded-lg border border-border-subtle px-3 py-2" data-testid="session-info-technical-details">
                            <summary className="cursor-pointer select-none list-none text-xs font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
                                <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
                                {t('common.technicalDetails')}
                            </summary>
                            <div className="mt-3 space-y-4">
                                {session && (
                                    <Section title={t('sessionInfo.sectionSession')}>
                                        <Row k={t('sessionInfo.rowSessionId')} v={<Mono>{session.sessionId}</Mono>} />
                                        <Row k={t('sessionInfo.rowProviderType')} v={<Mono>{session.providerType}</Mono>} />
                                        {session.transport && <Row k={t('sessionInfo.rowTransport')} v={session.transport} />}
                                        {workspacePath && <Row k={t('sessionInfo.rowWorkspace')} v={<Mono>{workspacePath}</Mono>} />}
                                        {session.spawnedAtMs ? <Row k={t('sessionInfo.rowSpawnedAt')} v={formatTimestamp(session.spawnedAtMs)} /> : null}
                                        {session.providerSessionId && (
                                            <Row k={t('sessionInfo.rowProviderSessionId')} v={<Mono>{session.providerSessionId}</Mono>} />
                                        )}
                                        {conv?.connectionState && <Row k={t('sessionInfo.rowConnection')} v={conv.connectionState} />}
                                    </Section>
                                )}
                                {worker && (worker.meshId || worker.taskId || worker.coordinatorSessionId) && (
                                    <Section title={t('sessionInfo.sectionMeshWorker')}>
                                        {worker.meshId && <Row k={t('sessionInfo.rowMeshId')} v={<Mono>{worker.meshId}</Mono>} />}
                                        {worker.taskId && <Row k={t('sessionInfo.rowTaskId')} v={<Mono>{worker.taskId}</Mono>} />}
                                        {worker.coordinatorSessionId && <Row k={t('sessionInfo.rowCoordinator')} v={<Mono>{worker.coordinatorSessionId}</Mono>} />}
                                    </Section>
                                )}
                                {session?.launch && (
                                    <Section title={t('sessionInfo.sectionLaunch')}>
                                        {session.launch.command && (
                                            <Row k={t('sessionInfo.rowCommand')} v={<Mono>{session.launch.command}</Mono>} />
                                        )}
                                        {session.launch.cwd && (
                                            <Row k={t('sessionInfo.rowWorkingDirectory')} v={<Mono>{session.launch.cwd}</Mono>} />
                                        )}
                                        {Array.isArray(session.launch.args) && session.launch.args.length > 0 && (
                                            <Row k={t('sessionInfo.rowArgs')} v={<Mono>{session.launch.args.join(' ')}</Mono>} />
                                        )}
                                        {Array.isArray(session.launch.extraArgs) && session.launch.extraArgs.length > 0 && (
                                            <Row k={t('sessionInfo.rowExtraArgs')} v={<Mono>{session.launch.extraArgs.join(' ')}</Mono>} />
                                        )}
                                        {Array.isArray(session.launch.extraEnvKeys) && session.launch.extraEnvKeys.length > 0 && (
                                            <Row k={t('sessionInfo.rowExtraEnv')} v={<Mono>{session.launch.extraEnvKeys.join(', ')}</Mono>} />
                                        )}
                                    </Section>
                                )}
                                {meshNode && (
                                    <Section title={t('sessionInfo.sectionMeshNode')}>
                                        {meshNode.nodeId && <Row k={t('sessionInfo.rowNodeId')} v={<Mono>{meshNode.nodeId}</Mono>} />}
                                        {meshNode.workspace && <Row k={t('sessionInfo.rowWorkspace')} v={<Mono>{meshNode.workspace}</Mono>} />}
                                        {meshNode.repoRoot && meshNode.repoRoot !== meshNode.workspace && (
                                            <Row k={t('sessionInfo.rowRepoRoot')} v={<Mono>{meshNode.repoRoot}</Mono>} />
                                        )}
                                        {meshNode.daemonId && <Row k={t('sessionInfo.rowDaemonId')} v={<Mono>{meshNode.daemonId}</Mono>} />}
                                        {meshNode.role && <Row k={t('sessionInfo.rowRole')} v={meshNode.role} />}
                                        {meshNode.machineStatus && <Row k={t('sessionInfo.rowMachineStatus')} v={meshNode.machineStatus} />}
                                        {meshNode.health && <Row k={t('sessionInfo.rowHealth')} v={meshNode.health} />}
                                        {meshNode.isLocalWorktree && (
                                            <Row k={t('sessionInfo.rowWorktree')} v={meshNode.worktreeBranch ? <Mono>{meshNode.worktreeBranch}</Mono> : t('common.yes')} />
                                        )}
                                        {typeof meshNode.launchReady === 'boolean' && (
                                            <Row k={t('sessionInfo.rowLaunchReady')} v={yesNo(meshNode.launchReady)} />
                                        )}
                                        {meshNode.git && (
                                            <Row
                                                k={t('sessionInfo.rowGit')}
                                                v={
                                                    <span>
                                                        {meshNode.git.branch || t('sessionInfo.gitDetached')}
                                                        {meshNode.git.headCommit ? ` @ ${String(meshNode.git.headCommit).slice(0, 10)}` : ''}
                                                        {meshNode.git.ahead ? ` ↑${meshNode.git.ahead}` : ''}
                                                        {meshNode.git.behind ? ` ↓${meshNode.git.behind}` : ''}
                                                        {meshNode.git.dirty ? ` · ${t('sessionInfo.gitDirty')}` : ` · ${t('sessionInfo.gitClean')}`}
                                                        {meshNode.git.upstream ? ` · ${meshNode.git.upstream}` : ''}
                                                    </span>
                                                }
                                            />
                                        )}
                                        {meshNode.connection && (
                                            <Row
                                                k={t('sessionInfo.rowConnection')}
                                                v={
                                                    <span>
                                                        {meshNode.connection.transport || '—'}
                                                        {meshNode.connection.state ? ` · ${meshNode.connection.state}` : ''}
                                                        {typeof meshNode.connection.rttMs === 'number' ? ` · RTT ${meshNode.connection.rttMs}ms` : ''}
                                                    </span>
                                                }
                                            />
                                        )}
                                        {Array.isArray(meshNode.providers) && meshNode.providers.length > 0 && (
                                            <Row k={t('sessionInfo.rowProviders')} v={<Mono>{meshNode.providers.join(', ')}</Mono>} />
                                        )}
                                        {Array.isArray(meshNode.providerPriority) && meshNode.providerPriority.length > 0 && (
                                            <Row k={t('sessionInfo.rowProviderPriority')} v={<Mono>{meshNode.providerPriority.join(' › ')}</Mono>} />
                                        )}
                                    </Section>
                                )}
                                {!meshNode && meshNodeError && (meshId || meshNodeId) && (
                                    <Section title={t('sessionInfo.sectionMeshNode')}>
                                        <div className="text-text-secondary italic">{meshNodeError}</div>
                                    </Section>
                                )}
                                {data?.coordinator && (
                                    <Section title={t('sessionInfo.sectionMeshCoordinator')}>
                                        <Row k={t('sessionInfo.rowMeshId')} v={<Mono>{data.coordinator.meshId}</Mono>} />
                                        {data.coordinator.cliType && <Row k={t('sessionInfo.rowCoordinatorCli')} v={data.coordinator.cliType} />}
                                        {data.coordinator.startedAt ? <Row k={t('sessionInfo.rowStartedAt')} v={formatTimestamp(data.coordinator.startedAt)} /> : null}
                                        {data.coordinator.injection && (
                                            <Row
                                                k={t('sessionInfo.rowPromptInjection')}
                                                v={`${data.coordinator.injection.mode}${data.coordinator.injection.target ? ` → ${data.coordinator.injection.target}` : ''}`}
                                            />
                                        )}
                                        {data.coordinator.mcpConfigPath && (
                                            <Row k={t('sessionInfo.rowMcpConfig')} v={<Mono>{data.coordinator.mcpConfigPath}</Mono>} />
                                        )}
                                        {data.coordinator.extraSystemPrompt && (
                                            <Block title={t('sessionInfo.blockExtraPrompt')} body={data.coordinator.extraSystemPrompt} />
                                        )}
                                        {data.coordinator.systemPrompt && (
                                            <Block title={t('sessionInfo.blockFinalPrompt')} body={data.coordinator.systemPrompt} />
                                        )}
                                    </Section>
                                )}
                                {session?.runtimeMetadata != null && (
                                    <RuntimeMetadataSection meta={session.runtimeMetadata} />
                                )}
                                {error && <div className="font-mono text-xs text-text-secondary break-all">{error}</div>}
                            </div>
                        </details>
                    )}
                </div>
        </Dialog>
    )
}

/**
 * Plain-text snapshot of everything the dialog knows — the "Copy diagnostics"
 * payload for a bug report. Deliberately includes the ids and launch details
 * the default view hides.
 */
export function buildSessionDiagnostics(input: {
    sessionId: string
    daemonId: string
    conv?: SessionInfoConversation
    data: SessionInfoResponse | null
    meshNode: JoinedMeshNode | null
    meshNodeError: string | null
}): string {
    const { sessionId, daemonId, conv, data, meshNode, meshNodeError } = input
    const payload = {
        sessionId,
        daemonId,
        machine: conv?.machineName || data?.machineNickname || null,
        connectionState: conv?.connectionState ?? null,
        git: conv?.git ?? null,
        session: data?.session ?? null,
        meshWorker: data?.meshWorker ?? null,
        coordinator: data?.coordinator ?? null,
        meshNode: meshNode ?? null,
        meshNodeError: meshNodeError ?? null,
        error: data?.error ?? null,
    }
    try {
        return JSON.stringify(payload, null, 2)
    } catch {
        return String(payload)
    }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <h3 className="text-xs uppercase tracking-wide text-text-secondary mb-1">{title}</h3>
            <div className="space-y-1">{children}</div>
        </div>
    )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex flex-col sm:flex-row gap-1 sm:gap-3">
            <div className="w-full sm:w-36 sm:shrink-0 text-text-secondary font-medium sm:font-normal">{k}</div>
            <div className="min-w-0 break-all">{v}</div>
        </div>
    )
}

function Mono({ children }: { children: React.ReactNode }) {
    return <code className="font-mono text-xs">{children}</code>
}

/** Small usage pill for the quota rows — same 70/90% tone vocabulary as the CLI. */
function QuotaChip({ label, tone }: { label: string; tone: string }) {
    const toneClass = tone === 'danger' ? 'bg-red-500/10 text-red-500'
        : tone === 'warn' ? 'bg-amber-500/10 text-amber-500'
        : tone === 'good' ? 'bg-emerald-500/10 text-emerald-500'
        : 'bg-white/5 text-text-secondary'
    return <span className={`rounded-full px-2 py-0.5 text-3xs font-medium ${toneClass}`}>{label}</span>
}

/**
 * Renders the daemon-reported runtime metadata (PtyRuntimeMetadata). Surfaces the
 * known scalar fields as rows and the full object as a collapsible JSON block so the
 * panel stays useful even as the metadata shape evolves.
 */
function RuntimeMetadataSection({ meta }: { meta: unknown }) {
    const { t } = useTranslation('common')
    if (!meta || typeof meta !== 'object') return null
    const m = meta as Record<string, unknown>
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
    const runtimeId = str(m.runtimeId)
    const lifecycle = str(m.lifecycle)
    const surfaceKind = str(m.surfaceKind)
    const recoveryState = str(m.recoveryState)
    const attached = Array.isArray(m.attachedClients) ? m.attachedClients.length : null
    return (
        <Section title={t('sessionInfo.sectionRuntime')}>
            {runtimeId && <Row k={t('sessionInfo.rowRuntimeId')} v={<Mono>{runtimeId}</Mono>} />}
            {lifecycle && <Row k={t('sessionInfo.rowLifecycle')} v={lifecycle} />}
            {surfaceKind && <Row k={t('sessionInfo.rowSurface')} v={surfaceKind} />}
            {recoveryState && <Row k={t('sessionInfo.rowRecoveryState')} v={recoveryState} />}
            {typeof m.restoredFromStorage === 'boolean' && (
                <Row k={t('sessionInfo.rowRestoredFromStorage')} v={m.restoredFromStorage ? t('common.yes') : t('common.no')} />
            )}
            {attached != null && <Row k={t('sessionInfo.rowAttachedClients')} v={String(attached)} />}
            <Block title={t('sessionInfo.blockRawMetadata')} body={safeJson(meta)} />
        </Section>
    )
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function Block({ title, body, defaultOpen = false }: { title: string; body: string; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="text-xs uppercase tracking-wide text-text-secondary hover:text-text-primary"
                style={{ pointerEvents: 'auto' }}
            >
                {open ? '▾' : '▸'} {title}
            </button>
            {open && (
                <pre className="mt-1 p-2 bg-[var(--surface-secondary)] border border-border-subtle rounded text-xs whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                    {body}
                </pre>
            )}
        </div>
    )
}
