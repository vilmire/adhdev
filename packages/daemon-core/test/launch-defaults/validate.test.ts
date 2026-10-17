import { describe, expect, it } from 'vitest';
import { validateLaunchDefault, type LaunchProviderFacts, type LaunchRole,
    type LaunchValidationPorts, type ToolRestriction } from '../../src/launch-defaults/index.js';
import type { ModelDiscoverySnapshot } from '../../src/models/types.js';

function facts(patch: Partial<LaunchProviderFacts> = {}): LaunchProviderFacts {
    return { type: 'codex-cli', category: 'cli', enabled: true, detected: true,
        assistant: { supported: true, toolRestriction: 'prompt_only' }, coordinator: 'supported',
        modelLaunchArgs: ['--model', '{{model}}'], modelOptions: ['retired-model'],
        discovery: { provider: 'codex-cli', status: 'ok', models: [{ slug: 'gpt-current' }], updatedAt: 1, fetchedAt: 1 },
        thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'], ...patch };
}
function ports(patch: Partial<LaunchProviderFacts> = {}): LaunchValidationPorts {
    return { resolveAlias: value => value === 'codex' ? 'codex-cli' : value,
        getProvider: value => value === 'codex-cli' ? facts(patch) : undefined };
}

describe('launch selection schema', () => {
    it.each([
        ['null', null, 'provider'], ['array', [], 'provider'], ['missing provider', {}, 'provider'],
        ['blank provider', { provider: '' }, 'provider'], ['whitespace', { provider: ' codex-cli' }, 'provider'],
        ['control characters', { provider: 'codex-cli\n' }, 'provider'],
        ['unknown field', { provider: 'codex-cli', autoApprove: true }, 'provider'],
        ['legacy spelling', { cliType: 'codex-cli' }, 'provider'],
        ['null model', { provider: 'codex-cli', model: null }, 'model'],
        ['blank model', { provider: 'codex-cli', model: '' }, 'model'],
        ['long model', { provider: 'codex-cli', model: 'x'.repeat(513) }, 'model'],
        ['number thinking', { provider: 'codex-cli', thinkingLevel: 2 }, 'thinkingLevel'],
        ['null thinking', { provider: 'codex-cli', thinkingLevel: null }, 'thinkingLevel'],
    ])('rejects %s with the offending field', (_name, candidate, field) => {
        expect(validateLaunchDefault('assistant', candidate, ports())).toEqual({ ok: false,
            issue: { field, reason: 'invalid_schema' } });
    });
    it('canonicalizes an alias without mutating the caller selection', () => {
        const candidate = Object.freeze({ provider: 'codex', model: 'gpt-current', thinkingLevel: 'high' });
        expect(validateLaunchDefault('assistant', candidate, ports())).toEqual({ ok: true,
            selection: { ...candidate, provider: 'codex-cli' }, warnings: [], toolRestriction: 'prompt_only', lowersToolLock: false });
        expect(candidate.provider).toBe('codex');
    });
    it('does not fabricate model or thinking when omitted', () => {
        const result = validateLaunchDefault('coordinator', { provider: 'codex-cli' }, ports());
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result));
        expect(result.selection).toEqual({ provider: 'codex-cli' });
        expect(result.warnings).toEqual([]);
    });
    it('rejects roles outside assistant/coordinator', () => {
        expect(validateLaunchDefault('worker' as LaunchRole, { provider: 'codex-cli' }, ports()))
            .toMatchObject({ ok: false, issue: { reason: 'invalid_schema' } });
    });
});

describe('machine availability and role eligibility', () => {
    it.each([
        ['unknown', { provider: 'unknown-cli' }, {}, 'provider_unknown'],
        ['not a CLI', { provider: 'codex-cli' }, { category: 'ide' }, 'provider_not_cli'],
        ['disabled', { provider: 'codex-cli' }, { enabled: false }, 'provider_disabled'],
        ['not detected', { provider: 'codex-cli' }, { detected: false }, 'provider_not_detected'],
        ['assistant ineligible', { provider: 'codex-cli' }, { assistant: { supported: false, toolRestriction: 'prompt_only' } }, 'provider_not_eligible'],
    ] as const)('rejects %s without choosing another provider', (_name, selection, patch, reason) => {
        expect(validateLaunchDefault('assistant', selection, ports(patch))).toEqual({ ok: false,
            issue: { field: 'provider', reason } });
    });
    it('rejects coordinator-ineligible providers independently of assistant eligibility', () => {
        expect(validateLaunchDefault('coordinator', { provider: 'codex-cli' }, ports({ coordinator: 'unsupported' })))
            .toMatchObject({ ok: false, issue: { field: 'provider', reason: 'provider_not_eligible' } });
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli' }, ports({ coordinator: 'unsupported' })).ok).toBe(true);
    });
    it('allows manual coordinator setup with an explicit warning', () => {
        expect(validateLaunchDefault('coordinator', { provider: 'codex-cli' }, ports({ coordinator: 'manual' })))
            .toMatchObject({ ok: true, warnings: ['manual_mcp_setup_required'] });
    });
    it('does not trust a registry result with a different canonical type', () => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli' }, ports({ type: 'other-cli' })))
            .toMatchObject({ ok: false, issue: { reason: 'provider_unknown' } });
    });
    it.each(['resolveAlias', 'getProvider'] as const)('fails closed when %s cannot read provider facts', method => {
        const unavailable = ports();
        unavailable[method] = () => { throw new Error('catalog offline'); };
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli' }, unavailable))
            .toEqual({ ok: false, issue: { field: 'provider', reason: 'catalog_unavailable' } });
    });
});

