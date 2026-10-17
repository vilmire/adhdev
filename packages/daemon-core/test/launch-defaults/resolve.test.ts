import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchDefaultsStore, resolveLaunchSelection, type LaunchDefaultsRead,
    type LaunchField, type LaunchProviderFacts, type LaunchValidationPorts,
    type ResolveLaunchInput } from '../../src/launch-defaults/index.js';

function ports(patch: Partial<LaunchProviderFacts> = {}): LaunchValidationPorts {
    return { resolveAlias: p => p === 'claude' ? 'claude-cli' : p,
        getProvider: type => ['claude-cli', 'codex-cli'].includes(type) ? {
            type, category: 'cli', enabled: true, detected: true,
            assistant: { supported: true, toolRestriction: type === 'claude-cli' ? 'enforced' : 'prompt_only' },
            coordinator: 'supported', modelLaunchArgs: ['--model', '{{model}}'],
            thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'], ...patch,
        } : undefined };
}
function snapshot(): LaunchDefaultsRead & { status: 'ok' } {
    return { status: 'ok', document: { version: 1, revision: 9, history: [],
        assistant: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', revision: 3, setBy: 'owner', setAt: 1 },
        coordinator: { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'low', revision: 7, setBy: 'owner', setAt: 2 } } };
}
function resolve(patch: Partial<ResolveLaunchInput> = {}, validation = ports()) {
    return resolveLaunchSelection({ role: 'assistant', stored: snapshot(), ...patch }, validation);
}
function success(patch: Partial<ResolveLaunchInput> = {}, validation = ports()) {
    const result = resolve(patch, validation);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
}

describe('explicit setup and fail-loud state', () => {
    it.each(['assistant', 'coordinator'] as const)('requires setup for %s even with a complete explicit override', role => {
        expect(resolve({ role, stored: { status: 'missing', reason: 'not_created' },
            override: { provider: 'codex-cli', model: 'gpt', thinkingLevel: 'low' } }))
            .toMatchObject({ ok: false, code: 'launch_default_required', role, field: 'provider', reason: 'not_created' });
    });
    it.each(['unreadable', 'invalid'] as const)('does not bypass %s disk with explicit args', status => {
        expect(resolve({ stored: { status, reason: 'bad_disk' }, override: { provider: 'codex-cli' } }))
            .toMatchObject({ ok: false, code: 'launch_default_unavailable', reason: 'bad_disk' });
    });
    it('rejects an invalid document even when a caller labels the snapshot ok', () => {
        const stored = snapshot();
        Object.assign(stored.document, { version: 2 });
        expect(resolve({ stored, override: { provider: 'codex-cli' } }))
            .toMatchObject({ code: 'launch_default_unavailable', reason: 'launch_defaults_schema_invalid' });
    });
    it.each(['assistant', 'coordinator'] as const)('does not invent a provider for an unset %s role', role => {
        const stored = snapshot();
        delete stored.document[role];
        expect(resolve({ role, stored })).toMatchObject({ code: 'launch_default_required', reason: 'role_default_unset' });
    });
    it.each([
        [{ enabled: false }, 'provider_disabled'], [{ detected: false }, 'provider_not_detected'],
        [{ assistant: { supported: false, toolRestriction: 'prompt_only' } }, 'provider_not_eligible'],
    ] as const)('fails loudly for unavailable stored provider %j', (patch, reason) => {
        expect(resolve({}, ports(patch))).toMatchObject({ ok: false, code: 'launch_default_unavailable',
            role: 'assistant', field: 'provider', source: 'stored_default', value: 'claude-cli', reason,
            defaultRef: { role: 'assistant', scope: 'global', revision: 3 } });
    });
    it('reports an unknown explicit provider as invalid rather than falling through', () => {
        expect(resolve({ override: { provider: 'unknown-cli' } })).toMatchObject({ ok: false,
            code: 'launch_selection_invalid', field: 'provider', value: 'unknown-cli', source: 'user', reason: 'provider_unknown' });
    });
    it('uses a usable explicit provider even when the saved provider is unavailable', () => {
        const validation = ports();
        const original = validation.getProvider;
        validation.getProvider = p => p === 'claude-cli' ? { ...original(p)!, enabled: false } : original(p);
        expect(success({ override: { provider: 'codex-cli' } }, validation).selection).toEqual({ provider: 'codex-cli' });
    });
    it.each([null, { provider: '' }, { model: null }, { thinkingLevel: '' }, { cliType: 'codex-cli' }])(
        'refuses malformed explicit selection %j', override => {
            expect(resolve({ override: override as ResolveLaunchInput['override'] }))
                .toMatchObject({ code: 'launch_selection_invalid', reason: 'invalid_schema', source: 'user' });
        });
});

