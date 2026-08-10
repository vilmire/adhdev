/**
 * INFINITE-GENERATING (codex-cli / antigravity-cli): a completion hold that no
 * clock can ever release.
 *
 * Observed live: a codex-cli mesh worker sat in `generating` for 13+ minutes
 * with no final assistant message, permanently occupying the one-active-per-node
 * write slot; antigravity-cli's completion verdict oscillated. claude-cli — the
 * only IMMEDIATE-timing provider of the three — was unaffected.
 *
 * All three providers are `native-source` class, so the class is NOT the
 * variable; the completion TIMING is (codex=floor, antigravity=hold,
 * claude=immediate). These tests pin the one property every timing class must
 * share: a hold is a delay, never a terminal state. Given a fixed set of
 * signals, repeated flushes must eventually stop returning `hold`.
 */
import { describe, it, expect } from 'vitest';
import {
    decideCompletionFlush,
    type CompletionArmState,
    type CompletionPolicy,
    type CompletionSignalReader,
    type AuthorityTiming,
} from '../../src/providers/completion/completion-engine';

const POLICY: CompletionPolicy = {
    finalizationRetryMs: 1_000,
    finalizationMaxWaitMs: 30_000,
    backgroundTaskHoldMaxMs: 300_000,
    canonCMinElapsedFloorMs: 20_000,
    transcriptGrowthQuietMs: 60_000,
    holdClassHardCapMs: 300_000,
    ptyParsedFinalAssistantQuietDwellMs: 1_200,
    terminalBlockHardCapMs: 600_000,
};

const T0 = 1_000_000;

/** The upper bound any bounded hold may use, plus slack. Past this, a hold is unbounded. */
const ABSOLUTE_BOUND_MS = Math.max(
    POLICY.finalizationMaxWaitMs,
    POLICY.backgroundTaskHoldMaxMs,
    POLICY.holdClassHardCapMs,
    POLICY.transcriptGrowthQuietMs,
    POLICY.terminalBlockHardCapMs,
) * 2;

function makeArm(overrides: Partial<CompletionArmState> = {}): CompletionArmState {
    return {
        firstObservedAt: T0,
        previousStatus: 'generating',
        turnStartedAt: T0 - 5_000,
        busyEpochAtArm: 3,
        lastOutputAtArm: T0 - 100,
        ...overrides,
    };
}

type ReaderOverrides = Partial<{ [K in keyof CompletionSignalReader]: ReturnType<CompletionSignalReader[K]> }>;

function makeReader(overrides: ReaderOverrides = {}): CompletionSignalReader {
    const value = <K extends keyof CompletionSignalReader>(key: K, fallback: ReturnType<CompletionSignalReader[K]>) =>
        (key in overrides ? overrides[key] : fallback) as ReturnType<CompletionSignalReader[K]>;
    return {
        now: () => value('now', T0 + 2_000),
        visibleStatus: () => value('visibleStatus', 'idle'),
        busyEpoch: () => value('busyEpoch', 3),
        lastOutputAt: () => value('lastOutputAt', T0 - 100),
        adapterWaitingForResponse: () => value('adapterWaitingForResponse', false),
        adapterTurnScopeActive: () => value('adapterTurnScopeActive', false),
        adapterAnyPending: () => value('adapterAnyPending', false),
        partialResponsePending: () => value('partialResponsePending', false),
        parsedStatus: () => value('parsedStatus', { ok: true, status: 'idle', modalActive: false, messages: [] }),
        staleParsedBusySuppressed: () => value('staleParsedBusySuppressed', false),
        backgroundTask: () => value('backgroundTask', { active: false }),
        finalAssistantEvidence: () => value('finalAssistantEvidence', { present: true, source: 'parsed', messages: [{ role: 'assistant' }] }),
        externalNativeTailProbe: () => value('externalNativeTailProbe', null),
        transcriptGrowth: () => value('transcriptGrowth', null),
        busyLeaseGateEnabled: () => value('busyLeaseGateEnabled', false),
        busyLease: () => value('busyLease', null),
        transcriptAgeMs: () => value('transcriptAgeMs', undefined),
        inApprovalResumeGrace: () => value('inApprovalResumeGrace', false),
        hasApprovalResolutionEvidence: () => value('hasApprovalResolutionEvidence', true),
        screenTailShowsApprovalPrompt: () => value('screenTailShowsApprovalPrompt', false),
        holdClassPtyStillActive: () => value('holdClassPtyStillActive', false),
        ownsExternalHistory: () => value('ownsExternalHistory', false),
        authorityTiming: () => value('authorityTiming', 'floor'),
        allowMissingAssistantTimeout: () => value('allowMissingAssistantTimeout', true),
    };
}

