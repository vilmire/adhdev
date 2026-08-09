import { describe, it, expect } from 'vitest';
import {
    decideCompletionFlush,
    decideShortGenerationCompletion,
    evaluateFinalizationBlock,
    resolveCompletionSettleDelayMs,
    type CompletionArmState,
    type CompletionPolicy,
    type CompletionSignalReader,
} from '../../src/providers/completion/completion-engine';
import { NATIVE_HISTORY_MESH_IDLE_SETTLE_MS } from '../../src/providers/cli-provider-instance-types';

// Historical production values — tests use the same numbers the incidents were fixed at.
const POLICY: CompletionPolicy = {
    finalizationRetryMs: 1_000,
    finalizationMaxWaitMs: 30_000,
    backgroundTaskHoldMaxMs: 300_000,
    canonCMinElapsedFloorMs: 20_000,
    transcriptGrowthQuietMs: 60_000,
    holdClassHardCapMs: 300_000,
    ptyParsedFinalAssistantQuietDwellMs: 1_200,
};

const T0 = 1_000_000;

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

/** Baseline: a quiet, idle, evidence-present parsed provider (codex-like) at T0+2s. */
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

describe('decideCompletionFlush — continuity cancels', () => {
    it('cancels when the visible status resumed off idle', () => {
        const d = decideCompletionFlush(makeArm(), makeReader({ visibleStatus: 'generating' }), POLICY);
        expect(d.kind).toBe('cancel');
        expect((d as any).reason).toBe('resumed_status');
    });

    it('cancels on busy re-entry (busyEpoch advanced) even after a hold claimed the pending', () => {
        const arm = makeArm({ loggedBlockReason: 'missing_final_assistant' });
        const d = decideCompletionFlush(arm, makeReader({ busyEpoch: 4 }), POLICY);
        expect(d.kind).toBe('cancel');
        expect((d as any).reason).toBe('busy_reentry');
    });

    it('cancels on new PTY output during settle — but ONLY before a block claimed the pending', () => {
        const fresh = decideCompletionFlush(makeArm(), makeReader({ lastOutputAt: T0 + 500 }), POLICY);
        expect(fresh.kind).toBe('cancel');
        expect((fresh as any).reason).toBe('new_pty_output');

        // KIMI cosmetic-repaint regression: once held, output recency must not delete the pending.
        const held = decideCompletionFlush(
            makeArm({ loggedBlockReason: 'missing_final_assistant' }),
            makeReader({ lastOutputAt: T0 + 500 }),
            POLICY,
        );
        expect(held.kind).not.toBe('cancel');
    });
});

describe('decideCompletionFlush — background task hold (FALSE-IDLE-BACKGROUND-CMD)', () => {
    it('holds while a background task is active, stamping the hold start', () => {
        const d = decideCompletionFlush(makeArm(), makeReader({ backgroundTask: { active: true, count: 1 } }), POLICY);
        expect(d.kind).toBe('hold');
        expect((d as any).reason).toBe('background_task_active');
        expect((d as any).armPatch.backgroundTaskHoldSince).toBe(T0 + 2_000);
        expect((d as any).firstOfReason).toBe(true);
    });

    it('releases past the hold cap instead of pinning forever', () => {
        const arm = makeArm({ backgroundTaskHoldSince: T0, loggedBlockReason: 'background_task_active' });
        const d = decideCompletionFlush(
            arm,
            makeReader({ now: T0 + POLICY.backgroundTaskHoldMaxMs + 1, backgroundTask: { active: true } }),
            POLICY,
        );
        // Falls through to normal finalization (baseline reader → clean emit).
        expect(d.kind).toBe('emit-genuine');
    });

    it('clears the hold stamp when the background job resolves', () => {
        const arm = makeArm({ backgroundTaskHoldSince: T0 + 1_000, loggedBlockReason: 'background_task_active' });
        const d = decideCompletionFlush(arm, makeReader(), POLICY);
        expect(d.kind).toBe('emit-genuine');
        expect((d as any).armPatch.backgroundTaskHoldSince).toBeNull();
        expect((d as any).armPatch.loggedBlockReason).toBeNull();
    });
});

