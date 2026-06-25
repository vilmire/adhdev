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
