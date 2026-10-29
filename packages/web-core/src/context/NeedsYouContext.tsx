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
    NEEDS_YOU_LIST_COMMAND,
    buildNeedsYouEntries,
    mergeNeedsYouSnapshots,
    needsYouCount,
    parseNeedsYouList,
    unwrapCommandBody,
    type NeedsYouEntry,
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
}

export interface NeedsYouOutcome {
    ok: boolean
    /** Daemon error code / message when !ok. */
    code?: string
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
    /** False until the first fetch settled (or no daemon to ask). */
    loaded: boolean
    /** Outcome of the last answer per itemId (a failure stays until the next attempt). */
    outcomes: Record<string, NeedsYouOutcome>
    busyIds: ReadonlySet<string>
    refresh: () => Promise<void>
    answer: (input: NeedsYouAnswerInput) => Promise<NeedsYouOutcome>
}

const EMPTY_STAGED: AssistantStagedWritesState = {
    items: null, memoryStatus: null, outcomes: {}, busyIds: new Set(), refresh: async () => {}, resolve: async () => {},
}

const EMPTY_STATE: NeedsYouState = {
    snapshot: EMPTY_NEEDS_YOU_SNAPSHOT, approvals: [], staged: EMPTY_STAGED, entries: [], count: 0, loaded: true, outcomes: {},
    busyIds: new Set(), refresh: async () => {}, answer: async () => ({ ok: false, code: 'unavailable' }),
}

const NeedsYouCtx = createContext<NeedsYouState | null>(null)

/** Minimum gap between mission-signal refetches. */
const SIGNAL_MIN_GAP_MS = 3_000
const SIGNAL_DEBOUNCE_MS = 800

export function missionsSignature(status: { missions?: Array<{ id?: string; updatedAt?: string; status?: string }> } | null | undefined): string {
    return (status?.missions ?? []).map(m => `${m.id}:${m.updatedAt ?? ''}:${m.status ?? ''}`).join('|')
}

export function NeedsYouProvider({ children }: { children: ReactNode }) {
    const { sendCommand, sendData } = useTransport()
    const { ides, connectionStates, initialLoaded } = useDaemons()
    const [snapshot, setSnapshot] = useState<NeedsYouSnapshot>(EMPTY_NEEDS_YOU_SNAPSHOT)
    const [loaded, setLoaded] = useState(false)
    const [outcomes, setOutcomes] = useState<Record<string, NeedsYouOutcome>>({})
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const seq = useRef(0)
    const lastFetchAt = useRef(0)
    const initialLoadedRef = useRef(initialLoaded)
    initialLoadedRef.current = initialLoaded

    const daemonIds = useMemo(
        () => (ides as any[])
            .filter(d => d && (d.daemonMode || d.type === 'adhdev-daemon') && typeof d.id === 'string')
            .map(d => d.id as string)
            .filter(id => { const st = connectionStates?.[id]; return st === undefined || st === 'connected' }),
        [ides, connectionStates],
    )
    const daemonKey = daemonIds.join(',')
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

    const refresh = useCallback(async () => {
        void stagedRefreshRef.current()
        const ids = daemonKey ? daemonKey.split(',') : []
        const mine = ++seq.current
        lastFetchAt.current = Date.now()
        if (ids.length === 0) { setSnapshot(EMPTY_NEEDS_YOU_SNAPSHOT); setLoaded(initialLoadedRef.current); return }
        const parts = await Promise.all(ids.map(async id => {
            try {
                const raw = await sendRef.current(id, NEEDS_YOU_LIST_COMMAND, { includeAnswered: true, includeLiveChecks: true, includeMissions: true })
                return parseNeedsYouList(raw, id)
            } catch {
                return EMPTY_NEEDS_YOU_SNAPSHOT
            }
        }))
        if (mine !== seq.current) return
        setSnapshot(mergeNeedsYouSnapshots(parts))
        setLoaded(true)
    }, [daemonKey])

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
    const hostedKey = useMemo(() => {
        const byMesh = new Map<string, string>()
        for (const m of snapshot.missions) byMesh.set(m.meshId, m.daemonId)
        for (const d of snapshot.decisions) byMesh.set(d.meshId, d.daemonId)
        return JSON.stringify([...byMesh.entries()].sort())
    }, [snapshot.missions, snapshot.decisions])
    const hostedList = useMemo(() => (JSON.parse(hostedKey) as Array<[string, string]>), [hostedKey])
    useEffect(() => {
        if (!sendData || hostedList.length === 0) return
        let timer: ReturnType<typeof setTimeout> | null = null
        const signatures = new Map<string, string>()
        const schedule = () => {
            if (timer) return
            const wait = Math.max(SIGNAL_DEBOUNCE_MS, SIGNAL_MIN_GAP_MS - (Date.now() - lastFetchAt.current))
            timer = setTimeout(() => { timer = null; void refresh() }, wait)
        }
        const unsubs = hostedList.map(([meshId, daemonId]) => subscriptionManager.subscribe<MeshStatusSnapshotUpdate>(
            { sendData },
            daemonId,
            { type: 'subscribe', topic: 'mesh.status', key: `mesh:status:${meshId}`, params: { meshId } },
            (update) => {
                if (update.topic !== 'mesh.status' || update.meshId !== meshId) return
                const sig = missionsSignature(extractRepoMeshStatus(update.status) as any)
                const prev = signatures.get(meshId)
                signatures.set(meshId, sig)
                if (prev !== undefined && prev !== sig) schedule()
            },
            { retryIntervalMs: 2_000 },
        ))
        return () => { if (timer) clearTimeout(timer); for (const u of unsubs) u() }
    }, [hostedList, sendData, refresh])

    const answer = useCallback(async (input: NeedsYouAnswerInput): Promise<NeedsYouOutcome> => {
        setBusyIds(prev => new Set(prev).add(input.itemId))
        let outcome: NeedsYouOutcome
        try {
            const raw = await sendRef.current(input.daemonId, NEEDS_YOU_ANSWER_COMMAND, {
                meshId: input.meshId,
                ...(input.missionId ? { missionId: input.missionId } : {}),
                itemId: input.itemId,
                ...(input.optionId ? { optionId: input.optionId } : {}),
                ...(input.text ? { text: input.text } : {}),
                ...(input.undo ? { undo: true } : {}),
                via: 'dashboard',
            })
            const body = unwrapCommandBody(raw)
            outcome = body?.success === true
                ? { ok: true, ...(typeof body.action === 'string' ? { action: body.action } : {}), ...(typeof body.delivery === 'string' ? { delivery: body.delivery } : {}) }
                : { ok: false, code: String(body?.code ?? body?.error ?? 'failed') }
        } catch (e) {
            outcome = { ok: false, code: e instanceof Error ? e.message : String(e) }
        }
        setOutcomes(prev => ({ ...prev, [input.itemId]: outcome }))
        setBusyIds(prev => { const next = new Set(prev); next.delete(input.itemId); return next })
        await refresh()
        return outcome
    }, [refresh])

    const entries = useMemo(() => buildNeedsYouEntries(snapshot, approvals, staged.items ?? []), [snapshot, approvals, staged.items])
    const value = useMemo<NeedsYouState>(() => ({
        snapshot, approvals, staged, entries, count: needsYouCount(entries), loaded, outcomes, busyIds, refresh, answer,
    }), [snapshot, approvals, staged, entries, loaded, outcomes, busyIds, refresh, answer])

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