describe('evaluateFinalizationBlock — adapter/parse blocks', () => {
    it('adapter pending blocks are terminal for a plain turn, non-terminal after approval-resolved idle (FALSEIDLE-a FixA)', () => {
        const plain = evaluateFinalizationBlock(makeArm(), makeReader({ adapterWaitingForResponse: true }), POLICY);
        expect(plain.block).toMatchObject({ reason: 'adapter_waiting_for_response', terminal: true });

        const approval = evaluateFinalizationBlock(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ adapterWaitingForResponse: true }),
            POLICY,
        );
        expect(approval.block).toMatchObject({ reason: 'adapter_waiting_for_response', terminal: false });
    });

    it('holds inside the approval-resume grace window for a generating→idle valley (SETTLE-VALLEY Fix 1)', () => {
        const r = evaluateFinalizationBlock(makeArm(), makeReader({ inApprovalResumeGrace: true }), POLICY);
        expect(r.block).toMatchObject({ reason: 'approval_resume_grace', terminal: false });
    });

    it('parse failures and busy parsed statuses block; generating-like parsed statuses are terminal', () => {
        const err = evaluateFinalizationBlock(makeArm(), makeReader({ parsedStatus: { ok: false, error: 'boom' } }), POLICY);
        expect(err.block?.reason).toBe('parse_error:boom');

        const busy = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ parsedStatus: { ok: true, status: 'generating', modalActive: false, messages: [] } }),
            POLICY,
        );
        expect(busy.block).toMatchObject({ reason: 'parsed_status:generating', terminal: true });

        const modal = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ parsedStatus: { ok: true, status: 'idle', modalActive: true, messages: [] } }),
            POLICY,
        );
        expect(modal.block).toMatchObject({ reason: 'parsed_modal_active', terminal: true });
    });

    it('suppressed stale parsed-busy yields a clean verdict', () => {
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                parsedStatus: { ok: true, status: 'generating', modalActive: false, messages: [] },
                staleParsedBusySuppressed: true,
            }),
            POLICY,
        );
        expect(r.block).toBeNull();
    });
});

describe('evaluateFinalizationBlock — missing final assistant, per timing class', () => {
    const missing = { present: false, source: 'external-native' as const, messages: [] };

    it('HOLD class (antigravity): holdForTranscript for mesh sessions, clean for interactive', () => {
        const mesh = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ ownsExternalHistory: true, authorityTiming: 'hold', finalAssistantEvidence: missing }),
            POLICY,
        );
        expect(mesh.block).toMatchObject({ reason: 'missing_final_assistant', terminal: false, holdForTranscript: true });

        const interactive = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                authorityTiming: 'hold',
                finalAssistantEvidence: missing,
                allowMissingAssistantTimeout: false,
            }),
            POLICY,
        );
        expect(interactive.block).toBeNull();
    });

    it('IMMEDIATE class (claude write-lag): un-floored transcript-evidence gate (no noExternalTranscriptSource)', () => {
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ ownsExternalHistory: true, authorityTiming: 'immediate', finalAssistantEvidence: missing }),
            POLICY,
        );
        expect(r.block).toMatchObject({ reason: 'missing_final_assistant', terminal: true, allowTimeout: true });
        expect(r.block?.noExternalTranscriptSource).toBeUndefined();
    });

    it('FLOOR class (codex/kimi): flagged noExternalTranscriptSource so the CANON-C floor applies', () => {
        const external = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ ownsExternalHistory: true, authorityTiming: 'floor', finalAssistantEvidence: missing }),
            POLICY,
        );
        expect(external.block).toMatchObject({
            reason: 'missing_final_assistant', terminal: true, allowTimeout: true, noExternalTranscriptSource: true,
        });

        const ptyParsed = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ finalAssistantEvidence: { present: false, source: 'parsed', messages: [] } }),
            POLICY,
        );
        expect(ptyParsed.block).toMatchObject({
            reason: 'missing_final_assistant', terminal: true, allowTimeout: true, noExternalTranscriptSource: true,
        });
    });

    it('an assistant tail in the external-native probe proves the turn done (clean verdict)', () => {
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                authorityTiming: 'immediate',
                finalAssistantEvidence: missing,
                externalNativeTailProbe: { lastRole: 'assistant', contentLen: 42 },
            }),
            POLICY,
        );
        expect(r.block).toBeNull();
    });

    it('SETTLE-VALLEY: approval-resolved idle on a native-history mesh worker holds for the transcript', () => {
        const r = evaluateFinalizationBlock(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ ownsExternalHistory: true, authorityTiming: 'immediate', finalAssistantEvidence: missing }),
            POLICY,
        );
        expect(r.block).toMatchObject({ reason: 'missing_final_assistant', terminal: false, holdForTranscript: true });
    });
});

