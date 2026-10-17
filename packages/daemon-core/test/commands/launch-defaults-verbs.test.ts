import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLaunchDefaultsHandlers, launchDefaultsCommandSources, type HostProjectLaunchState,
    type LaunchDefaultsCommandPorts, type LaunchDefaultsStagingProposal } from '../../src/commands/high-family/launch-defaults.js';
import { LaunchDefaultsStore, type LaunchProviderFacts, type LaunchRole,
    type LaunchSelection, type LaunchValidationPorts, type LaunchDefaultsDocument as CoreDocument } from '../../src/launch-defaults/index.js';
// Test-only source import: no production cross-package source dependency or barrel edit.
import type { LaunchDefaultsProposal, LaunchDefaultsResponse, LaunchDefaultsReadResponse,
    LaunchDefaultsSetResponse, LaunchDefaultsDocument } from '../../../mesh-shared/src/launch-defaults.js';

let dir: string;
let store: LaunchDefaultsStore;
let dependencies: LaunchDefaultsCommandPorts;
let handlers: ReturnType<typeof createLaunchDefaultsHandlers>;
let staged: LaunchDefaultsStagingProposal[];
let project: HostProjectLaunchState;
let locked: boolean;
let beforeLock: (() => void) | undefined;
let providerPatch: Partial<LaunchProviderFacts>;
const validation: LaunchValidationPorts = {
    resolveAlias: p => p === 'claude' ? 'claude-cli' : p,
    getProvider: type => ['claude-cli', 'codex-cli'].includes(type) ? {
        type, category: 'cli', enabled: true, detected: true,
        assistant: { supported: true, toolRestriction: type === 'claude-cli' ? 'enforced' : 'prompt_only' },
        coordinator: 'supported', modelLaunchArgs: ['--model', '{{model}}'],
        thinkingLaunchArgs: ['--effort', '{{level}}'], thinkingLevelOptions: ['low', 'high'], ...providerPatch,
    } : undefined,
};
function run(verb: keyof typeof handlers, args?: unknown): Promise<LaunchDefaultsResponse> {
    // Compilation proves all factory responses conform to the shared contract.
    return handlers[verb]({}, args);
}
async function set(role: LaunchRole = 'assistant', revision = 0, selection: LaunchSelection = { provider: 'claude-cli' }) {
    const result = await run('launch_defaults_set', { action: 'set', role, expectedRevision: revision, ...selection });
    expect(result).toMatchObject({ success: true, result: 'applied', revision: revision + 1, durable: true });
    return result;
}
function bytes() { return fs.readFileSync(store.path); }
beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'launch-defaults-verbs-'));
    providerPatch = {};
    store = new LaunchDefaultsStore(dir, validation);
    staged = [];
    project = { projectId: 'host-project', revision: 0, entry: null };
    locked = false;
    beforeLock = undefined;
    dependencies = { store, validation,
        assistantContext: () => ({ origin: 'human', reviewTurnOpen: false }),
        stage: proposal => { staged.push(structuredClone(proposal)); return `ldf-${staged.length}`; },
        projects: {
            read: ref => ref === project.projectId ? { ok: true, state: structuredClone(project) }
                : { ok: false, code: 'project_not_found' },
            withWriteLock: operation => {
                expect(locked).toBe(false);
                locked = true;
                try { beforeLock?.(); return operation(); } finally { locked = false; }
            },
            replace: state => {
                expect(locked).toBe(true);
                project = structuredClone(state);
                return { ok: true, durable: true };
            },
        },
    };
    handlers = createLaunchDefaultsHandlers(dependencies);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('unregistered command contract', () => {
    it('declares source restrictions for future registration without registering anything', () => {
        expect(launchDefaultsCommandSources.launch_defaults_set).toEqual(['p2p', 'ws', 'standalone']);
        expect(launchDefaultsCommandSources.assistant_launch_defaults_set).toEqual(['ipc', 'standalone']);
        expect(launchDefaultsCommandSources.assistant_launch_defaults).toEqual(['ipc', 'standalone']);
        expectTypeOf<LaunchDefaultsStagingProposal>().toMatchTypeOf<LaunchDefaultsProposal>();
        expectTypeOf<CoreDocument>().toEqualTypeOf<LaunchDefaultsDocument>();
        expectTypeOf<Awaited<ReturnType<typeof handlers.launch_defaults_get>>>().toMatchTypeOf<LaunchDefaultsReadResponse>();
        expectTypeOf<Awaited<ReturnType<typeof handlers.launch_defaults_set>>>().toMatchTypeOf<LaunchDefaultsSetResponse>();
    });
    it.each([
        {}, { action: 'set', role: 'assistant', provider: 'claude-cli' },
        { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: -1 },
        { action: 'clear', role: 'assistant', expectedRevision: 0, model: 'opus' },
        { action: 'set', role: 'worker', provider: 'claude-cli', expectedRevision: 0 },
        { action: 'set', role: 'assistant', project: 'host-project', provider: 'claude-cli', expectedRevision: 0 },
        { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0, origin: 'owner' },
        { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0, autoApprove: true },
    ])('rejects invalid/untrusted write args %j without state', async args => {
        expect(await run('launch_defaults_set', args)).toMatchObject({ success: false, code: 'invalid_args' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it.each([{ action: 'get', provider: 'claude-cli' }, { action: 'get', project: 'host-project' },
        { action: 'check', role: 'assistant', model: 'opus' }, { action: 'get', inlineMesh: {} }])(
        'rejects invalid/untrusted read args %j', async args => {
            expect(await run('launch_defaults_get', args)).toMatchObject({ code: 'invalid_args' });
        });
});

describe('global explicit setup, check and read', () => {
    it('reports absent setup and creates no document during get', async () => {
        expect(await run('launch_defaults_get')).toMatchObject({ success: false, code: 'launch_default_required', documentRevision: 0 });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('checks a candidate before setup without persisting it', async () => {
        expect(await run('launch_defaults_get', { action: 'check', role: 'assistant', provider: 'claude', model: 'opus' }))
            .toMatchObject({ success: true, result: 'check', selection: { provider: 'claude-cli', model: 'opus' }, warnings: ['catalog_unverified'] });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('stores explicit canonical setup then reads resolver-derived provenance', async () => {
        await set('assistant', 0, { provider: 'claude', model: 'opus', thinkingLevel: 'high' });
        const before = bytes();
        expect(await run('launch_defaults_get', { role: 'assistant' })).toMatchObject({ success: true, result: 'get', documentRevision: 1,
            roles: { assistant: { stored: { provider: 'claude-cli', revision: 1 }, effective: { ok: true,
                selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
                applied: { provider: { source: 'stored_default', defaultRef: { role: 'assistant', scope: 'global', revision: 1 } } } } } } });
        expect(bytes()).toEqual(before);
    });
    it('reads both roles without using the other role as a default', async () => {
        await set();
        expect(await run('launch_defaults_get')).toMatchObject({ code: 'launch_default_required', role: 'coordinator', documentRevision: 1 });
        await set('coordinator', 1, { provider: 'codex-cli', model: 'gpt' });
        expect(await run('launch_defaults_get')).toMatchObject({ success: true,
            roles: { assistant: { effective: { selection: { provider: 'claude-cli' } } }, coordinator: { effective: { selection: { provider: 'codex-cli' } } } } });
    });
    it('fails unavailable defaults loudly rather than substituting', async () => {
        await set();
        const before = bytes();
        providerPatch = { enabled: false };
        expect(await run('launch_defaults_get', { role: 'assistant' })).toMatchObject({ success: false,
            code: 'launch_default_unavailable', reason: 'provider_disabled', source: 'stored_default', value: 'claude-cli' });
        expect(bytes()).toEqual(before);
    });
    it('lets an owner replace an unreadable old provider catalog with an explicit usable choice', async () => {
        await set();
        const original = validation.getProvider;
        vi.spyOn(validation, 'getProvider').mockImplementation(type => {
            if (type === 'claude-cli') throw new Error('old provider catalog unavailable');
            return original(type);
        });
        await set('assistant', 1, { provider: 'codex-cli' });
    });
    it.each(['launch_defaults_get', 'launch_defaults_set'] as const)('preserves corrupt bytes for %s', async verb => {
        fs.writeFileSync(store.path, '{truncated');
        expect(await run(verb, verb === 'launch_defaults_get' ? {} : { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }))
            .toMatchObject({ code: 'launch_default_unavailable', reason: 'launch_defaults_json_invalid' });
        expect(bytes().toString()).toBe('{truncated');
        expect(fs.readdirSync(dir)).toEqual(['launch-defaults.json']);
    });
    it('rejects an unavailable provider at setup without a substitute', async () => {
        expect(await run('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'unknown-cli', expectedRevision: 0 }))
            .toMatchObject({ success: false, code: 'launch_default_invalid', role: 'assistant', field: 'provider', reason: 'provider_unknown' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('replaces a whole triple and clears with advancing document CAS', async () => {
        await set('assistant', 0, { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' });
        const replacement = await set('assistant', 1, { provider: 'codex-cli' });
        if (!replacement.success || replacement.result !== 'applied') throw new Error('expected applied');
        expect(replacement.entry).not.toHaveProperty('model');
        expect(replacement.entry).not.toHaveProperty('thinkingLevel');
        expect(await run('launch_defaults_set', { action: 'clear', role: 'assistant', expectedRevision: 2 }))
            .toMatchObject({ success: true, result: 'applied', entry: null, revision: 3, durable: true });
        const before = bytes();
        expect(await run('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 1 }))
            .toMatchObject({ code: 'revision_conflict', actualRevision: 3, committed: false });
        expect(await run('launch_defaults_get', { role: 'assistant' })).toMatchObject({ code: 'launch_default_required' });
        expect(bytes()).toEqual(before);
    });
    it('revalidates through the store instead of treating preflight as authority', async () => {
        const actual = store.write.bind(store);
        vi.spyOn(store, 'write').mockImplementation(request => { providerPatch = { detected: false }; return actual(request); });
        expect(await run('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }))
            .toMatchObject({ code: 'launch_default_invalid', reason: 'provider_not_detected', committed: false });
        expect(store.read().status).toBe('missing');
    });
    it('maps unreadable state to a loud refusal without a write attempt', async () => {
        vi.spyOn(store, 'read').mockReturnValue({ status: 'unreadable', reason: 'permission_denied' });
        const writer = vi.spyOn(store, 'write');
        expect(await run('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }))
            .toMatchObject({ code: 'launch_default_unavailable', reason: 'permission_denied' });
        expect(writer).not.toHaveBeenCalled();
    });
    it('never claims applied when replacement happened without confirmed durability', async () => {
        vi.spyOn(store, 'write').mockReturnValue({ ok: false, code: 'persistence_failed', committed: true,
            reason: 'durability_unconfirmed', document: { version: 1, revision: 4, history: [] } });
        expect(await run('launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }))
            .toEqual({ success: false, code: 'persistence_failed', error: 'durability_unconfirmed',
                reason: 'durability_unconfirmed', committed: true, documentRevision: 4 });
    });
});

describe('assistant authority and existing Inbox staging port', () => {
    it('applies human-origin setup and stamps assistant provenance', async () => {
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli', expectedRevision: 0, assistantSessionId: 'human-session' }))
            .toMatchObject({ success: true, result: 'applied', entry: { setBy: 'assistant' } });
        const read = store.read();
        if (read.status !== 'ok') throw new Error('expected document');
        expect(read.document.history[0]).toMatchObject({ by: 'assistant', origin: 'human' });
        expect(staged).toEqual([]);
    });
    it('reads authority from the daemon log adapter, never a supplied origin field', async () => {
        const context = vi.fn(() => ({ origin: 'relay' as const, reviewTurnOpen: false }));
        dependencies.assistantContext = context;
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli',
            expectedRevision: 0, assistantSessionId: 'session-1', origin: 'human' })).toMatchObject({ code: 'invalid_args' });
        expect(context).not.toHaveBeenCalled();
        await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli',
            expectedRevision: 0, assistantSessionId: 'session-1' });
        expect(context).toHaveBeenCalledWith('session-1');
        expect(staged[0]).toMatchObject({ callerSessionId: 'session-1', origin: 'relay' });
    });
    it.each(['relay', 'review_tainted', 'unlogged'] as const)('stages %s authority before any default write', async origin => {
        dependencies.assistantContext = origin === 'unlogged' ? undefined : () => ({ origin, reviewTurnOpen: false });
        const writer = vi.spyOn(store, 'write');
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli', expectedRevision: 0 }))
            .toMatchObject({ success: true, result: 'staged', stagedId: 'ldf-1', expectedRevision: 0 });
        expect(writer).not.toHaveBeenCalled();
        expect(staged).toEqual([expect.objectContaining({ kind: 'launch_defaults', role: 'coordinator',
            selection: { provider: 'codex-cli' }, previous: null, expectedRevision: 0,
            origin: origin === 'unlogged' ? 'relay' : origin })]);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('stages enforced-to-prompt-only assistant provider changes even with human origin', async () => {
        await set();
        const before = bytes();
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'codex-cli', expectedRevision: 1 }))
            .toMatchObject({ success: true, result: 'staged', previous: { provider: 'claude-cli' }, selection: { provider: 'codex-cli' } });
        expect(bytes()).toEqual(before);
    });
    it('uses the active enforced assistant lock during first setup too', async () => {
        dependencies.currentAssistantToolRestriction = () => 'enforced';
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'codex-cli', expectedRevision: 0 }))
            .toMatchObject({ result: 'staged' });
        expect(store.read().status).toBe('missing');
    });
    it('does not stage a direct owner downgrade or a human-origin clear that leaves launches unset', async () => {
        await set();
        await set('assistant', 1, { provider: 'codex-cli' });
        expect(await run('assistant_launch_defaults_set', { action: 'clear', role: 'assistant', expectedRevision: 2 }))
            .toMatchObject({ result: 'applied', entry: null });
        expect(staged).toEqual([]);
    });
    it('applies a human-origin same-provider edit without widening its tool lock', async () => {
        await set();
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', model: 'opus', expectedRevision: 1 }))
            .toMatchObject({ result: 'applied', entry: { provider: 'claude-cli', model: 'opus' } });
        expect(staged).toEqual([]);
    });
    it('does not reinterpret a same-provider model edit as a new provider downgrade', async () => {
        await set('assistant', 0, { provider: 'codex-cli' });
        dependencies.currentAssistantToolRestriction = () => 'enforced';
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'codex-cli', model: 'gpt', expectedRevision: 1 }))
            .toMatchObject({ result: 'applied', entry: { provider: 'codex-cli', model: 'gpt' } });
        expect(staged).toEqual([]);
    });
    it.each(['assistant_launch_defaults', 'assistant_launch_defaults_set'] as const)('denies %s during review turns', async verb => {
        dependencies.assistantContext = () => ({ origin: 'review', reviewTurnOpen: true });
        expect(await run(verb, verb.endsWith('_set') ? { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 } : {}))
            .toMatchObject({ code: 'review_turn_tool_denied' });
        expect(staged).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('refuses stale staged edits before invoking the Inbox', async () => {
        await set();
        dependencies.assistantContext = () => ({ origin: 'relay', reviewTurnOpen: false });
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli', expectedRevision: 0 }))
            .toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
        expect(staged).toEqual([]);
    });
    it.each(['missing', 'throwing', 'invalid id'] as const)('fails closed for %s Inbox', async mode => {
        dependencies.assistantContext = undefined;
        dependencies.stage = mode === 'missing' ? undefined : mode === 'throwing'
            ? () => { throw new Error('unavailable'); } : () => 'not-an-inbox-id';
        expect(await run('assistant_launch_defaults_set', { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 }))
            .toMatchObject({ success: false, code: mode === 'missing' ? 'staging_unavailable' : 'staging_failed' });
        expect(store.read().status).toBe('missing');
    });
    it('revalidates and CAS-checks staged intent when the owner later applies it', async () => {
        dependencies.assistantContext = undefined;
        await run('assistant_launch_defaults_set', { action: 'set', role: 'coordinator', provider: 'codex-cli', expectedRevision: 0 });
        const proposal = staged[0];
        providerPatch = { enabled: false };
        expect(await run('launch_defaults_set', { action: 'set', role: proposal.role, ...proposal.selection, expectedRevision: proposal.expectedRevision }))
            .toMatchObject({ code: 'launch_default_invalid', reason: 'provider_disabled' });
        providerPatch = {};
        await set();
        expect(await run('launch_defaults_set', { action: 'set', role: proposal.role, ...proposal.selection, expectedRevision: proposal.expectedRevision }))
            .toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
    });
});

describe('host-only project whole triples', () => {
    beforeEach(async () => { await set('coordinator', 0, { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' }); });
    const projectSet = (extra: Record<string, unknown> = {}) => ({ action: 'set', role: 'coordinator', project: 'host-project',
        provider: 'codex-cli', expectedRevision: 0, ...extra });
    it('writes only host project state under its lock and resolves project provenance', async () => {
        const globalBytes = bytes();
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ result: 'applied', scope: 'project', projectId: 'host-project', revision: 1 });
        expect(project.entry).toEqual({ provider: 'codex-cli', revision: 1, setBy: 'owner', setAt: expect.any(Number) });
        expect(await run('launch_defaults_get', { role: 'coordinator', project: 'host-project' })).toMatchObject({ success: true,
            project: { revision: 1 }, roles: { coordinator: { effective: { selection: { provider: 'codex-cli' },
                applied: { provider: { source: 'project_default', defaultRef: { scope: 'project', revision: 1, projectId: 'host-project' } },
                    model: { value: null, source: 'provider_default' }, thinkingLevel: { value: null, source: 'provider_default' } } } } } });
        expect(bytes()).toEqual(globalBytes);
    });
    it('uses a host project default when the global role is unset but setup exists', async () => {
        await run('launch_defaults_set', { action: 'clear', role: 'coordinator', expectedRevision: 1 });
        await run('launch_defaults_set', projectSet());
        expect(await run('launch_defaults_get', { role: 'coordinator', project: 'host-project' }))
            .toMatchObject({ success: true, roles: { coordinator: { stored: null, effective: { selection: { provider: 'codex-cli' } } } } });
    });
    it('advances project CAS on clear and explicitly inherits the global triple', async () => {
        await run('launch_defaults_set', projectSet());
        expect(await run('launch_defaults_set', { action: 'clear', role: 'coordinator', project: 'host-project', expectedRevision: 1 }))
            .toMatchObject({ result: 'applied', entry: null, revision: 2 });
        expect(project).toEqual({ projectId: 'host-project', revision: 2, entry: null });
        expect(await run('launch_defaults_get', { role: 'coordinator', project: 'host-project' }))
            .toMatchObject({ roles: { coordinator: { effective: { selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' } } } } });
        expect(await run('launch_defaults_set', projectSet({ expectedRevision: 1 }))).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
    });
    it('rechecks CAS under the host lock against a concurrent project edit', async () => {
        beforeLock = () => { project.revision = 1; };
        const replace = vi.spyOn(dependencies.projects!, 'replace');
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
        expect(replace).not.toHaveBeenCalled();
    });
    it('revalidates machine availability inside the host write lock', async () => {
        beforeLock = () => { providerPatch = { enabled: false }; };
        const replace = vi.spyOn(dependencies.projects!, 'replace');
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'launch_default_invalid', reason: 'provider_disabled' });
        expect(replace).not.toHaveBeenCalled();
    });
    it('refuses corrupt host state and a project identity change under the lock', async () => {
        const read = dependencies.projects!.read;
        dependencies.projects!.read = () => ({ ok: true, state: { ...project, entry: undefined } as unknown as HostProjectLaunchState });
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'project_storage_unavailable' });
        dependencies.projects!.read = read;
        beforeLock = () => { dependencies.projects!.read = () => ({ ok: true, state: { ...project, projectId: 'other-project' } }); };
        const replace = vi.spyOn(dependencies.projects!, 'replace');
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'project_storage_unavailable' });
        expect(replace).not.toHaveBeenCalled();
    });
    it.each(['project_not_found', 'project_ambiguous', 'project_not_hosted'] as const)('refuses %s rather than using inline/global writes', async code => {
        dependencies.projects!.read = () => ({ ok: false, code });
        const globalBytes = bytes();
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code });
        expect(bytes()).toEqual(globalBytes);
        expect(project.revision).toBe(0);
    });
    it('does not use project args as authority or bootstrap a missing global document', async () => {
        expect(await run('launch_defaults_set', projectSet({ inlineMesh: { coordinatorLaunch: { provider: 'codex-cli' } } })))
            .toMatchObject({ code: 'invalid_args' });
        fs.unlinkSync(store.path);
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'launch_default_required' });
        expect(project.revision).toBe(0);
    });
    it('stages relay project writes with host project CAS without changing either authority', async () => {
        dependencies.assistantContext = undefined;
        const globalBytes = bytes();
        expect(await run('assistant_launch_defaults_set', projectSet())).toMatchObject({ result: 'staged', expectedRevision: 0 });
        expect(staged[0]).toMatchObject({ project: 'host-project', selection: { provider: 'codex-cli' }, expectedRevision: 0 });
        expect(project.revision).toBe(0);
        expect(bytes()).toEqual(globalBytes);
    });
    it('fails unavailable project adapters without claiming applied', async () => {
        dependencies.projects = undefined;
        expect(await run('launch_defaults_set', projectSet())).toMatchObject({ code: 'project_storage_unavailable' });
    });
    it('reports unexpected write exceptions without asserting an uncommitted outcome', async () => {
        dependencies.projects!.replace = () => { throw new Error('unknown write boundary'); };
        const outcome = await run('launch_defaults_set', projectSet());
        expect(outcome).toMatchObject({ success: false, code: 'persistence_failed', reason: 'operation_outcome_unconfirmed' });
        expect(outcome).not.toHaveProperty('committed');
    });
    it('preserves committed-but-unconfirmed project write outcomes', async () => {
        dependencies.projects!.replace = state => { project = state; return { ok: false, committed: true, reason: 'durability_unconfirmed' }; };
        expect(await run('launch_defaults_set', projectSet()))
            .toMatchObject({ success: false, code: 'persistence_failed', reason: 'durability_unconfirmed', committed: true });
        expect(project.revision).toBe(1);
    });
});
