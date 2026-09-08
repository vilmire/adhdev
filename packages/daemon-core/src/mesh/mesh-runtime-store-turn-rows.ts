// Pure move out of mesh-runtime-store.ts (file-size gate: baseline-growth cap hit by
// MESH-TOOL-CALL-CALLER-INSTRUMENTATION 1단계's caller_role addition). No behavior
// change — the mesh_turn_attempts/mesh_turn_held_suspensions row shapes + mappers and
// the mesh-runtime.db retention sweep were the most self-contained slice: every symbol
// here only calls PUBLIC MeshRuntimeStore methods (never touches the private `db`
// handle or class-internal state), so it needed no class surgery to extract.
// mesh-runtime-store.ts re-exports these names — see the barrel-preserving pattern in
// mesh-tools-internal.ts / mesh-tools.ts for precedent (export diff verified: 0 change
// to mesh-runtime-store.ts's public surface).
import { LOG } from '../logging/logger.js';
import type { MeshGraphRetentionCounts } from './mesh-graph-store.js';
import {
    resolveGraphOutboxRetentionMs,
    resolveGraphRetentionEnforce,
    resolveGraphRetentionMs,
    resolveSessionDeliveryRetentionMs,
    resolveTurnAttemptRetentionMs,
} from './mesh-retention-config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