describe('evaluateFinalizationBlock — post-evidence gates', () => {
    it('approval_resolution_unconfirmed holds an unproven waiting_approval→idle on mesh sessions (FALSEIDLE-a)', () => {
        const r = evaluateFinalizationBlock(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ hasApprovalResolutionEvidence: false }),
            POLICY,
        );
        expect(r.block).toMatchObject({ reason: 'approval_resolution_unconfirmed', terminal: false });

        // Interactive sessions (no mesh context) are untouched — a human may answer the PTY directly.
        const interactive = evaluateFinalizationBlock(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ hasApprovalResolutionEvidence: false, allowMissingAssistantTimeout: false }),
            POLICY,
        );
        expect(interactive.block).toBeNull();
    });

    it('a still-visible approval prompt on screen blocks completion', () => {
        const r = evaluateFinalizationBlock(makeArm(), makeReader({ screenTailShowsApprovalPrompt: true }), POLICY);
        expect(r.block).toMatchObject({ reason: 'screen_shows_approval_prompt' });
    });

    it('parsed-evidence quiet dwell holds a fresh mid-stream fragment (FALSE-IDLE-MIDTURN codex)', () => {
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ lastOutputAt: T0 + 1_500, now: T0 + 2_000 }),
            POLICY,
        );
        expect(r.block).toMatchObject({ reason: 'parsed_final_assistant_quiet_dwell', terminal: false });
    });

    it('native-source quiet dwell uses the transcript clock for lease-gated providers (KIMI-POST-FINAL-WEDGE)', () => {
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                busyLeaseGateEnabled: true,
                finalAssistantEvidence: { present: true, source: 'external-native', messages: [{ role: 'assistant' }] },
                transcriptAgeMs: 300,
            }),
            POLICY,
        );
        expect(r.block).toMatchObject({ reason: 'native_source_final_assistant_quiet_dwell', terminal: false });
    });

    it('stashes the proving message snapshot for TOCTOU-free summary extraction', () => {
        const messages = [{ role: 'assistant', content: 'done' }];
        const r = evaluateFinalizationBlock(
            makeArm(),
            makeReader({ finalAssistantEvidence: { present: true, source: 'parsed', messages } }),
            POLICY,
        );
        expect(r.evidencePatch.resolvedFinalMessages).toBe(messages);
        expect(r.evidencePatch.resolvedFinalEvidenceSource).toBe('parsed');
    });
});

