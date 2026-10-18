import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverService, type DriverServicePorts } from '../../src/drivers/driver-service.js';
import { DriverActivationStore, type InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';
import { DriverActionStaging } from '../../src/drivers/staged-action.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import type { DriverCall } from '../../src/drivers/mcp-client.js';

let dir: string;
let service: DriverService;
let now: number;
let digest: string;
let manifest: InstalledDriverManifest;
let ports: DriverServicePorts;
let activations: DriverActivationStore;
let actions: DriverActionStaging;
let policy: Record<string, { actions: string[] }> | undefined;
let calls: number;
const worker = { meshId: 'mesh', taskId: 'task', sessionId: 'session', attemptId: 'attempt' };
const input = { type: 'browser', action: 'read', args: { message: 'hello' } };
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'driver-service-'));
    now = Date.now(); digest = `sha256:${'a'.repeat(64)}`; calls = 0;
    manifest = { type: 'browser', name: 'Browser', category: 'driver', providerVersion: '1.0.0', _sourceTrust: 'trusted',
        runtime: { kind: 'mcp-stdio', command: process.execPath },
        actions: [{ id: 'read', tool: 'echo', risk: 'read', inputSchema: 'input.json' },
            { id: 'erase', tool: 'erase', risk: 'destructive', inputSchema: 'input.json' }],
        resources: [{ key: 'profile', lease: 'session' }] };
    writeFileSync(join(dir, 'input.json'), JSON.stringify({ type: 'object', required: ['message'],
        properties: { message: { type: 'string' } }, additionalProperties: false }));
    activations = new DriverActivationStore({ configDir: dir, now: () => new Date(now) });
    activations.approve(manifest, digest);
    actions = new DriverActionStaging(dir, () => now);
    policy = { browser: { actions: ['read', 'erase'] } };
    ports = { registry: { getByCategory: vi.fn(() => [manifest]) },
        readCurrent: () => ({ module: manifest, treeDigest: digest, cwd: dir }), activations,
        activationStaging: new AssistantDriverStaging({ configDir: dir }), actions,
        policy: vi.fn(async () => policy), relay: vi.fn(() => ({ ok: true })), bus: createSessionLifecycleBus(), now: () => now,
        createProcess: vi.fn(() => ({ state: 'running', start: vi.fn(async () => {}), listTools: vi.fn(async () => []),
            callTool: vi.fn((_name, args) => { calls++; return Object.assign(Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(args) }] }), { id: 'call' }) as DriverCall; }),
            cancel: vi.fn(), close: vi.fn(async () => {}) })) };
    service = new DriverService(ports);
});
afterEach(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });

describe('six ordered permission gates', () => {
    it('1: requires proven Worker credentials before activation or policy', async () => {
        expect(await service.invoke(null, input)).toMatchObject({ code: 'worker_credential_required' });
        expect(ports.policy).not.toHaveBeenCalled();
    });
    it('2: rejects unapproved digests before mesh policy', async () => {
        digest = `sha256:${'b'.repeat(64)}`;
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_not_approved' });
        expect(ports.policy).not.toHaveBeenCalled();
    });
    it('3: rejects absent policy and disallowed or undeclared actions', async () => {
        policy = undefined;
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_not_allowed_for_mesh' });
        policy = { browser: { actions: ['unknown'] } };
        expect(await service.invoke(worker, { ...input, action: 'unknown' })).toMatchObject({ code: 'driver_not_allowed_for_mesh' });
    });
    it('4: creates a fixed destructive request without spawning or acquiring a lease', async () => {
        const args = { message: 'fixed' };
        const result = await service.invoke(worker, { ...input, action: 'erase', args });
        expect(result).toMatchObject({ code: 'owner_approval_required', expiresAt: now + 30 * 60_000 });
        args.message = 'mutated';
        expect(actions.read(String(result.stagedId))).toMatchObject({ kind: 'driver_action_request', args: { message: 'fixed' },
            activationDigest: digest, requesterTaskId: worker.taskId });
        expect(ports.createProcess).not.toHaveBeenCalled();
        expect(await service.invoke({ ...worker, sessionId: 'other' }, input)).toMatchObject({ success: true });
    });
    it('5: refuses a different session holding the resource before checking arguments', async () => {
        await service.invoke(worker, input);
        expect(await service.invoke({ ...worker, sessionId: 'other' }, { ...input, args: {} })).toMatchObject({ code: 'lease_held' });
        expect(calls).toBe(1);
    });
    it('6: refuses invalid arguments without creating a process or retaining a new lease', async () => {
        expect(await service.invoke(worker, { ...input, args: {} })).toMatchObject({ code: 'invalid_arguments' });
        expect(ports.createProcess).not.toHaveBeenCalled();
        expect(await service.invoke({ ...worker, sessionId: 'other' }, input)).toMatchObject({ success: true });
    });
    it('refuses schema path traversal', async () => {
        manifest.actions[0].inputSchema = '../outside.json';
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'invalid_arguments' });
        expect(ports.createProcess).not.toHaveBeenCalled();
    });
    it('rechecks revocation while awaiting schema/policy I/O', async () => {
        let n = 0;
        ports.policy = async () => { if (++n === 2) activations.setDisabled(manifest, digest, true); return policy; };
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_not_approved' });
        expect(ports.createProcess).not.toHaveBeenCalled();
    });
});

