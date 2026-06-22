/**
 * EVTTRACE — observation-only lifecycle tracing for mesh completion events.
 *
 * Pure logging. This module adds NO decision logic: every call site is a bare log
 * statement inserted ALONGSIDE (never replacing) the existing control flow. Its only
 * job is to make a single completion event greppable across its whole lifecycle by a
 * stable correlation key, and to mark — with one uniform anchor — every point where
 * such an event is rejected / held / skipped / deduped.
 *
 * grep anchors:
 *   [EvtTrace] [stage:<name>]   — lifecycle progressed a step (INFO)
 *   [EvtTrace] [drop:<reason>]  — event did NOT advance here, with the reason (WARN)
 *
 * Follow one completion: grep the daemon log for its `task=<id>` (or `sess=<id>`)
 * across the [stage:*] lines; the line with [drop:*] is where it died.
 *
 * Dependency-light on purpose (only the logger) so both providers/ and mesh/ can
 * import it without any cycle risk.
 */
import { LOG } from '../logging/logger.js';

const CAT = 'EvtTrace';

function s(v: unknown): string {
    return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export interface MeshEventTraceCtx {
    /** Primary correlation anchor — the mesh task id (meshActiveTaskId / metadataEvent.taskId). */
    taskId?: unknown;
    /** Optional per-event id when the producer assigns one. */
    eventId?: unknown;
    /** Worker session id — the fallback anchor when no task is attached. */
    sessionId?: unknown;
    nodeId?: unknown;
    meshId?: unknown;
    event?: unknown;
}

/**
 * Stable, greppable correlation key. `task=` and `sess=` are ALWAYS rendered (as `-`
 * when absent) so the key shape is uniform across stages and a single grep alternation
 * (`task=<id>\|sess=<id>`) follows the event end-to-end.
 */
export function meshEventTraceKey(ctx: MeshEventTraceCtx): string {
    const segs = [`task=${s(ctx.taskId) || '-'}`];
    const eventId = s(ctx.eventId);
    if (eventId) segs.push(`evt=${eventId}`);
    segs.push(`sess=${s(ctx.sessionId) || '-'}`);
    const nodeId = s(ctx.nodeId);
    if (nodeId) segs.push(`node=${nodeId}`);
    const meshId = s(ctx.meshId);
    if (meshId) segs.push(`mesh=${meshId}`);
    const event = s(ctx.event);
    if (event) segs.push(`event=${event}`);
    return segs.join(' ');
}

/** Lifecycle progress (INFO). One line per stage the event clears. */
export function traceMeshEventStage(stage: string, ctx: MeshEventTraceCtx, detail?: string): void {
    LOG.info(CAT, `[stage:${stage}] ${meshEventTraceKey(ctx)}${detail ? ` — ${detail}` : ''}`);
}

/** Event did not advance — rejected / held / skipped / deduped (WARN). */
export function traceMeshEventDrop(reason: string, ctx: MeshEventTraceCtx, detail?: string): void {
    LOG.warn(CAT, `[drop:${reason}] ${meshEventTraceKey(ctx)}${detail ? ` — ${detail}` : ''}`);
}
