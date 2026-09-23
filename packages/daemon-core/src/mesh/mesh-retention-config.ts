// ---------------------------------------------------------------------------
// mesh-retention-config — lifecycle retention tunables + env resolvers
// ---------------------------------------------------------------------------
// Lifecycle retention Slice 1 (mesh-runtime.db + mesh-ledger disk gaps). Holds
// the retention tunables and their env-override resolvers, mirroring the
// mesh-reconcile-config.ts pattern: each resolver reads a MESH_* env var and
// clamps the value so a mis-set env cannot make retention pathologically
// aggressive (delete live data) or effectively disable it forever. Resolvers
// are called at sweep time (not import time), so an env change takes effect on
// the next hourly sweep without a restart.
//
// Scope (Slice 1): safe SQLite/disk retention only —
//   1. (retired, C-W8) the legacy session-delivery table terminal-row pruning went with the
//      table; (1b) turn-ledger mesh attempts replaced it in
//      pruneMeshRuntimeRetention (mesh-runtime-store-turn-rows.ts).
//   2. (retired, C-W9a) the per-mesh ledger rotation cap went with the JSONL
//      mirror; leftover rotations age out through the 30-day JSONL pass.
//
// Scope (Slice 2): converged local worktree-node auto-removal —
//   3. Convergence grace before an eligible worktree node may be removed
//      (wired into the two-tick retention pass in mesh-worktree-retention.ts).
//   4. Durable execution lease so two retention passes can never remove the
//      same node concurrently (same module).
//
// Scope (Slice 3): graph control-plane retention —
//   5. Terminal-graph cascade window over the seven mesh_task_graph* /
//      mesh_graph_* tables (wired into MeshGraphStore.pruneTerminalGraphs).
//   6. Delivered/failed outbox-row window, a cross-graph sweep independent of
//      (5) (MeshGraphStore.pruneTerminalOutbox).
//   7. The enforce switch that keeps (5)+(6) in OBSERVE mode by default.
// ---------------------------------------------------------------------------

import { readNonEmptyString } from './mesh-events-utils.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// (1) The legacy session-delivery retention retired with its table (C-W8).

// ─── (1b) turn-ledger mesh attempt retention ──────────────────────────────────
// TERMINAL mesh attempts (`turn_attempts`, scope mesh_queue / mesh_direct) past
// this window are deleted with their `turn_events` / `turn_holds` rows
// (`TurnStore.pruneTerminalMeshAttempts`; C-W8 moved it off the retired legacy
// mesh_turn_* tables). Nonterminal attempts are never pruned; each session's
// newest attempt survives at any age because Stage 6 presentation resolves a
// session with no time bound. Plain (non-mesh) attempts are the scheduler's
// own 7-day prune.
//
// Default 30 days, aligned with MESH_TERMINAL_QUEUE_RETENTION_MS: an attempt row
// is the turn-level companion of the queue row it came from. Clamp [1d, 90d],
// same rationale as (1).
export const DEFAULT_TURN_ATTEMPT_RETENTION_MS = 30 * DAY_MS;

export function resolveTurnAttemptRetentionMs(): number {
    const raw = readNonEmptyString(process.env.MESH_TURN_ATTEMPT_RETENTION_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1 * DAY_MS && parsed <= 90 * DAY_MS) return parsed;
    }
    return DEFAULT_TURN_ATTEMPT_RETENTION_MS;
}

// ─── (2) per-mesh ledger rotation cap — retired with the JSONL mirror (C-W9a) ─
// The rotated-out files that are left age out through runDiskRetentionSweep's
// 30-day JSONL pass.

// ─── (3) worktree-node convergence grace (Slice 2) ───────────────────────────
// A converged local worktree node must be OBSERVED as fully eligible (every
// exclusion check in mesh-worktree-retention.ts passing) on at least two
// separate retention passes spanning at least this grace window before the
// automatic reconcile phase may remove it. The grace clock starts at the first
// recorded eligible pass, so the effective wait is ≥ grace regardless of tick
// cadence. Default 48h: comfortably longer than any in-flight merge/review
// workflow, so a node is only removed once its convergence is undeniably
// settled. Clamp [1h, 30d]: below 1h the grace would not protect a slow
// reviewer; above 30d retention is effectively disabled. An explicit 0
// disables automatic worktree-node retention entirely (planning still runs in
// dry-run form; nothing is ever executed).
export const DEFAULT_WORKTREE_NODE_RETENTION_GRACE_MS = 48 * HOUR_MS;

export function resolveWorktreeNodeRetentionGraceMs(): number {
    const raw = readNonEmptyString(process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
            if (parsed === 0) return 0; // disabled
            if (parsed >= 1 * HOUR_MS && parsed <= 30 * DAY_MS) return parsed;
        }
    }
    return DEFAULT_WORKTREE_NODE_RETENTION_GRACE_MS;
}

