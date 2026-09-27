/**
 * Mesh-mode CallTool post-processing: coordinator notices on EVERY mesh tool
 * response, AND the single choke point that minifies every mesh tool's JSON
 * text before it goes out over stdio.
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
 *
 * ★Minification (2026-09-27 tools/list context-cost diet): individual tool
 * handlers across ~25 files build their own response text with
 * `JSON.stringify(x, null, 2)` (pretty-printed, historically for human
 * readability when this was debugged by eye). Since EVERY mesh tool response
 * passes through this wrapper (server.ts's mesh-mode CallTool handler calls
 * only `runMeshToolWithPendingEvents`, never returns a handler's text
 * directly — see the "server.ts routes every tool through" test below), this
 * is the one place a blanket re-serialize can normalize the wire format
 * without touching those ~25 handler files. Any text that parses as a JSON
 * object or array is re-stringified with NO indentation (cuts the transmitted
 * bytes by roughly a third to a half versus 2-space indentation); anything
 * that fails to parse (plain text, an error string) is passed through
 * unchanged, exactly as the pre-existing "non-JSON is never touched" rule for
 * event-attachment already required.
 */
import { drainCoordinatorPendingEvents, type MeshContext } from './mesh-tools-internal.js';

function parseJson(text: string): unknown {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge drained coordinator events into `text` unless the tool already drained
 * during this call (`drainCountBefore` differs) or already carries the field.
 * Also minifies `text` when it parses as JSON (object or array), whether or
 * not events are attached — see the module doc comment.
 */
export async function attachPendingCoordinatorEventsToResponse(
    ctx: MeshContext,
    text: string,
    drainCountBefore: number,
): Promise<string> {
    const parsed = parseJson(text);
    if (parsed === undefined) return text; // not JSON — never touched (nowhere to attach, nothing to minify)
    if ((ctx.noticeDrainCount ?? 0) !== drainCountBefore || !isJsonObject(parsed) || Object.prototype.hasOwnProperty.call(parsed, 'pendingCoordinatorEvents')) {
        // No event-attachment for this call, but still minify.
        return JSON.stringify(parsed);
    }
    const events = await drainCoordinatorPendingEvents(ctx);
    if (events.length === 0) return JSON.stringify(parsed);
    return JSON.stringify({ ...parsed, pendingCoordinatorEvents: events });
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