describe('decideCompletionFlush — hold pipeline ordering and release', () => {
    const floorMissing: ReaderOverrides = {
        ownsExternalHistory: true,
        authorityTiming: 'floor',
        finalAssistantEvidence: { present: false, source: 'external-native', messages: [] },
    };

    it('TX-FSM Stage 1: a growing transcript holds a floor-class missing-assistant block', () => {
        const d = decideCompletionFlush(
            makeArm(),
            makeReader({ ...floorMissing, transcriptGrowth: { available: true, growing: true, msgCount: 7, mtimeAgeMs: 900 } }),
            POLICY,
        );
        expect(d.kind).toBe('hold');
        expect((d as any).reason).toBe('native_transcript_advancing');
    });

    it('TX-FSM Stage 2: an active busy lease keeps holding when growth paused (canary-gated)', () => {
        const d = decideCompletionFlush(
            makeArm(),
            makeReader({
                ...floorMissing,
                transcriptGrowth: { available: true, growing: false },
                busyLeaseGateEnabled: true,
                busyLease: { active: true, remainingMs: 5_000 },
            }),
            POLICY,
        );
        expect(d.kind).toBe('hold');
        expect((d as any).reason).toBe('busy_lease_active');
    });

    it('CANON-C floor: floor-class weak emit waits out the min-elapsed floor, then decouples', () => {
        const early = decideCompletionFlush(makeArm(), makeReader(floorMissing), POLICY);
        expect(early.kind).toBe('hold');
        expect((early as any).reason).toBe('canon_c_min_elapsed_floor');

        const after = decideCompletionFlush(
            makeArm(),
            makeReader({ ...floorMissing, now: T0 + POLICY.canonCMinElapsedFloorMs + 1 }),
            POLICY,
        );
        expect(after.kind).toBe('emit-weak');
        expect((after as any).decoupledImmediateEmit).toBe(true);
        expect((after as any).emittedAfterFinalizationTimeout).toBe(false);
    });

    it('IMMEDIATE class (claude): decoupled weak emit fires without any floor', () => {
        const d = decideCompletionFlush(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                authorityTiming: 'immediate',
                finalAssistantEvidence: { present: false, source: 'external-native', messages: [] },
            }),
            POLICY,
        );
        expect(d.kind).toBe('emit-weak');
        expect((d as any).decoupledImmediateEmit).toBe(true);
    });

    it('non-gate blocks hold to the 30s cap, then force a weak emit (forced_timeout)', () => {
        // waiting_approval→idle keeps adapter block non-terminal; before the cap → hold.
        const held = decideCompletionFlush(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ adapterWaitingForResponse: true }),
            POLICY,
        );
        expect(held.kind).toBe('hold');
        expect((held as any).reason).toBe('adapter_waiting_for_response');

        const forced = decideCompletionFlush(
            makeArm({ previousStatus: 'waiting_approval' }),
            makeReader({ adapterWaitingForResponse: true, now: T0 + POLICY.finalizationMaxWaitMs + 1 }),
            POLICY,
        );
        expect(forced.kind).toBe('emit-weak');
        expect((forced as any).emittedAfterFinalizationTimeout).toBe(true);
        expect((forced as any).decoupledImmediateEmit).toBe(false);
    });

    it('terminal blocks hold indefinitely (a genuinely busy adapter never force-completes)', () => {
        const d = decideCompletionFlush(
            makeArm(),
            makeReader({ adapterWaitingForResponse: true, now: T0 + 10 * 60_000 }),
            POLICY,
        );
        expect(d.kind).toBe('hold');
        expect((d as any).reason).toBe('adapter_waiting_for_response');
    });

    it('ANTIGRAVITY-30S-CAP-PREMATURE: hold-class holds past the cap while the PTY is active, releases at the hard cap', () => {
        const holdMissing: ReaderOverrides = {
            ownsExternalHistory: true,
            authorityTiming: 'hold',
            finalAssistantEvidence: { present: false, source: 'external-native', messages: [] },
            holdClassPtyStillActive: true,
        };
        const pastCap = decideCompletionFlush(
            makeArm(),
            makeReader({ ...holdMissing, now: T0 + POLICY.finalizationMaxWaitMs + 5_000 }),
            POLICY,
        );
        expect(pastCap.kind).toBe('hold');
        expect((pastCap as any).reason).toBe('antigravity_hold_pty_active');

        const quietPastCap = decideCompletionFlush(
            makeArm(),
            makeReader({
                ...holdMissing,
                holdClassPtyStillActive: false,
                now: T0 + POLICY.finalizationMaxWaitMs + 5_000,
            }),
            POLICY,
        );
        expect(quietPastCap.kind).toBe('emit-weak');

        const pastHardCap = decideCompletionFlush(
            makeArm(),
            makeReader({ ...holdMissing, now: T0 + POLICY.holdClassHardCapMs + 1 }),
            POLICY,
        );
        expect(pastHardCap.kind).toBe('emit-weak');
    });

    it('clean path: no block → genuine emit carrying the evidence stash', () => {
        const messages = [{ role: 'assistant', content: 'final answer' }];
        const d = decideCompletionFlush(
            makeArm(),
            makeReader({ finalAssistantEvidence: { present: true, source: 'parsed', messages } }),
            POLICY,
        );
        expect(d.kind).toBe('emit-genuine');
        expect((d as any).armPatch.resolvedFinalMessages).toBe(messages);
    });

    it('hold decisions dedupe logging via firstOfReason against loggedBlockReason', () => {
        const first = decideCompletionFlush(makeArm(), makeReader(floorMissing), POLICY);
        expect((first as any).firstOfReason).toBe(true);
        const repeat = decideCompletionFlush(
            makeArm({ loggedBlockReason: 'canon_c_min_elapsed_floor' }),
            makeReader(floorMissing),
            POLICY,
        );
        expect((repeat as any).firstOfReason).toBe(false);
    });
});

