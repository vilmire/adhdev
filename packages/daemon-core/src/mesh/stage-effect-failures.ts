// Bounded retry for stage effects that keep failing the same way (live 2026-11-07, c8b231ee: a
// create_review_child that failed `stage_review_stale_parent` every tick wrote one stage_progress ledger row
// per retry for an hour and held the node's write slot forever). The tracker dedupes identical consecutive
// failure texts and says when a streak is long enough to escalate to a stage block.

/** Consecutive identical failures of one effect before the pipeline stops retrying and blocks the stage. */
export const STAGE_EFFECT_FAILURE_ESCALATION_THRESHOLD = 8;

/** Failures that are an honest wait (another reviewer holds the checkout), not a defect: logged once, never escalated. */
const isWaitingError = (detail: string): boolean => /^review_input_busy\b/.test(detail);

export interface StageEffectFailureVerdict {
    /** Write the failure to the ledger (first occurrence of this streak, and the escalation itself). */
    log: boolean;
    /** The streak crossed the threshold: stop retrying and surface a blocked outcome. */
    escalate: boolean;
    count: number;
}

export class StageEffectFailureTracker {
    private readonly streaks = new Map<string, { signature: string; count: number }>();
    constructor(private readonly threshold = STAGE_EFFECT_FAILURE_ESCALATION_THRESHOLD) {}

    private key(meshId: string, parentId: string, effectKind: string) { return `${meshId}\u0000${parentId}\u0000${effectKind}`; }

    record(meshId: string, parentId: string, effectKind: string, detail: string): StageEffectFailureVerdict {
        const k = this.key(meshId, parentId, effectKind);
        const prev = this.streaks.get(k);
        const count = prev && prev.signature === detail ? prev.count + 1 : 1;
        this.streaks.set(k, { signature: detail, count });
        const escalate = count >= this.threshold && !isWaitingError(detail);
        return { log: count === 1 || escalate, escalate, count };
    }

    /** The effect succeeded (or the stage moved on): the next failure starts a fresh streak. */
    clear(meshId: string, parentId: string, effectKind?: string): void {
        if (effectKind) { this.streaks.delete(this.key(meshId, parentId, effectKind)); return; }
        const prefix = `${meshId}\u0000${parentId}\u0000`;
        for (const k of [...this.streaks.keys()]) if (k.startsWith(prefix)) this.streaks.delete(k);
    }
}