describe('role and axis provenance', () => {
    it.each(['assistant', 'coordinator'] as const)('records %s entry revision separately from document revision', role => {
        const expected = snapshot().document[role]!;
        const result = success({ role });
        const ref = { role, scope: 'global', revision: expected.revision };
        expect(result.selection).toEqual({ provider: expected.provider, model: expected.model, thinkingLevel: expected.thinkingLevel });
        expect(result.documentRevision).toBe(9);
        expect(result.defaultRef).toEqual(ref);
        for (const field of ['provider', 'model', 'thinkingLevel'] as const) {
            expect(result.applied[field]).toEqual({ value: expected[field], source: 'stored_default', defaultRef: ref });
        }
    });
    it.each(['assistant', 'coordinator'] as const)('marks every fully explicit %s axis as user and claims no default reference', role => {
        const override = { provider: 'codex-cli', model: 'gpt', thinkingLevel: 'high' };
        const result = success({ role, override });
        expect(result.selection).toEqual(override);
        expect(result.defaultRef).toBeUndefined();
        expect(result.documentRevision).toBe(9);
        for (const field of ['provider', 'model', 'thinkingLevel'] as const) {
            expect(result.applied[field]).toEqual({ value: override[field], source: 'user' });
        }
    });
    it.each(['model', 'thinkingLevel'] as const)('inherits untouched axes when only %s is explicit', field => {
        const value = field === 'model' ? 'custom-model' : 'low';
        const result = success({ override: { [field]: value } });
        expect(result.applied[field]).toEqual({ value, source: 'user' });
        expect(result.applied.provider.source).toBe('stored_default');
        const inherited = field === 'model' ? 'thinkingLevel' : 'model';
        expect(result.applied[inherited].source).toBe('stored_default');
        expect(result.selection[inherited]).toBe(snapshot().document.assistant![inherited]);
    });
    it('inherits axes for an explicit alias of the same provider', () => {
        const result = success({ override: { provider: 'claude' } });
        expect(result.selection).toEqual({ provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' });
        expect(result.applied.provider).toEqual({ value: 'claude-cli', source: 'user' });
        expect(result.applied.model.source).toBe('stored_default');
    });
    it.each(['assistant', 'coordinator'] as const)('drops both inherited axes when %s changes provider', role => {
        const result = success({ role, override: { provider: 'codex-cli' } });
        expect(result.selection).toEqual({ provider: 'codex-cli' });
        expect(result.applied.model).toEqual({ value: null, source: 'provider_default' });
        expect(result.applied.thinkingLevel).toEqual({ value: null, source: 'provider_default' });
        expect(result.defaultRef).toBeUndefined();
    });
    it('does not strip an incompatible explicit model to make a launch succeed', () => {
        expect(resolve({ override: { provider: 'codex-cli', model: 'opus' } }))
            .toMatchObject({ code: 'launch_selection_invalid', field: 'model', source: 'user', value: 'opus', reason: 'model_provider_mismatch' });
    });
    it('attributes a no-longer-offered stored model to its default revision', () => {
        expect(resolve({}, ports({ discovery: { provider: 'claude-cli', status: 'ok',
            models: [{ slug: 'sonnet' }], updatedAt: 1, fetchedAt: 1 } })))
            .toMatchObject({ code: 'launch_default_unavailable', field: 'model', source: 'stored_default',
                value: 'opus', reason: 'model_not_offered', candidates: ['sonnet'],
                defaultRef: { scope: 'global', revision: 3 } });
    });
});

describe('trusted host project override', () => {
    const project = { projectId: 'host-project', revision: 12,
        selection: { provider: 'codex-cli', model: 'gpt', thinkingLevel: 'high' } };
    it('wins over the stored coordinator triple and records host project provenance', () => {
        const result = success({ role: 'coordinator', hostCoordinatorLaunch: project });
        const ref = { role: 'coordinator', scope: 'project', revision: 12, projectId: 'host-project' };
        expect(result.selection).toEqual(project.selection);
        expect(result.defaultRef).toEqual(ref);
        for (const field of ['provider', 'model', 'thinkingLevel'] as const) {
            expect(result.applied[field]).toEqual({ value: project.selection[field], source: 'project_default', defaultRef: ref });
        }
    });
    it('lets explicit axes win over project axes', () => {
        const result = success({ role: 'coordinator', hostCoordinatorLaunch: project, override: { model: 'custom-model', thinkingLevel: 'low' } });
        expect(result.selection).toEqual({ provider: 'codex-cli', model: 'custom-model', thinkingLevel: 'low' });
        expect(result.applied.provider.source).toBe('project_default');
        expect(result.applied.model).toEqual({ value: 'custom-model', source: 'user' });
        expect(result.applied.thinkingLevel).toEqual({ value: 'low', source: 'user' });
    });
    it('treats missing project axes as CLI defaults, even for the same global provider', () => {
        const result = success({ role: 'coordinator', hostCoordinatorLaunch: { ...project, selection: { provider: 'claude-cli' } } });
        expect(result.selection).toEqual({ provider: 'claude-cli' });
        expect(result.applied.model).toEqual({ value: null, source: 'provider_default' });
        expect(result.applied.thinkingLevel).toEqual({ value: null, source: 'provider_default' });
    });
    it('does not inherit project or global axes after an explicit provider change', () => {
        expect(success({ role: 'coordinator', hostCoordinatorLaunch: project, override: { provider: 'claude-cli' } }).selection)
            .toEqual({ provider: 'claude-cli' });
    });
    it('does not bypass missing setup with a host project override', () => {
        expect(resolve({ role: 'coordinator', hostCoordinatorLaunch: project, stored: { status: 'missing', reason: 'unset' } }))
            .toMatchObject({ code: 'launch_default_required' });
    });
    it('fails an unavailable project without falling back to a usable global entry', () => {
        expect(resolve({ role: 'coordinator', hostCoordinatorLaunch: { ...project, selection: { provider: 'unknown-cli' } } }))
            .toMatchObject({ code: 'launch_default_unavailable', reason: 'provider_unknown', source: 'project_default',
                defaultRef: { scope: 'project', revision: 12, projectId: 'host-project' } });
    });
    it('refuses coordinator project data on an assistant launch', () => {
        expect(resolve({ hostCoordinatorLaunch: project })).toMatchObject({ code: 'launch_default_unavailable', reason: 'invalid_host_project_override' });
    });
    it.each([{ projectId: '' }, { revision: 0 }, { revision: 1.5 }, { selection: { provider: 'codex-cli', approvalMode: 'auto' } }])(
        'fails loudly for malformed trusted project data %j', patch => {
            expect(resolve({ role: 'coordinator', hostCoordinatorLaunch: { ...project, ...patch } }))
                .toMatchObject({ code: 'launch_default_unavailable', reason: 'invalid_host_project_override' });
        });
});

describe('explicit ignoreDefault', () => {
    it.each(['model', 'thinkingLevel'] as const)('ignores only %s while preserving other provenance', field => {
        const result = success({ ignoreDefault: [field] });
        expect(result.selection).not.toHaveProperty(field);
        expect(result.applied[field]).toEqual({ value: null, source: 'provider_default' });
        expect(result.applied.provider.source).toBe('stored_default');
    });
    it('never invents a provider when all defaults are ignored', () => {
        expect(resolve({ ignoreDefault: true })).toMatchObject({ code: 'launch_default_required' });
        expect(resolve({ ignoreDefault: ['provider'] })).toMatchObject({ code: 'launch_default_required' });
        expect(success({ ignoreDefault: true, override: { provider: 'codex-cli' } }).selection).toEqual({ provider: 'codex-cli' });
    });
    it('retains explicit fields even when their defaults are ignored', () => {
        const result = success({ ignoreDefault: ['model'], override: { model: 'custom' } });
        expect(result.applied.model).toEqual({ value: 'custom', source: 'user' });
        expect(result.selection.thinkingLevel).toBe('high');
    });
    it('rejects unknown axes rather than silently accepting them', () => {
        expect(resolve({ ignoreDefault: ['approvalMode' as LaunchField] }))
            .toMatchObject({ code: 'launch_selection_invalid', reason: 'invalid_ignore_default' });
    });
});

describe('resolution never persists', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'launch-defaults-resolve-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    it('leaves store bytes, project bytes, revision and directory contents unchanged on success and failure', () => {
        const store = new LaunchDefaultsStore(dir, ports());
        for (const [index, role] of (['assistant', 'coordinator'] as const).entries()) {
            expect(store.write({ role, selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
                expectedRevision: index, by: 'owner', origin: 'owner' }).ok).toBe(true);
        }
        const meshPath = join(dir, 'meshes.json');
        const project = { projectId: 'host-project', revision: 5, selection: { provider: 'codex-cli', model: 'gpt' } };
        fs.writeFileSync(meshPath, JSON.stringify({ coordinatorLaunch: project }));
        const before = fs.readFileSync(store.path);
        const meshBefore = fs.readFileSync(meshPath);
        const inputs: Partial<ResolveLaunchInput>[] = [
            {}, { override: { model: 'custom' } }, { override: { provider: 'codex-cli' } },
            { override: { provider: 'missing-cli' } }, { ignoreDefault: true },
            { role: 'coordinator', hostCoordinatorLaunch: project },
        ];
        expect(inputs.map(patch => resolve({ stored: store.read(), ...patch }).ok)).toEqual([true, true, true, false, false, true]);
        expect(fs.readFileSync(store.path)).toEqual(before);
        expect(fs.readFileSync(meshPath)).toEqual(meshBefore);
        expect(JSON.parse(before.toString()).revision).toBe(2);
        expect(fs.readdirSync(dir).sort()).toEqual(['launch-defaults.json', 'meshes.json']);
    });
    it('does not create a file or config directory during missing-state failures', () => {
        const store = new LaunchDefaultsStore(join(dir, 'absent'), ports());
        expect(resolve({ stored: store.read(), override: { provider: 'codex-cli' } })).toMatchObject({ code: 'launch_default_required' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('does not mutate the input document or trusted project object', () => {
        const stored = snapshot();
        const project = { projectId: 'host-project', revision: 5, selection: { provider: 'codex-cli', model: 'gpt' } };
        const before = structuredClone({ stored, project });
        const freeze = (value: object) => {
            Object.freeze(value);
            Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
        };
        freeze(stored); freeze(project);
        expect(success({ stored, role: 'coordinator', hostCoordinatorLaunch: project }).selection).toEqual(project.selection);
        expect({ stored, project }).toEqual(before);
    });
});
