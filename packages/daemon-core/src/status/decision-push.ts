/**
 * Owner-decision push (structured missions design §9; owner decision D1, 2026-10-28).
 *
 * ★ CONTENT BOUNDARY — a deliberate, bounded widening of the "Push notification exception"
 * (CLAUDE.md). The server may receive, per decision push: ids (mesh/mission/item/option), the
 * question truncated to 80 chars, up to 3 option labels truncated to 24 chars, the recommended
 * option id, `urgency`, `dueAt`, and the `reason`. NEVER `context`, option `detail`, free-text
 * answers, mission goal/summary/title, or chat content.
 *
 * `projectDecisionPushEvent` is an ALLOW-LIST: it builds a fresh object field by field from a
 * decision entry. Never rewrite it as a spread plus deletes — that would leak every field later
 * added to `OwnerDecisionEntry` (it already carries `context` and `missionTitle`).
 *
 * Delivery is server-leg only (`sendServer`): the dashboard sees decisions over P2P
 * (`mission_decisions_list`). Standalone passes no `sendServer`, so nothing is registered there.
 */
import {
    DECISION_PUSH_OPTION_LABEL_MAX,
    DECISION_PUSH_OPTIONS_MAX,
    DECISION_PUSH_QUESTION_MAX,
    type DecisionPushWire,
} from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { DaemonStatusEventPayload } from '../shared-types.js';
import { buildOwnerDecisions, type OwnerDecisionEntry } from '../mesh/mesh-mission-decisions.js';
import { setDecisionPushListener } from '../mesh/mesh-mission-decision-push-notifier.js';

function clip(value: string, max: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Pure allow-list projection of an open decision onto the server push payload. */
export function projectDecisionPushEvent(
    entry: Pick<OwnerDecisionEntry, 'meshId' | 'missionId' | 'itemId' | 'question' | 'options' | 'recommended' | 'urgency' | 'dueAt'>,
    reason: 'new' | 'remind',
    timestamp: number = Date.now(),
): DaemonStatusEventPayload {
    const options = entry.options
        .slice(0, DECISION_PUSH_OPTIONS_MAX)
        .map(o => ({ id: o.id, label: clip(o.label, DECISION_PUSH_OPTION_LABEL_MAX) }));
    const decision: DecisionPushWire = {
        meshId: entry.meshId,
        missionId: entry.missionId,
        itemId: entry.itemId,
        question: clip(entry.question, DECISION_PUSH_QUESTION_MAX),
        options,
        urgency: entry.urgency === 'blocking' ? 'blocking' : 'normal',
        reason,
    };
    // The recommendation travels only if its option made the (<=3) cut — the push action needs a label.
    if (entry.recommended && options.some(o => o.id === entry.recommended)) decision.recommended = entry.recommended;
    if (entry.dueAt) decision.dueAt = entry.dueAt;
    return { event: 'agent:decision_needed', timestamp, decision };
}

export interface DecisionPushEmitterDeps {
    sendServer(payload: DaemonStatusEventPayload): void;
    /** Test seam; defaults to the live store read. */
    resolveEntry?(meshId: string, itemId: string): OwnerDecisionEntry | undefined;
    /** Max remembered itemId+reason keys (oldest evicted). */
    maxDedupe?: number;
}

/**
 * Register the decision-push listener. One event per (itemId, reason): a new decision pushes once,
 * a blocking decision's due-crossing pushes once more as `remind`. A decision that was answered
 * or withdrawn before the (deferred) read is silently skipped. Returns the unsubscribe.
 */
export function createDecisionPushEmitter(deps: DecisionPushEmitterDeps): () => void {
    const seen = new Set<string>();
    const max = deps.maxDedupe ?? 512;
    const resolve = deps.resolveEntry
        ?? ((meshId: string, itemId: string) => buildOwnerDecisions(meshId).find(e => e.itemId === itemId));
    setDecisionPushListener((src) => {
        const key = `${src.itemId}:${src.reason}`;
        if (seen.has(key)) return;
        seen.add(key);
        while (seen.size > max) {
            const oldest = seen.values().next().value;
            if (oldest === undefined) break;
            seen.delete(oldest);
        }
        // Deferred: the writer calls us inside its (synchronous) transaction; read after it commits.
        queueMicrotask(() => {
            try {
                const entry = resolve(src.meshId, src.itemId);
                if (!entry) return; // answered / withdrawn / rolled back meanwhile
                deps.sendServer(projectDecisionPushEvent(entry, src.reason));
            } catch (error) {
                LOG.warn('DecisionPush', `delivery failed: ${(error as Error)?.message ?? error}`);
            }
        });
    });
    return () => setDecisionPushListener(null);
}
