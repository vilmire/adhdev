/**
 * NeedsYouContext — the owner-decision inbox state shared by the "Needs you" page,
 * the navigation count badge and the Overview mission cards (structured-missions
 * design 2026-10-28 §6.2). Follows the staged-Inbox hook pattern
 * (hooks/useAssistantStagedWrites.ts): list + per-item outcomes + busy ids +
 * refresh/resolve over the dashboard's ordinary command transport (standalone
 * WS/HTTP, cloud P2P — never a server relay).
 *
 * Refresh policy (no tight polling): on mount / when the set of connected daemons
 * changes, when the window regains focus, after every answer, and when a hosted
 * mesh's `mesh.status` feed reports that a mission changed (a mission write calls
 * notifyMissionChanged on the daemon, which flushes that feed). Daemons that do not
 * know the command (older builds) simply contribute nothing.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MeshStatusSnapshotUpdate } from '@adhdev/daemon-core'
import { useTransport } from './TransportContext'
import { useDaemons } from '../compat'
import { subscriptionManager } from '../managers/SubscriptionManager'
import type { AssistantStagedWritesState } from '../hooks/useAssistantStagedWrites'
import { useAggregatedStagedWrites } from '../hooks/useAggregatedStagedWrites'
import { extractRepoMeshStatus } from '../utils/repo-mesh-status'
import { deriveProviderApprovalInbox } from '../components/MeshGraph/providerApprovalInbox'
import type { PendingApprovalItem } from '../components/MeshGraph/PendingApprovalsInbox'
import {
    EMPTY_NEEDS_YOU_SNAPSHOT,
    NEEDS_YOU_ANSWER_COMMAND,
    NEEDS_YOU_LIVE_CHECK_COMMAND,
    NEEDS_YOU_LIST_COMMAND,
    PENDING_ACTION_TTL_MS,
    applyPendingOwnerActions,
    buildNeedsYouEntries,
    mergeNeedsYouSnapshots,
    needsYouCount,
    parseNeedsYouList,
    pendingActionKey,
    unwrapCommandBody,
    type NeedsYouEntry,
    type PendingOwnerAction,
    type NeedsYouSnapshot,
} from '../components/needs-you/needs-you-model'

export interface NeedsYouAnswerInput {
    daemonId: string
    meshId: string
    missionId?: string
    itemId: string
    optionId?: string
    text?: string
    undo?: boolean
    /** The decision revision the card showed; the daemon refuses the answer as stale when it moved on. */
    expectedRevision?: number
}

export interface NeedsYouLiveCheckInput {
    daemonId: string
    meshId: string
    itemId: string
    verdict: 'works' | 'doesnt_work' | 'not_relevant'
    note?: string
}

export interface NeedsYouOutcome {
    ok: boolean
    /** Daemon error code / message when !ok. */
    code?: string
    /** Free text of a failed answer, so the card can put it back in its field instead of losing it. */
    text?: string
    action?: string
    delivery?: string
}

export interface NeedsYouState {
    snapshot: NeedsYouSnapshot
    approvals: PendingApprovalItem[]
    /** Owner-held writes (driver activations / destructive driver actions / assistant writes) of every connected daemon (ids are daemon-composite; resolve routes to the owner). */
    staged: AssistantStagedWritesState
    entries: NeedsYouEntry[]
    /** Open decisions + approvals (the nav badge). */
    count: number
    /** False until the first fetch settled (or no daemon to ask). Daemons answer independently: true as soon as one has data. */
    loaded: boolean
    /** Machines that have not answered their first list call yet (drives the "still loading N machines" hint). */
    loadingCount?: number
    /** Machines whose last list call failed or timed out: their previous items stay on screen, marked stale. */
    staleDaemonIds?: readonly string[]
    /** Outcome of the last answer per itemId (a failure stays until the next attempt). */
    outcomes: Record<string, NeedsYouOutcome>
    busyIds: ReadonlySet<string>
    refresh: () => Promise<void>
    answer: (input: NeedsYouAnswerInput) => Promise<NeedsYouOutcome>
    /** Owner verdict on a live check ("Works" / "Doesn't work" + optional note) — stored as item state + evidence on the daemon. */
    resolveLiveCheck: (input: NeedsYouLiveCheckInput) => Promise<NeedsYouOutcome>
}

