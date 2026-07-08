import { describe, it, expect } from 'vitest';
import { expandThinkingLaunchArgs, expandModelLaunchArgs } from '../../src/commands/cli-manager.js';

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
