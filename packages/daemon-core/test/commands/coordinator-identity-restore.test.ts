import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { LOG } from '../../src/logging/logger.js';
import { restoreHostedSessions, type CliRestoreHost } from '../../src/commands/cli-manager-restore.js';
import { toHostedCliRuntimeDescriptor } from '../../src/commands/low-family/session-host.js';
import { listHostedCliRuntimes } from '../../src/session-host/runtime-support.js';
import * as coordinatorRegistry from '../../src/mesh/coordinator-registry.js';
import { getCoordinatorForSession, loadMeshCoordinatorRegistry, registerMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { listLocalCoordinatorSessions } from '../../src/mesh/mesh-event-forwarding.js';
import { ensureCoordinator } from '../../src/assistant/coordinator-lifecycle.js';
import { buildSessionEntries } from '../../src/status/builders.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';

const inventory = vi.hoisted(() => ({ records: [] as any[] }));
vi.mock('@adhdev/session-host-core', async importOriginal => ({
    ...await importOriginal<typeof import('@adhdev/session-host-core')>(),
    SessionHostClient: class {
        async request() { return { success: true, result: inventory.records }; }
        async close() {}
    },
}));

const owner = { namespace: 'restore-preview', endpoint: 'unix:/tmp/restore-preview.sock', managedBy: 'test-cloud', clientId: 'restore-test' };
const foreign = { ...owner, namespace: 'restore-standalone', managedBy: 'test-standalone', endpoint: 'unix:/tmp/restore-standalone.sock' };
let config: string;
let previousConfig: string | undefined;
let assistant: AssistantRegistry;

function runtime(id = 'coordinator', mesh = 'mesh-test'): any {
    return { sessionId: id, category: 'cli', providerType: 'test-cli', workspace: '/test-workspace',
        lifecycle: 'running', startedAt: 100, lastActivityAt: 200,
        meta: { managedBy: owner.managedBy, meshCoordinatorFor: mesh, providerSessionId: `native-${id}`,
            launchRecord: { sessionId: id, providerType: 'test-cli', workspace: '/test-workspace',
                launchedAt: 90, launchedBy: 'mesh', model: {}, thinkingLevel: {}, roleLaunch: {
                    role: 'coordinator', selection: { provider: 'test-cli' }, documentRevision: 1,
                    applied: { provider: { value: 'test-cli', source: 'user' },
                        model: { value: null, source: 'provider_default' }, thinkingLevel: { value: null, source: 'provider_default' } },
                } } } };
}

function persist(record: any, namespace = owner.namespace) {
    const dir = join(config, 'session-host', namespace, 'runtimes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${record.sessionId}.json`), JSON.stringify({ record, snapshot: {} }));
}

function host(records?: any[]): CliRestoreHost {
    return { adapters: new Map(), deps: { getHostedBindingOwner: () => owner, hostedRuntimeManagerTag: owner.managedBy,
        getInstanceManager: () => ({ getInstance: () => undefined, removeInstance: vi.fn() }),
        listHostedCliRuntimes: async () => records ?? inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!).filter(Boolean) },
        providerLoader: { resolveAlias: (type: string) => type, getMeta: () => ({ category: 'cli' }),
            resolve: () => ({ category: 'cli', resume: { supported: true, resumeSessionArgs: ['--resume', '{{id}}'] } }), getSettings: () => ({}) },
        registerCliInstance: vi.fn(async () => {}) } as unknown as CliRestoreHost;
}

beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'coordinator-restore-'));
    previousConfig = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = config;
    mkdirSync(join(config, 'daemon'), { recursive: true });
    writeFileSync(join(config, 'daemon', 'mesh-coordinators.json'), '[]');
    loadMeshCoordinatorRegistry();
    inventory.records = [runtime()];
    assistant = new AssistantRegistry({ configDir: config });
    setAssistantRegistryForTests(assistant);
});
afterEach(() => {
    vi.restoreAllMocks();
    setAssistantRegistryForTests(null);
    rmSync(config, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfig;
});

describe('exact persisted coordinator identity recovery', () => {
    // Reuse the independent review's four-record probe shape: old retained
    // candidate without a row, exact current owner, ordinary worker, assistant.
    function reviewedBatch(legacy: boolean | 'mismatched' = false) {
        const old = runtime('retained-old');
        if (legacy === true) delete old.meta.launchRecord;
        if (legacy === 'mismatched') old.meta.launchRecord.sessionId = 'other-runtime';
        const current = runtime('current-owner'); current.startedAt = 300;
        const worker = runtime('ordinary-worker');
        delete worker.meta.meshCoordinatorFor; delete worker.meta.launchRecord;
        const asst = runtime('bound-assistant');
        delete asst.meta.meshCoordinatorFor; delete asst.meta.launchRecord;
        asst.meta.assistant = true;
        inventory.records = [old, current, worker, asst];
        inventory.records.forEach(r => persist(r));
        const binding = { meshId: 'mesh-test', sessionId: current.sessionId, startedAt: 300,
            cliType: 'test-cli', workspace: current.workspace, hostOwner: owner };
        registerMeshCoordinator(binding);
        assistant.bindSession({ sessionId: asst.sessionId, cliType: 'test-cli', workspace: asst.workspace, hostOwner: owner, at: 1 });
        return { old, current, worker, asst, binding, records: inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!) };
    }

    it.each([
        ['boot', false], ['partial', false], ['boot', true], ['partial', true], ['boot', 'mismatched'], ['partial', 'mismatched'],
    ] as const)('review B1 %s mixed batch restores all four and marks only the exact owner (legacy/mismatched=%s)', async (path, legacy) => {
        const batch = reviewedBatch(legacy);
        const fixture = host(batch.records);
        const m = new DaemonCliManager({ ...fixture.deps, getP2p: () => null } as any, fixture.providerLoader);
        const states: any[] = [];
        const stop = vi.fn(), input = vi.fn();
        const diagnostic = vi.spyOn(LOG, 'warn');
        const writes = vi.spyOn(coordinatorRegistry, 'registerMeshCoordinator');
        const attach = vi.spyOn(m, 'registerCliInstance').mockImplementation(async (id, type, _cli, workspace, _args, _provider, settings) => {
            states.push({ instanceId: id, type, category: 'cli', status: 'idle', workspace, settings });
            m.adapters.set(id, { stop, send: input, detach: vi.fn() } as any);
        });
        expect(await m.restoreHostedSessions(path === 'boot' ? undefined : batch.records)).toBe(4);
        expect(m.hostedRestoreState).toBe('ready');
        expect(attach.mock.calls.map(c => c[0])).toEqual(batch.records.map(r => r.runtimeId));
        expect(states.map(s => s.settings.meshCoordinatorFor)).toEqual([undefined, 'mesh-test', undefined, undefined]);
        expect(states[3].settings.assistant).toBe(true);
        expect(getCoordinatorForSession(batch.old.sessionId)).toBeUndefined();
        expect(writes.mock.calls.map(c => c[0].sessionId)).toEqual([batch.current.sessionId]);
        expect(getCoordinatorForSession(batch.current.sessionId)).toEqual(batch.binding);
        expect(assistant.reload()).toMatchObject({ sessionId: batch.asst.sessionId, hostOwner: owner });
        expect(diagnostic.mock.calls.some(c => c.some(value => typeof value === 'string' && value.includes('coordinator_identity_conflict') && value.includes(batch.old.sessionId)))).toBe(true);
        const launch = vi.fn();
        const components = { instanceManager: { getByCategory: () => states.map(state => ({ getState: () => state })) } } as any;
        expect(await ensureCoordinator('mesh-test', { coordinators: mesh => listLocalCoordinatorSessions(components, mesh)
            .map(c => ({ ...c, managedByAssistant: false })), launch, hide: vi.fn() }))
            .toMatchObject({ ok: true, sessionId: batch.current.sessionId, launched: false });
        expect(launch).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(input).not.toHaveBeenCalled();
    });

    it.each(['boot', 'partial'])('review B1 %s strict registry failure drops marks without blocking sessions or writing registry', async path => {
        const batch = reviewedBatch();
        const registryPath = join(config, 'daemon', 'mesh-coordinators.json');
        writeFileSync(registryPath, '{invalid');
        const h = host(batch.records);
        expect(await restoreHostedSessions(h, path === 'boot' ? undefined : batch.records)).toBe(4);
        expect(vi.mocked(h.registerCliInstance).mock.calls.every(c => c[6].meshCoordinatorFor === undefined)).toBe(true);
        expect(vi.mocked(h.registerCliInstance).mock.calls[3][6].assistant).toBe(true);
        expect(readFileSync(registryPath, 'utf8')).toBe('{invalid');
    });

    it.each(['boot', 'partial'])('review M1 %s late conflict detaches only failed attachment and continues through later sessions', async path => {
        const batch = reviewedBatch();
        // The first candidate is initially the only coordinator of its mesh;
        // the later exact coordinator belongs to a different mesh.
        batch.current.meta.meshCoordinatorFor = 'mesh-other';
        persist(batch.current);
        registerMeshCoordinator({ ...batch.binding, meshId: 'mesh-other' });
        batch.records = inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!);
        const fixture = host(batch.records);
        const h = new DaemonCliManager({ ...fixture.deps, getP2p: () => null } as any, fixture.providerLoader);
        const detach = vi.fn(), stop = vi.fn(), input = vi.fn();
        const attach = vi.spyOn(h, 'registerCliInstance').mockImplementation(async id => {
            h.adapters.set(id, { detach: id === batch.old.sessionId ? detach : vi.fn(), stop, send: input } as any);
            if (id === batch.old.sessionId) registerMeshCoordinator({ meshId: 'mesh-test', sessionId: 'late-current-owner', startedAt: 500, hostOwner: owner });
        });
        expect(await h.restoreHostedSessions(path === 'boot' ? undefined : batch.records)).toBe(3);
        expect(h.hostedRestoreState).toBe('ready');
        expect(attach.mock.calls.map(c => c[0])).toEqual(batch.records.map(r => r.runtimeId));
        expect(detach).toHaveBeenCalledOnce();
        expect(h.adapters.has(batch.old.sessionId)).toBe(false);
        expect(attach.mock.calls[1][6].meshCoordinatorFor).toBe('mesh-other');
        expect(attach.mock.calls[3][6].assistant).toBe(true);
        expect(getCoordinatorForSession('late-current-owner')?.startedAt).toBe(500);
        expect(getCoordinatorForSession(batch.old.sessionId)).toBeUndefined();
        expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
    });

    it.each(['boot', 'partial'])('review %s abort still stops the mixed batch and detaches only the in-flight attachment', async path => {
        const batch = reviewedBatch();
        const h = host(batch.records), abort = new AbortController();
        const detach = vi.fn(), stop = vi.fn(), input = vi.fn();
        const attach = vi.mocked(h.registerCliInstance).mockImplementationOnce(async id => {
            h.adapters.set(id, { detach, stop, send: input } as any);
            abort.abort();
        });
        await expect(restoreHostedSessions(h, path === 'boot' ? undefined : batch.records, abort.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(attach).toHaveBeenCalledOnce();
        expect(detach).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
        expect(getCoordinatorForSession(batch.current.sessionId)).toEqual(batch.binding);
        expect(getCoordinatorForSession(batch.old.sessionId)).toBeUndefined();
    });

    it('a refused candidate cannot acquire a coordinator mark from provider defaults', async () => {
        const batch = reviewedBatch();
        const h = host(batch.records);
        vi.spyOn(h.providerLoader, 'getSettings').mockReturnValue({ meshCoordinatorFor: 'untrusted-default' });
        expect(await restoreHostedSessions(h, batch.records)).toBe(4);
        expect(vi.mocked(h.registerCliInstance).mock.calls.map(c => c[6].meshCoordinatorFor))
            .toEqual([undefined, 'mesh-test', undefined, undefined]);
    });

    it.each(['boot', 'resume'])('%s mapper restores only the genuine coordinator, repairs after attach and survives a second restart', async path => {
        const coordinator = runtime();
        persist(coordinator);
        const sibling = runtime('ordinary');
        delete sibling.meta.meshCoordinatorFor;
        delete sibling.meta.launchRecord;
        const asst = runtime('assistant');
        delete asst.meta.meshCoordinatorFor;
        delete asst.meta.launchRecord;
        asst.meta.assistant = true;
        inventory.records = [coordinator, sibling, asst];
        const records = path === 'boot' ? await listHostedCliRuntimes({ kind: 'unix', path: '/tmp/test.sock' })
            : inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!);
        expect(records[0]).toMatchObject({ meshCoordinatorFor: 'mesh-test' });
        const h = host(records);
        vi.mocked(h.registerCliInstance).mockImplementation(async id => {
            if (id !== 'coordinator') return;
            expect(getCoordinatorForSession('coordinator')).toBeUndefined();
        });
        expect(await restoreHostedSessions(h, path === 'boot' ? undefined : records)).toBe(3);
        const calls = vi.mocked(h.registerCliInstance).mock.calls;
        expect(calls[0][6].meshCoordinatorFor).toBe('mesh-test');
        expect(calls[1][6].meshCoordinatorFor).toBeUndefined();
        expect(calls[2][6].assistant).toBe(true);
        expect(calls.map(c => [c[0], c[8]?.providerSessionId])).toEqual([
            ['coordinator', 'native-coordinator'], ['ordinary', 'native-ordinary'], ['assistant', 'native-assistant'],
        ]);
        const states = calls.map(c => ({ instanceId: c[0], type: 'test-cli', category: 'cli',
            status: 'idle', workspace: c[3], settings: c[6] }));
        const entries = buildSessionEntries(states as any, new Map(), { profile: 'metadata' });
        expect(entries[0].coordinator).toEqual({ meshId: 'mesh-test', role: 'coordinator' });
        expect(entries[1].coordinator).toBeUndefined();
        expect(entries[2].assistant).toBe(true);
        const launch = vi.fn();
        const components = { instanceManager: { getByCategory: () => states.map(state => ({ getState: () => state })) } } as any;
        expect(await ensureCoordinator('mesh-test', { coordinators: mesh =>
            listLocalCoordinatorSessions(components, mesh).map(c => ({ ...c, managedByAssistant: false })),
            launch, hide: vi.fn() })).toMatchObject({ ok: true, sessionId: 'coordinator', launched: false });
        expect(launch).not.toHaveBeenCalled();
        expect(assistant.reload()).toMatchObject({ sessionId: 'assistant', hostOwner: owner });
        loadMeshCoordinatorRegistry();
        expect(getCoordinatorForSession('coordinator')).toEqual({ meshId: 'mesh-test', sessionId: 'coordinator',
            cliType: 'test-cli', workspace: '/test-workspace', startedAt: 100, hostOwner: owner });
        const next = host(records);
        expect(await restoreHostedSessions(next, records)).toBe(3);
        expect(vi.mocked(next.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBe('mesh-test');
        next.adapters.set('coordinator', {} as any);
        expect(await restoreHostedSessions(next, [records[0]])).toBe(0);
    });

    it.each(['missing', 'uuid', 'provider', 'role', 'workspace', 'mesh', 'foreign', 'ambiguous', 'terminal', 'owner', 'manager', 'ordinary', 'malformed', 'conversation', 'generation', 'launcher'])('refuses %s evidence without publishing a binding', async kind => {
        const record = runtime();
        const descriptor = toHostedCliRuntimeDescriptor(record)!;
        if (kind === 'uuid') record.meta.launchRecord.sessionId = 'other';
        if (kind === 'provider') record.meta.launchRecord.providerType = 'other-cli';
        if (kind === 'role') record.meta.launchRecord.roleLaunch.role = 'assistant';
        if (kind === 'workspace') record.workspace = '/other';
        if (kind === 'mesh') record.meta.meshCoordinatorFor = 'other-mesh';
        if (kind === 'ordinary') { delete record.meta.meshCoordinatorFor; delete record.meta.launchRecord; }
        if (kind === 'malformed') record.meta.launchRecord = { roleLaunch: { role: 'coordinator' } };
        if (kind === 'conversation') record.meta.providerSessionId = 'foreign-conversation';
        if (kind === 'generation') record.startedAt = 999;
        if (kind === 'launcher') record.meta.launchRecord.launchedBy = 'api';
        if (kind === 'terminal') record.termination = { lifecycle: 'stopped' };
        if (kind !== 'missing') persist(record, kind === 'foreign' ? foreign.namespace : owner.namespace);
        if (kind === 'ambiguous') persist(record, foreign.namespace);
        const h = host();
        if (kind === 'owner') h.deps.getHostedBindingOwner = () => undefined;
        if (kind === 'manager') descriptor.managedBy = undefined;
        expect(await restoreHostedSessions(h, [descriptor])).toBe(1);
        expect(vi.mocked(h.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBeUndefined();
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
    });

    it('does not attach a terminated record through either mapper', async () => {
        const record = runtime();
        record.termination = { lifecycle: 'stopped' };
        persist(record);
        inventory.records = [record];
        expect(await listHostedCliRuntimes({ kind: 'unix', path: '/tmp/test.sock' })).toEqual([]);
        expect(toHostedCliRuntimeDescriptor(record)).toBeNull();
    });

    it.each(['same', 'foreign', 'different-workspace'])('preserves an existing newer %s binding', async kind => {
        const record = runtime(); persist(record);
        const newer = { meshId: 'mesh-test', sessionId: 'newer', startedAt: 300, cliType: 'test-cli',
            workspace: kind === 'different-workspace' ? '/other' : record.workspace, hostOwner: kind === 'foreign' ? foreign : owner };
        registerMeshCoordinator(newer);
        const h = host();
        expect(await restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).toBe(1);
        expect(vi.mocked(h.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBeUndefined();
        expect(getCoordinatorForSession('newer')).toEqual(newer);
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
    });

    it('attaches two ambiguous candidates as ordinary without granting either a coordinator mark', async () => {
        const records = [runtime(), runtime('second')]; records.forEach(r => persist(r));
        const h = host(records.map(r => toHostedCliRuntimeDescriptor(r)!));
        expect(await restoreHostedSessions(h)).toBe(2);
        expect(vi.mocked(h.registerCliInstance).mock.calls.every(c => c[6].meshCoordinatorFor === undefined)).toBe(true);
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
        expect(getCoordinatorForSession('second')).toBeUndefined();
    });

    it.each(['starting', 'stopping', 'interrupted', 'foreign-managed'])('a newer %s candidate excludes coordinator recovery without violating lifecycle/manager fences', async lifecycle => {
        const record = runtime(); persist(record);
        const newer = runtime('newer'); newer.startedAt = 300;
        if (lifecycle === 'foreign-managed') newer.meta.managedBy = foreign.managedBy;
        else newer.lifecycle = lifecycle;
        inventory.records = [record, newer];
        const records = inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!);
        const h = host(records);
        expect(await restoreHostedSessions(h)).toBe(lifecycle === 'interrupted' ? 2 : 1);
        expect(vi.mocked(h.registerCliInstance).mock.calls.every(c => c[6].meshCoordinatorFor === undefined)).toBe(true);
        expect(getCoordinatorForSession(record.sessionId)).toBeUndefined();
    });

    it('does not repair an unsuccessful or cancelled attachment', async () => {
        const record = runtime(); persist(record);
        const records = [toHostedCliRuntimeDescriptor(record)!];
        const h = host();
        vi.mocked(h.registerCliInstance).mockRejectedValueOnce(new Error('attach failed'));
        expect(await restoreHostedSessions(h, records)).toBe(0);
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
        const abort = new AbortController();
        vi.mocked(h.registerCliInstance).mockImplementationOnce(async () => { abort.abort(); });
        await expect(restoreHostedSessions(h, records, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
    });

    it.each(['binding', 'evidence', 'corrupt-registry', 'corrupt-runtime', 'same-uuid-generation', 'owner'])('rechecks %s after attach and detaches on conflict without stopping the runtime', async kind => {
        const record = runtime(); persist(record);
        const h = host();
        const detach = vi.fn(), stop = vi.fn();
        vi.mocked(h.registerCliInstance).mockImplementationOnce(async id => {
            h.adapters.set(id, { detach, stop } as any);
            if (kind === 'binding') registerMeshCoordinator({ meshId: 'mesh-test', sessionId: 'newer', startedAt: 300, hostOwner: owner });
            else if (kind === 'corrupt-registry') writeFileSync(join(config, 'daemon', 'mesh-coordinators.json'), '{invalid');
            else if (kind === 'corrupt-runtime') writeFileSync(join(config, 'session-host', owner.namespace, 'runtimes', id + '.json'), '{invalid');
            else if (kind === 'same-uuid-generation') registerMeshCoordinator({ meshId: 'mesh-test', sessionId: id, startedAt: 999, hostOwner: owner });
            else if (kind === 'owner') h.deps.getHostedBindingOwner = () => foreign;
            else { record.termination = { lifecycle: 'stopped' }; persist(record); }
        });
        expect(await restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).toBe(0);
        expect(detach).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalled();
        if (kind === 'same-uuid-generation') expect(getCoordinatorForSession('coordinator')?.startedAt).toBe(999);
        else expect(getCoordinatorForSession('coordinator')).toBeUndefined();
    });

    it.each(['absent', 'failure', 'newer', 'newer-during-attach', 'failure-during-attach'])('requires a complete current recovery census (%s)', async kind => {
        const record = runtime(); persist(record);
        const h = host();
        if (kind === 'absent') h.deps.listHostedCliRuntimes = undefined;
        if (kind === 'failure') h.deps.listHostedCliRuntimes = async () => { throw new Error('inventory failed'); };
        const newer = runtime('newer'); newer.startedAt = 300;
        if (kind === 'newer') { persist(newer); inventory.records.push(newer); }
        const detach = vi.fn();
        vi.mocked(h.registerCliInstance).mockImplementationOnce(async id => {
            h.adapters.set(id, { detach } as any);
            if (kind === 'newer-during-attach') { persist(newer); inventory.records.push(newer); }
            if (kind === 'failure-during-attach') h.deps.listHostedCliRuntimes = async () => { throw new Error('inventory failed'); };
        });
        expect(await restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).toBe(kind.endsWith('during-attach') ? 0 : 1);
        if (kind.endsWith('during-attach')) expect(detach).toHaveBeenCalledOnce();
        else {
            expect(h.registerCliInstance).toHaveBeenCalledOnce();
            expect(vi.mocked(h.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBeUndefined();
        }
        expect(getCoordinatorForSession(record.sessionId)).toBeUndefined();
    });

    it('cancels during the post-attach census without publishing or stopping the retained runtime', async () => {
        const record = runtime(); persist(record);
        const h = host();
        const abort = new AbortController(), detach = vi.fn(), stop = vi.fn();
        vi.mocked(h.registerCliInstance).mockImplementationOnce(async id => {
            h.adapters.set(id, { detach, stop } as any);
            h.deps.listHostedCliRuntimes = async () => { abort.abort(); return [toHostedCliRuntimeDescriptor(record)!]; };
        });
        await expect(restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!], abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(detach).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalled();
        expect(getCoordinatorForSession(record.sessionId)).toBeUndefined();
    });

    it('requires an exact owned registry entry for legacy marks without launch provenance', async () => {
        const record = runtime(); delete record.meta.launchRecord; persist(record);
        const descriptor = toHostedCliRuntimeDescriptor(record)!;
        const ordinary = host();
        expect(await restoreHostedSessions(ordinary, [descriptor])).toBe(1);
        expect(vi.mocked(ordinary.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBeUndefined();
        const existing = { meshId: 'mesh-test', sessionId: record.sessionId, startedAt: 100, hostOwner: owner,
            systemPrompt: 'synthetic test prompt', injection: { mode: 'cli_arg' } };
        registerMeshCoordinator(existing);
        const h = host();
        expect(await restoreHostedSessions(h, [descriptor])).toBe(1);
        expect(vi.mocked(h.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBe('mesh-test');
        expect(getCoordinatorForSession(record.sessionId)).toEqual(existing);
    });

    it('rejects an exact foreign binding and inconsistent exact mesh evidence', async () => {
        const record = runtime(); persist(record);
        for (const binding of [
            { meshId: 'mesh-test', hostOwner: foreign },
            { meshId: 'different-mesh', hostOwner: owner },
        ]) {
            registerMeshCoordinator({ ...binding, sessionId: record.sessionId, startedAt: 100 });
            const h = host();
            expect(await restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).toBe(1);
            expect(vi.mocked(h.registerCliInstance).mock.calls[0][6].meshCoordinatorFor).toBeUndefined();
            expect(getCoordinatorForSession(record.sessionId)).toMatchObject(binding);
        }
    });
});
