/**
 * Slot model enforcement — a model that is not declared on the node's capability
 * slots must never reach the launch arguments.
 *
 * Owner invariant: "a user explicitly configured a brain; a model they never
 * configured must not run. A model absent from the UI slots executing at all is
 * the defect." Whether it is actually billed is irrelevant.
 *
 * Owner-specified resolution — three branches, with 'busy' and 'absent' kept
 * strictly apart:
 *   1. declaring slot with capacity      → run
 *   2. declaring slot exists, all busy   → WAIT in the queue (transient, no page)
 *   3. no declaring slot at all          → NOTIFY the coordinator (permanent)
 *
 * Substituting another model is NOT allowed: silently downgrading to a model the
 * user never chose breaks the same principle as running an undeclared one.
 */
import { describe, expect, it } from 'vitest';
import {
    decideSlotForModel,
    isModelAllowedBySlot,
    modelNamesEquivalent,
    canonicalizeModelName,
    SLOT_MODEL_BUSY_SKIP_REASON,
    SLOT_MODEL_ABSENT_SKIP_REASON,
} from '../../src/mesh/slot-model-enforcement.js';
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';

const slot = (s: Partial<NodeCapabilitySlot> & { provider: string }): NodeCapabilitySlot =>
    ({ difficulty: [], capability: [], ...s }) as NodeCapabilitySlot;

/** Slot + capacity pair, the shape decideSlotForModel consumes. */
const avail = (s: NodeCapabilitySlot, available = true) => ({ slot: s, available });

