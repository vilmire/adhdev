import type { MeshLedgerKind } from './mesh-ledger.js';

// ---------------------------------------------------------------------------
// Core event injection
// ---------------------------------------------------------------------------

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_started',
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'agent:ready',
    'monitor:no_progress',
    'refine:accepted',
    'refine:completed',
    'refine:failed',
    'worktree_bootstrap_complete',
    'worktree_bootstrap_failed',
    // G3: mission-hygiene nudge. Emitted once when all of a mission's tasks first
    // become terminal — a "consider closing this mission" hint for the coordinator.
    // Purely informational: NOT force-injected (no blocked coordinator waits on it)
    // and NOT an approval; it never drives a mission status transition on its own.
    'mission_close_candidate',
]);

export const EVENT_TO_LEDGER_KIND: Record<string, MeshLedgerKind> = {
    'agent:generating_completed': 'task_completed',
    'agent:waiting_approval': 'task_approval_needed',
    'agent:stopped': 'task_failed',
    'monitor:no_progress': 'task_stalled',
};

export function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

// Terminal events that the coordinator is actively blocked waiting on. When the
// coordinator CLI session dispatches a task (e.g. mesh_send_task) it stays in
// `generating` until the result arrives — but a generating coordinator queues
// incoming send_message calls into its adapter's pendingOutboundQueue, which is
// only flushed on the coordinator's OWN idle transition. That transition can't
// happen until it receives this very event → deadlock. We force-inject these so
// they bypass the busy send-guard and land in the PTY while generating.
export const MESH_FORCE_INJECT_EVENTS: ReadonlySet<string> = new Set([
    'agent:generating_completed',
    'agent:stopped',
    'agent:waiting_approval',
    'refine:completed',
    'refine:failed',
    'worktree_bootstrap_complete',
    'worktree_bootstrap_failed',
]);

export function shouldForceInjectMeshEvent(eventName: unknown): boolean {
    return typeof eventName === 'string' && MESH_FORCE_INJECT_EVENTS.has(eventName);
}

// APPROVAL-Q1-REALTIME. Approval-kind coordinator events: a worker is blocked on an
// approval prompt and needs the coordinator to act (mesh_approve). Approval is treated
// differently from a completion in the reconcile loop's no-idle hold, and the reason is
// WHERE each event's authoritative state lives:
//   - A completion's payload (finalSummary / worker result) exists ONLY in the pending
//     event, so a drain-without-inject loses it forever → it MUST ride the idle-edge hold
//     until it can land in the coordinator as a real turn.
//   - An approval's authoritative state is recorded at LEVEL in the ledger the moment the
//     event is processed (task_approval_needed → mesh_status awaiting_approval, see
//     onMeshCoordinatorEventForwarded + mesh-active-work). The pending approval event is
//     therefore only a real-time NUDGE, not the source of truth: it can be delivered to a
//     busy coordinator's inbox (and dropped) without data loss, because the level state
//     re-derives it. That is why approval is exempt from the idle-edge hold completions
//     require, and why a stale/resolved approval nudge can simply be dropped.
export const MESH_APPROVAL_EVENTS: ReadonlySet<string> = new Set([
    'agent:waiting_approval',
]);

export function isMeshApprovalEvent(eventName: unknown): boolean {
    return typeof eventName === 'string' && MESH_APPROVAL_EVENTS.has(eventName);
}
