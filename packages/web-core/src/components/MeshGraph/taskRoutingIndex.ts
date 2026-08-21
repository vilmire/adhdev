/**
 * taskRoutingIndex — joins a queue task to the routing decision recorded when it was
 * dispatched, so the Tasks tab can answer "which model ran this, and where did it come
 * from" without opening the ledger modal.
 *
 * WHY THIS EXISTS
 * The queue row (`RepoMeshQueueTask`) is model-blind by design: it carries difficulty,
 * priority and assignment, but NOT the resolved provider/model/thinking level. Those live
 * only on the `task_dispatched` ledger entry, under `payload.routingDecision`, written by
 * `recordTaskDispatchedLedger()` in daemon-core's mesh-queue-assignment.ts. The data was
 * already on the wire and already rendered — but only inside Overview → Ledger → entry
 * modal, which is three clicks away from the task you are actually looking at.
 *
 * TRANSPORT NOTE
 * This joins data that arrives via the `mesh_status` command/response (P2P DataChannel in
 * cloud, localhost WS in standalone). It does NOT touch the cloud `status_report` path,
 * whose content-boundary allow-list (`buildCloudStatusReportPayload` → RoutingSessionEntry)
 * carries no mesh or ledger data at all. Nothing here widens that boundary.
 *
 * Pure and deterministic: no React, unit-testable directly.
 */

import type { RepoMeshLedgerEntryStatus, RepoMeshStatus } from '@adhdev/daemon-core'

/** The subset of `payload.routingDecision` the task surfaces care about. */
export interface TaskRoutingSummary {
    /** Provider that executed the task (e.g. claude-cli). */
    providerType?: string
    /** Resolved model (e.g. opus) — the owner-facing "what completed this". */
    model?: string
    /** Resolved thinking level (e.g. high). */
    thinkingLevel?: string
    /** How the task got here: queue | autoLaunch | direct. */
    source?: string
    /** remote | local. */
    transport?: string
    /** Slot fitness score that won the selection. */
    fitnessScore?: number
    /** Node the work was routed to. */
    selectedNodeId?: string
    /** Free-form selection reason recorded by the router. */
    reason?: string
    /** Count of same-node candidates that lost the slot race (detail, folded in UI). */
    intraNodeLoserCount?: number
    /** Count of other nodes skipped during selection (detail, folded in UI). */
    skippedCount?: number
    /** Timestamp of the dispatch entry this summary came from. */
    dispatchedAt?: string
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Resolve a ledger entry's task id, preferring the promoted base field and falling back
 *  to payload.taskId (legacy rows / daemons predating the LEDGER-TASK-TRACEABILITY work).
 *  Mirrors daemon-core's `ledgerEntryTaskId`, which is not exported to web-core. */
export function ledgerEntryTaskId(entry: RepoMeshLedgerEntryStatus): string | undefined {
    const base = str((entry as unknown as Record<string, unknown>).taskId)
    if (base) return base
    const payload = entry.payload as Record<string, unknown> | undefined
    return payload ? str(payload.taskId) : undefined
}

/** Project a raw `payload.routingDecision` into the display summary. Returns null when the
 *  entry carries no routing decision (older daemons, or non-dispatch kinds). */
export function readTaskRouting(entry: RepoMeshLedgerEntryStatus): TaskRoutingSummary | null {
    const payload = entry.payload as Record<string, unknown> | undefined
    const raw = payload && typeof payload === 'object' ? payload.routingDecision : undefined
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rd = raw as Record<string, unknown>
    const intraNodeLosers = Array.isArray(rd.intraNodeLosers) ? rd.intraNodeLosers.length : 0
    const skipped = Array.isArray(rd.skippedCandidates) ? rd.skippedCandidates.length : 0
    const summary: TaskRoutingSummary = {
        providerType: str(rd.resolvedProviderType),
        model: str(rd.resolvedModel),
        thinkingLevel: str(rd.resolvedThinkingLevel),
        source: str(rd.source),
        transport: str(rd.transport),
        fitnessScore: num(rd.fitnessScore),
        selectedNodeId: str(rd.selectedNodeId),
        reason: str(rd.reason),
        // Omitted counts come from the daemon's own truncation, so add them back in so the
        // folded detail reports the true total rather than the truncated array length.
        intraNodeLoserCount: intraNodeLosers + (num(rd.intraNodeLosersOmitted) ?? 0) || undefined,
        skippedCount: skipped + (num(rd.skippedCandidatesOmitted) ?? 0) || undefined,
        dispatchedAt: str(entry.timestamp),
    }
    // A summary with nothing worth showing is treated as absent.
    return summary.model || summary.providerType || summary.source ? summary : null
}

/**
 * Build taskId → routing summary from a mesh status payload's ledger tail.
 *
 * The tail is capped daemon-side (currently 20 entries for the graph payload), so this is
 * a best-effort enrichment: recently dispatched tasks resolve, older ones simply render
 * without a model chip rather than showing a wrong one. When a task has been dispatched
 * more than once (requeue), the LATEST dispatch wins — that is the run whose outcome the
 * row is reporting.
 */
export function buildTaskRoutingIndex(status: RepoMeshStatus | null | undefined): Map<string, TaskRoutingSummary> {
    const index = new Map<string, TaskRoutingSummary>()
    const entries = status?.ledger?.entries
    if (!Array.isArray(entries)) return index
    for (const entry of entries) {
        if (!entry || entry.kind !== 'task_dispatched') continue
        const taskId = ledgerEntryTaskId(entry)
        if (!taskId) continue
        const routing = readTaskRouting(entry)
        if (!routing) continue
        const existing = index.get(taskId)
        // Keep the newest dispatch. Entries are not guaranteed ordered, so compare
        // timestamps rather than relying on iteration order.
        if (existing) {
            const prev = Date.parse(existing.dispatchedAt || '')
            const next = Date.parse(routing.dispatchedAt || '')
            if (Number.isFinite(prev) && Number.isFinite(next) && next < prev) continue
        }
        index.set(taskId, routing)
    }
    return index
}

/** Compact one-line execution profile: "claude-cli · opus · high". */
export function formatExecutionProfile(routing: TaskRoutingSummary | undefined | null): string {
    if (!routing) return ''
    return [routing.providerType, routing.model, routing.thinkingLevel].filter(Boolean).join(' · ')
}