const EMPTY_STAGED: AssistantStagedWritesState = {
    items: null, memoryStatus: null, outcomes: {}, busyIds: new Set(), refresh: async () => {}, resolve: async () => {},
}

const EMPTY_STATE: NeedsYouState = {
    snapshot: EMPTY_NEEDS_YOU_SNAPSHOT, approvals: [], staged: EMPTY_STAGED, entries: [], count: 0, loaded: true, loadingCount: 0, staleDaemonIds: [], outcomes: {},
    busyIds: new Set(), refresh: async () => {}, answer: async () => ({ ok: false, code: 'unavailable' }), resolveLiveCheck: async () => ({ ok: false, code: 'unavailable' }),
}

const NeedsYouCtx = createContext<NeedsYouState | null>(null)

/** Minimum gap between mission-signal refetches. */
const SIGNAL_MIN_GAP_MS = 3_000
const SIGNAL_DEBOUNCE_MS = 800
/** A list call that takes longer is abandoned for this round (the machine keeps its previous items, marked stale). */
export const LIST_TIMEOUT_MS = 8_000

interface DaemonPart { snapshot: NeedsYouSnapshot; stale: boolean }

const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Set `localStorage['needs-you-debug']` to any non-empty value other than "0" to log round-trip timings. */
export const NEEDS_YOU_DEBUG_FLAG = 'needs-you-debug'

function timingEnabled(): boolean {
    try {
        const v = typeof localStorage !== 'undefined' ? localStorage.getItem(NEEDS_YOU_DEBUG_FLAG) : null
        return !!v && v !== '0'
    } catch { return false }
}

/** Fixed failure classes: raw error text (which can carry ids or content) never reaches the console. */
type FailureClass = 'timeout' | 'transport' | 'refused'

/** Opt-in timing, so the real browser round trip can be measured live (console.debug is hidden by default). */
function logTiming(event: string, payload: Record<string, unknown>): void {
    if (typeof console === 'undefined' || !timingEnabled()) return
    console.debug(`[needs-you] ${event}`, payload)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms)
        p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
    })
}

export function missionsSignature(status: { missions?: Array<{ id?: string; updatedAt?: string; status?: string }> } | null | undefined): string {
    return (status?.missions ?? []).map(m => `${m.id}:${m.updatedAt ?? ''}:${m.status ?? ''}`).join('|')
}

