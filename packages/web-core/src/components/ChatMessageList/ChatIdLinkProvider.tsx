/**
 * ChatIdLinkProvider — the heavy half of "identifiers in chat bubbles become links".
 *
 * Resolution is lazy and subscription-free: the resolver reads the sources the dashboard
 * already holds, at render time —
 *   - session ids  → the daemon/session lists (`useBaseDaemons().ides`)
 *   - `mi_…`       → NeedsYou snapshot (open/answered decisions, live checks)
 *   - mission/task → NeedsYou missions + the shared coordinator mesh-status store
 *   - `art_…`      → shape-checked; only offered when this chat has a daemon to ask (the
 *                    click then looks the artifact up with the existing `artifact_list` /
 *                    `artifact_fetch` commands, and says so if it is not there)
 * An id nobody knows is never linked. The context value only changes when the *set* of known
 * ids changes (signature), so rows do not re-parse on every status tick.
 *
 * Trade-off (owner principle: convenience first, never silently): a row rendered before an id
 * became known keeps showing plain text until its next render — acceptable, ids that matter
 * are known by the time the message is read.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import type { ChatAttachmentMeta } from '@adhdev/daemon-core'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useNeedsYou } from '../../context/NeedsYouContext'
import { useTransport } from '../../context/TransportContext'
import { listCoordinatorMeshStatuses, subscribeAnyCoordinatorMeshStatus } from '../../utils/coordinator-mesh-status-store'
import { buildMeshDeepLink } from '../../utils/mesh-deep-link'
import { buildDecisionFallbackUrl } from '../../hooks/decisionPushAnswer'
import { fetchMeshArtifactPayload } from '../../utils/mesh-artifact-fetch'
import { resolveArtifactSessionTarget } from '../../hooks/useArtifactRead'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'
import ArtifactFullscreenViewer from '../attachments/ArtifactFullscreenViewer'
import { openArtifactInNewWindow } from '../attachments/artifact-popout'
import { toArtifactViewerItem, type ArtifactViewerItem } from '../attachments/artifact-viewer-item'
import { ChatIdLinkContext, type ChatIdLinkApi } from './chat-id-link-context'
import { isChatIdShape, type ChatIdResolver, type ChatIdTarget } from './chat-id-links'

export interface ChatIdLinkProviderProps {
    children: ReactNode
    contextKey?: string
    daemonId?: string
    sessionId?: string
    meshCoordinatorDaemonId?: string
}

const ARTIFACT_LIST_PAGE = 100
const ARTIFACT_LIST_MAX_PAGES = 5
const metaCache = new Map<string, { hostDaemonId: string; attachment: ChatAttachmentMeta }>()

export function sessionHref(id: string): string {
    return `/dashboard?activeTab=${encodeURIComponent(id)}`
}

/** Pure: where a non-artifact target navigates. */
export function chatIdTargetHref(target: ChatIdTarget): string | null {
    switch (target.kind) {
        case 'session': return sessionHref(target.id)
        case 'decision': return buildDecisionFallbackUrl(target.meshId, target.id)
        case 'mission': return buildMeshDeepLink({ meshId: target.meshId, tab: 'overview', missionId: target.id })
        case 'task': return buildMeshDeepLink({ meshId: target.meshId, tab: 'tasks', taskId: target.id })
        default: return null
    }
}

interface Known {
    sessions: Set<string>
    decisions: Map<string, string>
    missions: Map<string, string>
    tasks: Map<string, string>
}

function collectSessions(ides: readonly any[]): Set<string> {
    const out = new Set<string>()
    const add = (v: unknown) => { if (typeof v === 'string' && v) out.add(v.toLowerCase()) }
    for (const ide of ides) {
        add(ide?.sessionId); add(ide?.providerSessionId); add(ide?.historySessionId); add(ide?.nativeSessionId)
        if (Array.isArray(ide?.childSessions)) {
            for (const c of ide.childSessions) { add(c?.id); add(c?.providerSessionId) }
        }
    }
    return out
}

