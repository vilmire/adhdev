/**
 * PROVIDER PAIRING regression — the SLOT MODEL GUARD returns a (slot, model)
 * PAIR, and the launch path must spawn both halves of the same pair.
 *
 * THE DEFECT: the assignment path resolved the provider first
 * (resolveUsableProvider → resolved.providerType, which is what launch_cli
 * actually spawns), then called decideSlotForModel over EVERY slot on the node
 * with no provider filter, and harvested only `.model` from the result. So a
 * node holding a claude-cli/opus slot handed `opus` back for a grok-cli launch:
 * a (provider, model) pair no operator ever declared.
 *
 * NOT A RACE — deterministic. `resolved` and the slot decision are consecutive
 * synchronous reads of the same node object with no await between them, so any
 * `difficult` task landing on a node with a claude slot and resolving to a
 * non-claude provider reproduced it every time.
 *
 * THE DOWNSTREAM DAMAGE is where it actually bites, and it is not the launch
 * arg. The borrowed model becomes routingDecision.resolvedModel → the claim's
 * `assignedModel` → allowedClassifiedDifficultiesForSession(node, slots,
 * 'grok-cli', 'opus'), which filters grok's slots by a model none of them
 * declare, returns [], and fails every classified task's difficulty floor.
 * It also leaves `claimingSlot` undefined, which silently drops the per-slot
 * maxParallel cap entirely.
 *
 * THE CODEX-400 GUARD IS NOT A DEFENCE. It runs AFTER the substitution and only
 * strips Anthropic models sent to non-Anthropic providers, so it happens to hide
 * the opus→grok case while letting any substitution BETWEEN two non-Anthropic
 * providers through untouched. The non-Anthropic test below pins that the fix
 * does not lean on it.
 */
import { describe, expect, it } from 'vitest';
import {
    decideSlotForModel,
    finalizeSlotSelection,
    SLOT_MODEL_BUSY_SKIP_REASON,
    SLOT_MODEL_ABSENT_SKIP_REASON,
} from '../../src/mesh/slot-model-enforcement.js';
import { allowedClassifiedDifficultiesForSession, taskMeetsSessionDifficultyFloor } from '../../src/mesh/mesh-difficulty-floor.js';
import { isModelAllowedBySlot } from '../../src/mesh/slot-model-enforcement.js';
import { resolveSlotMaxParallel } from '../../src/repo-mesh-types.js';
import { buildAutoLaunchRoutingDecision } from '../../src/mesh/mesh-routing-decision.js';
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';

const slot = (s: Partial<NodeCapabilitySlot> & { provider: string }): NodeCapabilitySlot =>
    ({ difficulty: [], capability: [], ...s }) as NodeCapabilitySlot;

const avail = (s: NodeCapabilitySlot, available = true) => ({ slot: s, available });

/**
 * Today's incident shape: a node that offers claude-cli/opus for difficult work
 * AND a grok-cli slot. A difficult task presets model 'opus'; provider selection
 * (quota, fitness) picks grok-cli.
 */
const CLAUDE_OPUS = slot({ provider: 'claude-cli', model: 'opus', difficulty: ['easy', 'medium', 'difficult'], maxParallel: 1 });
const GROK = slot({ provider: 'grok-cli', model: 'grok-4.6', difficulty: ['easy', 'medium', 'difficult'], maxParallel: 2 });