describe('catalog and launch capability validation', () => {
    it('uses successful discovery as replacement, rejecting retired manifest models', () => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', model: 'retired-model' }, ports()))
            .toEqual({ ok: false, issue: { field: 'model', reason: 'model_not_offered', candidates: ['gpt-current'] } });
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', model: 'gpt-current' }, ports()).ok).toBe(true);
    });
    it('uses discovered picker labels for providers with a label-to-slug map', () => {
        const labeled = ports({ modelLaunchValueMap: { 'Old label': 'old-slug' },
            discovery: { provider: 'codex-cli', status: 'ok', models: [{ slug: 'new-slug', label: 'New label' }], updatedAt: 1, fetchedAt: 1 } });
        expect(validateLaunchDefault('coordinator', { provider: 'codex-cli', model: 'New label' }, labeled).ok).toBe(true);
        expect(validateLaunchDefault('coordinator', { provider: 'codex-cli', model: 'Old label' }, labeled))
            .toMatchObject({ ok: false, issue: { reason: 'model_not_offered', candidates: ['New label'] } });
    });
    it('fails loudly for an empty successful catalog instead of assuming manifest availability', () => {
        const discovery: ModelDiscoverySnapshot = { provider: 'codex-cli', status: 'ok', models: [], updatedAt: 1, fetchedAt: 1 };
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', model: 'retired-model' }, ports({ discovery })))
            .toEqual({ ok: false, issue: { field: 'model', reason: 'catalog_unavailable' } });
    });
    it.each([undefined, 'error', 'unavailable', 'not-supported'] as const)(
        'permits custom model with catalog_unverified when discovery is %s', status => {
            const discovery: ModelDiscoverySnapshot | undefined = status === undefined ? undefined
                : { provider: 'codex-cli', status, models: [], updatedAt: 1, fetchedAt: 1 };
            expect(validateLaunchDefault('coordinator', { provider: 'codex-cli', model: 'custom-model' }, ports({ discovery })))
                .toMatchObject({ ok: true, selection: { model: 'custom-model' }, warnings: ['catalog_unverified'] });
        });
    it.each(['opus', 'sonnet', 'haiku', 'claude-opus-4', 'anthropic/model'])('rejects cross-provider model %s', model => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', model }, ports()))
            .toEqual({ ok: false, issue: { field: 'model', reason: 'model_provider_mismatch' } });
    });
    it('allows Claude aliases on the Claude provider while reporting discovery uncertainty', () => {
        const claude: LaunchValidationPorts = { resolveAlias: p => p,
            getProvider: type => facts({ type, discovery: undefined }) };
        expect(validateLaunchDefault('assistant', { provider: 'claude-cli', model: 'opus' }, claude))
            .toMatchObject({ ok: true, selection: { model: 'opus' }, warnings: ['catalog_unverified'] });
    });
    it.each([undefined, []])('refuses model when model launch arguments are %j', modelLaunchArgs => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', model: 'gpt-current' }, ports({ modelLaunchArgs })))
            .toEqual({ ok: false, issue: { field: 'model', reason: 'model_unsupported' } });
    });
    it('does not silently drop unsupported thinking', () => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', thinkingLevel: 'high' }, ports({ thinkingLaunchArgs: [] })))
            .toEqual({ ok: false, issue: { field: 'thinkingLevel', reason: 'thinking_unsupported' } });
    });
    it('permits declared runtime thinking while enforcing the offered levels', () => {
        const runtime = ports({ thinkingLaunchArgs: undefined, runtimeThinking: true });
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', thinkingLevel: 'high' }, runtime))
            .toMatchObject({ ok: true, selection: { thinkingLevel: 'high' } });
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', thinkingLevel: 'max' }, runtime))
            .toEqual({ ok: false, issue: { field: 'thinkingLevel', reason: 'thinking_not_offered', candidates: ['low', 'high'] } });
    });
    it('rejects thinking without a catalog of levels', () => {
        expect(validateLaunchDefault('assistant', { provider: 'codex-cli', thinkingLevel: 'high' }, ports({ thinkingLevelOptions: undefined })))
            .toEqual({ ok: false, issue: { field: 'thinkingLevel', reason: 'thinking_not_offered', candidates: [] } });
    });
});

describe('pre-write tool-lock information', () => {
    it.each([
        ['assistant', 'enforced', 'prompt_only', true],
        ['assistant', 'prompt_only', 'prompt_only', false],
        ['assistant', 'enforced', 'enforced', false],
        ['assistant', undefined, 'prompt_only', false],
        ['coordinator', 'enforced', 'prompt_only', false],
    ] as const)('%s: %s to %s reports downgrade=%s', (role, previous, next, downgrade) => {
        expect(validateLaunchDefault(role, { provider: 'codex-cli' },
            ports({ assistant: { supported: true, toolRestriction: next } }), previous as ToolRestriction | undefined))
            .toMatchObject({ ok: true, toolRestriction: next, lowersToolLock: downgrade });
    });
});
