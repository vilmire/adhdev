/**
 * The assistant's recent memory writes for one daemon, with undo (design
 * docs/design/2026-11-01-assistant-memory.md §3.2).
 *
 * Reads `assistant_memory_digest` and reverses through `assistant_memory_undo`
 * on the dashboard's normal command transport. Like the staged-writes hook it
 * does not poll: it refreshes on mount / daemon change, when the caller opens
 * the list, when the assistant's turn commits (the only moment it can have
 * written something) and after every undo.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    ASSISTANT_MEMORY_DIGEST_COMMAND,
    ASSISTANT_MEMORY_MERGE_COMMAND,
    ASSISTANT_MEMORY_UNDO_COMMAND,
    mergePayload,
    parseMemoryDigest,
    parseMemoryUndoOutcome,
    type AssistantMemoryDigest,
    type AssistantMemorySuggestion,
    type AssistantMemoryUndoOutcome,
    type AssistantMemoryUndoTarget,
} from '../components/dashboard/assistant-memory-digest'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

const BUSY_STATUSES: ReadonlySet<string> = new Set(['generating', 'long_generating', 'no_progress', 'waiting_approval'])

export interface AssistantMemoryDigestState {
    /** null until the first answer, and while the daemon has no digest verb (surface hidden). */
    digest: AssistantMemoryDigest | null
    /** Outcome of the last undo per key (`id` or `batch:<id>`); failures stay visible under the row. */
    outcomes: Record<string, AssistantMemoryUndoOutcome>
    busyKeys: ReadonlySet<string>
    refresh: () => Promise<void>
    undo: (target: AssistantMemoryUndoTarget) => Promise<void>
    /** Apply a duplicate / similar suggestion (keeps the first entry, drops the second; one undoable batch). */
    merge: (suggestion: AssistantMemorySuggestion) => Promise<void>
}

export function undoKey(target: AssistantMemoryUndoTarget): string {
    return 'id' in target ? target.id : `batch:${target.batchId}`
}

export function useAssistantMemoryDigest(options: {
    daemonId: string | null | undefined
    enabled: boolean
    status?: string
    sendCommand: SendCommand
}): AssistantMemoryDigestState {
    const { daemonId, enabled, status, sendCommand } = options
    const [digest, setDigest] = useState<AssistantMemoryDigest | null>(null)
    const [outcomes, setOutcomes] = useState<Record<string, AssistantMemoryUndoOutcome>>({})
    const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const seq = useRef(0)

    const refresh = useCallback(async () => {
        if (!enabled || !daemonId) return
        const mine = ++seq.current
        let next: AssistantMemoryDigest | null = null
        try {
            next = parseMemoryDigest(await sendRef.current(daemonId, ASSISTANT_MEMORY_DIGEST_COMMAND, {}))
        } catch {
            next = null
        }
        if (mine !== seq.current) return
        setDigest(next)
    }, [daemonId, enabled])

    useEffect(() => {
        setDigest(null)
        setOutcomes({})
        void refresh()
    }, [refresh])

    const prevStatus = useRef(status)
    useEffect(() => {
        const was = prevStatus.current
        prevStatus.current = status
        if (was && BUSY_STATUSES.has(was) && !(status && BUSY_STATUSES.has(status))) void refresh()
    }, [status, refresh])

    const undo = useCallback(async (target: AssistantMemoryUndoTarget) => {
        if (!daemonId) return
        const key = undoKey(target)
        setBusyKeys(prev => new Set([...prev, key]))
        let outcome: AssistantMemoryUndoOutcome
        try {
            outcome = parseMemoryUndoOutcome(await sendRef.current(daemonId, ASSISTANT_MEMORY_UNDO_COMMAND, target))
        } catch (e) {
            outcome = { ok: false, code: e instanceof Error ? e.message : String(e) }
        }
        setOutcomes(prev => ({ ...prev, [key]: outcome }))
        setBusyKeys(prev => {
            const next = new Set(prev)
            next.delete(key)
            return next
        })
        await refresh()
    }, [daemonId, refresh])

    const merge = useCallback(async (suggestion: AssistantMemorySuggestion) => {
        const payload = mergePayload(suggestion)
        if (!daemonId || !payload) return
        const key = `merge:${suggestion.items.join('|')}`
        setBusyKeys(prev => new Set([...prev, key]))
        let outcome: AssistantMemoryUndoOutcome
        try {
            outcome = parseMemoryUndoOutcome(await sendRef.current(daemonId, ASSISTANT_MEMORY_MERGE_COMMAND, payload))
        } catch (e) {
            outcome = { ok: false, code: e instanceof Error ? e.message : String(e) }
        }
        setOutcomes(prev => ({ ...prev, [key]: outcome }))
        setBusyKeys(prev => {
            const next = new Set(prev)
            next.delete(key)
            return next
        })
        await refresh()
    }, [daemonId, refresh])

    return { digest, outcomes, busyKeys, refresh, undo, merge }
}