describe('SLOT MODEL GUARD — provider pairing', () => {
    describe("today's regression: winner provider keeps its own model", () => {
        it('does not hand a claude slot model to a grok launch', () => {
            const d = decideSlotForModel({
                requestedModel: 'opus',
                providerType: 'grok-cli',
                slots: [avail(CLAUDE_OPUS), avail(GROK)],
            });
            // The pair must be internally consistent: whatever slot comes back,
            // it must belong to the provider that will actually be spawned.
            if (d.outcome === 'run') {
                expect(d.slot.provider).toBe('grok-cli');
                expect(d.model).not.toBe('opus');
            }
            // grok declares no 'opus' slot, so this is an honest absence.
            expect(d.outcome).toBe('notify');
            if (d.outcome === 'notify') {
                expect(d.reason).toBe(SLOT_MODEL_ABSENT_SKIP_REASON);
                // The reported declared-models list must describe the WINNER's
                // slots, not the whole node — otherwise the coordinator is told
                // 'opus' is available on a provider that cannot run it.
                expect(d.declaredModels).toEqual(['grok-4.6']);
                expect(d.declaredModels).not.toContain('opus');
            }
        });

        it('INJECTION: without the provider filter the pair breaks (the old behaviour)', () => {
            // Exactly the pre-fix call — no providerType. This is the defect,
            // asserted so the regression is unambiguous: the guard returns a
            // claude slot while the launch would spawn grok-cli.
            const unscoped = decideSlotForModel({
                requestedModel: 'opus',
                slots: [avail(CLAUDE_OPUS), avail(GROK)],
            });
            expect(unscoped.outcome).toBe('run');
            if (unscoped.outcome === 'run') {
                expect(unscoped.slot.provider).toBe('claude-cli'); // ← foreign provider
                expect(unscoped.model).toBe('opus');               // ← the model that got harvested
            }
        });

        it('runs on the winner when the winner itself declares the model', () => {
            const d = decideSlotForModel({
                requestedModel: 'grok-4.6',
                providerType: 'grok-cli',
                slots: [avail(CLAUDE_OPUS), avail(GROK)],
            });
            expect(d.outcome).toBe('run');
            if (d.outcome === 'run') {
                expect(d.slot.provider).toBe('grok-cli');
                expect(d.model).toBe('grok-4.6');
            }
        });
    });

    describe('notify/wait now fire honestly for the winning provider', () => {
        it("wait: the winner's declaring slot is at cap — a FREE foreign slot must not mask it", () => {
            // The masking only bites when the foreign slot ALSO satisfies the
            // model check, which is what makes the unscoped filter dangerous:
            // two providers can declare the same model string. Here both
            // declare 'shared-m'; grok (the winner) is full, codex is free.
            // Pre-fix, codex's free slot answered "yes, a declaring slot has
            // capacity" and the task launched on grok anyway — the wait branch
            // never fired even though the slot that would actually run it was
            // at its cap.
            const grokBusy = slot({ provider: 'grok-cli', model: 'shared-m', maxParallel: 1 });
            const codexFree = slot({ provider: 'codex-cli', model: 'shared-m', maxParallel: 1 });
            const d = decideSlotForModel({
                requestedModel: 'shared-m',
                providerType: 'grok-cli',
                slots: [avail(codexFree, true), avail(grokBusy, false)],
            });
            expect(d.outcome).toBe('wait');
            if (d.outcome === 'wait') {
                expect(d.reason).toBe(SLOT_MODEL_BUSY_SKIP_REASON);
                expect(d.busySlots.every(s => s.provider === 'grok-cli')).toBe(true);
            }
        });

        it('INJECTION: unscoped, a free foreign slot masks the wait and the task launches', () => {
            const grokBusy = slot({ provider: 'grok-cli', model: 'shared-m', maxParallel: 1 });
            const codexFree = slot({ provider: 'codex-cli', model: 'shared-m', maxParallel: 1 });
            const unscoped = decideSlotForModel({
                requestedModel: 'shared-m',
                slots: [avail(codexFree, true), avail(grokBusy, false)],
            });
            expect(unscoped.outcome).toBe('run');
            if (unscoped.outcome === 'run') expect(unscoped.slot.provider).toBe('codex-cli');
        });

        it('notify: the winning provider has no slot at all', () => {
            const d = decideSlotForModel({
                requestedModel: 'opus',
                providerType: 'codex-cli',
                slots: [avail(CLAUDE_OPUS), avail(GROK)],
            });
            expect(d.outcome).toBe('notify');
            if (d.outcome === 'notify') expect(d.declaredModels).toEqual([]);
        });

        it("wait vs notify stay distinct within the winner's own slots", () => {
            const busyGrok = slot({ provider: 'grok-cli', model: 'grok-4.6', maxParallel: 1 });
            const otherGrok = slot({ provider: 'grok-cli', model: 'grok-3', maxParallel: 1 });
            const wait = decideSlotForModel({
                requestedModel: 'grok-4.6', providerType: 'grok-cli',
                slots: [avail(busyGrok, false), avail(otherGrok, true)],
            });
            expect(wait.outcome).toBe('wait'); // declared but full — transient, no page
            const notify = decideSlotForModel({
                requestedModel: 'grok-9', providerType: 'grok-cli',
                slots: [avail(busyGrok, true), avail(otherGrok, true)],
            });
            expect(notify.outcome).toBe('notify'); // never declared — permanent
        });

        it('omitting providerType keeps the unscoped behaviour for callers that have not picked one', () => {
            const d = decideSlotForModel({ requestedModel: 'opus', slots: [avail(CLAUDE_OPUS), avail(GROK)] });
            expect(d.outcome).toBe('run');
        });
    });

    describe('non-Anthropic ↔ non-Anthropic: the CODEX-400 guard cannot help here', () => {
        // The guard drops a model only when it is a Claude model AND the provider
        // is not Anthropic-backed. Two non-Anthropic providers slip past it
        // entirely, so the pairing fix must stand on its own.
        const CODEX = slot({ provider: 'codex-cli', model: 'gpt-5.6-sol', difficulty: ['difficult'] });
        const GROK_ONLY = slot({ provider: 'grok-cli', model: 'grok-4.6', difficulty: ['difficult'] });

        it("does not hand codex's model to a grok launch", () => {
            const d = decideSlotForModel({
                requestedModel: 'gpt-5.6-sol',
                providerType: 'grok-cli',
                slots: [avail(CODEX), avail(GROK_ONLY)],
            });
            expect(d.outcome).toBe('notify');
            if (d.outcome === 'notify') expect(d.declaredModels).toEqual(['grok-4.6']);
        });

        it('INJECTION: unscoped, the codex model is harvested for the grok launch', () => {
            const unscoped = decideSlotForModel({
                requestedModel: 'gpt-5.6-sol',
                slots: [avail(CODEX), avail(GROK_ONLY)],
            });
            expect(unscoped.outcome).toBe('run');
            if (unscoped.outcome === 'run') {
                expect(unscoped.slot.provider).toBe('codex-cli');
                expect(unscoped.model).toBe('gpt-5.6-sol');
            }
        });
    });

    describe('downstream: difficulty floor and per-slot cap', () => {
        const NODE = { policy: { slots: [CLAUDE_OPUS, GROK] } };
        const SLOTS = [CLAUDE_OPUS, GROK];

        it('a poisoned model empties the allowance and fails every classified floor', () => {
            // The pre-fix state: provider grok-cli carrying claude's 'opus'.
            const poisoned = allowedClassifiedDifficultiesForSession(NODE, SLOTS, 'grok-cli', 'opus');
            expect(poisoned).toEqual([]);
            for (const difficulty of ['easy', 'medium', 'difficult'] as const) {
                expect(taskMeetsSessionDifficultyFloor({ difficulty }, poisoned)).toBe(false);
            }
        });

        it('the paired model keeps the allowance non-empty and admits difficult work', () => {
            const paired = allowedClassifiedDifficultiesForSession(NODE, SLOTS, 'grok-cli', 'grok-4.6');
            expect(paired).toEqual(['easy', 'medium', 'difficult']);
            expect(taskMeetsSessionDifficultyFloor({ difficulty: 'difficult' }, paired)).toBe(true);
        });

        it('the per-slot maxParallel cap survives only when the pair holds', () => {
            // claimingSlot is found by (provider matches) AND (model allowed by slot).
            const findClaimingSlot = (providerType: string, assignedModel?: string) =>
                SLOTS.find(s => s.provider?.trim() === providerType && isModelAllowedBySlot(assignedModel, s));

            // Poisoned: no grok slot declares opus → claimingSlot undefined →
            // slotMaxParallel undefined → the cap is silently not applied.
            const poisonedSlot = findClaimingSlot('grok-cli', 'opus');
            expect(poisonedSlot).toBeUndefined();

            // Paired: the grok slot is found and its cap of 2 is enforced.
            const pairedSlot = findClaimingSlot('grok-cli', 'grok-4.6');
            expect(pairedSlot).toBeDefined();
            expect(resolveSlotMaxParallel(SLOTS, 'grok-cli', pairedSlot!.model, isModelAllowedBySlot)).toBe(2);
        });
    });

    describe('finalizeSlotSelection — demotion bookkeeping', () => {
        // Extracted from the assignment loop; pinned here so the extraction is
        // behaviour-preserving and the two demotion reasons stay distinguishable.
        it('no demotion when the guard settles on the winning slot', () => {
            const f = finalizeSlotSelection({
                winningSlot: GROK, decidedSlot: GROK, decidedModel: 'grok-4.6', winningSlotHasCapacity: true,
            });
            expect(f.demoted).toBe(false);
            expect(f.demotionReason).toBeUndefined();
            expect(f.model).toBe('grok-4.6');
        });

        it('model-only move still counts as a demotion', () => {
            const other = slot({ provider: 'grok-cli', model: 'grok-3' });
            const f = finalizeSlotSelection({
                winningSlot: GROK, decidedSlot: other, decidedModel: 'grok-3', winningSlotHasCapacity: false,
            });
            expect(f.demoted).toBe(true);
            expect(f.demotionReason).toBe('winning_slot_capacity_exhausted');
        });

        it('winning slot still had capacity → reselected, not exhausted', () => {
            const other = slot({ provider: 'grok-cli', model: 'grok-3' });
            const f = finalizeSlotSelection({
                winningSlot: GROK, decidedSlot: other, decidedModel: 'grok-3', winningSlotHasCapacity: true,
            });
            expect(f.demotionReason).toBe('slot_reselected_during_launch');
        });

        it('a model-less finalized slot launches with no model', () => {
            const bare = slot({ provider: 'grok-cli' });
            const f = finalizeSlotSelection({
                winningSlot: bare, decidedSlot: bare, decidedModel: undefined, winningSlotHasCapacity: true,
            });
            expect(f.model).toBeUndefined();
            expect(f.demoted).toBe(false);
        });
    });

    describe('ledger consistency: executedSlot describes what actually ran', () => {
        const resolved = {
            providerType: 'claude-cli',
            slot: slot({ provider: 'claude-cli', model: 'opus' }),
            selectionTrajectory: {
                candidates: [], quotaOrder: [],
                providerWinner: { providerType: 'claude-cli', model: 'opus', fitnessScore: 1 },
            },
        } as any;

        const finalizationFor = (executedSlot: NodeCapabilitySlot) =>
            (buildAutoLaunchRoutingDecision({
                node: { policy: { slots: [] } },
                meshId: 'mesh_pairing_ledger',
                task: { difficulty: 'difficult' } as any,
                resolved,
                skippedCandidates: [],
                requiredTagsResult: { required: [], satisfied: true, missing: [] },
                executedSlot,
                demotionReason: 'winning_slot_capacity_exhausted',
            }).selectionTrajectory as any).slotFinalization;

        it('model-only demote reports the executed provider from the executed slot', () => {
            // Same provider, different model. Pre-fix this took the
            // `sameDeclaredProvider` branch and echoed the WINNING provider —
            // harmless while the providers agree, but it encoded the false
            // assumption that provider and model always move together.
            const f = finalizationFor(slot({ provider: 'claude-cli', model: 'sonnet' }));
            expect(f.demoted).toBe(true);
            expect(f.executedSlot).toEqual({ providerType: 'claude-cli', model: 'sonnet' });
            expect(f.winningSlot).toEqual({ providerType: 'claude-cli', model: 'opus' });
        });

        it('provider demote reports the provider that actually ran, never the winner', () => {
            const f = finalizationFor(slot({ provider: 'grok-cli', model: 'grok-4.6' }));
            expect(f.demoted).toBe(true);
            expect(f.executedSlot).toEqual({ providerType: 'grok-cli', model: 'grok-4.6' });
            expect(f.executedSlot.providerType).not.toBe(f.winningSlot.providerType);
        });

        it('no demote leaves both halves equal', () => {
            const f = finalizationFor(slot({ provider: 'claude-cli', model: 'opus' }));
            expect(f.demoted).toBe(false);
            expect(f.executedSlot).toEqual(f.winningSlot);
        });

        it('reports the executed slot even when resolved.providerType disagrees with it', () => {
            // THE PAIRING BUG'S LEDGER SIGNATURE, and the only shape that
            // separates the two formulations. `resolved.providerType` is what
            // launch_cli spawns (grok-cli); the winning and executed SLOTS both
            // carry claude-cli. The old form keyed off `winningSlot.provider ===
            // executedSlot.provider` — true here — and therefore substituted
            // `resolved.providerType`, printing executedSlot.providerType as
            // 'grok-cli' while executedSlot.model stayed claude's 'opus': the
            // two halves of one recorded slot describing different providers.
            // That is exactly the self-contradicting entry seen in the live
            // ledger (executedSlot: claude-cli alongside resolvedProviderType:
            // grok-cli). Deriving both halves from executedSlot makes the
            // record internally consistent whatever the launch path did.
            const mismatched = {
                providerType: 'grok-cli',
                slot: slot({ provider: 'claude-cli', model: 'opus' }),
                selectionTrajectory: {
                    candidates: [], quotaOrder: [],
                    providerWinner: { providerType: 'grok-cli', model: 'opus', fitnessScore: 1 },
                },
            } as any;
            const f = (buildAutoLaunchRoutingDecision({
                node: { policy: { slots: [] } },
                meshId: 'mesh_pairing_ledger_mismatch',
                task: { difficulty: 'difficult' } as any,
                resolved: mismatched,
                skippedCandidates: [],
                requiredTagsResult: { required: [], satisfied: true, missing: [] },
                executedSlot: slot({ provider: 'claude-cli', model: 'sonnet' }),
                demotionReason: 'slot_reselected_during_launch',
            }).selectionTrajectory as any).slotFinalization;

            expect(f.demoted).toBe(true);
            // Both halves come from the executed slot — no borrowed provider.
            expect(f.executedSlot).toEqual({ providerType: 'claude-cli', model: 'sonnet' });
            expect(f.executedSlot.providerType).not.toBe('grok-cli');
        });
    });
});
