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
//   1. mesh_session_delivery terminal-row age pruning (wired into
//      pruneMeshRuntimeRetention in mesh-runtime-store.ts).
//   2. Per-mesh ledger rotation total-byte/count cap over CLOSED rotation
//      files (wired into runDiskRetentionSweep in mesh-disk-retention.ts).
// ---------------------------------------------------------------------------

import { readNonEmptyString } from './mesh-events-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

// ─── (1) mesh_session_delivery retention ─────────────────────────────────────
// Terminal-outcome rows (completed/failed/expired/cancelled) past this window
// are deleted. Live/nonterminal rows (queued/delivering/delivered/acked) are
// NEVER pruned here — they carry the retry/recovery semantics
// (taskHasConfirmedDelivery / taskDeliveryConsumed / consumeSessionDelivery).
// Default 14 days: every reader that consults delivery rows (re-drive grace,
// assigned-stranded watchdog, ack tracking) operates on a seconds-to-hours
// horizon, so 14d is a generous dead-space window. Clamp [1d, 90d] so a mis-set
// env cannot prune rows a live recovery path might still need, nor keep them
// effectively forever.
export const DEFAULT_SESSION_DELIVERY_RETENTION_MS = 14 * DAY_MS;

export function resolveSessionDeliveryRetentionMs(): number {
    const raw = readNonEmptyString(process.env.MESH_SESSION_DELIVERY_RETENTION_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1 * DAY_MS && parsed <= 90 * DAY_MS) return parsed;
    }
    return DEFAULT_SESSION_DELIVERY_RETENTION_MS;
}

// ─── (2) per-mesh ledger rotation cap ────────────────────────────────────────
// Closed rotation files (<mesh>.<n>.jsonl and <mesh>.archive.<n>.jsonl) are the
// only unbounded on-disk ledger growth left: the active file self-limits via
// compaction/rotation slots, but the rotated-out files accumulate forever. The
// cap evicts the OLDEST closed rotation files once the per-mesh totals exceed
// the bounds. It NEVER touches the active ledger (<mesh>.jsonl), the current
// archive append target (<mesh>.archive.jsonl), archived-counts.json, or the
// runtime DB (mesh-runtime.db*).
//
// Default 200 MB per mesh: comfortably above what a long-lived mesh's closed
// rotations hold, so eviction only triggers on genuinely unbounded growth.
// Clamp [16 MB, 4 GB]: below 16 MB the cap would fight the 10 MB rotation
// threshold (a single rotation could not exist); above 4 GB is effectively
// unbounded. An explicit 0 disables the byte cap.
export const DEFAULT_LEDGER_ROTATION_MAX_BYTES = 200 * MB;

export function resolveLedgerRotationMaxBytes(): number {
    const raw = readNonEmptyString(process.env.MESH_LEDGER_ROTATION_MAX_BYTES);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
            if (parsed === 0) return 0; // disabled
            if (parsed >= 16 * MB && parsed <= 4 * 1024 * MB) return parsed;
        }
    }
    return DEFAULT_LEDGER_ROTATION_MAX_BYTES;
}

// Count backstop over the same closed-rotation set. The rotation naming scheme
// already bounds slots (≤10 active rotations + ≤5 archive rotations), so the
// default 15 matches that natural ceiling and only guards against a future
// naming change re-opening unbounded growth. Clamp [1, 50]; an explicit 0
// disables the count cap.
export const DEFAULT_LEDGER_ROTATION_MAX_FILES = 15;

export function resolveLedgerRotationMaxFiles(): number {
    const raw = readNonEmptyString(process.env.MESH_LEDGER_ROTATION_MAX_FILES);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
            if (parsed === 0) return 0; // disabled
            if (parsed >= 1 && parsed <= 50) return parsed;
        }
    }
    return DEFAULT_LEDGER_ROTATION_MAX_FILES;
}
