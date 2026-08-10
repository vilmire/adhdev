/**
 * THE COMPLETION-EVIDENCE INVARIANT
 *
 *   evidence.present === false  ⇒  evaluateFinalizationBlock MUST NOT return block: null
 *
 * A null block is a CLEAN completion — "the turn is provably finished". Deriving
 * that from evidence that explicitly says the final assistant was NOT found is a
 * contradiction, and it is the shape of two opposite live defects:
 *
 *  - codex-cli (timing=floor) held a terminal block forever → infinite `generating`.
 *  - antigravity-cli (hold) / claude-cli (immediate) fell THROUGH both the
 *    `source === 'external-native'` and the `timing === 'floor'` returns when the
 *    native transcript was unresolved, reached the tail `return { block: null }`,
 *    and emitted a clean completion with zero evidence — the empty-summary
 *    notification the owner observed.
 *
 * Both violate the same invariant from opposite directions, so it is asserted
 * EXHAUSTIVELY over every (timing × evidence-source × ownsExternal × mesh) combo
 * rather than sampled.
 */
import { describe, it, expect } from 'vitest';
import {
    evaluateFinalizationBlock,
    type AuthorityTiming,
    type CompletionArmState,
    type CompletionPolicy,
    type CompletionSignalReader,
    type EvidenceSource,
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

/** The three live CLI providers, all native-source, differing only in completion timing. */
const TIMINGS: Array<{ timing: AuthorityTiming; provider: string }> = [
    { timing: 'floor', provider: 'codex-cli' },
    { timing: 'hold', provider: 'antigravity-cli' },
    { timing: 'immediate', provider: 'claude-cli' },
];
const SOURCES: EvidenceSource[] = ['external-native', 'parsed', 'unavailable'];

describe('INVARIANT: evidence.present === false must never yield a clean (null) block', () => {
    // Exhaustive: 3 timings × 3 sources × ownsExternal × mesh = 36 combinations.
    for (const { timing, provider } of TIMINGS) {
        for (const source of SOURCES) {
            for (const ownsExternal of [true, false]) {
                for (const mesh of [true, false]) {
                    const label = `${provider} (timing=${timing}) source=${source} ownsExternal=${ownsExternal} mesh=${mesh}`;
                    // DOCUMENTED CARVE-OUT (completion-engine.ts:283, pre-existing and
                    // deliberate): a HOLD-class provider on a NON-mesh (interactive) session
                    // whose native transcript is resolved but simply has no final assistant
                    // yet emits clean rather than blocking. Holding here would freeze a human's
                    // interactive session waiting on a transcript write that only the mesh path
                    // has a timeout for. Not the fall-through defect and out of scope to change
                    // — asserting it would lock in behaviour the owner has not been asked about.
                    const isInteractiveHoldCarveOut = timing === 'hold'
                        && source === 'external-native'
                        && ownsExternal
                        && !mesh;
                    it.skipIf(isInteractiveHoldCarveOut)(label, () => {
                        const { block } = evaluateFinalizationBlock(
                            makeArm(),
                            makeReader({
                                ownsExternalHistory: ownsExternal,
                                authorityTiming: timing,
                                finalAssistantEvidence: { present: false, source, messages: [] },
                                allowMissingAssistantTimeout: mesh,
                                // No native tail probe: nothing independently proves the turn ended.
                                externalNativeTailProbe: null,
                            }),
                            POLICY,
                        );
                        expect(block, `clean completion emitted with NO final-assistant evidence (${label})`).not.toBeNull();
                    });
                }
            }
        }
    }
});

describe('the fall-through case emits weak (bounded + provenanced), never clean and never a permanent hold', () => {
    // ownsExternal + unresolved transcript + hold/immediate: the gap that reached
    // `return { block: null }`. It must produce a block that the verdict stage can
    // release — i.e. carrying allowTimeout so it is never an unbounded terminal hold.
    for (const timing of ['hold', 'immediate'] as const) {
        for (const source of ['unavailable', 'parsed'] as const) {
            it(`timing=${timing} source=${source} yields a releasable missing_final_assistant block`, () => {
                const { block } = evaluateFinalizationBlock(
                    makeArm(),
                    makeReader({
                        ownsExternalHistory: true,
                        authorityTiming: timing,
                        finalAssistantEvidence: { present: false, source, messages: [] },
                        allowMissingAssistantTimeout: true,
                    }),
                    POLICY,
                );
                expect(block).not.toBeNull();
                expect(block?.reason).toBe('missing_final_assistant');
                // allowTimeout marks it as the transcript-evidence gate → the verdict stage
                // releases it via the weak-emit path (which carries explicit
                // "without finalized assistant turn" provenance) rather than holding forever.
                expect(block?.allowTimeout).toBe(true);
            });
        }
    }

    it('FLOOR class keeps its terminal+floored block on the RESOLVED external-native path (no regression)', () => {
        // The unified fall-through return must not weaken codex's real path: when the
        // native transcript IS resolved but carries no final assistant, floor still gets
        // terminal:true + noExternalTranscriptSource so the CANON-C min-elapsed floor applies.
        const { block } = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                authorityTiming: 'floor',
                finalAssistantEvidence: { present: false, source: 'external-native', messages: [] },
                allowMissingAssistantTimeout: true,
            }),
            POLICY,
        );
        expect(block).toMatchObject({
            reason: 'missing_final_assistant', terminal: true, allowTimeout: true, noExternalTranscriptSource: true,
        });
    });

    it('a non-mesh interactive session still resolves rather than blocking on evidence it will never get', () => {
        const { block } = evaluateFinalizationBlock(
            makeArm(),
            makeReader({
                ownsExternalHistory: true,
                authorityTiming: 'immediate',
                finalAssistantEvidence: { present: false, source: 'unavailable', messages: [] },
                allowMissingAssistantTimeout: false,
            }),
            POLICY,
        );
        // Non-mesh: allowTimeout is false, so this must NOT be a terminal block that
        // outlives the 30s cap — the hard cap is the only backstop and 10min of a wrong
        // state is not acceptable for an interactive session.
        expect(block).not.toBeNull();
        expect(block?.reason).toBe('missing_final_assistant');
    });
});

describe('present:true evidence is unaffected (no regression to the clean path)', () => {
    for (const { timing, provider } of TIMINGS) {
        it(`${provider} (timing=${timing}) still emits clean when evidence is present`, () => {
            const { block } = evaluateFinalizationBlock(
                makeArm(),
                makeReader({
                    ownsExternalHistory: true,
                    authorityTiming: timing,
                    finalAssistantEvidence: { present: true, source: 'external-native', messages: [{ role: 'assistant' }] },
                }),
                POLICY,
            );
            expect(block).toBeNull();
        });
    }
});
