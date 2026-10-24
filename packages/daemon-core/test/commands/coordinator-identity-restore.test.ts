import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreHostedSessions, type CliRestoreHost } from '../../src/commands/cli-manager-restore.js';
import { toHostedCliRuntimeDescriptor } from '../../src/commands/low-family/session-host.js';
import { listHostedCliRuntimes } from '../../src/session-host/runtime-support.js';
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
    setAssistantRegistryForTests(null);
    rmSync(config, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfig;
});

describe('exact persisted coordinator identity recovery', () => {
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
        await expect(restoreHostedSessions(h, [descriptor])).rejects.toThrow('coordinator_identity_');
        expect(h.registerCliInstance).not.toHaveBeenCalled();
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
        await expect(restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).rejects.toThrow('coordinator_identity_conflict');
        expect(h.registerCliInstance).not.toHaveBeenCalled();
        expect(getCoordinatorForSession('newer')).toEqual(newer);
        expect(getCoordinatorForSession('coordinator')).toBeUndefined();
    });

    it('refuses two genuine candidates for one mesh before attaching either', async () => {
        const records = [runtime(), runtime('second')]; records.forEach(r => persist(r));
        const h = host(records.map(r => toHostedCliRuntimeDescriptor(r)!));
        await expect(restoreHostedSessions(h)).rejects.toThrow('coordinator_identity_conflict');
        expect(h.registerCliInstance).not.toHaveBeenCalled();
    });

    it.each(['starting', 'stopping', 'interrupted', 'foreign-managed'])('a newer %s candidate excludes recovery without being attached', async lifecycle => {
        const record = runtime(); persist(record);
        const newer = runtime('newer'); newer.startedAt = 300;
        if (lifecycle === 'foreign-managed') newer.meta.managedBy = foreign.managedBy;
        else newer.lifecycle = lifecycle;
        inventory.records = [record, newer];
        const records = inventory.records.map(r => toHostedCliRuntimeDescriptor(r)!);
        const h = host(records);
        await expect(restoreHostedSessions(h)).rejects.toMatchObject({ code: 'coordinator_identity_conflict' });
        expect(h.registerCliInstance).not.toHaveBeenCalled();
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
        await expect(restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).rejects.toThrow('coordinator_identity_');
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
        await expect(restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).rejects.toMatchObject({ code: 'coordinator_identity_conflict' });
        if (kind.endsWith('during-attach')) expect(detach).toHaveBeenCalledOnce();
        else expect(h.registerCliInstance).not.toHaveBeenCalled();
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
        await expect(restoreHostedSessions(host(), [descriptor])).rejects.toMatchObject({ code: 'coordinator_identity_conflict' });
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
            await expect(restoreHostedSessions(h, [toHostedCliRuntimeDescriptor(record)!])).rejects.toMatchObject({ code: 'coordinator_identity_conflict' });
            expect(h.registerCliInstance).not.toHaveBeenCalled();
            expect(getCoordinatorForSession(record.sessionId)).toMatchObject(binding);
        }
    });
});
