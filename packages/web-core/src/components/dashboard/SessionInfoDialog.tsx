/**
 * SessionInfoDialog
 *
 * Modal that surfaces everything the daemon knows about a single live session:
 * session id, provider, workspace, when it spawned, and — for mesh coordinator
 * sessions — the actual system prompt that was injected, where it landed, and
 * any per-launch extra instructions.
 *
 * Triggered by SessionInfoButton (the ⓘ next to the chat controls). Loads the
 * payload on open via daemon's `get_session_info` command, so it's free for
 * non-coordinator sessions and only pays the round-trip when a user opens it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransport } from '../../context/TransportContext'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import {
    joinMeshNodeForSession,
    resolveSessionMeshId,
    resolveSessionMeshNodeId,
    type JoinedMeshNode,
    type SessionInfoConversation,
} from './session-info-data'
import Dialog from '../ui/Dialog'

export type { SessionInfoConversation } from './session-info-data'

interface SessionInjection {
    mode: string
    target?: string
}

interface SessionInfoCoordinator {
    meshId?: string
    startedAt?: number
    cliType?: string
    systemPrompt?: string
    extraSystemPrompt?: string
    injection?: SessionInjection
    mcpConfigPath?: string
}

/** Launch metadata mirrored from daemon-core CliLaunchInfo (get_session_info). */
interface SessionLaunchInfo {
    command?: string
    args?: string[]
    extraArgs?: string[]
    cwd?: string
    extraEnvKeys?: string[]
    providerSessionId?: string
}

interface SessionInfoSession {
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

interface SessionInfoResponse {
    success: boolean
    error?: string
    session?: SessionInfoSession
    coordinator?: SessionInfoCoordinator | null
}

interface Props {
    sessionId: string
    daemonId: string
    conv?: SessionInfoConversation
    onClose: () => void
}

function formatTimestamp(ms?: number): string {
    if (!ms || !Number.isFinite(ms)) return '—'
    try {
        const d = new Date(ms)
        return `${d.toLocaleString()} (${ms})`
    } catch {
        return String(ms)
    }
}

function formatRelative(ms?: number): string {
    if (!ms) return ''
    const delta = Date.now() - ms
    if (delta < 0) return ''
    const sec = Math.floor(delta / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return `${Math.floor(hr / 24)}d ago`
}

export default function SessionInfoDialog({ sessionId, daemonId, conv, onClose }: Props) {
    const { t } = useTranslation('common')
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
    }, [sendCommand, daemonId, sessionId])

    useEffect(() => { void load() }, [load])

    // Join the live mesh node this session belongs to. Best-effort: a session that
    // isn't a mesh member (no meshId), a daemon with no loadMeshStatus override, or a
    // failed/empty mesh_status all leave the Mesh node section hidden rather than
    // blocking the whole panel.
    const loadMeshNode = useCallback(async () => {
        setMeshNode(null)
        setMeshNodeError(null)
        if (!meshId || !meshNodeId || !meshOverrides?.loadMeshStatus) return
        try {
            const raw = await meshOverrides.loadMeshStatus(daemonId, meshId, { refresh: false })
            const node = joinMeshNodeForSession(raw, meshNodeId)
            if (!node) {
                setMeshNodeError(t('sessionInfo.stampedToNode'))
                return
            }
            setMeshNode(node)
        } catch (e: any) {
            setMeshNodeError(e?.message || 'Failed to load mesh node info')
        }
    }, [meshOverrides, daemonId, meshId, meshNodeId])

    useEffect(() => { void loadMeshNode() }, [loadMeshNode])

    const footer = (
        <>
            <button
                type="button"
                onClick={() => void load()}
                className="px-3 py-1 text-sm rounded border border-border-default hover:bg-surface-secondary"
            >{t('sessionInfo.refresh')}</button>
            <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-sm rounded bg-accent text-white hover:opacity-90"
            >{t('sessionInfo.close')}</button>
        </>
    )