// ─── (4) worktree-node removal lease (Slice 2) ───────────────────────────────
// Before executing a removal the retention pass persists a lease marker in the
// durable state file; a second pass (or a second daemon sharing the config
// root) that sees an unexpired lease owned by someone else skips the node with
// reason 'lease_held'. A crashed remover's lease simply expires and the next
// pass retries — removal itself is idempotent (already-missing worktree path /
// already-removed membership are both success cases). Default 10min: far
// longer than any single removal (git worktree remove + membership splice),
// short enough that a crash does not strand the node for hours. Clamp
// [1min, 1h].
export const DEFAULT_WORKTREE_NODE_RETENTION_LEASE_MS = 10 * 60 * 1000;

export function resolveWorktreeNodeRetentionLeaseMs(): number {
    const raw = readNonEmptyString(process.env.MESH_WORKTREE_NODE_RETENTION_LEASE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 60 * 1000 && parsed <= 60 * 60 * 1000) return parsed;
    }
    return DEFAULT_WORKTREE_NODE_RETENTION_LEASE_MS;
}

// ─── (5) terminal-graph cascade window (Slice 3) ─────────────────────────────
// The seven graph control-plane tables (mesh_task_graphs + nodes/edges/outputs/
// gates/workspace_intents/outbox) had NO lifecycle GC at all: every graph ever
// accepted stays forever, along with a node row per task, an edge row per
// dependency, and an immutable output version per terminal commit. This window
// deletes a graph — always as a WHOLE, never row-by-row — once it has been
// terminal for longer than the window.
//
// Default 30 days, aligned with MESH_TERMINAL_QUEUE_RETENTION_MS. That
// alignment is not cosmetic: mesh_task_outputs is keyed by the queue task id and
// backs the queue task's detail view, so letting the graph side and the queue
// side age out on different clocks would leave one referring to a task the other
// had already forgotten. Clamp [1d, 90d], same rationale as (1).
export const DEFAULT_GRAPH_RETENTION_MS = 30 * DAY_MS;

export function resolveGraphRetentionMs(): number {
    const raw = readNonEmptyString(process.env.MESH_GRAPH_RETENTION_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1 * DAY_MS && parsed <= 90 * DAY_MS) return parsed;
    }
    return DEFAULT_GRAPH_RETENTION_MS;
}

// ─── (6) delivered/failed outbox window (Slice 3) ────────────────────────────
// A cross-graph sweep, deliberately SEPARATE from (5): outbox rows may carry a
// NULL graph_id, so the graph cascade can never reach them, and delivered rows
// accumulate far faster than graphs do (several per state transition). Only the
// terminal statuses are collected — 'pending' is NEVER pruned at any age,
// because a pending row is undelivered work the drain still owes.
//
// ★ 'failed' is also a RETRY-BACKOFF state, not only a dead end:
// markOutboxEventStatus writes attempt_count/next_attempt_at_ms alongside it. The
// age gate is what makes collecting it safe — a row still being retried is being
// touched, so its updated_at stays recent and it falls outside the window.
//
// Default 14 days, matching MESH_TOOL_CALL_LOG_RETENTION_MS: same character of
// data (a delivery/audit trail read only over a recent debugging horizon).
// Clamp [1d, 90d].
export const DEFAULT_GRAPH_OUTBOX_RETENTION_MS = 14 * DAY_MS;

export function resolveGraphOutboxRetentionMs(): number {
    const raw = readNonEmptyString(process.env.MESH_GRAPH_OUTBOX_RETENTION_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1 * DAY_MS && parsed <= 90 * DAY_MS) return parsed;
    }
    return DEFAULT_GRAPH_OUTBOX_RETENTION_MS;
}

// ─── (7) graph retention enforce switch (Slice 3) ────────────────────────────
// The graph tables carry NO foreign keys (mesh-graph-schema.ts is ADDITIVE-ONLY;
// FKs cannot be added retroactively to live DBs), so the seven-table delete order
// is entirely an application-level invariant: miss a table and the orphan is
// silent — no error, no constraint violation, just rows nothing will ever reach
// again. Deletion is also irreversible.
//
// So the first shipped default is OBSERVE: the sweep runs its full selection —
// terminal-graph predicate, every exception filter, the outbox window — and
// reports the counts it WOULD delete, without issuing a single DELETE. Flipping
// the default to enforce is a separate, deliberate commit made after live
// observe counts have been read; it is not something an operator should trip
// into by accident, which is why only an explicit '1'/'true' enables it.
export function resolveGraphRetentionEnforce(): boolean {
    const raw = readNonEmptyString(process.env.MESH_GRAPH_RETENTION_ENFORCE);
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
}
