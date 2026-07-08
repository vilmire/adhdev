/**
 * "Next task routing" preview — a static, rule-based projection of which node an
 * untargeted task would go to next under the current distribution strategy.
 *
 * Mirrors the daemon's orderEligibleNodes comparator (mesh-queue-assignment.ts):
 *   priority desc → (Spread only: active load asc) → input/config order.
 * The round-robin tie-break cursor is runtime state we don't have here, so equal
 * (priority, load) nodes are shown in config order with a note that ties rotate.
 *
 * This is a teaching aid for the rules, NOT a live scheduler trace — it uses the
 * queue's current `assigned` counts as the load input but does not simulate the
 * re-rank-after-each-assignment drain. It also does not apply required_tags
 * filtering (an untargeted task has none); a tagged task narrows to matching
 * nodes first, which we call out in the caption.
 */
import { useMemo } from 'react'
import { getNodeActiveAssignments } from './MeshNodeList'
import type { MeshNode, MeshQueueEntry, MeshSchedulingStrategy } from './types'

function nodeLabel(node: MeshNode): string {
    const n = node as any
    return n.machine_label || n.machine_nickname || n.hostname || (typeof node.workspace === 'string' ? node.workspace.split('/').filter(Boolean).pop() : '') || node.id
}

function priorityOf(node: MeshNode): number {
    const p = Number(node.policy?.schedulingPriority)
    return Number.isFinite(p) ? p : 0
}

export interface RoutingPreviewRow {
    node: MeshNode
    index: number
    priority: number
    load: number
    rank: number
    tiedWithWinner: boolean
}

/** True for the strategies the daemon treats as load-spreading. */
export function isSpreadStrategy(strategy: MeshSchedulingStrategy): boolean {
    return strategy === 'least_loaded' || strategy === 'round_robin'
}

/**
 * Rank nodes the way the daemon's orderEligibleNodes would for an untargeted
 * task: priority desc → (Spread only: load asc) → config order. Pure so it can
 * be unit-tested against the daemon's documented comparator.
 */
export function rankRoutingPreview(nodes: MeshNode[], meshQueue: MeshQueueEntry[], strategy: MeshSchedulingStrategy): RoutingPreviewRow[] {
    const spread = isSpreadStrategy(strategy)
    // In order (first_eligible) ignores priority AND load — it takes nodes in
    // config order, matching the daemon's orderEligibleNodes short-circuit. Only
    // the priority_only / spread strategies consult priority; only spread adds load.
    const usesPriority = strategy === 'priority_only' || spread
    const rows = nodes.map((node, index) => ({
        node,
        index,
        priority: priorityOf(node),
        load: getNodeActiveAssignments(node, meshQueue).length,
    }))
    const sorted = [...rows].sort((a, b) => {
        if (usesPriority) {
            const prio = b.priority - a.priority
            if (prio !== 0) return prio
        }
        if (spread) {
            const load = a.load - b.load
            if (load !== 0) return load
        }
        return a.index - b.index
    })
    const top = sorted[0]
    return sorted.map((r, rank) => ({
        ...r,
        rank,
        // Ties only rotate under Spread. In order is deterministic config order,
        // so nothing is "tied" there.
        tiedWithWinner: spread && !!top && r !== top && r.priority === top.priority && r.load === top.load,
    }))
}

interface Props {
    nodes: MeshNode[]
    meshQueue: MeshQueueEntry[]
    schedulingStrategy: MeshSchedulingStrategy
}

export default function MeshRoutingPreview({ nodes, meshQueue, schedulingStrategy }: Props) {
    // Unset strategy resolves to the daemon default 'first_eligible' (In order).
    const isSpread = isSpreadStrategy(schedulingStrategy)

    const ranked = useMemo(
        () => rankRoutingPreview(nodes, meshQueue, schedulingStrategy),
        [nodes, meshQueue, schedulingStrategy],
    )

    if (nodes.length === 0) return null

    const winnerTies = ranked.filter(r => r.rank === 0 || r.tiedWithWinner)
    const rotates = isSpread && winnerTies.length > 1

    return (
        <fieldset className="mt-5 border-none p-0 m-0">
            <legend className="text-[13px] font-medium text-text-secondary mb-2">Next task routing</legend>
            <p className="text-[12px] text-text-muted mb-2">
                Predicted order an <em>untargeted</em> task would try, under{' '}
                <span className="font-medium text-text-primary">{isSpread ? 'Spread' : 'In order'}</span>.{' '}
                {isSpread
                    ? 'Highest priority first, then the least-loaded node; ties rotate each pass.'
                    : 'The first eligible node in config order takes the work — priority and load are ignored.'}
            </p>
            <ol className="flex flex-col gap-1.5">
                {ranked.map(r => (
                    <li key={r.node.id}
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${r.rank === 0
                            ? 'border-accent-primary/50 bg-accent-primary/10'
                            : 'border-border-subtle bg-bg-secondary/50'}`}>
                        <span className={`text-[11px] font-semibold w-5 shrink-0 ${r.rank === 0 ? 'text-accent-primary' : 'text-text-muted'}`}>
                            #{r.rank + 1}
                        </span>
                        <span className="text-sm text-text-primary truncate flex-1 min-w-0">{nodeLabel(r.node)}</span>
                        <span className="flex items-center gap-2 shrink-0 text-[11px] text-text-muted">
                            <span title="Scheduling priority (higher wins; ignored under In order)">prio {r.priority}</span>
                            <span title="Active assigned tasks now (the load metric Spread balances)">load {r.load}</span>
                            {r.rank === 0 && <span className="rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 font-medium text-accent-primary">next</span>}
                            {r.tiedWithWinner && <span className="rounded-full border border-border-subtle px-1.5 py-0.5">tie</span>}
                        </span>
                    </li>
                ))}
            </ol>
            <p className="mt-2 text-[11px] text-text-muted">
                {rotates && 'Tied nodes alternate across passes (round-robin). '}
                A task with required_tags first narrows to matching nodes, then this order applies. Capacity caps can skip a higher-ranked node.
            </p>
        </fieldset>
    )
}
