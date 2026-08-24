/**
 * QUOTA-BUSY FALLBACK — when the quota-ranked first choice is quota-clear but
 * saturated, continue down the SAME node's ranking instead of leaving the task
 * queued for the next reconcile tick.
 *
 * THE DEFECT THIS FIXES: quota ranking is recomputed from scratch on every
 * reconcile tick (~4s), and nothing carries "this provider was busy last tick"
 * across ticks. So a saturated first choice was re-elected tick after tick,
 * each time producing the same `slot_for_model_busy` wait, while an idle
 * sibling slot on the same node was never tried. Observed in production: three
 * `difficult` tasks serialized onto a single codex slot for 20 minutes — the
 * last claimed one second after its sibling finished — while an idle
 * `claude-cli/opus maxParallel:2` sat unused and was never attempted once.
 *
 * WHY IT LIVES HERE AND NOT IN THE ASSIGNMENT LOOP: mesh-queue-assignment.ts is
 * a frozen file-size baseline (check-file-sizes.mjs) that must be decomposed
 * rather than grown. Keeping the walk pure — ranking + a capacity probe in, a
 * verdict out — also makes the termination argument checkable by a test
 * instead of by reading the surrounding async loop.
 *
 * ─── SCOPE, AND WHY THE NARROWNESS IS THE SAFETY PROPERTY ───
 *
 * This applies to exactly ONE outcome: a capacity-driven 'wait'. Two adjacent
 * paths are deliberately untouched, and widening to either would break a real
 * invariant:
 *
 *   • QUOTA-GATED providers are not reachable from here by construction. They
 *     never enter `ranked.clear` at all (rankProvidersByQuotaGate splits them
 *     into `ranked.gated`), and this walk only ever consumes `clear`. That is
 *     what makes the owner's concern — "don't fall back onto a provider that's
 *     nearly out of quota, it'll just be exhausted next" — structurally
 *     impossible rather than merely unlikely. Every candidate this returns has
 *     already passed the same quota gate the first choice passed.
 *
 *   • The 'notify' outcome (no slot declares the requested model) is a
 *     PERMANENT configuration fact, not a transient one. Absorbing it into a
 *     fallback would convert a misconfiguration the coordinator must see into
 *     silent rerouting. `slot-model-enforcement.ts` documents busy-vs-absent as
 *     opposite in nature specifically so they cannot share a code path; this
 *     module honors that split by only ever being consulted for 'wait'.
 *
 * Fallback is also strictly INTRA-NODE (owner decision): it reorders which
 * provider on this node is tried, never which node runs the task.
 *
 * The selection-time capacity estimate (`slotHasCapacity`) staying approximate
 * and optimistic relative to the claim-time check is intentional upstream
 * design, not something this module tries to reconcile — if a candidate this
 * walk returns is refused at claim time, the task simply stays queued and
 * retries, exactly as before.
 */
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';

/** A provider the quota gate cleared, paired with the slot it would launch on. */
export interface QuotaFallbackCandidate {
    slot: NodeCapabilitySlot;
    providerType: string;
}

/**
 * Whether a given candidate can actually run the task right now.
 *
 * The caller supplies this because capacity depends on live assignment counts
 * and on the slot-model guard, both of which the assignment loop owns. It must
 * be a pure read — this walk may call it once per candidate.
 */
export type QuotaFallbackProbe = (candidate: QuotaFallbackCandidate) => boolean;

export type QuotaFallbackResult =
    /**
     * A later quota-clear candidate on this node can run now. The caller should
     * re-run its normal launch path against `candidate` — the walk decides
     * WHICH provider to reconsider, never how to launch it.
     */
    | { outcome: 'fallback'; candidate: QuotaFallbackCandidate; skipped: string[] }
    /**
     * No later candidate can run either. The caller must fall back to its
     * original behaviour (leave the task queued with the first choice's own
     * wait reason), so exhausting the list is byte-identical to not having
     * consulted this module at all.
     */
    | { outcome: 'exhausted'; skipped: string[] };

/**
 * Walk the quota-clear ranking past a saturated first choice to the next
 * candidate that can run.
 *
 * ─── TERMINATION ───
 *
 * This function cannot loop. It is a single forward pass over a finite array
 * with no back-edge: `clearOrder` is bounded by the node's de-duplicated
 * provider list, each entry is visited at most once (`seen` also collapses any
 * duplicate the ranking might contain), and the probe is never re-consulted for
 * a provider already rejected. There is no retry, no re-ranking, and no
 * recursion. Every path returns — the loop's only exits are an accepting probe
 * or running off the end of the array into `exhausted`. Because the caller
 * treats `exhausted` as "keep the original wait", the worst case degrades to
 * today's behaviour rather than to a stall.
 *
 * @param clearOrder  Quota-clear provider types, best-first. `clear[0]` is the
 *                    first choice that was found busy.
 * @param candidates  Provider→slot pairs for this node; the first entry per
 *                    provider wins, matching selection's own de-duplication.
 * @param busyProviderType The saturated first choice, always excluded.
 * @param probe       Can this candidate run right now?
 */
export function selectQuotaBusyFallback(args: {
    clearOrder: readonly string[];
    candidates: readonly QuotaFallbackCandidate[];
    busyProviderType: string;
    probe: QuotaFallbackProbe;
}): QuotaFallbackResult {
    const { clearOrder, candidates, busyProviderType, probe } = args;

    // First slot per provider, mirroring selectProviderWithDiagnostics' own
    // de-dup so the fallback launches on the same slot selection would have.
    const slotByProvider = new Map<string, QuotaFallbackCandidate>();
    for (const candidate of candidates) {
        if (!slotByProvider.has(candidate.providerType)) {
            slotByProvider.set(candidate.providerType, candidate);
        }
    }

    const skipped: string[] = [];
    const seen = new Set<string>([busyProviderType]);
    for (const providerType of clearOrder) {
        if (seen.has(providerType)) continue;   // busy first choice, or a duplicate
        seen.add(providerType);
        const candidate = slotByProvider.get(providerType);
        if (!candidate) continue;               // ranked but no slot on this node
        if (probe(candidate)) {
            return { outcome: 'fallback', candidate, skipped };
        }
        skipped.push(providerType);
    }
    return { outcome: 'exhausted', skipped };
}
