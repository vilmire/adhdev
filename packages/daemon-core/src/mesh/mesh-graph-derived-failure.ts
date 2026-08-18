/**
 * GRAPH-ORCHESTRATION Phase C3 — derived failure + public policy
 * (design docs/design/2026-08-18-graph-orchestration-full.md :513-565, :336-369).
 *
 * Adopted approach (design :522): derive dependency failure for `block` from
 * current predecessor statuses. Do NOT write `dependency_failed:*` onto
 * dependents. The unchanged `taskDependenciesSatisfied` predicate already
 * stays false while a predecessor is non-`completed`. Retry of the predecessor
 * unblocks automatically once it reaches `completed`.
 *
 * `cancel` remains an explicit transactional cancellation cascade (design :535-538).
 * It does not reverse if the predecessor is later force-requeued.
 *
 * Skip (C1 `run_if` / `on_upstream_skip`) is a different axis: a skipped node
 * is terminal for graph/mission accounting and is deliberately NOT `completed`.
 * A failed predecessor must NEVER be rewritten as a skip, and a skip must NEVER
 * appear in public `dependencyFailures`.
 *
 * ★ This module must not implement coordinator-gate leases, claim, release, or
 * timeout (C2). Cancel/block walks `worker_task` nodes only. A downstream
 * `coordinator_gate` is left untouched — C2 observes worker terminals.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
    MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES,
    type MeshGraphNodeState,
    type MeshGraphOnDependencyFailure,
    type MeshGraphStatus,
    type MeshTaskGraphEdgeRow,
    type MeshTaskGraphNodeRow,
} from './mesh-graph-types.js';

// ── Public policy text (design :552-559) ─────────────────────────────────────

/**
 * The public schema/tool description text (design :552-559). Keep this string
 * identical wherever the field is exposed (RepoMeshPolicy, prompt, tools).
 */
export const MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT =
    'on_dependency_failure controls downstream tasks when a required worker task fails or is '
    + 'cancelled. `block` (default) keeps downstream pending and automatically recovers if the '
    + 'predecessor is retried and later completes. `cancel` terminally cancels the dependent branch; '
    + 'it is not revived by predecessor retry.';

export const MESH_GRAPH_SKIP_BLOCK_PREFIX = 'graph_skipped:';
export const LEGACY_DEPENDENCY_FAILED_PREFIX = 'dependency_failed:';

export class MeshGraphPolicyError extends Error {
    constructor(message: string, readonly code = 'invalid_on_dependency_failure') {
        super(message);
        this.name = 'MeshGraphPolicyError';
    }
}

// ── Policy parse / validate (design :548-550) ────────────────────────────────

/**
 * Parse a present-or-absent `on_dependency_failure` value.
 *
 * - missing / null / undefined → `block` (the default)
 * - `'block'` | `'cancel'` → that value
 * - anything else → throw {@link MeshGraphPolicyError}
 *
 * Invalid values must fail validation instead of silently becoming `block`
 * (design :548-550).
 */
export function parseOnDependencyFailurePolicy(value: unknown): MeshGraphOnDependencyFailure {
    if (value === undefined || value === null || value === '') return 'block';
    if (typeof value === 'string' && (MESH_GRAPH_ON_DEPENDENCY_FAILURE_POLICIES as readonly string[]).includes(value)) {
        return value as MeshGraphOnDependencyFailure;
    }
    throw new MeshGraphPolicyError(
        `invalid_on_dependency_failure: must be 'block' or 'cancel' (got ${JSON.stringify(value)}). `
        + 'Invalid values are rejected; they do not silently become \'block\'.',
    );
}

/** Runtime resolve: only an explicit `'cancel'` selects the cascade; anything else is `block`. */
export function resolveOnDependencyFailurePolicy(value: unknown): MeshGraphOnDependencyFailure {
    return value === 'cancel' ? 'cancel' : 'block';
}

export interface MeshGraphPolicy {
    on_dependency_failure: MeshGraphOnDependencyFailure;
}

export interface MeshGraphPublicPolicyView {
    on_dependency_failure: MeshGraphOnDependencyFailure;
    /** Set when stored policy_json could not be parsed strictly; apply still uses `block`. */
    policyInvalid?: string;
}

/** Normalize a graph `policy_json` object. Throws on a present-but-invalid field. */
export function parseGraphPolicy(policyJson: string | undefined | null): MeshGraphPolicy {
    const parsed = safeParseObject(policyJson);
    const raw = parsed?.on_dependency_failure ?? parsed?.onDependencyFailure;
    return { on_dependency_failure: parseOnDependencyFailurePolicy(raw) };
}

/**
 * Runtime graph-policy read. A corrupt stored document fails closed to `block`
 * (do not destroy a branch because JSON was hand-edited) and surfaces the
 * parse error on the public view.
 */
export function projectGraphPublicPolicy(policyJson: string | undefined | null): MeshGraphPublicPolicyView {
    try {
        return parseGraphPolicy(policyJson);
    } catch (e) {
        return {
            on_dependency_failure: 'block',
            policyInvalid: e instanceof Error ? e.message : String(e),
        };
    }
}