describe('leases, state and invocation history', () => {
    it('releases leases on SessionLifecycleBus terminated', async () => {
        await service.invoke(worker, input);
        ports.bus!.emit({ kind: 'terminated', sessionId: worker.sessionId, at: now, cause: 'user', providerType: 'test', runtimeSettings: {} } as never);
        expect(await service.invoke({ ...worker, sessionId: 'other' }, input)).toMatchObject({ success: true });
    });
    it('isolates declared resource keys and refuses undeclared keys', async () => {
        manifest.resources!.push({ key: 'second-profile', lease: 'session' });
        expect(await service.invoke(worker, { ...input, resourceKey: 'profile' })).toMatchObject({ success: true });
        expect(await service.invoke({ ...worker, sessionId: 'other' }, { ...input, resourceKey: 'second-profile' })).toMatchObject({ success: true });
        expect(await service.invoke(worker, { ...input, resourceKey: 'undeclared' })).toMatchObject({ code: 'invalid_arguments' });
    });
    it('expires leases and allows reuse by the same session', async () => {
        await service.invoke(worker, input);
        expect(await service.invoke(worker, input)).toMatchObject({ success: true });
        now += 31 * 60_000;
        expect(await service.invoke({ ...worker, sessionId: 'other' }, input)).toMatchObject({ success: true });
    });
    it('reports ready/running and keeps a bounded immutable history', async () => {
        expect(await service.list()).toMatchObject({ success: true, drivers: [{ state: 'ready' }] });
        expect(ports.registry.getByCategory).toHaveBeenCalledWith('driver');
        for (let i = 0; i < 102; i++) await service.invoke(worker, input);
        expect(await service.describe('browser')).toMatchObject({ state: 'running' });
        expect(service.invocations()).toHaveLength(100);
        expect(service.invocations()[0]).toMatchObject({ status: 'completed', caller: { kind: 'worker', taskId: 'task' } });
        service.invocations()[0].status = 'failed';
        expect(service.invocations()[0].status).toBe('completed');
    });
    it('never restarts a crashed process and returns a structured failure', async () => {
        ports.createProcess = vi.fn(() => ({ state: 'failed', start: vi.fn(async () => { throw Error('crash'); }),
            listTools: vi.fn(), callTool: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_execution_failed' });
        expect(await service.describe('browser')).toMatchObject({ state: 'failed' });
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_execution_failed' });
        expect(ports.createProcess).toHaveBeenCalledTimes(1);
    });
    it('disabled wins and stops an existing process', async () => {
        await service.invoke(worker, input);
        expect(await service.setEnabled('browser', false)).toMatchObject({ state: 'installed' });
        expect(await service.invoke(worker, input)).toMatchObject({ code: 'driver_not_approved' });
    });
    it('trusted elevated requires the owner toggle, untrusted still requires staging', async () => {
        digest = `sha256:${'c'.repeat(64)}`;
        expect(await service.describe('browser')).toMatchObject({ state: 'installed' });
        expect(await service.setEnabled('browser', true)).toMatchObject({ state: 'ready' });
        manifest._sourceTrust = 'user-custom'; digest = `sha256:${'d'.repeat(64)}`;
        activations.setDisabled(manifest, digest, true);
        expect(await service.setEnabled('browser', true)).toMatchObject({ state: 'installed', stagedId: expect.any(String) });
        expect(activations.isReady('browser', digest)).toBe(false);
    });
    it('explicitly refuses remote targets', async () => {
        expect(await service.invoke(worker, { ...input, target: 'another-machine' })).toMatchObject({ code: 'unsupported' });
    });
});

describe('owner destructive approval', () => {
    const stage = async () => String((await service.invoke(worker, { ...input, action: 'erase' })).stagedId);
    it('expires after 31 minutes without execution', async () => {
        const id = await stage(); now += 31 * 60_000;
        expect(await service.resolveAction(id, 'apply', 'ws')).toMatchObject({ result: 'expired' });
        expect(calls).toBe(0);
    });
    it('is stale after a digest change, even if that digest was approved', async () => {
        const id = await stage(); digest = `sha256:${'e'.repeat(64)}`; activations.approve(manifest, digest);
        expect(await service.resolveAction(id, 'apply', 'p2p')).toMatchObject({ result: 'stale' });
        expect(calls).toBe(0);
    });
    it('executes exactly once, credits the owner, and relays to the fixed requesting task', async () => {
        const id = await stage();
        expect(await service.resolveAction(id, 'apply', 'standalone')).toMatchObject({ success: true });
        expect(await service.resolveAction(id, 'apply', 'standalone')).toMatchObject({ code: 'already_resolved' });
        expect(calls).toBe(1);
        expect(ports.relay).toHaveBeenCalledWith(worker, expect.objectContaining({ stagedId: id, success: true }));
        expect(service.invocations()[0].caller).toMatchObject({ kind: 'owner', source: 'standalone', stagedRequestId: id });
    });
    it('simultaneous approvals execute once; discard also prevents replay', async () => {
        const id = await stage();
        const results = await Promise.all([service.resolveAction(id, 'apply', 'ws'), service.resolveAction(id, 'apply', 'ws')]);
        expect(results.filter(r => r.success)).toHaveLength(1);
        expect(calls).toBe(1);
        const second = await stage();
        expect(await service.resolveAction(second, 'discard', 'ws')).toMatchObject({ result: 'discarded' });
        expect(await service.resolveAction(second, 'apply', 'ws')).toMatchObject({ code: 'already_resolved' });
    });
    it('does not execute if approval expires during policy I/O', async () => {
        const id = await stage();
        ports.policy = async () => { now += 31 * 60_000; return policy; };
        expect(await service.resolveAction(id, 'apply', 'ws')).toMatchObject({ code: 'expired' });
        expect(calls).toBe(0);
    });
    it('rechecks machine approval before owner execution', async () => {
        const id = await stage(); activations.setDisabled(manifest, digest, true);
        expect(await service.resolveAction(id, 'apply', 'ws')).toMatchObject({ code: 'driver_not_approved' });
        expect(calls).toBe(0);
    });
});