/** Row shape returned by the mesh_turn_attempts accessors (camelCase, store-agnostic). */
export interface MeshTurnAttemptRow {
    attemptId: string;
    meshId: string;
    taskId: string;
    attemptSeq: number;
    nodeId: string | null;
    sessionId: string | null;
    providerType: string | null;
    coordinatorDaemonId: string | null;
    coordinatorSessionId: string | null;
    dispatchNonce: number | null;
    stage: string;
    redriveCount: number;
    leaseDeadlineMs: number | null;
    acceptedAt: string | null;
    deliveredAt: string | null;
    consumedAt: string | null;
    terminalOutcome: string | null;
    terminalReason: string | null;
    terminalAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export function meshTurnAttemptFromRow(r: Record<string, unknown>): MeshTurnAttemptRow {
    return {
        attemptId: r.attempt_id as string,
        meshId: r.mesh_id as string,
        taskId: r.task_id as string,
        attemptSeq: r.attempt_seq as number,
        nodeId: r.node_id as string | null,
        sessionId: r.session_id as string | null,
        providerType: r.provider_type as string | null,
        coordinatorDaemonId: r.coordinator_daemon_id as string | null,
        coordinatorSessionId: r.coordinator_session_id as string | null,
        dispatchNonce: r.dispatch_nonce as number | null,
        stage: r.stage as string,
        redriveCount: r.redrive_count as number,
        leaseDeadlineMs: r.lease_deadline_ms as number | null,
        acceptedAt: r.accepted_at as string | null,
        deliveredAt: r.delivered_at as string | null,
        consumedAt: r.consumed_at as string | null,
        terminalOutcome: r.terminal_outcome as string | null,
        terminalReason: r.terminal_reason as string | null,
        terminalAt: r.terminal_at as string | null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
    };
}

/** Row shape returned by the mesh_turn_held_suspensions accessors (camelCase, content-free). */
export interface MeshTurnHeldSuspensionRow {
    holdId: string;
    meshId: string;
    attemptId: string;
    taskId: string;
    stage: string;
    sessionId: string | null;
    dispatchNonce: number | null;
    occurredAtMs: number | null;
    recordedAt: string;
    status: string;
    resolution: string | null;
    resolvedAt: string | null;
}

export function meshTurnHeldSuspensionFromRow(r: Record<string, unknown>): MeshTurnHeldSuspensionRow {
    return {
        holdId: r.hold_id as string,
        meshId: r.mesh_id as string,
        attemptId: r.attempt_id as string,
        taskId: r.task_id as string,
        stage: r.stage as string,
        sessionId: r.session_id as string | null,
        dispatchNonce: r.dispatch_nonce as number | null,
        occurredAtMs: r.occurred_at_ms as number | null,
        recordedAt: r.recorded_at as string,
        status: r.status as string,
        resolution: r.resolution as string | null,
        resolvedAt: r.resolved_at as string | null,
    };
}

/**
 * Hook invoked when mesh_event_ledger rows change in a way that is NOT scoped to a
 * single mesh, so mesh-ledger can drop its (per-mesh keyed) read cache wholesale.
 * Two callers: the retention sweep's cross-mesh DELETE below, and
 * MeshRuntimeStore.resetForTests, which swaps the entire database out.
 *
 * Registered by mesh-ledger at import time; a no-op until then, which is correct —
 * nothing can be holding a ledger cache before mesh-ledger has loaded. It lives
 * here rather than in mesh-ledger because mesh-ledger imports mesh-runtime-store,
 * which imports this file: a static import back would close an import cycle.
 */
let onLedgerBulkChange: (() => void) | undefined;

export function registerLedgerBulkChangeListener(fn: () => void): void {
    onLedgerBulkChange = fn;
}

export function notifyLedgerBulkChange(): void {
    try { onLedgerBulkChange?.(); } catch { /* cache invalidation is best-effort */ }
}

// ─── Mesh runtime retention windows (SoT 1-11 (b) / gap I-10) ────────────────
// mesh-runtime.db had lifecycle GC only for mesh_pending_events (prunePendingEvents,
// hourly via the mesh-event maintenance sweep) and fingerprints/tool-call windows;
// mesh_event_ledger and terminal mesh_queue rows grew without bound. These windows
// are deliberately CONSERVATIVE — every production reader operates on a recent
// window far narrower than these, so the deletes trade only dead space:
//   - Event ledger 30 days: readers are tail/limit-bounded (≤ a few hundred rows) or
//     recent-task scoped; 30d comfortably exceeds any reconcile/stat/audit horizon.
//     Operating notes are exempted inside pruneEventLedger (retained forever).
//   - Tool-call log 14 days: it backs a seconds-scale rate-limit window; 14d keeps a
//     generous debugging horizon at trivial cost.
//   - Terminal queue rows 30 days: mesh_task_history / completion-dedup lookups are
//     recent-task scoped; live dependsOn anchors are exempted inside
//     pruneTerminalQueueEntries.
//   - Terminal turn-attempt rows 30 days, cascading to mesh_turn_events and
//     mesh_turn_held_suspensions: these were the last unbounded turn-side growth
//     (one attempt row + its causal event log per dispatched turn, never deleted).
//     Aligned with the terminal-queue window because an attempt is the turn-level
//     companion of its queue row. Nonterminal rows, each session's newest attempt,
//     and attempts holding an unresolved suspension are all exempted inside
//     pruneTerminalTurnAttempts; the window is env-tunable
//     (resolveTurnAttemptRetentionMs, clamped [1d, 90d]).
//   - Terminal session-delivery rows 14 days (lifecycle retention Slice 1):
//     completed/failed/expired/cancelled rows only — live/nonterminal rows
//     (queued/delivering/delivered/acked) carry the retry/recovery semantics and
//     are never pruned. Window is env-tunable (resolveSessionDeliveryRetentionMs,
//     clamped [1d, 90d]); the resolver is read at sweep time.
//   - Terminal graphs 30 days (lifecycle retention Slice 3), cascading across all
//     seven graph control-plane tables, plus a separate 14-day sweep over
//     delivered/failed outbox rows. The graph tables previously had no GC at all.
//     Both windows are env-tunable and both default to OBSERVE mode: they report
//     the rows they WOULD delete and delete nothing until
//     MESH_GRAPH_RETENTION_ENFORCE is set, because the graph schema carries no
//     foreign keys, so a missed table would orphan rows silently. Selection rules
//     and the workspace/outbox exceptions live in
//     MeshGraphStore.pruneTerminalGraphs / pruneTerminalOutbox.
// No VACUUM here by design: reclaiming file pages is not worth stalling the daemon's
// single writer; freed pages are reused by future inserts.
export const MESH_EVENT_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const MESH_TOOL_CALL_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days
export const MESH_TERMINAL_QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Periodic retention sweep for the mesh-runtime.db tables that previously had no
 * lifecycle GC (event ledger, tool-call log, terminal queue rows, terminal
 * session-delivery rows). Runs on the SAME cadence as the pending-events retention
 * prune (the hourly mesh-event maintenance sweep in mesh-event-forwarding.ts).
 * Best-effort and idempotent: a store failure degrades to a no-op with one warn;
 * re-running with nothing to prune is a set of cheap no-op DELETEs.
 * The returned counts are the content-free sweep metrics (row counts only, never
 * message/payload content).
 */
export function pruneMeshRuntimeRetention(): {
    ledger: number;
    toolCalls: number;
    terminalQueue: number;
    sessionDelivery: number;
    turnAttempts: number;
    turnEvents: number;
    turnHeldSuspensions: number;
    graph: MeshGraphRetentionCounts;
} {
    try {
        const store = MeshRuntimeStore.getInstance();
        const ledger = store.pruneEventLedger(MESH_EVENT_LEDGER_RETENTION_MS);
        // LEDGER-READ-AMPLIFICATION: this DELETE is cross-mesh (one statement, no
        // meshId), so it cannot use mesh-ledger's per-mesh invalidateLedgerCache.
        // That cache holds entries for up to 30s, so without this a sweep would
        // leave pruned rows readable for the rest of the TTL. Dispatched through a
        // registered hook rather than importing mesh-ledger directly: mesh-ledger
        // imports mesh-runtime-store, which imports THIS file, so a static import
        // back would close an import cycle. Only pay the cost when rows went away.
        if (ledger > 0) notifyLedgerBulkChange();
        const toolCalls = store.pruneToolCallLog(MESH_TOOL_CALL_LOG_RETENTION_MS);
        const terminalQueue = store.pruneTerminalQueueEntries(MESH_TERMINAL_QUEUE_RETENTION_MS);
        const sessionDelivery = store.pruneTerminalSessionDeliveries(resolveSessionDeliveryRetentionMs());
        const turn = store.pruneTerminalTurnAttempts(resolveTurnAttemptRetentionMs());
        if (ledger + toolCalls + terminalQueue + sessionDelivery + turn.attempts > 0) {
            LOG.info('MeshRuntimeStore', `Retention prune removed ${ledger} ledger / ${toolCalls} tool-call / ${terminalQueue} terminal-queue / ${sessionDelivery} terminal-session-delivery / ${turn.attempts} turn-attempt (+${turn.events} turn-event, +${turn.heldSuspensions} held-suspension) row(s)`);
        }
        // Slice 3 — graph control-plane retention. Deliberately its own try/catch
        // and its own log line: it is the newest and by far the widest-blast-radius
        // sweep (seven FK-less tables), so a failure here must not cost the
        // established sweeps above their results, and its observe/enforce mode has
        // to be legible on its own rather than buried in the line above.
        const graph = pruneMeshGraphRetention(store);
        return {
            ledger,
            toolCalls,
            terminalQueue,
            sessionDelivery,
            turnAttempts: turn.attempts,
            turnEvents: turn.events,
            turnHeldSuspensions: turn.heldSuspensions,
            graph,
        };
    } catch (e: any) {
        LOG.warn('MeshRuntimeStore', `Runtime retention prune failed: ${e?.message || e}`);
        return {
            ledger: 0, toolCalls: 0, terminalQueue: 0, sessionDelivery: 0,
            turnAttempts: 0, turnEvents: 0, turnHeldSuspensions: 0,
            graph: emptyGraphRetentionCounts(),
        };
    }
}

function emptyGraphRetentionCounts(): MeshGraphRetentionCounts {
    return {
        graphs: 0, nodes: 0, edges: 0, outputs: 0, gates: 0,
        workspaceIntents: 0, outbox: 0, skippedGraphs: 0,
        enforced: false,
    };
}

/**
 * Graph-side half of the retention sweep (lifecycle Slice 3): the terminal-graph
 * seven-table cascade plus the independent delivered/failed outbox window.
 *
 * Both calls honour MESH_GRAPH_RETENTION_ENFORCE, which is OFF by default — so
 * what this normally does is COUNT and log, deleting nothing. The log line names
 * the mode explicitly ('observe' vs 'enforce') so a live operator reading it can
 * never mistake a would-delete count for rows that actually went away; those
 * observed counts are the evidence for the later, separate commit that flips the
 * default. Counts are row counts only — content-free.
 */
function pruneMeshGraphRetention(store: MeshRuntimeStore): MeshGraphRetentionCounts {
    try {
        const enforce = resolveGraphRetentionEnforce();
        const graphStore = store.graphStore();
        const counts = graphStore.pruneTerminalGraphs(resolveGraphRetentionMs(), { enforce });
        // Cross-graph sweep: folded into the same `outbox` tally because both
        // reach the one table, and the cascade has already removed the rows
        // belonging to pruned graphs by this point (in enforce mode), so the two
        // numbers cannot double-count the same row.
        counts.outbox += graphStore.pruneTerminalOutbox(resolveGraphOutboxRetentionMs(), { enforce });
        const total = counts.graphs + counts.nodes + counts.edges + counts.outputs
            + counts.gates + counts.workspaceIntents + counts.outbox;
        if (total > 0 || counts.skippedGraphs > 0) {
            LOG.info('MeshRuntimeStore', `Graph retention ${enforce ? 'enforce' : 'observe'}: ${counts.graphs} graph / ${counts.nodes} node / ${counts.edges} edge / ${counts.outputs} output / ${counts.gates} gate / ${counts.workspaceIntents} workspace-intent / ${counts.outbox} outbox row(s)${enforce ? ' removed' : ' would be removed'}, ${counts.skippedGraphs} graph(s) held back`);
        }
        return counts;
    } catch (e: any) {
        LOG.warn('MeshRuntimeStore', `Graph retention prune failed: ${e?.message || e}`);
        return emptyGraphRetentionCounts();
    }
}