export function NeedsYouProvider({ children }: { children: ReactNode }) {
    const { sendCommand, sendData } = useTransport()
    const { ides, connectionStates, initialLoaded } = useDaemons()
    const [parts, setParts] = useState<Record<string, DaemonPart>>({})
    const [pending, setPending] = useState<Record<string, PendingOwnerAction>>({})
    const [outcomes, setOutcomes] = useState<Record<string, NeedsYouOutcome>>({})
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const seqs = useRef(new Map<string, number>())
    const lastFetchAt = useRef(0)

    const daemonIds = useMemo(
        () => (ides as any[])
            .filter(d => d && (d.daemonMode || d.type === 'adhdev-daemon') && typeof d.id === 'string')
            .map(d => d.id as string)
            .filter(id => { const st = connectionStates?.[id]; return st === undefined || st === 'connected' }),
        [ides, connectionStates],
    )
    const daemonKey = daemonIds.join(',')
    // A machine that left the set must not keep its old list or overlays: if it comes back it counts as
    // "not loaded yet" instead of showing stale data as fresh. Late answers of the removed machine are dropped.
    useEffect(() => {
        const current = new Set(daemonKey ? daemonKey.split(',') : [])
        for (const id of [...seqs.current.keys()]) if (!current.has(id)) seqs.current.set(id, (seqs.current.get(id) ?? 0) + 1)
        setParts(prev => {
            const ids = Object.keys(prev)
            if (ids.every(id => current.has(id))) return prev
            const out: Record<string, DaemonPart> = {}
            for (const id of ids) if (current.has(id)) out[id] = prev[id]!
            return out
        })
        setPending(prev => {
            const entries = Object.entries(prev)
            if (entries.every(([, a]) => current.has(a.daemonId))) return prev
            return Object.fromEntries(entries.filter(([, a]) => current.has(a.daemonId)))
        })
    }, [daemonKey])
    // Hard expiry: drop overlays when their time is up (the render path also ignores expired ones).
    useEffect(() => {
        const times = Object.values(pending).map(a => a.expiresAt).filter((t): t is number => t !== undefined)
        if (times.length === 0) return
        const timer = setTimeout(() => {
            const now = Date.now()
            setPending(prev => {
                const kept = Object.entries(prev).filter(([, a]) => a.expiresAt === undefined || a.expiresAt > now)
                return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
            })
        }, Math.max(0, Math.min(...times) - Date.now()) + 1)
        return () => clearTimeout(timer)
    }, [pending])
    const approvals = useMemo(() => deriveProviderApprovalInbox(ides, connectionStates), [ides, connectionStates])

    // Owner-held writes live on whichever daemon staged them: aggregate across all connected daemons.
    const machineLabels = useMemo(() => {
        const out: Record<string, string> = {}
        for (const d of ides as any[]) if (d && typeof d.id === 'string') out[d.id] = d.ownerMachineName || d.hostname || d.id
        return out
    }, [ides])
    const staged = useAggregatedStagedWrites({ daemonIds, machineLabels, sendCommand })
    const stagedRefreshRef = useRef(staged.refresh)
    stagedRefreshRef.current = staged.refresh

    /** Fetch one daemon's list. Results land per daemon as they arrive; a stale (superseded) answer is dropped. */
    const fetchDaemon = useCallback(async (id: string) => {
        const mine = (seqs.current.get(id) ?? 0) + 1
        seqs.current.set(id, mine)
        const startedAt = Date.now()
        const t0 = clockMs()
        let next: DaemonPart | null = null
        try {
            const raw = await withTimeout(sendRef.current(id, NEEDS_YOU_LIST_COMMAND, { includeAnswered: true, includeLiveChecks: true, includeMissions: true }), LIST_TIMEOUT_MS)
            next = { snapshot: parseNeedsYouList(raw, id), stale: false }
            logTiming('list', { daemonId: id, ms: Math.round(clockMs() - t0), ok: true })
        } catch (e) {
            const failure: FailureClass = e instanceof Error && e.message === 'timeout' ? 'timeout' : 'transport'
            logTiming('list', { daemonId: id, ms: Math.round(clockMs() - t0), ok: false, failure })
        }
        if (seqs.current.get(id) !== mine) return
        if (next) {
            const fresh = next
            setParts(prev => ({ ...prev, [id]: fresh }))
            // A press the daemon confirmed before this fetch began is now part of the list: drop its overlay.
            setPending(prev => {
                let changed = false
                const out: Record<string, PendingOwnerAction> = {}
                for (const [k, a] of Object.entries(prev)) {
                    if (a.daemonId === id && a.confirmedAt !== undefined && a.confirmedAt <= startedAt) changed = true
                    else out[k] = a
                }
                return changed ? out : prev
            })
        } else {
            // Failed or timed out: keep what this machine last reported (never replace it with "nothing"), flagged stale.
            setParts(prev => ({ ...prev, [id]: { snapshot: prev[id]?.snapshot ?? EMPTY_NEEDS_YOU_SNAPSHOT, stale: true } }))
        }
    }, [])

    const refreshDaemons = useCallback(async (ids: readonly string[]) => {
        lastFetchAt.current = Date.now()
        await Promise.all(ids.map(fetchDaemon))
    }, [fetchDaemon])

    const refresh = useCallback(async () => {
        void stagedRefreshRef.current()
        await refreshDaemons(daemonKey ? daemonKey.split(',') : [])
    }, [daemonKey, refreshDaemons])

    useEffect(() => { void refresh() }, [refresh, initialLoaded])

    // Window regained focus → one refetch (cheap catch-up for anything the feed missed).
    useEffect(() => {
        if (typeof document === 'undefined') return
        const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [refresh])

    // Mission-change signal: ride the hosted meshes' `mesh.status` feed and refetch when the missions
    // signature changes (the daemon flushes that feed from notifyMissionChanged). Debounced and rate-limited.
    const baseSnapshot = useMemo(
        () => mergeNeedsYouSnapshots(daemonIds.map(id => parts[id]?.snapshot).filter((x): x is NeedsYouSnapshot => !!x)),
        [daemonIds, parts],
    )
    const snapshot = useMemo(() => applyPendingOwnerActions(baseSnapshot, Object.values(pending)), [baseSnapshot, pending])
    const settledCount = daemonIds.filter(id => !!parts[id]).length
    const loadingCount = daemonIds.length - settledCount
    const anyFresh = daemonIds.some(id => parts[id] && !parts[id].stale)
    const loaded = daemonIds.length === 0 ? initialLoaded : (anyFresh || loadingCount === 0)
    const staleDaemonIds = useMemo(() => daemonIds.filter(id => parts[id]?.stale), [daemonIds, parts])
    const hostedKey = useMemo(() => {
        const byMesh = new Map<string, string>()
        for (const m of baseSnapshot.missions) byMesh.set(m.meshId, m.daemonId)
        for (const d of baseSnapshot.decisions) byMesh.set(d.meshId, d.daemonId)
        return JSON.stringify([...byMesh.entries()].sort())
    }, [baseSnapshot.missions, baseSnapshot.decisions])
    const hostedList = useMemo(() => (JSON.parse(hostedKey) as Array<[string, string]>), [hostedKey])
    useEffect(() => {
        if (!sendData || hostedList.length === 0) return
        let timer: ReturnType<typeof setTimeout> | null = null
        const signatures = new Map<string, string>()
        const schedule = (daemonId: string) => {
            dirty.add(daemonId)
            if (timer) return
            const wait = Math.max(SIGNAL_DEBOUNCE_MS, SIGNAL_MIN_GAP_MS - (Date.now() - lastFetchAt.current))
            timer = setTimeout(() => { timer = null; const ids = [...dirty]; dirty.clear(); void refreshDaemons(ids) }, wait)
        }
        const dirty = new Set<string>()
        const unsubs = hostedList.map(([meshId, daemonId]) => subscriptionManager.subscribe<MeshStatusSnapshotUpdate>(
            { sendData },
            daemonId,
            { type: 'subscribe', topic: 'mesh.status', key: `mesh:status:${meshId}`, params: { meshId } },
            (update) => {
                if (update.topic !== 'mesh.status' || update.meshId !== meshId) return
                const sig = missionsSignature(extractRepoMeshStatus(update.status) as any)
                const prev = signatures.get(meshId)
                signatures.set(meshId, sig)
                if (prev !== undefined && prev !== sig) schedule(daemonId)
            },
            { retryIntervalMs: 2_000 },
        ))
        return () => { if (timer) clearTimeout(timer); for (const u of unsubs) u() }
    }, [hostedList, sendData, refreshDaemons])

    /**
     * Shared press flow: show the result at once (optimistic overlay + busy), run the command, then either
     * revert with the error or confirm and re-fetch ONLY the owning daemon in the background.
     */
    const runPress = useCallback(async (
        label: string,
        input: { daemonId: string; meshId: string; itemId: string },
        optimisticInput: PendingOwnerAction | null,
        send: () => Promise<NeedsYouOutcome>,
        failExtra: Partial<NeedsYouOutcome> = {},
    ): Promise<NeedsYouOutcome> => {
        const key = pendingActionKey(input)
        const t0 = clockMs()
        let optimistic = optimisticInput
        if (optimistic) optimistic = { ...optimistic, expiresAt: Date.now() + PENDING_ACTION_TTL_MS }
        setBusyIds(prev => new Set(prev).add(input.itemId))
        setOutcomes(prev => { if (!(input.itemId in prev)) return prev; const next = { ...prev }; delete next[input.itemId]; return next })
        if (optimistic) setPending(prev => ({ ...prev, [key]: optimistic }))
        let outcome: NeedsYouOutcome
        let thrown = false
        try {
            outcome = await send()
        } catch (e) {
            thrown = true
            outcome = { ok: false, code: e instanceof Error ? e.message : String(e) }
        }
        if (!outcome.ok) outcome = { ...outcome, ...failExtra }
        logTiming(label, { daemonId: input.daemonId, ms: Math.round(clockMs() - t0), ok: outcome.ok, ...(outcome.ok ? {} : { failure: (thrown ? (outcome.code === 'timeout' ? 'timeout' : 'transport') : 'refused') satisfies FailureClass }) })
        setOutcomes(prev => ({ ...prev, [input.itemId]: outcome }))
        setBusyIds(prev => { const next = new Set(prev); next.delete(input.itemId); return next })
        if (optimistic) {
            const confirmedAt = Date.now()   // taken now, not inside the updater: the owner re-fetch below must start at or after it
            setPending(prev => {
                const cur = prev[key]
                if (cur !== optimistic) return prev
                if (!outcome.ok) { const next = { ...prev }; delete next[key]; return next }
                return { ...prev, [key]: { ...cur, confirmedAt, expiresAt: confirmedAt + PENDING_ACTION_TTL_MS } }
            })
        }
        // Not awaited: the card already shows the truth; the owning daemon's list catches up on its own.
        void refreshDaemons([input.daemonId])
        return outcome
    }, [refreshDaemons])

    const answer = useCallback((input: NeedsYouAnswerInput): Promise<NeedsYouOutcome> => {
        // Undo reopens the decision: whatever overlay still stands for it must go, or the card stays hidden.
        if (input.undo) {
            const undoKey = pendingActionKey(input)
            setPending(prev => { if (!(undoKey in prev)) return prev; const next = { ...prev }; delete next[undoKey]; return next })
        }
        const optimistic: PendingOwnerAction | null = input.undo ? null : {
            kind: 'answer', daemonId: input.daemonId, meshId: input.meshId, itemId: input.itemId,
            ...(input.optionId ? { optionId: input.optionId } : {}), ...(input.text ? { text: input.text } : {}), at: new Date().toISOString(),
        }
        return runPress('answer', input, optimistic, async () => {
            const raw = await sendRef.current(input.daemonId, NEEDS_YOU_ANSWER_COMMAND, {
                meshId: input.meshId,
                ...(input.missionId ? { missionId: input.missionId } : {}),
                itemId: input.itemId,
                ...(input.optionId ? { optionId: input.optionId } : {}),
                ...(input.text ? { text: input.text } : {}),
                ...(input.undo ? { undo: true } : {}),
                ...(typeof input.expectedRevision === 'number' ? { expectedRevision: input.expectedRevision } : {}),
                via: 'dashboard',
            })
            const body = unwrapCommandBody(raw)
            return body?.success === true
                ? { ok: true, ...(typeof body.action === 'string' ? { action: body.action } : {}), ...(typeof body.delivery === 'string' ? { delivery: body.delivery } : {}) }
                : { ok: false, code: String(body?.code ?? body?.error ?? 'failed') }
        }, input.text ? { text: input.text } : {})
    }, [runPress])

    const resolveLiveCheck = useCallback((input: NeedsYouLiveCheckInput): Promise<NeedsYouOutcome> => {
        const optimistic: PendingOwnerAction = { kind: 'live_check', daemonId: input.daemonId, meshId: input.meshId, itemId: input.itemId, verdict: input.verdict }
        return runPress('live_check', input, optimistic, async () => {
            const raw = await sendRef.current(input.daemonId, NEEDS_YOU_LIVE_CHECK_COMMAND, {
                meshId: input.meshId,
                itemId: input.itemId,
                verdict: input.verdict,
                ...(input.note ? { note: input.note } : {}),
                via: 'dashboard',
            })
            const body = unwrapCommandBody(raw)
            return body?.success === true
                ? { ok: true, ...(typeof body.state === 'string' ? { action: body.state } : {}) }
                : { ok: false, code: String(body?.code ?? body?.error ?? 'failed') }
        })
    }, [runPress])

    const entries = useMemo(() => buildNeedsYouEntries(snapshot, approvals, staged.items ?? []), [snapshot, approvals, staged.items])
    const value = useMemo<NeedsYouState>(() => ({
        snapshot, approvals, staged, entries, count: needsYouCount(entries), loaded, loadingCount, staleDaemonIds, outcomes, busyIds, refresh, answer, resolveLiveCheck,
    }), [snapshot, approvals, staged, entries, loaded, loadingCount, staleDaemonIds, outcomes, busyIds, refresh, answer, resolveLiveCheck])

    return <NeedsYouCtx.Provider value={value}>{children}</NeedsYouCtx.Provider>
}

/** Injects a ready-made state (tests, storybook-style hosts). */
export const NeedsYouStateProvider = NeedsYouCtx.Provider

/** The inbox state; an inert empty state outside a provider (tests, hosts that did not mount one). */
export function useNeedsYou(): NeedsYouState {
    return useContext(NeedsYouCtx) ?? EMPTY_STATE
}

/** Open decisions + approvals, for the navigation badge. */
export function useNeedsYouCount(): number {
    return useNeedsYou().count
}
