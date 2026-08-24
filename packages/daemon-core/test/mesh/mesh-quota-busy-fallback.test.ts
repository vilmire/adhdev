/**
 * QUOTA-BUSY FALLBACK — the walk past a saturated first choice to the next
 * quota-clear candidate on the SAME node.
 *
 * The production defect being guarded: quota ranking is recomputed from scratch
 * on every reconcile tick with no memory of "this provider was busy last tick",
 * so a saturated first choice was re-elected indefinitely while an idle sibling
 * slot on the same node was never tried once (three `difficult` tasks serialized
 * onto one codex slot for 20 minutes with an idle claude-cli/opus maxParallel:2
 * beside it).
 *
 * The suite is organized around what could go wrong with the FIX rather than
 * only what was wrong before it:
 *   1. it actually falls through (the injection test — the assertion that turns
 *      red the moment the walk stops skipping the busy provider)
 *   2. it always terminates, including when every candidate is busy
 *   3. it does not over-correct: gated providers unreachable, 'notify' untouched,
 *      and `quotaBusyFallback: false` reproducing the old behaviour exactly
 */
import { describe, expect, it } from 'vitest';
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';
import {
    selectQuotaBusyFallback,
    type QuotaFallbackCandidate,
} from '../../src/mesh/mesh-quota-fallback.js';
import {
    DEFAULT_QUOTA_ROUTING_POLICY,
    resolveQuotaRoutingPolicy,
    normalizeQuotaRoutingPolicy,
} from '../../src/repo-mesh-types.js';

const slot = (provider: string, model?: string, maxParallel?: number): NodeCapabilitySlot =>
    ({ provider, ...(model ? { model } : {}), ...(maxParallel ? { maxParallel } : {}) }) as NodeCapabilitySlot;

const candidate = (provider: string, model?: string): QuotaFallbackCandidate =>
    ({ providerType: provider, slot: slot(provider, model) });

/** The production shape: codex busy, opus idle, both quota-clear. */
const CODEX = candidate('codex-cli', 'gpt-5-codex');
const OPUS = candidate('claude-cli', 'opus');
const KIMI = candidate('kimi-cli', 'kimi-code/k3');

describe('selectQuotaBusyFallback — falls through a saturated first choice', () => {
    it('picks the next quota-clear candidate when the winner is busy', () => {
        // ★INJECTION TEST: this is the assertion that goes red if the walk stops
        // skipping the busy first choice. Reverting the fix (returning the winner
        // or refusing to walk) makes `outcome` 'exhausted' and the task keeps
        // waiting on codex — exactly the 20-minute serialization observed.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'claude-cli'],
            candidates: [CODEX, OPUS],
            busyProviderType: 'codex-cli',
            probe: c => c.providerType === 'claude-cli',   // only opus is idle
        });

        expect(result.outcome).toBe('fallback');
        expect(result.outcome === 'fallback' && result.candidate.providerType).toBe('claude-cli');
    });

    it('respects the quota ranking order rather than array order', () => {
        // The walk must consume the RISK-ORDERED clear list; taking `candidates`
        // order instead would silently discard the quota decision.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'kimi-cli', 'claude-cli'],
            candidates: [OPUS, KIMI, CODEX],     // deliberately different order
            busyProviderType: 'codex-cli',
            probe: () => true,                    // every remaining candidate is idle
        });

        expect(result.outcome === 'fallback' && result.candidate.providerType).toBe('kimi-cli');
    });

    it('keeps walking past additional busy candidates', () => {
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'kimi-cli', 'claude-cli'],
            candidates: [CODEX, KIMI, OPUS],
            busyProviderType: 'codex-cli',
            probe: c => c.providerType === 'claude-cli',   // kimi busy too
        });

        expect(result.outcome === 'fallback' && result.candidate.providerType).toBe('claude-cli');
        expect(result.skipped).toEqual(['kimi-cli']);      // reported, not silently dropped
    });

    it('never returns the busy provider itself', () => {
        // A probe that says "everything is runnable" must still not re-elect the
        // provider the caller already found saturated.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'claude-cli'],
            candidates: [CODEX, OPUS],
            busyProviderType: 'codex-cli',
            probe: () => true,
        });

        expect(result.outcome === 'fallback' && result.candidate.providerType).toBe('claude-cli');
    });

    it('launches on the same slot selection would have used (first slot per provider)', () => {
        const firstOpusSlot = slot('claude-cli', 'opus', 2);
        const secondOpusSlot = slot('claude-cli', 'sonnet', 1);
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'claude-cli'],
            candidates: [
                CODEX,
                { providerType: 'claude-cli', slot: firstOpusSlot },
                { providerType: 'claude-cli', slot: secondOpusSlot },
            ],
            busyProviderType: 'codex-cli',
            probe: () => true,
        });

        expect(result.outcome === 'fallback' && result.candidate.slot).toBe(firstOpusSlot);
    });
});

