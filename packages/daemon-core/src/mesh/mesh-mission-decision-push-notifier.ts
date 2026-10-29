/**
 * Decision-push notifier. Fires when an owner decision is freshly asked, or when a BLOCKING
 * decision crosses its `dueAt` (remind). Same module-level single-slot pattern as
 * `mesh-mission-change-notifier.ts`: the writers are reached from paths with no router context.
 * The host runtime registers a listener (status/decision-push.ts) that projects the entry onto
 * the server `status_event` (allow-list) — the mesh layer never builds wire text itself.
 *
 * No listener = no-op (standalone has no server leg, unit tests, CLI).
 */
export interface DecisionPushSource {
    meshId: string;
    missionId: string;
    itemId: string;
    reason: 'new' | 'remind';
}

type DecisionPushListener = (src: DecisionPushSource) => void;

let listener: DecisionPushListener | null = null;

export function setDecisionPushListener(fn: DecisionPushListener | null): void {
    listener = fn;
}

export function notifyDecisionPush(src: DecisionPushSource): void {
    if (!listener) return;
    try { listener(src); } catch { /* a push must never fail a mission write */ }
}