describe('slot model enforcement', () => {
    describe('isModelAllowedBySlot', () => {
        it('allows the exact model the slot declares', () => {
            expect(isModelAllowedBySlot('sonnet', slot({ provider: 'claude-cli', model: 'sonnet' }))).toBe(true);
        });

        it('BLOCKS a model the slot does not declare (opus on a sonnet slot)', () => {
            expect(isModelAllowedBySlot('opus', slot({ provider: 'claude-cli', model: 'sonnet' }))).toBe(false);
        });

        it('treats an unspecified slot model as "provider default only"', () => {
            const s = slot({ provider: 'codex-cli' });
            expect(isModelAllowedBySlot(undefined, s)).toBe(true);
            expect(isModelAllowedBySlot('opus', s)).toBe(false);
        });

        it('matches alias and display forms of the same model', () => {
            const s = slot({ provider: 'antigravity-cli', model: 'Claude Opus 4.6 (Thinking)' });
            expect(isModelAllowedBySlot('opus', s)).toBe(true);
            expect(isModelAllowedBySlot('claude-opus-4-6', s)).toBe(true);
            expect(isModelAllowedBySlot('Claude Opus 4.6 (Thinking)', s)).toBe(true);
        });

        it('does NOT match a different family in display form', () => {
            const s = slot({ provider: 'antigravity-cli', model: 'Claude Sonnet 4.6 (Thinking)' });
            expect(isModelAllowedBySlot('opus', s)).toBe(false);
        });
    });

    describe('model name canonicalization (no raw string compare)', () => {
        it('canonicalizes every surface form of the same model identically', () => {
            expect(canonicalizeModelName('opus')?.family).toBe('opus');
            expect(canonicalizeModelName('claude-opus-4-6')).toMatchObject({ family: 'opus', version: '4.6' });
            expect(canonicalizeModelName('Claude Opus 4.6 (Thinking)')).toMatchObject({ family: 'opus', version: '4.6' });
        });

        it('treats the version-less preset alias as compatible with any version', () => {
            expect(modelNamesEquivalent('opus', 'Claude Opus 4.6 (Thinking)')).toBe(true);
        });

        it('does not equate different explicit versions or different families', () => {
            expect(modelNamesEquivalent('claude-opus-4-6', 'claude-opus-4-1')).toBe(false);
            expect(modelNamesEquivalent('opus', 'sonnet')).toBe(false);
        });

        it('falls back to a normalized literal compare for non-Claude models', () => {
            expect(modelNamesEquivalent('kimi-code/k3', 'kimi code k3')).toBe(true);
            expect(modelNamesEquivalent('gpt-5-codex', 'kimi-code/k3')).toBe(false);
        });

        it('never equates a Claude model with a non-Claude one', () => {
            expect(modelNamesEquivalent('opus', 'gpt-5-codex')).toBe(false);
        });
    });

    describe('decideSlotForModel — 1) run', () => {
        it('runs on a declaring slot that has capacity', () => {
            const s = slot({ provider: 'claude-cli', model: 'sonnet' });
            const d = decideSlotForModel({ requestedModel: 'sonnet', slots: [avail(s)] });
            expect(d.outcome).toBe('run');
            if (d.outcome === 'run') {
                expect(d.slot).toBe(s);
                expect(d.model).toBe('sonnet');
            }
        });

        it('passes no model for a model-less slot so the provider uses its default', () => {
            const d = decideSlotForModel({ requestedModel: undefined, slots: [avail(slot({ provider: 'codex-cli' }))] });
            expect(d.outcome).toBe('run');
            if (d.outcome === 'run') expect(d.model).toBeUndefined();
        });

        it('prefers a free declaring slot over a busy one', () => {
            const busy = slot({ provider: 'claude-cli', model: 'sonnet', maxParallel: 1 });
            const free = slot({ provider: 'kimi', model: 'sonnet' });
            const d = decideSlotForModel({ requestedModel: 'sonnet', slots: [avail(busy, false), avail(free, true)] });
            expect(d.outcome).toBe('run');
            if (d.outcome === 'run') expect(d.slot).toBe(free);
        });
    });

    describe('decideSlotForModel — 2) wait (transient)', () => {
        // ★ The slot EXISTS. Waiting resolves it, so the task must stay queued —
        // not be substituted onto another model and not be paged as a blocker.
        it('WAITS when the only declaring slot is at its cap', () => {
            const s = slot({ provider: 'claude-cli', model: 'sonnet', maxParallel: 1 });
            const d = decideSlotForModel({ requestedModel: 'sonnet', slots: [avail(s, false)] });
            expect(d.outcome).toBe('wait');
            if (d.outcome === 'wait') {
                expect(d.reason).toBe(SLOT_MODEL_BUSY_SKIP_REASON);
                expect(d.busySlots).toEqual([s]);
            }
        });

        it('waits rather than falling back to a different model that is free', () => {
            const busySonnet = slot({ provider: 'claude-cli', model: 'sonnet', maxParallel: 1 });
            const freeHaiku = slot({ provider: 'claude-cli', model: 'haiku' });
            const d = decideSlotForModel({
                requestedModel: 'sonnet',
                slots: [avail(busySonnet, false), avail(freeHaiku, true)],
            });
            expect(d.outcome).toBe('wait'); // NOT 'run' on haiku
        });
    });

    describe('decideSlotForModel — 3) notify (permanent)', () => {
        // ★ THE ORIGINAL DEFECT: difficult→opus preset on a sonnet-only node.
        it('NOTIFIES when no slot declares the model (opus on a sonnet-only node)', () => {
            const d = decideSlotForModel({
                requestedModel: 'opus',
                slots: [avail(slot({ provider: 'claude-cli', model: 'sonnet' }))],
            });
            expect(d.outcome).toBe('notify');
            if (d.outcome === 'notify') {
                expect(d.reason).toBe(SLOT_MODEL_ABSENT_SKIP_REASON);
                expect(d.declaredModels).toEqual(['sonnet']);
            }
        });

        it('notifies even when the non-declaring slots are idle (capacity is irrelevant)', () => {
            const d = decideSlotForModel({
                requestedModel: 'opus',
                slots: [avail(slot({ provider: 'claude-cli', model: 'sonnet' }), true)],
            });
            expect(d.outcome).toBe('notify');
        });

        it('reports a model-less slot as "(provider default)" in the guidance', () => {
            const d = decideSlotForModel({
                requestedModel: 'opus',
                slots: [avail(slot({ provider: 'codex-cli' }))],
            });
            expect(d.outcome).toBe('notify');
            if (d.outcome === 'notify') expect(d.declaredModels).toEqual(['(provider default)']);
        });

        it('notifies when the node has no slots at all', () => {
            const d = decideSlotForModel({ requestedModel: 'opus', slots: [] });
            expect(d.outcome).toBe('notify');
        });
    });

    describe('busy and absent are distinct outcomes', () => {
        it('the same model yields wait when a slot exists and notify when it does not', () => {
            const declaring = slot({ provider: 'claude-cli', model: 'opus', maxParallel: 1 });
            const notDeclaring = slot({ provider: 'claude-cli', model: 'sonnet', maxParallel: 1 });

            const busy = decideSlotForModel({ requestedModel: 'opus', slots: [avail(declaring, false)] });
            const absent = decideSlotForModel({ requestedModel: 'opus', slots: [avail(notDeclaring, false)] });

            expect(busy.outcome).toBe('wait');
            expect(absent.outcome).toBe('notify');
            expect(busy.outcome).not.toBe(absent.outcome);
        });
    });
});
