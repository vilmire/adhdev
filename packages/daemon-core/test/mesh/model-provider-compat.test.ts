import { describe, expect, it } from 'vitest';
import {
    isAnthropicModel,
    isAnthropicProvider,
    isModelCompatibleWithProvider,
} from '../../src/mesh/model-provider-compat.js';
import { DEFAULT_DIFFICULTY_BRAINS } from '@adhdev/mesh-shared';

describe('model ↔ provider compatibility guard (codex 400 root)', () => {
    describe('isAnthropicModel', () => {
        it('recognizes the provider-agnostic brain-preset aliases as Anthropic', () => {
            expect(isAnthropicModel('opus')).toBe(true);
            expect(isAnthropicModel('sonnet')).toBe(true);
            expect(isAnthropicModel('haiku')).toBe(true);
            expect(isAnthropicModel('opus-4')).toBe(true);
            expect(isAnthropicModel('sonnet-4-5')).toBe(true);
        });

        it('recognizes explicit claude-*/anthropic ids (case-insensitive)', () => {
            expect(isAnthropicModel('claude-opus-4-8')).toBe(true);
            expect(isAnthropicModel('Claude-Sonnet')).toBe(true);
            expect(isAnthropicModel('anthropic/claude')).toBe(true);
        });

        it('does NOT flag non-Anthropic / unknown models', () => {
            expect(isAnthropicModel('gpt-5-codex')).toBe(false);
            expect(isAnthropicModel('gemini-2.5-pro')).toBe(false);
            expect(isAnthropicModel('opusculum')).toBe(false); // not a bare opus family
            expect(isAnthropicModel('')).toBe(false);
            expect(isAnthropicModel(undefined)).toBe(false);
            expect(isAnthropicModel(null)).toBe(false);
        });
    });

    describe('isAnthropicProvider', () => {
        it('treats only claude-cli as Anthropic-backed', () => {
            expect(isAnthropicProvider('claude-cli')).toBe(true);
            expect(isAnthropicProvider('Claude-CLI')).toBe(true);
        });
        it('treats codex/antigravity/hermes/gemini as non-Anthropic', () => {
            expect(isAnthropicProvider('codex-cli')).toBe(false);
            expect(isAnthropicProvider('antigravity-cli')).toBe(false);
            expect(isAnthropicProvider('hermes-cli')).toBe(false);
            expect(isAnthropicProvider('gemini-cli')).toBe(false);
            expect(isAnthropicProvider('')).toBe(false);
            expect(isAnthropicProvider(undefined)).toBe(false);
        });
    });

    describe('isModelCompatibleWithProvider — the invariant', () => {
        it('BLOCKS an Anthropic model on a non-Anthropic provider', () => {
            expect(isModelCompatibleWithProvider('opus', 'codex-cli')).toBe(false);
            expect(isModelCompatibleWithProvider('claude-opus-4-8', 'codex-cli')).toBe(false);
            expect(isModelCompatibleWithProvider('sonnet', 'antigravity-cli')).toBe(false);
            expect(isModelCompatibleWithProvider('haiku', 'hermes-cli')).toBe(false);
        });

        it('ALLOWS an Anthropic model on claude-cli', () => {
            expect(isModelCompatibleWithProvider('opus', 'claude-cli')).toBe(true);
            expect(isModelCompatibleWithProvider('claude-sonnet-4-6', 'claude-cli')).toBe(true);
        });

        it('ALLOWS non-Anthropic / unknown models on any provider (nothing legitimate stripped)', () => {
            expect(isModelCompatibleWithProvider('gpt-5-codex', 'codex-cli')).toBe(true);
            expect(isModelCompatibleWithProvider('gemini-2.5-pro', 'gemini-cli')).toBe(true);
            expect(isModelCompatibleWithProvider(undefined, 'codex-cli')).toBe(true);
            expect(isModelCompatibleWithProvider('', 'codex-cli')).toBe(true);
        });
    });

    describe('difficulty-preset scenario: codex-cli node never gets a claude model', () => {
        // The launch guard strips exactly the model a difficulty preset would have
        // forwarded. Prove that every Claude-family preset alias is refused on a
        // codex-cli node.
        //
        // These aliases are no longer SHIPPED (DEFAULT_DIFFICULTY_BRAINS is {} —
        // difficulty is a routing hint and the slot owns the model), so the list is
        // written out literally rather than read from that map, which would now make
        // the loop vacuous. The guard still matters: an operator may configure these
        // presets explicitly, and MAGI slots carry the same aliases.
        it('every Claude-family preset alias is blocked on codex-cli', () => {
            const presetModels = ['haiku', 'sonnet', 'opus'];
            // Any alias an operator could still configure must be covered.
            for (const slot of Object.values(DEFAULT_DIFFICULTY_BRAINS)) {
                if (slot?.model) expect(presetModels).toContain(slot.model);
            }
            for (const model of presetModels) {
                // A difficulty task resolves to `model`; on a codex-cli node the guard must
                // refuse it → effectiveModel dropped → codex launches with its own default.
                expect(isModelCompatibleWithProvider(model, 'codex-cli')).toBe(false);
                // The same preset model IS honored on a claude-cli node.
                expect(isModelCompatibleWithProvider(model, 'claude-cli')).toBe(true);
            }
        });
    });
});