export function ChatIdLinkProvider(props: ChatIdLinkProviderProps) {
    return useInRouterContext() ? <WithRouter {...props} /> : <Core {...props} navigate={null} />
}

function WithRouter(props: ChatIdLinkProviderProps) {
    const navigate = useNavigate()
    return <Core {...props} navigate={navigate} />
}

function Core({ children, contextKey, daemonId, sessionId, meshCoordinatorDaemonId, navigate }: ChatIdLinkProviderProps & { navigate: ((to: string) => void) | null }) {
    const { t } = useTranslation('common')
    const { ides } = useBaseDaemons()
    const needsYou = useNeedsYou()
    const { sendCommand } = useTransport()
    const [meshTick, setMeshTick] = useState(0)
    const [viewer, setViewer] = useState<ArtifactViewerItem | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    // Mesh status changes → bump only when the id population changed (count signature), throttled.
    const meshSigRef = useRef('')
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const unsub = subscribeAnyCoordinatorMeshStatus(() => {
            if (timer) return
            timer = setTimeout(() => {
                timer = null
                const sig = listCoordinatorMeshStatuses()
                    .map(m => `${m.meshId}:${(m.status.missions ?? []).length}:${((m.status.queue as any)?.tasks ?? []).length}`).join('|')
                if (sig !== meshSigRef.current) { meshSigRef.current = sig; setMeshTick(n => n + 1) }
            }, 1000)
        })
        return () => { if (timer) clearTimeout(timer); unsub() }
    }, [])

    const known = useMemo<Known>(() => {
        const snap = needsYou.snapshot
        const decisions = new Map<string, string>()
        for (const d of snap.decisions) decisions.set(d.itemId, d.meshId)
        for (const d of snap.liveChecks) decisions.set(d.itemId, d.meshId)
        for (const d of snap.answered) decisions.set(d.itemId, d.meshId)
        const missions = new Map<string, string>()
        for (const m of snap.missions) missions.set(m.missionId.toLowerCase(), m.meshId)
        const tasks = new Map<string, string>()
        for (const { meshId, status } of listCoordinatorMeshStatuses()) {
            for (const m of status.missions ?? []) if (m?.id) missions.set(String(m.id).toLowerCase(), meshId)
            for (const task of ((status.queue as any)?.tasks ?? []) as Array<{ id?: string }>) {
                if (task?.id) tasks.set(String(task.id).toLowerCase(), meshId)
            }
        }
        return { sessions: collectSessions(ides as any[]), decisions, missions, tasks }
        // meshTick: the mesh-status store is read here
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ides, needsYou.snapshot, meshTick])

    const canAskForArtifacts = Boolean(daemonId || meshCoordinatorDaemonId || contextKey)
    const stateRef = useRef({ known, canAskForArtifacts, sendCommand, ides, contextKey, daemonId, sessionId, meshCoordinatorDaemonId, navigate, t })
    stateRef.current = { known, canAskForArtifacts, sendCommand, ides, contextKey, daemonId, sessionId, meshCoordinatorDaemonId, navigate, t }

    // The context value changes only when the known-id population does.
    const signature = `${canAskForArtifacts}|${[...known.sessions].join(',')}|${[...known.decisions.keys()].join(',')}|${[...known.missions.keys()].join(',')}|${[...known.tasks.keys()].join(',')}`

    const findArtifact = useCallback(async (artifactId: string) => {
        const cached = metaCache.get(artifactId)
        if (cached) return cached
        const st = stateRef.current
        const target = resolveArtifactSessionTarget({
            daemonId: st.daemonId, sessionId: st.sessionId, meshCoordinatorDaemonId: st.meshCoordinatorDaemonId,
            contextKey: st.contextKey, ides: st.ides as any,
        })
        const hostDaemonId = target?.meshCoordinatorDaemonId || st.meshCoordinatorDaemonId || target?.daemonId || st.daemonId || ''
        if (!hostDaemonId) return null
        const keep = (attachment: ChatAttachmentMeta, fallbackSession?: string) => {
            const withOrigin = attachment.originSessionId || !fallbackSession ? attachment : { ...attachment, originSessionId: fallbackSession }
            const hit = { hostDaemonId, attachment: withOrigin }
            metaCache.set(artifactId, hit)
            return hit
        }
        const listPages = async (args: Record<string, unknown>, fallbackSession?: string) => {
            let cursor: string | null = null
            for (let page = 0; page < ARTIFACT_LIST_MAX_PAGES; page++) {
                const raw = await st.sendCommand(hostDaemonId, 'artifact_list', { ...args, limit: ARTIFACT_LIST_PAGE, ...(cursor ? { cursor } : {}) })
                const body = unwrapDaemonCommandBody<Record<string, unknown>>(raw)
                if (!body || body.success === false) return null
                const list = Array.isArray(body.attachments) ? (body.attachments as ChatAttachmentMeta[]) : []
                const found = list.find(a => a.artifactId === artifactId)
                if (found) return keep(found, fallbackSession)
                if (body.hasMore !== true || typeof body.nextCursor !== 'string') return null
                cursor = body.nextCursor
            }
            return null
        }
        // Meshes this host coordinates first (a coordinator quotes worker artifacts), then the chat's own session.
        for (const { meshId, daemonId: meshDaemon } of listCoordinatorMeshStatuses()) {
            if (meshDaemon && meshDaemon !== hostDaemonId) continue
            const hit = await listPages({ meshId }).catch(() => null)
            if (hit) return hit
        }
        const sid = target?.sessionId || st.sessionId
        if (sid) return listPages({ sessionId: sid, targetSessionId: sid }, sid).catch(() => null)
        return null
    }, [])

    const openArtifact = useCallback(async (artifactId: string, newWindow: boolean) => {
        const st = stateRef.current
        try {
            const hit = await findArtifact(artifactId)
            if (!hit) { setNotice(st.t('chat.idLink.artifactNotFound', { id: artifactId })); return }
            const payload = await fetchMeshArtifactPayload({ sendCommand: st.sendCommand, hostDaemonId: hit.hostDaemonId, attachment: hit.attachment })
            const item = toArtifactViewerItem(payload)
            if (newWindow) { if (!openArtifactInNewWindow(item)) setViewer(item) } else setViewer(item)
        } catch (e) {
            setNotice(st.t('chat.idLink.artifactFailed', { id: artifactId, reason: e instanceof Error ? e.message : String(e) }))
        }
    }, [findArtifact])

    useEffect(() => {
        if (!notice) return
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
    }, [notice])

    const api = useMemo<ChatIdLinkApi>(() => {
        const resolve: ChatIdResolver = (id) => {
            if (!isChatIdShape(id)) return null
            const k = stateRef.current.known
            const key = id.toLowerCase()
            if (id.startsWith('art_')) return stateRef.current.canAskForArtifacts ? { kind: 'artifact', id } : null
            if (id.startsWith('mi_')) {
                const meshId = k.decisions.get(id)
                return meshId ? { kind: 'decision', id, meshId } : null
            }
            if (k.sessions.has(key)) return { kind: 'session', id }
            const missionMesh = k.missions.get(key)
            if (missionMesh) return { kind: 'mission', id, meshId: missionMesh }
            const taskMesh = k.tasks.get(key)
            if (taskMesh) return { kind: 'task', id, meshId: taskMesh }
            return null
        }
        return {
            resolve,
            hrefOf: chatIdTargetHref,
            open: (target, opts) => {
                if (target.kind === 'artifact') { void openArtifact(target.id, opts?.newWindow === true); return }
                const href = chatIdTargetHref(target)
                const nav = stateRef.current.navigate
                if (href && nav) nav(href)
                else if (href && typeof window !== 'undefined') window.location.assign(href)
            },
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature, openArtifact])

    return (
        <ChatIdLinkContext.Provider value={api}>
            {children}
            {notice && (
                <div role="alert" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-primary shadow-lg">
                    {notice}
                </div>
            )}
            {viewer && <ArtifactFullscreenViewer item={viewer} popOutPayload={viewer} onClose={() => setViewer(null)} />}
        </ChatIdLinkContext.Provider>
    )
}
