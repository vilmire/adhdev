// Review-in-task R2: track how long a review child has been refused ONLY for `review_independence_required`.
// The claim path and the auto-launch selector call noteReviewRefusal() with whatever reviewRoutingRefusal decided;
// the stage tick promotes the child to the fresh-session fallback after STAGE_INDEPENDENCE_FALLBACK_MS.
// In-memory by design: a daemon restart restarts the window (conservative — never falls back early).

import { STAGE_INDEPENDENCE_FALLBACK_MS } from '@adhdev/mesh-shared';

const since = new Map<string, number>();

export function noteReviewRefusal(taskId: string, refusal: string | undefined, nowMs = Date.now()): void {
    if (refusal === 'review_independence_required') { if (!since.has(taskId)) since.set(taskId, nowMs); }
    else since.delete(taskId);
}

export function independenceRefusalExceeded(taskId: string, nowMs: number, windowMs = STAGE_INDEPENDENCE_FALLBACK_MS): boolean {
    const t = since.get(taskId);
    return t !== undefined && nowMs - t >= windowMs;
}

export function clearReviewRefusal(taskId: string): void { since.delete(taskId); }
export function __resetIndependenceTrackerForTests(): void { since.clear(); }