describe('selectQuotaBusyFallback — termination', () => {
    it('★terminates when EVERY candidate is busy (the primary loop risk)', () => {
        // The single most dangerous failure mode: a walk that retries instead of
        // finishing would hang the reconcile tick. It must fall out to
        // 'exhausted' so the caller restores the original wait.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'kimi-cli', 'claude-cli'],
            candidates: [CODEX, KIMI, OPUS],
            busyProviderType: 'codex-cli',
            probe: () => false,                   // nothing can run
        });

        expect(result.outcome).toBe('exhausted');
        expect(result.skipped).toEqual(['kimi-cli', 'claude-cli']);
    });

    it('terminates when the busy provider is the only candidate', () => {
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli'],
            candidates: [CODEX],
            busyProviderType: 'codex-cli',
            probe: () => true,
        });

        expect(result.outcome).toBe('exhausted');
    });

    it('terminates on an empty ranking', () => {
        expect(selectQuotaBusyFallback({
            clearOrder: [],
            candidates: [],
            busyProviderType: 'codex-cli',
            probe: () => true,
        }).outcome).toBe('exhausted');
    });

    it('probes each provider at most once, even with duplicates in the ranking', () => {
        // Termination rests on every entry being visited once. A duplicated
        // ranking entry must not re-probe — that is the shape a retry loop takes.
        const probed: string[] = [];
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'kimi-cli', 'kimi-cli', 'codex-cli', 'claude-cli'],
            candidates: [CODEX, KIMI, OPUS],
            busyProviderType: 'codex-cli',
            probe: c => { probed.push(c.providerType); return false; },
        });

        expect(result.outcome).toBe('exhausted');
        expect(probed).toEqual(['kimi-cli', 'claude-cli']);   // no repeats, no codex
    });

    it('skips ranked providers that have no slot on this node', () => {
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'ghost-cli', 'claude-cli'],
            candidates: [CODEX, OPUS],            // ghost-cli has no slot
            busyProviderType: 'codex-cli',
            probe: () => true,
        });

        expect(result.outcome === 'fallback' && result.candidate.providerType).toBe('claude-cli');
    });
});

describe('quota-busy fallback — scope guards (no over-correction)', () => {
    it('★cannot reach a quota-GATED provider: only the clear ranking is walked', () => {
        // Structural guarantee behind the owner's "don't fall back onto a nearly
        // exhausted provider" constraint. Gated providers live in ranked.gated and
        // are never passed as clearOrder, so a gated candidate is unreachable even
        // when it has an idle slot and the probe would accept it.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli'],            // claude-cli is GATED → absent here
            candidates: [CODEX, OPUS],
            busyProviderType: 'codex-cli',
            probe: () => true,                    // would happily accept opus
        });

        expect(result.outcome).toBe('exhausted');
    });

    it('only accepts a candidate the probe approves — the probe owns run/wait/notify', () => {
        // The walk never decides launchability itself; it defers to the caller's
        // decideSlotForModel probe, which is what keeps 'notify' (no slot declares
        // the model) out of the fallback path entirely.
        const result = selectQuotaBusyFallback({
            clearOrder: ['codex-cli', 'claude-cli'],
            candidates: [CODEX, OPUS],
            busyProviderType: 'codex-cli',
            probe: () => false,                   // e.g. 'notify' for this candidate
        });

        expect(result.outcome).toBe('exhausted');
    });
});

describe('quotaBusyFallback policy field', () => {
    it('★defaults to ON', () => {
        expect(DEFAULT_QUOTA_ROUTING_POLICY.quotaBusyFallback).toBe(true);
        expect(resolveQuotaRoutingPolicy(null).quotaBusyFallback).toBe(true);
        expect(resolveQuotaRoutingPolicy({}).quotaBusyFallback).toBe(true);
    });

    it('honours an explicit false — the opt-out must survive resolution', () => {
        expect(resolveQuotaRoutingPolicy({ quotaBusyFallback: false }).quotaBusyFallback).toBe(false);
    });

    it('falls back to the default for a non-boolean value', () => {
        expect(resolveQuotaRoutingPolicy({ quotaBusyFallback: 'yes' as any }).quotaBusyFallback).toBe(true);
        expect(resolveQuotaRoutingPolicy({ quotaBusyFallback: undefined }).quotaBusyFallback).toBe(true);
    });

    it('persists only a non-default value (persistence economy)', () => {
        // An untouched mesh must not gain a key — same rule the numeric
        // thresholds follow, so meshes.json stays byte-for-byte stable.
        expect(normalizeQuotaRoutingPolicy({ quotaBusyFallback: true })).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy({ quotaBusyFallback: false }))
            .toEqual({ quotaBusyFallback: false });
    });

    it('leaves the other thresholds untouched', () => {
        // Guards against the new field disturbing the existing resolution.
        const resolved = resolveQuotaRoutingPolicy({ quotaBusyFallback: false });
        expect(resolved.sessionMinRemainingPercent).toBe(DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent);
        expect(resolved.weeklyMinRemainingPercent).toBe(DEFAULT_QUOTA_ROUTING_POLICY.weeklyMinRemainingPercent);
        expect(resolved.staleAfterMs).toBe(DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs);
        expect(resolved.spreadBonusMax).toBe(DEFAULT_QUOTA_ROUTING_POLICY.spreadBonusMax);
    });
});
