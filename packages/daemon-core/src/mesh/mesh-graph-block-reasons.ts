/**
 * The system `blockedReason` codecs the graph engine stamps onto pending queue rows
 * it must hold back: materialization errors, a dead workspace, and a coordinator
 * gate. Each prefix is both written and parsed here so the two can never drift.
 */

// ── Graph-owned queue blocks (step 7) ─────────────────────────────────────────

const GRAPH_BLOCK_PREFIX = 'graph_materialization_pending:';

/** The ONLY blockedReason shape the graph engine may set or clear. */
export function graphMaterializationBlockReason(nodeId: string, materializationVersion: number): string {
    return `${GRAPH_BLOCK_PREFIX}${nodeId}:${materializationVersion}`;
}

export function parseGraphMaterializationBlock(reason: string | undefined): { nodeId: string; version: number } | null {
    if (!reason || !reason.startsWith(GRAPH_BLOCK_PREFIX)) return null;
    const rest = reason.slice(GRAPH_BLOCK_PREFIX.length);
    const sep = rest.lastIndexOf(':');
    if (sep <= 0) return null;
    const version = Number(rest.slice(sep + 1));
    if (!Number.isInteger(version) || version < 0) return null;
    return { nodeId: rest.slice(0, sep), version };
}

// ── Dead-workspace queue blocks (phase D) ────────────────────────────────────

const WORKSPACE_DEAD_PREFIX = 'workspace_terminal:';

/**
 * The blockedReason for a node whose workspace saga reached a terminal state.
 *
 * Deliberately NOT a `graph_materialization_pending:` block: that prefix means
 * "the graph will materialize this later", and the whole defect being fixed
 * here is that a permanently-dead workspace wore exactly that label. The
 * distinct prefix is what lets an operator — and mesh_graph_view — tell "still
 * preparing" from "will never prepare".
 */
export function workspaceTerminalBlockReason(workspaceRef: string, sagaState: string): string {
    return `${WORKSPACE_DEAD_PREFIX}${workspaceRef}:${sagaState}`;
}

// ── Coordinator-gate queue blocks (phase C2) ─────────────────────────────────

const GATE_BLOCK_PREFIX = 'coordinator_gate:';

/**
 * The blockedReason a coordinator gate puts on its downstream queue rows
 * (design :22, :402-405). Graph-owned: only the gate's own fenced release (or
 * the deadline sweep) may clear it — never a timeout and never the scheduler.
 */
export function coordinatorGateBlockReason(gateId: string): string {
    return `${GATE_BLOCK_PREFIX}${gateId}`;
}

export function parseCoordinatorGateBlock(reason: string | undefined): { gateId: string } | null {
    if (!reason || !reason.startsWith(GATE_BLOCK_PREFIX)) return null;
    const gateId = reason.slice(GATE_BLOCK_PREFIX.length);
    return gateId.length > 0 ? { gateId } : null;
}