/** The live wedge shape: idle PTY, quiet, but the native transcript never grew a final assistant. */
const MISSING_EXTERNAL = { present: false, source: 'external-native' as const, messages: [] };

/**
 * Drives the flush loop forward on the real clock until it stops holding.
 * Returns the terminal decision plus how long it took.
 */
function runUntilRelease(
    timing: AuthorityTiming,
    extra: ReaderOverrides,
    maxMs = ABSOLUTE_BOUND_MS,
): { kind: string; reason?: string; waitedMs: number } {
    let arm = makeArm();
    // Step at the retry cadence, but coarsely enough to keep the test fast.
    const step = 1_000;
    for (let elapsed = 0; elapsed <= maxMs; elapsed += step) {
        const reader = makeReader({ ...extra, now: T0 + elapsed, authorityTiming: timing });
        const d = decideCompletionFlush(arm, reader, POLICY);
        if (d.kind !== 'hold') return { kind: d.kind, reason: (d as any).reason, waitedMs: elapsed };
        // Apply the patch the caller would persist, so loggedBlockReason dedupe advances.
        arm = {
            ...arm,
            loggedBlockReason: d.armPatch.loggedBlockReason ?? undefined,
            backgroundTaskHoldSince: d.armPatch.backgroundTaskHoldSince ?? undefined,
        };
    }
    return { kind: 'hold', reason: 'never_released', waitedMs: maxMs };
}

describe('INFINITE-GENERATING: no completion hold may be unbounded', () => {
    // The three live providers, all native-source, differing only in timing.
    const PROVIDERS: Array<{ name: string; timing: AuthorityTiming }> = [
        { name: 'codex-cli (floor)', timing: 'floor' },
        { name: 'antigravity-cli (hold)', timing: 'hold' },
        { name: 'claude-cli (immediate)', timing: 'immediate' },
    ];

    describe('interactive session (allowMissingAssistantTimeout=false)', () => {
        for (const { name, timing } of PROVIDERS) {
            it(`${name} releases instead of holding forever`, () => {
                const r = runUntilRelease(timing, {
                    ownsExternalHistory: true,
                    finalAssistantEvidence: MISSING_EXTERNAL,
                    allowMissingAssistantTimeout: false,
                });
                expect(r.reason).not.toBe('never_released');
                expect(r.kind).toMatch(/^emit-(weak|genuine)$/);
            });
        }
    });

    describe('mesh worker session (allowMissingAssistantTimeout=true)', () => {
        for (const { name, timing } of PROVIDERS) {
            it(`${name} releases instead of holding forever`, () => {
                const r = runUntilRelease(timing, {
                    ownsExternalHistory: true,
                    finalAssistantEvidence: MISSING_EXTERNAL,
                    allowMissingAssistantTimeout: true,
                });
                expect(r.reason).not.toBe('never_released');
                expect(r.kind).toMatch(/^emit-(weak|genuine)$/);
            });
        }
    });

    it('codex floor-class still observes the CANON-C min-elapsed floor before releasing', () => {
        const r = runUntilRelease('floor', {
            ownsExternalHistory: true,
            finalAssistantEvidence: MISSING_EXTERNAL,
            allowMissingAssistantTimeout: true,
        });
        expect(r.waitedMs).toBeGreaterThanOrEqual(POLICY.canonCMinElapsedFloorMs);
    });

    it('antigravity hold-class with a permanently active PTY still releases at the hard cap', () => {
        const r = runUntilRelease('hold', {
            ownsExternalHistory: true,
            finalAssistantEvidence: MISSING_EXTERNAL,
            allowMissingAssistantTimeout: true,
            holdClassPtyStillActive: true,
        });
        expect(r.reason).not.toBe('never_released');
        expect(r.waitedMs).toBeLessThanOrEqual(POLICY.holdClassHardCapMs + 1_000);
    });

    it('a terminal adapter block (turn scope never closed) does not wedge the session forever', () => {
        for (const { name, timing } of PROVIDERS) {
            const r = runUntilRelease(timing, {
                ownsExternalHistory: true,
                adapterTurnScopeActive: true,
                finalAssistantEvidence: MISSING_EXTERNAL,
                allowMissingAssistantTimeout: true,
            });
            expect(r.reason, `${name} wedged on adapter_turn_scope_active`).not.toBe('never_released');
        }
    });
});
