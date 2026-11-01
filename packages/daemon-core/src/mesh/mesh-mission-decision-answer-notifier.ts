/**
 * Decision-answer notifier. `answerMissionDecision` calls `notifyDecisionAnswered`
 * AFTER its transaction commits, for every answer, change and undo of an owner
 * decision (not for an idempotent `unchanged`). Unlike the single-slot change
 * notifier this one has several independent subscribers (the assistant's
 * preference promotion today), each returned an `off`. A subscriber that throws
 * never fails the answer.
 *
 * The event carries identifiers and enums only; a subscriber that needs the
 * decision text reads the item itself.
 */
export interface DecisionAnsweredEvent {
    meshId: string;
    missionId: string;
    itemId: string;
    action: 'answered' | 'changed' | 'undone';
    revision: number;
    /** Who answered (absent on an undo). */
    by?: 'owner' | 'auto_recommended';
    via?: 'dashboard' | 'assistant' | 'push' | 'cli' | 'auto';
    optionId?: string;
}

type Listener = (e: DecisionAnsweredEvent) => void;

const listeners = new Set<Listener>();

export function subscribeDecisionAnswered(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function notifyDecisionAnswered(e: DecisionAnsweredEvent): void {
    for (const fn of [...listeners]) {
        try { fn(e); } catch { /* a subscriber must never fail a decision write */ }
    }
}
