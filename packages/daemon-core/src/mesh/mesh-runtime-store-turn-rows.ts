// Pure move out of mesh-runtime-store.ts (file-size gate: baseline-growth cap hit by
// MESH-TOOL-CALL-CALLER-INSTRUMENTATION 1단계's caller_role addition). No behavior
// change — the mesh-runtime.db retention sweep (and, until C-W8, the legacy
// mesh_turn_* row shapes; until C-W9a, the event-ledger cache-invalidation hook)
// was the most self-contained slice: every symbol here only calls PUBLIC
// MeshRuntimeStore methods, so it needed no class surgery to extract.
// mesh-runtime-store.ts re-exports these names — see the barrel-preserving pattern in
// mesh-tools-internal.ts / mesh-tools.ts for precedent (export diff verified: 0 change
// to mesh-runtime-store.ts's public surface).
import { LOG } from '../logging/logger.js';
import { resolveTurnAttemptRetentionMs } from './mesh-retention-config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { meshTopicIndexFor } from './mesh-topic-index.js';

// ─── Mesh runtime retention windows (SoT 1-11 (b) / gap I-10) ────────────────
// mesh-runtime.db had lifecycle GC only for the legacy pending-event inbox and
// fingerprints/tool-call windows; the (retired) event ledger and terminal mesh_queue
// rows grew without bound. These windows are deliberately CONSERVATIVE — every
// production reader operates on a recent window far narrower than these, so the
// deletes trade only dead space:
//   - Local mesh records 30 days (C-W9a: `mesh_local_records`, successor of the
//     event ledger): readers are tail/limit-bounded or recent-task scoped; 30d
//     comfortably exceeds any refine-resume / stat / audit horizon. Time-ordered
//     deletion drops a job's dispatch before its terminal, never the reverse.
//     (Operating notes live in `mesh_operating_notes`, not here.)
//   - Tool-call log 14 days: it backs a seconds-scale rate-limit window; 14d keeps a
//     generous debugging horizon at trivial cost.
//   - Terminal queue rows 30 days: mesh_task_history / completion-dedup lookups are
//     recent-task scoped; live dependsOn anchors are exempted inside
//     pruneTerminalQueueEntries.
//   - Terminal MESH turn attempts 30 days (C-W8: the turn ledger's
//     `turn_attempts`, successor of the retired legacy mesh_turn_* cascade),
//     with their turn_events / turn_holds rows; each session's newest attempt is
//     kept (TurnStore.pruneTerminalMeshAttempts). Plain attempts are pruned by
//     the ledger scheduler. Env-tunable (resolveTurnAttemptRetentionMs).
//   - Mesh topic index (`mesh_topic_index`, the SQL read model of the
//     `mesh.<id>.events` topic) 30 days by `at_ms` — see MeshTopicIndex.pruneOlderThan.
//   - `mesh_task_outputs` ride the terminal-queue prune (same window,
//     same transaction) — see pruneTerminalQueueEntriesDetailed.
// No VACUUM here by design: reclaiming file pages is not worth stalling the daemon's
// single writer; freed pages are reused by future inserts.
export const MESH_LOCAL_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const MESH_TOOL_CALL_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days
export const MESH_TERMINAL_QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MESH_TOPIC_INDEX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;     // 30 days

/**
 * Periodic retention sweep for the mesh-runtime.db tables that previously had no
 * lifecycle GC (local mesh records, tool-call log, terminal queue rows, terminal
 * mesh turn attempts). Runs on the SAME cadence as the pending-events retention
 * prune (the hourly mesh-event maintenance sweep in mesh-event-forwarding.ts).
 * Best-effort and idempotent: a store failure degrades to a no-op with one warn;
 * re-running with nothing to prune is a set of cheap no-op DELETEs.
 * The returned counts are the content-free sweep metrics (row counts only, never
 * message/payload content).
 */
export function pruneMeshRuntimeRetention(): {
    localRecords: number;
    toolCalls: number;
    terminalQueue: number;
    taskOutputs: number;
    topicIndex: number;
    turnAttempts: number;
} {
    try {
        const store = MeshRuntimeStore.getInstance();
        const localRecords = store.localRecordStore().prune(MESH_LOCAL_RECORD_RETENTION_MS);
        const toolCalls = store.pruneToolCallLog(MESH_TOOL_CALL_LOG_RETENTION_MS);
        const { queue: terminalQueue, taskOutputs } = store.pruneTerminalQueue(MESH_TERMINAL_QUEUE_RETENTION_MS);
        const topicIndex = meshTopicIndexFor(store.db).pruneOlderThan(Date.now() - MESH_TOPIC_INDEX_RETENTION_MS);
        const turn = store.transaction(() => store.turnStore().pruneTerminalMeshAttempts(resolveTurnAttemptRetentionMs(), Date.now()));
        if (localRecords + toolCalls + terminalQueue + taskOutputs + topicIndex + turn.attempts > 0) {
            LOG.info('MeshRuntimeStore', `Retention prune removed ${localRecords} local-record / ${toolCalls} tool-call / ${terminalQueue} terminal-queue (+${taskOutputs} task-output) / ${topicIndex} topic-index / ${turn.attempts} mesh turn-attempt (+${turn.events} turn-event, +${turn.holds} hold) row(s)`);
        }
        return {
            localRecords,
            toolCalls,
            terminalQueue,
            taskOutputs,
            topicIndex,
            turnAttempts: turn.attempts,
        };
    } catch (e: any) {
        LOG.warn('MeshRuntimeStore', `Runtime retention prune failed: ${e?.message || e}`);
        return {
            localRecords: 0, toolCalls: 0, terminalQueue: 0, taskOutputs: 0, topicIndex: 0, turnAttempts: 0,
        };
    }
}
