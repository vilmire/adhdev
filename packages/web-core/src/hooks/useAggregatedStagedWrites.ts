/**
 * Owner-held writes of EVERY connected daemon, in the shape of useAssistantStagedWrites
 * (Needs-you inbox + nav badge). Driver activations and assistant held writes live on the
 * daemon that hosts them, so asking only the first daemon hid the rest.
 *
 * Item ids / review-turn ids are only unique per daemon, so each aggregated item carries a
 * composite id (`<daemonId>\u0001<id>`) and a `machine` tag; `resolve` decodes the composite
 * id and sends the verb to the owning daemon with the daemon's own ids. Refreshes on mount,
 * when the daemon set changes, on demand and after every resolve (no polling).
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
import type { AssistantStagedTarget, AssistantStagedWritesState } from './useAssistantStagedWrites'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

const SEP = '\u0001'
const compose = (daemonId: string, id: string) => `${daemonId}${SEP}${id}`

function splitComposite(id: string): { daemonId: string; id: string } | null {
    const at = id.indexOf(SEP)
    return at < 0 ? null : { daemonId: id.slice(0, at), id: id.slice(at + 1) }
}

export function useAggregatedStagedWrites(options: {
    daemonIds: readonly string[]
    /** Human machine name per daemon id; only shown (as item.machine) when more than one daemon is connected. */
    machineLabels?: Record<string, string>
    sendCommand: SendCommand
}): AssistantStagedWritesState {
    const { daemonIds, machineLabels, sendCommand } = options
    const daemonKey = daemonIds.join(',')
    const [items, setItems] = useState<AssistantStagedItem[] | null>(null)
    const [outcomes, setOutcomes] = useState<Record<string, AssistantStagedOutcome>>({})
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const labelsRef = useRef(machineLabels)
    labelsRef.current = machineLabels
    const seq = useRef(0)

    const refresh = useCallback(async () => {
        const ids = daemonKey ? daemonKey.split(',') : []
        if (ids.length === 0) { setItems(null); return }
        const mine = ++seq.current
        const multi = ids.length > 1
        let anyAnswered = false
        const parts = await Promise.all(ids.map(async daemonId => {
            try {
                const list = parseStagedList(await sendRef.current(daemonId, ASSISTANT_STAGED_COMMAND, { action: 'list' }))
                if (list) anyAnswered = true
                return (list ?? []).map((item): AssistantStagedItem => ({
                    ...item,
                    id: compose(daemonId, item.id),
                    ...(item.reviewTurnId ? { reviewTurnId: compose(daemonId, item.reviewTurnId) } : {}),
                    ...(multi ? { machine: labelsRef.current?.[daemonId] || daemonId } : {}),
                }))
            } catch {
                return []
            }
        }))
        if (mine !== seq.current) return
        const next = anyAnswered ? parts.flat() : null
        setItems(next)
        const live = new Set((next || []).map(i => i.id))
        setOutcomes(prev => {
            const kept: Record<string, AssistantStagedOutcome> = {}
            for (const [id, o] of Object.entries(prev)) if (live.has(id) && !o.ok) kept[id] = o
            return kept
        })
    }, [daemonKey])

    useEffect(() => { setOutcomes({}); void refresh() }, [refresh])

    const resolve = useCallback(async (target: AssistantStagedTarget, decision: AssistantStagedDecision) => {
        const compIds = 'id' in target ? [target.id] : target.ids
        const first = splitComposite(compIds[0] ?? '')
        if (!first) return
        const daemonId = first.daemonId
        const localIds = compIds.map(c => splitComposite(c)?.id ?? c)
        setBusyIds(prev => new Set([...prev, ...compIds]))
        let result: Record<string, AssistantStagedOutcome>
        try {
            const args = 'id' in target
                ? { id: localIds[0], decision }
                : { reviewTurnId: splitComposite(target.reviewTurnId)?.id ?? target.reviewTurnId, decision }
            const local = parseResolveOutcomes(await sendRef.current(daemonId, ASSISTANT_STAGED_COMMAND, args), localIds)
            result = Object.fromEntries(compIds.map((c, i) => [c, local[localIds[i]] ?? { ok: false, code: 'no_outcome' }]))
        } catch (e) {
            const code = e instanceof Error ? e.message : String(e)
            result = Object.fromEntries(compIds.map(id => [id, { ok: false, code }]))
        }
        setOutcomes(prev => ({ ...prev, ...result }))
        setBusyIds(prev => { const next = new Set(prev); for (const id of compIds) next.delete(id); return next })
        await refresh()
    }, [refresh])

    return { items, memoryStatus: null, outcomes, busyIds, refresh, resolve }
}
