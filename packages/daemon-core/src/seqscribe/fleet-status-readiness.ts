/**
 * Phase 4 Stage 3 — fail-closed readiness for a future `fleet.status` reader.
 *
 * This module does not switch a consumer. It only evaluates the four pieces of
 * evidence that a later cutover must provide. Missing/unknown evidence is a
 * refusal, because the existing WS path remains authoritative.
 *
 * ★ Currently uncalled outside its own test — this is intentional, not dead
 * code to clean up. Unlike `mesh.<id>.events`, `fleet.status` has no legacy
 * read path to cut over: the daemon never read peer status from a file or DB,
 * so there is nothing for a "primary" mode to replace, and `FleetStatusMode`
 * stays `'shadow' | 'off'` (see docs/design/2026-08-26-seqscribe-integration-
 * plan.md §5, "fleet.status primary 승격 — 설계 노트", decided 2026-08-28,
 * recommendation C). This evaluator is kept, not deleted, because its four
 * conditions become load-bearing again if the legacy WS `status_report`
 * publish is ever retired (§5's "레거시 WS 발행 중단은 후속 Stage 몫") — that
 * would introduce a real cutover for the first time. Re-evaluate wiring this
 * in only if that retirement is separately approved; do not wire it in to
 * satisfy an otherwise-unrelated task.
 */

import type { SeqscribeNodeHandle } from './node.js';
import {
    fleetStatusParityCounters,
    type FleetStatusParityCounters,
} from './fleet-status-parity.js';
import { FLEET_STATUS_TOPIC } from './topics.js';

export type FleetStatusReadinessReason =
    | 'topic_or_grant_unavailable'
    | 'not_caught_up'
    | 'parity_unclean'
    | 'primary_not_intended';

export interface FleetStatusReadiness {
    ready: boolean;
    reason: FleetStatusReadinessReason | null;
}

export interface FleetStatusReadinessInput {
    /** Node the future consumer is attached to. */
    node?: Pick<SeqscribeNodeHandle, 'topics'> | null;
    /** Last grant map actually advertised to the transport. Null is unknown. */
    grantedTopics?: ReadonlySet<string> | null;
    /** Future SUB/read-model backlog has drained through its pinned head. */
    caughtUp?: boolean;
    /** Explicit future-consumer cutover intent. This stage never acts on it. */
    primaryIntent?: boolean;
}

type ParityEvidence = Pick<FleetStatusParityCounters, 'runs' | 'mismatches'>;

/**
 * Evaluate all four readiness conditions in their diagnostic order.
 *
 * `parity` defaults to live process counters. The explicit argument lets tests
 * evaluate each condition independently and lets a caller pin one coherent
 * evidence snapshot for a larger routing decision.
 */
export function evaluateFleetStatusReadiness(
    input: FleetStatusReadinessInput = {},
    parity: ParityEvidence = fleetStatusParityCounters(),
): FleetStatusReadiness {
    const topicPresent = input.node?.topics.some((definition) => definition.topic === FLEET_STATUS_TOPIC) === true;
    const topicGranted = input.grantedTopics?.has(FLEET_STATUS_TOPIC) === true;
    if (!topicPresent || !topicGranted) {
        return { ready: false, reason: 'topic_or_grant_unavailable' };
    }

    if (input.caughtUp !== true) return { ready: false, reason: 'not_caught_up' };

    // A zero before the first comparison is absence of evidence, not clean
    // parity. At least one completed run is required.
    if (parity.runs < 1 || parity.mismatches !== 0) {
        return { ready: false, reason: 'parity_unclean' };
    }

    if (input.primaryIntent !== true) {
        return { ready: false, reason: 'primary_not_intended' };
    }

    return { ready: true, reason: null };
}
