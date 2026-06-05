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

import { useCallback, useEffect, useState } from 'react'
import { useTransport } from '../../context/TransportContext'

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

interface SessionInfoSession {
    sessionId: string
    providerType: string
    providerName?: string
    transport?: string
    workspace?: string
    spawnedAtMs?: number
    providerSessionId?: string
    runtimeMetadata?: unknown
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

export default function SessionInfoDialog({ sessionId, daemonId, onClose }: Props) {
    const { sendCommand } = useTransport()
    const [loading, setLoading] = useState(true)
    const [data, setData] = useState<SessionInfoResponse | null>(null)
    const [error, setError] = useState<string | null>(null)

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
                setError(inner?.error || 'Failed to load session info')
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

    // Esc closes — same convention as other modals in web-core.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Session info"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={onClose}
            /* SessionInfoButton's parent (the chat-activity-toggle-bar) has
               pointer-events: none so the bar doesn't steal clicks from the
               chat body. We portal-by-fixed-positioning visually, but the DOM
               parent chain still inherits that, so clicks on the backdrop —
               and on Close/✕ — would silently fall through. Re-enable here. */
            style={{ pointerEvents: 'auto' }}
        >
            <div
                className="bg-[var(--surface-primary)] text-text-primary border border-border-default rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                    <h2 className="text-base font-semibold">Session info</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-text-secondary hover:text-text-primary px-2 py-1 rounded"
                        aria-label="Close"
                    >×</button>
                </div>
                <div className="overflow-y-auto px-4 py-3 text-sm space-y-4">
                    {loading && <div className="text-text-secondary">Loading…</div>}
                    {error && <div className="text-red-500">{error}</div>}
                    {data?.session && (
                        <Section title="Session">
                            <Row k="Session ID" v={<Mono>{data.session.sessionId}</Mono>} />
                            <Row k="Provider" v={`${data.session.providerName || data.session.providerType} (${data.session.providerType})`} />
                            {data.session.transport && <Row k="Transport" v={data.session.transport} />}
                            {data.session.workspace && <Row k="Workspace" v={<Mono>{data.session.workspace}</Mono>} />}
                            <Row
                                k="Spawned at"
                                v={
                                    <>
                                        {formatTimestamp(data.session.spawnedAtMs)}
                                        {data.session.spawnedAtMs ? <span className="text-text-secondary ml-2">{formatRelative(data.session.spawnedAtMs)}</span> : null}
                                    </>
                                }
                            />
                            {data.session.providerSessionId && (
                                <Row k="Provider session ID" v={<Mono>{data.session.providerSessionId}</Mono>} />
                            )}
                        </Section>
                    )}
                    {data?.coordinator && (
                        <Section title="Mesh coordinator">
                            <Row k="Mesh ID" v={<Mono>{data.coordinator.meshId}</Mono>} />
                            {data.coordinator.cliType && <Row k="Coordinator CLI" v={data.coordinator.cliType} />}
                            <Row
                                k="Started at"
                                v={
                                    <>
                                        {formatTimestamp(data.coordinator.startedAt)}
                                        {data.coordinator.startedAt ? <span className="text-text-secondary ml-2">{formatRelative(data.coordinator.startedAt)}</span> : null}
                                    </>
                                }
                            />
                            {data.coordinator.injection && (
                                <Row
                                    k="Prompt injection"
                                    v={`${data.coordinator.injection.mode}${data.coordinator.injection.target ? ` → ${data.coordinator.injection.target}` : ''}`}
                                />
                            )}
                            {data.coordinator.mcpConfigPath && (
                                <Row k="MCP config" v={<Mono>{data.coordinator.mcpConfigPath}</Mono>} />
                            )}
                            {data.coordinator.extraSystemPrompt && (
                                <Block title="Per-launch extra prompt" body={data.coordinator.extraSystemPrompt} defaultOpen />
                            )}
                            {data.coordinator.systemPrompt && (
                                <Block title="Final system prompt (click to expand)" body={data.coordinator.systemPrompt} />
                            )}
                        </Section>
                    )}
                    {data && !data.coordinator && (
                        <div className="text-text-secondary italic">
                            This isn't a mesh coordinator session, so no coordinator-specific
                            prompt was injected. The agent runs with whatever defaults its CLI
                            ships with.
                        </div>
                    )}
                </div>
                <div className="border-t border-border-subtle px-4 py-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="px-3 py-1 text-sm rounded border border-border-default hover:bg-surface-secondary"
                    >Refresh</button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3 py-1 text-sm rounded bg-accent text-white hover:opacity-90"
                    >Close</button>
                </div>
            </div>
        </div>
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
        <div className="flex gap-3">
            <div className="w-44 shrink-0 text-text-secondary">{k}</div>
            <div className="min-w-0 break-all">{v}</div>
        </div>
    )
}

function Mono({ children }: { children: React.ReactNode }) {
    return <code className="font-mono text-xs">{children}</code>
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
