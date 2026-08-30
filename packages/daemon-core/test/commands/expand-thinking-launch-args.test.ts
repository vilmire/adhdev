import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandThinkingLaunchArgs, expandModelLaunchArgs } from '../../src/commands/cli-manager.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANTIGRAVITY_MANIFEST = resolve(HERE, '../../../../../adhdev-providers/cli/antigravity-cli/provider.v1.json');
const ANTIGRAVITY_MODELS = resolve(HERE, '../../../../../adhdev-providers/tests/fixtures/antigravity-models.txt');

describe('expandModelLaunchArgs (brain-routing model axis)', () => {
    it('substitutes {{model}} as a standalone token (claude form)', () => {
        expect(expandModelLaunchArgs(['--model', '{{model}}'], 'haiku'))
            .toEqual(['--model', 'haiku']);
    });

    it('substitutes {{model}} INSIDE a token (codex -c model= form) — the regression', () => {
        // This is the bug fixed: the old `part === "{{model}}"` exact-match left
        // codex's `model={{model}}` unexpanded.
        expect(expandModelLaunchArgs(['-c', 'model={{model}}'], 'gpt-5-codex'))
            .toEqual(['-c', 'model=gpt-5-codex']);
    });

    it('returns undefined for no template or no model (no-op)', () => {
        expect(expandModelLaunchArgs(undefined, 'haiku')).toBeUndefined();
        expect(expandModelLaunchArgs([], 'haiku')).toBeUndefined();
        expect(expandModelLaunchArgs(['--model', '{{model}}'], undefined)).toBeUndefined();
        expect(expandModelLaunchArgs(['--model', '{{model}}'], '  ')).toBeUndefined();
    });

    it('trims the model', () => {
        expect(expandModelLaunchArgs(['--model', '{{model}}'], '  opus  '))
            .toEqual(['--model', 'opus']);
    });

    it.skipIf(!existsSync(ANTIGRAVITY_MANIFEST) || !existsSync(ANTIGRAVITY_MODELS))(
        'maps the real Antigravity display label to the slug measured from agy models', () => {
            const provider = JSON.parse(readFileSync(ANTIGRAVITY_MANIFEST, 'utf8'));
            const modelsOutput = readFileSync(ANTIGRAVITY_MODELS, 'utf8');
            expect(modelsOutput).toContain('gemini-3.7-flash-high     Gemini 3.7 Flash (High)');
            expect(expandModelLaunchArgs(
                provider.modelLaunchArgs,
                'Gemini 3.7 Flash (High)',
                provider.modelLaunchValueMap,
            )).toEqual(['--model', 'gemini-3.7-flash-high']);
        },
    );
});

describe('expandThinkingLaunchArgs (brain-routing thinking axis)', () => {
    it('substitutes {{level}} in every template token', () => {
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], 'high', undefined))
            .toEqual(['--effort', 'high']);
    });

    it('substitutes {{level}} inside a larger token (codex -c form)', () => {
        expect(expandThinkingLaunchArgs(['-c', 'model_reasoning_effort={{level}}'], 'medium', undefined))
            .toEqual(['-c', 'model_reasoning_effort=medium']);
    });

    it('maps the standard level through thinkingLevelMap when present', () => {
        // A provider whose "high" is its own "xhigh".
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], 'high', { high: 'xhigh' }))
            .toEqual(['--effort', 'xhigh']);
    });

    it('passes a level through unchanged when the map lacks it', () => {
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], 'low', { high: 'xhigh' }))
            .toEqual(['--effort', 'low']);
    });

    it('returns undefined for no template (no-op, never fails launch)', () => {
        expect(expandThinkingLaunchArgs(undefined, 'high', undefined)).toBeUndefined();
        expect(expandThinkingLaunchArgs([], 'high', undefined)).toBeUndefined();
    });

    it('returns undefined for no/blank level', () => {
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], undefined, undefined)).toBeUndefined();
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], '  ', undefined)).toBeUndefined();
    });

    it('trims the level', () => {
        expect(expandThinkingLaunchArgs(['--effort', '{{level}}'], '  high  ', undefined))
            .toEqual(['--effort', 'high']);
    });
});