export function serializeGraphPolicy(policy: MeshGraphPolicy): string {
    return JSON.stringify({ on_dependency_failure: policy.on_dependency_failure });
}

// ── Skip vs failure (design :356-369 vs :522-538) ────────────────────────────

/** Queue placeholder for a C1 skip: cancelled + `graph_skipped:*`, never `completed`. */
export function isGraphSkipPlaceholder(entry: {
    status?: string;
    blockedReason?: string;
    cancelReason?: string;
} | null | undefined): boolean {
    if (!entry) return false;
    const reason = entry.blockedReason ?? entry.cancelReason ?? '';
    return entry.status === 'cancelled' && reason.startsWith(MESH_GRAPH_SKIP_BLOCK_PREFIX);
}

export function isLegacyDependencyFailedBlock(reason: string | undefined): boolean {
    return parseLegacyDependencyFailedPredecessor(reason) !== null;
}

/**
 * Exact `dependency_failed:<taskId>` only (design :561-564). Never matches
 * `graph_skipped:`, `materialization_error:`, or a graph-owned block.
 */
export function parseLegacyDependencyFailedPredecessor(reason: string | undefined): string | null {
    if (typeof reason !== 'string') return null;
    if (!reason.startsWith(LEGACY_DEPENDENCY_FAILED_PREFIX)) return null;
    const rest = reason.slice(LEGACY_DEPENDENCY_FAILED_PREFIX.length);
    if (!rest || rest.startsWith(':')) return null;
    return rest;
}

// ── Derived public view (design :524-527) ────────────────────────────────────

export interface MeshDependencyFailure {
    taskId: string;
    status: 'failed' | 'cancelled';
    reason?: string;
}

export interface MeshDerivedDependencyState {
    waitingOn: string[];
    dependenciesSatisfied: boolean;
    dependencyFailures: MeshDependencyFailure[];
}

/**
 * View-time derivation of explanatory failure data. Truth stays in predecessor
 * statuses; this never writes `blockedReason`. A skipped predecessor is
 * waiting-on (not completed) but is NOT a dependency failure.
 */
export function deriveDependencyFailures(
    dependsOn: readonly string[] | undefined,
    statusById: ReadonlyMap<string, string>,
    depMetaById?: ReadonlyMap<string, { blockedReason?: string; cancelReason?: string; status?: string }>,
): MeshDependencyFailure[] {
    const deps = Array.isArray(dependsOn) ? dependsOn : [];
    const failures: MeshDependencyFailure[] = [];
    for (const taskId of deps) {
        const meta = depMetaById?.get(taskId);
        const status = statusById.get(taskId) ?? meta?.status;
        if (isGraphSkipPlaceholder({ status, blockedReason: meta?.blockedReason, cancelReason: meta?.cancelReason })) {
            continue;
        }
        if (status !== 'failed' && status !== 'cancelled') continue;
        const reason = meta?.cancelReason ?? meta?.blockedReason;
        failures.push({
            taskId,
            status,
            ...(reason ? { reason } : {}),
        });
    }
    return failures;
}

// ── Graph rollup (C3 failed/cancelled rollups) ───────────────────────────────

const SUCCESS_TERMINAL: ReadonlySet<MeshGraphNodeState> = new Set(['completed', 'released', 'skipped']);
const WORKER_SETTLED: ReadonlySet<MeshGraphNodeState> = new Set([
    'completed', 'skipped', 'failed', 'cancelled',
]);
const GATE_SETTLED: ReadonlySet<MeshGraphNodeState> = new Set(['released', 'cancelled', 'expired']);

/**
 * Classify a graph's next status from current node states.
 *
 * C2 interface assumption: in-flight coordinator gates (`declared` /
 * `awaiting_coordinator` / `claimed`) leave the graph unrolled — C2 owns
 * `waiting_gate` and gate expiry. C3 never writes those states.
 *
 * Under `block`, failed workers leave dependents non-terminal, so this
 * returns null and the graph stays `active` (retry can still recover).
 */
export function classifyGraphRollup(nodes: readonly MeshTaskGraphNodeRow[]): MeshGraphStatus | null {
    const gates = nodes.filter(n => n.kind === 'coordinator_gate');
    const workers = nodes.filter(n => n.kind !== 'coordinator_gate');
    if (gates.some(g => !GATE_SETTLED.has(g.state))) return null;
    if (workers.some(w => !WORKER_SETTLED.has(w.state))) return null;
    if (workers.some(w => w.state === 'failed')) return 'failed';
    if (workers.some(w => w.state === 'cancelled') || gates.some(g => g.state === 'cancelled' || g.state === 'expired')) {
        return 'cancelled';
    }
    if (workers.length === 0 && gates.length === 0) return 'completed';
    if (workers.every(w => SUCCESS_TERMINAL.has(w.state)) && gates.every(g => g.state === 'released' || SUCCESS_TERMINAL.has(g.state))) {
        return 'completed';
    }
    return 'completed';
}