describe('arm policy — settle-window selection (generating→idle normal branch)', () => {
    it('native-history + autonomous mesh gets the settle window; plain native-history flushes immediately', () => {
        expect(resolveCompletionSettleDelayMs({ ownsExternalHistory: true, autonomousMeshSession: true }))
            .toBe(NATIVE_HISTORY_MESH_IDLE_SETTLE_MS);
        expect(resolveCompletionSettleDelayMs({ ownsExternalHistory: true, autonomousMeshSession: false })).toBe(0);
    });

    it('screen-parsed providers keep the historical 3s debounce regardless of mesh', () => {
        expect(resolveCompletionSettleDelayMs({ ownsExternalHistory: false, autonomousMeshSession: true })).toBe(3000);
        expect(resolveCompletionSettleDelayMs({ ownsExternalHistory: false, autonomousMeshSession: false })).toBe(3000);
    });
});

describe('arm policy — short-generation routing (FALSE-IDLE short-gen settle)', () => {
    it('an autonomous mesh session NEVER fires inline — always the settle arm, even with a confirmed summary', () => {
        const withSummary = decideShortGenerationCompletion({
            timing: 'immediate', evidenceSource: 'parsed', hasFinalSummary: true, autonomousMeshSession: true,
        });
        expect(withSummary).toEqual({ action: 'settle_arm', missingEvidence: false, flushDelayMs: NATIVE_HISTORY_MESH_IDLE_SETTLE_MS });
        const zeroEvidenceDip = decideShortGenerationCompletion({
            timing: 'floor', evidenceSource: 'unavailable', hasFinalSummary: false, autonomousMeshSession: true,
        });
        expect(zeroEvidenceDip.action).toBe('settle_arm');
        expect(zeroEvidenceDip.missingEvidence).toBe(true);
    });

    it('missingEvidence folds floor-class, external-native, AND zero-evidence dips; a summary clears all three', () => {
        for (const input of [
            { timing: 'floor', evidenceSource: 'parsed' },
            { timing: 'immediate', evidenceSource: 'external-native' },
            { timing: 'immediate', evidenceSource: 'unavailable' },
        ] as const) {
            expect(decideShortGenerationCompletion({ ...input, hasFinalSummary: false, autonomousMeshSession: false }))
                .toEqual({ action: 'suppress', missingEvidence: true });
            expect(decideShortGenerationCompletion({ ...input, hasFinalSummary: true, autonomousMeshSession: false }).action)
                .toBe('inline_fire');
        }
    });

    it('non-mesh interactive fast-path keeps the inline fire when evidence is confirmed-class', () => {
        expect(decideShortGenerationCompletion({
            timing: 'immediate', evidenceSource: 'parsed', hasFinalSummary: false, autonomousMeshSession: false,
        })).toEqual({ action: 'inline_fire', missingEvidence: false });
    });
});
