

import { readText } from '@adhdev/mesh-shared';
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
    const raw = readText(process.env.MESH_TURN_ATTEMPT_RETENTION_MS);
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
    const raw = readText(process.env.MESH_WORKTREE_NODE_RETENTION_GRACE_MS);
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
    const raw = readText(process.env.MESH_WORKTREE_NODE_RETENTION_LEASE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 60 * 1000 && parsed <= 60 * 60 * 1000) return parsed;
    }
    return DEFAULT_WORKTREE_NODE_RETENTION_LEASE_MS;
}