export function isSuccessTerminalNode(state: MeshGraphNodeState): boolean {
    return SUCCESS_TERMINAL.has(state);
}

// ── Cancel cascade (design :535-538) ─────────────────────────────────────────

const CANCELABLE_NODE_STATES: ReadonlySet<MeshGraphNodeState> = new Set([
    'declared', 'blocked', 'materialized',
]);

export interface MeshDerivedFailureStore {
    findQueueEntryById(meshId: string, taskId: string): {
        id: string;
        status: string;
        dependsOn?: string[];
        blockedReason?: string;
        cancelReason?: string;
        cancelledAt?: string;
    } | null;
}

export interface GraphCancelCascadeResult {
    cancelledNodeIds: string[];
    cancelledTaskIds: string[];
}

/**
 * Explicit transactional cancellation of the dependent worker branch.
 * Does not touch coordinator_gate nodes (C2). Does not strip `dependsOn`.
 * Does not rewrite a skip as a cancel (already-skipped nodes stay skipped).
 * Only pending queue placeholders flip; an assigned worker is left running.
 */
export function applyGraphCancelCascade(
    store: MeshDerivedFailureStore,
    nodes: readonly MeshTaskGraphNodeRow[],
    edges: readonly MeshTaskGraphEdgeRow[],
    origin: MeshTaskGraphNodeRow,
    nowIso: string,
    updateNodeState: (node: MeshTaskGraphNodeRow, reason: string) => void,
): GraphCancelCascadeResult {
    const byId = new Map(nodes.map(n => [n.nodeId, n] as const));
    const frontier = [origin.nodeId];
    const seen = new Set<string>(frontier);
    const cancelledNodeIds: string[] = [];
    const cancelledTaskIds: string[] = [];
    const sourceTaskId = origin.queueTaskId ?? origin.nodeId;
    const sourceRef = origin.ref ?? origin.nodeId;

    while (frontier.length > 0) {
        const currentId = frontier.pop()!;
        const outgoing = edges.filter(e => e.fromNodeId === currentId && e.kind !== 'gate');
        for (const edge of outgoing) {
            const target = byId.get(edge.toNodeId);
            if (!target || seen.has(target.nodeId)) continue;
            seen.add(target.nodeId);
            // C2 owns gate nodes. A worker-task cancel does not flip a gate.
            if (target.kind !== 'worker_task') continue;
            if (target.state === 'skipped') continue;
            if (!CANCELABLE_NODE_STATES.has(target.state)) continue;

            const reason = `${LEGACY_DEPENDENCY_FAILED_PREFIX}${sourceRef}`;
            updateNodeState(target, reason);
            target.state = 'cancelled';
            target.failureReason = reason;
            cancelledNodeIds.push(target.nodeId);

            if (target.queueTaskId) {
                const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
                // Queue-row terminal write stays in the runner (structural pin:
                // only the choke point / work-queue may assign a literal terminal
                // status). We report the still-pending placeholder here.
                if (entry && entry.status === 'pending') {
                    cancelledTaskIds.push(entry.id);
                }
            }
            frontier.push(target.nodeId);
        }
    }
    return { cancelledNodeIds, cancelledTaskIds };
}

// ── Legacy blockedReason migration (design :561-564) ─────────────────────────

export interface LegacyDependencyFailedClear {
    taskId: string;
    meshId: string;
    predecessorId: string;
}

/**
 * Clear only exact `dependency_failed:<taskId>` markers on queue payloads.
 * Records each referenced predecessor, then deletes the marker. Other block
 * reasons are never touched. The first upgraded view derives the same
 * user-visible reason from current predecessor statuses.
 */
export function migrateLegacyDependencyFailedQueueBlocks(db: DatabaseHandle): LegacyDependencyFailedClear[] {
    let rows: Array<{ id: string; mesh_id: string; payload: string }>;
    try {
        rows = db.prepare(`SELECT id, mesh_id, payload FROM mesh_queue`).all() as Array<{
            id: string; mesh_id: string; payload: string;
        }>;
    } catch {
        return [];
    }
    const cleared: LegacyDependencyFailedClear[] = [];
    const update = db.prepare(`UPDATE mesh_queue SET payload = ?, updated_at = ? WHERE id = ? AND mesh_id = ?`);
    const nowIso = new Date().toISOString();
    for (const row of rows) {
        let entry: { blockedReason?: string; [key: string]: unknown };
        try {
            entry = JSON.parse(row.payload) as { blockedReason?: string };
        } catch {
            continue;
        }
        const predecessorId = parseLegacyDependencyFailedPredecessor(entry.blockedReason);
        if (!predecessorId) continue;
        delete entry.blockedReason;
        update.run(JSON.stringify(entry), nowIso, row.id, row.mesh_id);
        cleared.push({ taskId: row.id, meshId: row.mesh_id, predecessorId });
    }
    return cleared;
}

function safeParseObject(text: string | undefined | null): Record<string, unknown> | null {
    if (!text) return null;
    try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return value as Record<string, unknown>;
    } catch {
        return null;
    }
}
