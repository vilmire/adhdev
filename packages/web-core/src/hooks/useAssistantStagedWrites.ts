/**
 * The assistant's held-for-approval writes for one daemon (design
 * 2026-10-07-assistant-layer.md §4.10.2, research 2026-10-08 Q8).
 *
 * Reads and resolves through `assistant_staged_resolve` on the dashboard's
 * normal command transport (standalone WS/HTTP, cloud P2P). The daemon pushes
 * no event when a write is staged, so the list refreshes:
 *   - when the assistant pane mounts (or its daemon changes),
 *   - when the caller asks (opening the list),
 *   - when the assistant's turn commits (status leaves a busy state) — the only
 *     moment the assistant can have staged something new,
 *   - after every resolve.
 * No interval polling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    ASSISTANT_STAGED_COMMAND,
    parseResolveOutcomes,
    parseStagedList,
    type AssistantStagedDecision,
    type AssistantStagedItem,
    type AssistantStagedOutcome,
} from '../components/dashboard/assistant-staged'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

/** Statuses during which the assistant's turn is still running. */
const BUSY_STATUSES: ReadonlySet<string> = new Set(['generating', 'long_generating', 'no_progress', 'waiting_approval'])

export type AssistantStagedTarget = { id: string } | { reviewTurnId: string; ids: string[] }

export interface AssistantStagedWritesState {
    /** null until the first answer, and while the daemon has no list verb (surface hidden). */
    items: AssistantStagedItem[] | null
    /** Outcome of the last resolve per item id (failures stay until the item leaves the list). */
    outcomes: Record<string, AssistantStagedOutcome>
    /** Item ids with a resolve in flight. */
    busyIds: ReadonlySet<string>
    refresh: () => Promise<void>
    resolve: (target: AssistantStagedTarget, decision: AssistantStagedDecision) => Promise<void>
}

export function useAssistantStagedWrites(options: {
    daemonId: string | null | undefined
    enabled: boolean
    status?: string
    sendCommand: SendCommand
}): AssistantStagedWritesState {
    const { daemonId, enabled, status, sendCommand } = options
    const [items, setItems] = useState<AssistantStagedItem[] | null>(null)
    const [outcomes, setOutcomes] = useState<Record<string, AssistantStagedOutcome>>({})
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const seq = useRef(0)

    const refresh = useCallback(async () => {
        if (!enabled || !daemonId) return
        const mine = ++seq.current
        let next: AssistantStagedItem[] | null = null
        try {
            next = parseStagedList(await sendRef.current(daemonId, ASSISTANT_STAGED_COMMAND, { action: 'list' }))
        } catch {
            next = null
        }
        if (mine !== seq.current) return
        setItems(next)
        // Drop outcomes of items that left the list (resolved here or elsewhere).
        const live = new Set((next || []).map(i => i.id))
        setOutcomes(prev => {
            const kept: Record<string, AssistantStagedOutcome> = {}
            for (const [id, o] of Object.entries(prev)) if (live.has(id) && !o.ok) kept[id] = o
            return kept
        })
    }, [daemonId, enabled])

    useEffect(() => {
        setItems(null)
        setOutcomes({})
        void refresh()
    }, [refresh])

    const prevStatus = useRef(status)
    useEffect(() => {
        const was = prevStatus.current
        prevStatus.current = status
        if (was && BUSY_STATUSES.has(was) && !(status && BUSY_STATUSES.has(status))) void refresh()
    }, [status, refresh])

    const resolve = useCallback(async (target: AssistantStagedTarget, decision: AssistantStagedDecision) => {
        if (!daemonId) return
        const ids = 'id' in target ? [target.id] : target.ids
        setBusyIds(prev => new Set([...prev, ...ids]))
        let result: Record<string, AssistantStagedOutcome>
        try {
            const args = 'id' in target ? { id: target.id, decision } : { reviewTurnId: target.reviewTurnId, decision }
            result = parseResolveOutcomes(await sendRef.current(daemonId, ASSISTANT_STAGED_COMMAND, args), ids)
        } catch (e) {
            const code = e instanceof Error ? e.message : String(e)
            result = Object.fromEntries(ids.map(id => [id, { ok: false, code }]))
        }
        setOutcomes(prev => ({ ...prev, ...result }))
        setBusyIds(prev => {
            const next = new Set(prev)
            for (const id of ids) next.delete(id)
            return next
        })
        await refresh()
    }, [daemonId, refresh])

    return { items, outcomes, busyIds, refresh, resolve }
}
