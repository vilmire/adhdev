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
 *
 * Lives in shared/ — NOT mesh/ — precisely because both layers consume it. While it
 * sat under mesh/, every providers/completion/* call site registered as a
 * providers → mesh boundary violation (check-import-boundaries.mjs) even though the
 * module has no mesh dependency at all: the arrows were an artifact of its location,
 * not real coupling. Keep it free of imports from providers/, mesh/, and
 * cli-adapters/ so it stays neutral.
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

// ─── Per-(reason, anchor) streak dedup ───────────────────────────────────────
// 2026-09-23 preview log review: a single (reason, taskId) pair repeated its
// drop WARN every ~4s in bursts (12 consecutive hits for one task inside 20s
// was the worst observed case; 5,758 WARN lines total for three reasons across
// 8 days) because traceMeshEventDrop was a bare unconditional LOG.warn with no
// dedup. This is a GENERIC fix at the module level — keyed on (reason, anchor)
// only, never on the specific reason string — so every future drop reason
// inherits the same streak collapsing without another call site touching this
// file. Anchor prefers taskId (the review's dominant case), then sessionId,
// then nodeId, mirroring meshEventTraceKey's own task→sess fallback so the
// dedup key lines up with what a human greps by.
//
// Behaviour: the FIRST drop for a (reason, anchor) key logs WARN immediately
// (visibility is never delayed). Every repeat within the same streak logs
// DEBUG instead of WARN (still greppable, just off the default-visible level).
// Once STREAK_FLUSH_MS has elapsed since the last WARN for that key, the next
// call re-emits a WARN carrying the repeat count accumulated since the last
// flush, so a long-lived streak still surfaces periodically rather than going
// permanently silent. There is no background timer: flushing is driven by
// call cadence (the failure mode being fixed calls this every few seconds
// during a live streak, so wall-clock gating on each call is sufficient) —
// this avoids adding another interval to unref/leak-check/tear down.
const STREAK_FLUSH_MS = 5 * 60 * 1000; // one WARN summary per key per 5 minutes, at most
// A finished streak (task terminated, reason stopped firing) leaves its key in
// the map forever with nothing to evict it — over a long-running daemon's
// lifetime, distinct (reason, taskId) pairs accumulate without bound. Evict
// opportunistically rather than on a timer (this module intentionally has no
// interval to unref/leak-check — see module doc): once the map crosses
// EVICT_SCAN_AT_SIZE entries, the current call sweeps out anything idle past
// STALE_AFTER_MS. This keeps the hot path (the common case: map well under
// the threshold) O(1) and only pays the O(n) sweep cost on the rare calls that
// cross the threshold.
const STALE_AFTER_MS = 30 * 60 * 1000;
const EVICT_SCAN_AT_SIZE = 500;

interface DropStreak {
    /** Repeats seen since the last WARN flush for this key (not counting that WARN's own occurrence). */
    countSinceFlush: number;
    /** Total repeats seen across the whole streak (for the summary line). */
    totalCount: number;
    lastWarnAt: number;
}

const dropStreaks = new Map<string, DropStreak>();

function evictStaleDropStreaks(now: number): void {
    if (dropStreaks.size < EVICT_SCAN_AT_SIZE) return;
    for (const [key, streak] of dropStreaks) {
        if (now - streak.lastWarnAt > STALE_AFTER_MS) dropStreaks.delete(key);
    }
}

function dropStreakAnchor(ctx: MeshEventTraceCtx): string {
    const taskId = s(ctx.taskId);
    if (taskId) return `task=${taskId}`;
    const sessionId = s(ctx.sessionId);
    if (sessionId) return `sess=${sessionId}`;
    const nodeId = s(ctx.nodeId);
    if (nodeId) return `node=${nodeId}`;
    return '-';
}

/** Test hook: clears in-memory streak state so tests don't leak into each other. */
export function __resetMeshEventDropStreaksForTests(): void {
    dropStreaks.clear();
}

/** Event did not advance — rejected / held / skipped / deduped.
 *  First occurrence of a (reason, taskId/sessionId/nodeId) streak logs WARN;
 *  repeats within STREAK_FLUSH_MS log DEBUG; the streak re-surfaces at WARN
 *  with a repeat count every STREAK_FLUSH_MS as long as it keeps firing. */
export function traceMeshEventDrop(reason: string, ctx: MeshEventTraceCtx, detail?: string): void {
    const key = `${reason}\u0000${dropStreakAnchor(ctx)}`;
    const now = Date.now();
    evictStaleDropStreaks(now);
    const existing = dropStreaks.get(key);
    const line = `[drop:${reason}] ${meshEventTraceKey(ctx)}${detail ? ` — ${detail}` : ''}`;

    if (!existing) {
        dropStreaks.set(key, { countSinceFlush: 0, totalCount: 1, lastWarnAt: now });
        LOG.warn(CAT, line);
        return;
    }

    existing.totalCount++;
    if (now - existing.lastWarnAt >= STREAK_FLUSH_MS) {
        const repeats = existing.countSinceFlush;
        existing.countSinceFlush = 0;
        existing.lastWarnAt = now;
        LOG.warn(CAT, `${line} (repeated ${repeats}x in the last ${Math.round(STREAK_FLUSH_MS / 60000)}m, ${existing.totalCount} total this streak)`);
        return;
    }

    existing.countSinceFlush++;
    LOG.debug(CAT, line);
}