    return (
        /* SessionInfoButton's parent (the chat-activity-toggle-bar) has
           pointer-events: none so the bar doesn't steal clicks from the
           chat body. Dialog portals into <body> which is outside that
           subtree, so pointer events work correctly. */
        <Dialog open onClose={onClose} title={t('sessionInfo.title')} size="lg" footer={footer}>
            <div className="text-sm space-y-4">
                    {loading && <div className="text-text-secondary">{t('sessionInfo.loading')}</div>}
                    {error && <div className="text-red-500">{error}</div>}
                    {data?.session && (
                        <Section title={t('sessionInfo.sectionSession')}>
                            <Row k={t('sessionInfo.rowSessionId')} v={<Mono>{data.session.sessionId}</Mono>} />
                            <Row k={t('sessionInfo.rowProvider')} v={`${data.session.providerName || data.session.providerType} (${data.session.providerType})`} />
                            {data.session.transport && <Row k={t('sessionInfo.rowTransport')} v={data.session.transport} />}
                            {data.session.workspace && <Row k={t('sessionInfo.rowWorkspace')} v={<Mono>{data.session.workspace}</Mono>} />}
                            <Row
                                k={t('sessionInfo.rowSpawnedAt')}
                                v={
                                    <>
                                        {formatTimestamp(data.session.spawnedAtMs)}
                                        {data.session.spawnedAtMs ? <span className="text-text-secondary ml-2">{formatRelative(data.session.spawnedAtMs)}</span> : null}
                                    </>
                                }
                            />
                            {data.session.providerSessionId && (
                                <Row k={t('sessionInfo.rowProviderSessionId')} v={<Mono>{data.session.providerSessionId}</Mono>} />
                            )}
                            {!data.session.workspace && conv?.workspacePath && (
                                <Row k={t('sessionInfo.rowWorkspace')} v={<Mono>{conv.workspacePath}</Mono>} />
                            )}
                            {conv?.machineName && <Row k={t('sessionInfo.rowMachine')} v={conv.machineName} />}
                            {conv?.connectionState && <Row k={t('sessionInfo.rowConnection')} v={conv.connectionState} />}
                            {conv?.git && (
                                <Row
                                    k={t('sessionInfo.rowWorkspaceGit')}
                                    v={
                                        <span>
                                            {conv.git.branch || '(detached)'}
                                            {conv.git.ahead ? ` ↑${conv.git.ahead}` : ''}
                                            {conv.git.behind ? ` ↓${conv.git.behind}` : ''}
                                            {conv.git.dirty ? ' · dirty' : ' · clean'}
                                        </span>
                                    }
                                />
                            )}
                        </Section>
                    )}
                    {data?.session?.launch && (
                        <Section title={t('sessionInfo.sectionLaunch')}>
                            {data.session.launch.command && (
                                <Row k={t('sessionInfo.rowCommand')} v={<Mono>{data.session.launch.command}</Mono>} />
                            )}
                            {data.session.launch.cwd && (
                                <Row k={t('sessionInfo.rowWorkingDirectory')} v={<Mono>{data.session.launch.cwd}</Mono>} />
                            )}
                            {Array.isArray(data.session.launch.args) && data.session.launch.args.length > 0 && (
                                <Row k={t('sessionInfo.rowArgs')} v={<Mono>{data.session.launch.args.join(' ')}</Mono>} />
                            )}
                            {Array.isArray(data.session.launch.extraArgs) && data.session.launch.extraArgs.length > 0 && (
                                <Row k={t('sessionInfo.rowExtraArgs')} v={<Mono>{data.session.launch.extraArgs.join(' ')}</Mono>} />
                            )}
                            {Array.isArray(data.session.launch.extraEnvKeys) && data.session.launch.extraEnvKeys.length > 0 && (
                                <Row
                                    k={t('sessionInfo.rowExtraEnv')}
                                    v={<Mono>{data.session.launch.extraEnvKeys.join(', ')}</Mono>}
                                />
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
                                <Row k={t('sessionInfo.rowWorktree')} v={meshNode.worktreeBranch ? <Mono>{meshNode.worktreeBranch}</Mono> : 'yes'} />
                            )}
                            {typeof meshNode.launchReady === 'boolean' && (
                                <Row k={t('sessionInfo.rowLaunchReady')} v={meshNode.launchReady ? 'yes' : 'no'} />
                            )}
                            {meshNode.git && (
                                <Row
                                    k={t('sessionInfo.rowGit')}
                                    v={
                                        <span>
                                            {meshNode.git.branch || '(detached)'}
                                            {meshNode.git.headCommit ? ` @ ${String(meshNode.git.headCommit).slice(0, 10)}` : ''}
                                            {meshNode.git.ahead ? ` ↑${meshNode.git.ahead}` : ''}
                                            {meshNode.git.behind ? ` ↓${meshNode.git.behind}` : ''}
                                            {meshNode.git.dirty ? ' · dirty' : ' · clean'}
                                            {meshNode.git.upstream ? ` · ${meshNode.git.upstream}` : ''}
                                        </span>
                                    }
                                />
                            )}
                            {meshNode.connection && (
                                <Row
                                    k="Connection"
                                    v={
                                        <span>
                                            {meshNode.connection.transport || '—'}
                                            {meshNode.connection.state ? ` · ${meshNode.connection.state}` : ''}
                                            {typeof meshNode.connection.rttMs === 'number' ? ` · ${meshNode.connection.rttMs}ms RTT` : ''}
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
                            <Row
                                k={t('sessionInfo.rowStartedAt')}
                                v={
                                    <>
                                        {formatTimestamp(data.coordinator.startedAt)}
                                        {data.coordinator.startedAt ? <span className="text-text-secondary ml-2">{formatRelative(data.coordinator.startedAt)}</span> : null}
                                    </>
                                }
                            />
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
                                <Block title="Per-launch extra prompt" body={data.coordinator.extraSystemPrompt} defaultOpen />
                            )}
                            {data.coordinator.systemPrompt && (
                                <Block title="Final system prompt (click to expand)" body={data.coordinator.systemPrompt} />
                            )}
                        </Section>
                    )}
                    {data?.session?.runtimeMetadata != null && (
                        <RuntimeMetadataSection meta={data.session.runtimeMetadata} />
                    )}
                    {data && !data.coordinator && (
                        <div className="text-text-secondary italic">
                            {t('sessionInfo.notCoordinatorSession')}
                        </div>
                    )}
                </div>
        </Dialog>
    )
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
                <Row k={t('sessionInfo.rowRestoredFromStorage')} v={m.restoredFromStorage ? 'yes' : 'no'} />
            )}
            {attached != null && <Row k={t('sessionInfo.rowAttachedClients')} v={String(attached)} />}
            <Block title="Raw runtime metadata (click to expand)" body={safeJson(meta)} />
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
