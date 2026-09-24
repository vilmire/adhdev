/**
 * Mesh-mode CallTool post-processing: coordinator notices on EVERY mesh tool
 * response.
 *
 * Coordinator notices (worker completion / failure / blocked / late report /
 * false idle / stall …) are durable `turn.notify` rows on the daemon; an
 * MCP-only coordinator (no PTY session for the daemon to type into) receives
 * them only as `pendingCoordinatorEvents` on a tool result, read + acked by
 * `get_pending_mesh_events` (drainCoordinatorPendingEvents). Five tools drained
 * inline (mesh_status, mesh_task_history, mesh_ledger_query, mesh_send_task,
 * mesh_read_chat); every other tool's response carried nothing, so the
 * coordinator prose ("on your next tool call") was only true for those five.
 *
 * `runMeshToolWithPendingEvents` wraps a tool invocation and, when the tool did
 * NOT drain itself (the context's `noticeDrainCount` is unchanged) and its
 * result is a JSON object without the field, drains once and merges the events
 * in. Non-JSON results are never drained: an acked notice with nowhere to go
 * would be consumed unseen.
 */
import { drainCoordinatorPendingEvents, type MeshContext } from './mesh-tools-internal.js';

function parseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * Merge drained coordinator events into `text` unless the tool already drained
 * during this call (`drainCountBefore` differs) or already carries the field.
 */
export async function attachPendingCoordinatorEventsToResponse(
    ctx: MeshContext,
    text: string,
    drainCountBefore: number,
): Promise<string> {
    if ((ctx.noticeDrainCount ?? 0) !== drainCountBefore) return text;
    const parsed = parseJsonObject(text);
    if (!parsed || Object.prototype.hasOwnProperty.call(parsed, 'pendingCoordinatorEvents')) return text;
    const events = await drainCoordinatorPendingEvents(ctx);
    if (events.length === 0) return text;
    const pretty = /\n/.test(text);
    return JSON.stringify({ ...parsed, pendingCoordinatorEvents: events }, null, pretty ? 2 : undefined);
}

/** Run one mesh tool and attach undrained coordinator notices to its result. */
export async function runMeshToolWithPendingEvents(
    ctx: MeshContext,
    run: () => Promise<string>,
): Promise<string> {
    const before = ctx.noticeDrainCount ?? 0;
    const text = await run();
    return attachPendingCoordinatorEventsToResponse(ctx, text, before);
}
