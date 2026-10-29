/**
 * Deterministic safety net for a coordinator that asks the owner a multiple-choice
 * question in plain text instead of registering a decision item (live QA, claude-cli
 * haiku coordinator 2026-10-29: "Decision for you 1./2./3. … Which one should I use?").
 *
 * ★Design note §5.2 rejected a daemon-side plain-text parser because it false-positives
 * (a status report with a numbered list and a trailing "anything else?" is not a
 * decision). So this is deliberately NARROW — a miss costs nothing (the prompt rule and
 * the assistant remain the primary routes), a false positive puts a bogus card in the
 * owner's inbox. A final message qualifies only when ALL hold:
 *   - its last non-empty line is a question (ends with `?`) with a decision cue
 *     ("which", "should I", "shall I", "do you want", "want me to", …);
 *   - immediately before it is ONE contiguous block of 2–5 numbered lines `1.`…`N.`
 *     (strictly sequential from 1);
 *   - a cue word ("decision", "option", "choose", "pick", …) sits in the line right above
 *     the block or in the question itself (a plain numbered summary ending "Should I
 *     merge these?" has neither);
 *   - the coordinator registered no decision item during the turn.
 * The result is a normal decision item in the carry-over mission, flagged in its
 * `context` as inferred, deduped like any other (same question → the existing item).
 * Sunset: delete this file when coordinators stop producing such messages (watch the
 * `inferred` decisions count in the decision metrics) or when the prompt rule makes it
 * dead code.
 */
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { LOG } from '../logging/logger.js';

export interface InferredOwnerQuestion {
    question: string;
    options: Array<{ label: string }>;
}

const NUMBERED = /^\s*\(?(\d{1,2})[.)]\s+(\S.*)$/;
const QUESTION_CUE = /\b(which|should i|shall i|do you want|would you like|want me to|how should i|what should i|do you prefer|prefer)\b/i;
const HEADER_CUE = /\b(decision|decide|options?|choices?|choose|pick|alternatives?|approach(?:es)?)\b/i;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTION_CHARS = 200;

/** Pure, strict extractor (see the module comment for why it is so narrow). */
export function extractOwnerQuestion(finalMessage: string | null | undefined): InferredOwnerQuestion | null {
    if (typeof finalMessage !== 'string') return null;
    const lines = finalMessage.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd());
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length < 3) return null;
    const qLine = lines[lines.length - 1].trim();
    if (!/[?？]$/.test(qLine) || qLine.length > MAX_QUESTION_CHARS || NUMBERED.test(qLine) || !QUESTION_CUE.test(qLine)) return null;

    // Walk upward over the option block (single blank lines tolerated between options).
    let i = lines.length - 2;
    while (i >= 0 && !lines[i].trim()) i--;
    const collected: Array<{ n: number; text: string }> = [];
    while (i >= 0) {
        const raw = lines[i];
        if (!raw.trim()) { i--; continue; }
        const m = NUMBERED.exec(raw);
        if (!m) break;
        collected.push({ n: Number(m[1]), text: m[2].trim() });
        i--;
    }
    const options = collected.reverse();
    if (options.length < 2 || options.length > 5) return null;
    if (!options.every((o, idx) => o.n === idx + 1)) return null;
    // A nested/continuation line directly above the block means the block is not a standalone
    // option list; require the nearest non-blank line above to be a header cue, or the question itself to carry one.
    let header = '';
    while (i >= 0 && !lines[i].trim()) i--;
    if (i >= 0) header = lines[i];
    if (!HEADER_CUE.test(header) && !HEADER_CUE.test(qLine)) return null;
    return {
        question: qLine,
        options: options.map(o => ({ label: o.text.length > MAX_OPTION_CHARS ? `${o.text.slice(0, MAX_OPTION_CHARS - 1)}…` : o.text })),
    };
}

export interface InferredDecisionDeps {
    bus: Pick<SessionLifecycleBus, 'on'>;
    /** Mesh the session coordinates, or null when it is not a coordinator. */
    coordinatorMeshOf(sessionId: string): string | null;
    /** The committed attempt's final assistant message, or null when unavailable. */
    readFinalMessage(meshId: string, sessionId: string, attemptId: string): Promise<string | null>;
    /** True when a decision item was registered on the mesh at/after `sinceMs`. */
    decisionRegisteredSince(meshId: string, sinceMs: number): boolean;
    /** Register the inferred decision (carry-over mission, deduped). */
    register(meshId: string, q: InferredOwnerQuestion): void;
    now?: () => number;
}

/** Marker text in the decision's `context`, so the UI/metrics can tell inferred items apart. */
export const INFERRED_DECISION_CONTEXT = 'Inferred from the coordinator\'s plain-text question (it did not register a decision item).';

/** Coordinator turn committed → maybe register the plain-text question as a decision item. */
export function subscribeInferredOwnerDecisions(deps: InferredDecisionDeps): Unsubscribe {
    const now = deps.now ?? Date.now;
    const startedAt = new Map<string, number>();
    return deps.bus.on('turn', (e) => {
        if (!e.attemptId.startsWith('plain:')) return; // coordinator-style plain turns only
        if (e.phase === 'started') { startedAt.set(e.sessionId, now()); return; }
        if (e.phase !== 'committed' || (e.outcome && e.outcome !== 'completed')) return;
        const meshId = deps.coordinatorMeshOf(e.sessionId);
        if (!meshId) return;
        const since = startedAt.get(e.sessionId) ?? now() - 15 * 60_000;
        startedAt.delete(e.sessionId);
        void (async () => {
            try {
                if (deps.decisionRegisteredSince(meshId, since)) return;
                const body = await deps.readFinalMessage(meshId, e.sessionId, e.attemptId);
                const q = extractOwnerQuestion(body);
                if (!q) return;
                deps.register(meshId, q);
                LOG.info('MeshDecision', `registered inferred owner decision from coordinator ${e.sessionId} plain-text question (mesh ${meshId})`);
            } catch (err: any) {
                LOG.warn('MeshDecision', `inferred owner decision skipped: ${err?.message || err}`);
            }
        })();
    }, { name: 'mesh.inferred-owner-decisions' });
}
