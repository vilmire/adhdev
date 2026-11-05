import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverService, type DriverServicePorts } from '../../src/drivers/driver-service.js';
import { DriverActivationStore, type InstalledDriverManifest } from '../../src/drivers/activation-store.js';
import { DriverGrantStore } from '../../src/drivers/grant-store.js';
import { AssistantDriverStaging } from '../../src/assistant/driver-staging.js';
import { DriverActionStaging } from '../../src/drivers/staged-action.js';
import { validateDriverProviderManifest } from '../../src/providers/sdk/v1/validators/manifest.js';
import type { DriverCall } from '../../src/drivers/mcp-client.js';

const mockedTimeouts: Array<number | undefined> = [];
vi.mock('../../src/drivers/managed-mcp-process.js', () => ({
    ManagedMcpProcess: class {
        state = 'running';
        constructor(_runtime: unknown, options: { requestTimeoutMs?: number }) { mockedTimeouts.push(options.requestTimeoutMs); }
        async start() {}
        async listTools() { return []; }
        callTool(): DriverCall { return Object.assign(Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }), { id: 'c' }) as DriverCall; }
        cancel() {}
        async close() {}
    },
}));

let dir: string, digest: string, now: number;
let manifest: InstalledDriverManifest;
let ports: DriverServicePorts;
let service: DriverService;
let grants: DriverGrantStore;
let activations: DriverActivationStore;
let staging: AssistantDriverStaging;
let calls: number;
const worker = { meshId: 'mesh', taskId: 'task', sessionId: 'session', attemptId: 'attempt' };
const click = { type: 'cu', action: 'click', args: { x: 1 } };
const build = (extra: Partial<DriverServicePorts> = {}) => {
    ports = { registry: { getByCategory: vi.fn(() => [manifest]) },
        readCurrent: () => ({ module: manifest, treeDigest: digest, cwd: dir }), activations, activationStaging: staging,
        actions: new DriverActionStaging(dir, () => now), policy: vi.fn(async () => ({})), relay: vi.fn(() => ({ ok: true })),
        now: () => now, grants,
        createProcess: vi.fn(() => ({ state: 'running', start: vi.fn(async () => {}), listTools: vi.fn(async () => []),
            callTool: vi.fn(() => { calls++; return Object.assign(Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }), { id: 'c' }) as DriverCall; }),
            cancel: vi.fn(), close: vi.fn(async () => {}) })), ...extra };
    service = new DriverService(ports);
};
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'driver-grants-')); now = Date.now(); calls = 0; mockedTimeouts.length = 0;
    digest = `sha256:${'c'.repeat(64)}`;
    manifest = { type: 'cu', name: 'Computer', category: 'driver', providerVersion: '1.0.0', _sourceTrust: 'trusted',
        runtime: { kind: 'mcp-stdio', command: process.execPath },
        grants: [{ id: 'input', title: 'Input', description: 'Click and type' }, { id: 'shell', title: 'Shell' }],
        actions: [{ id: 'click', tool: 'click', risk: 'write', grant: 'input', inputSchema: 'input.json' },
            { id: 'run', tool: 'run', risk: 'write', grant: 'shell', lease: false },
            { id: 'plain', tool: 'plain', risk: 'read' }],
        resources: [{ key: 'desktop', lease: 'session' }] };
    writeFileSync(join(dir, 'input.json'), JSON.stringify({ type: 'object' }));
    activations = new DriverActivationStore({ configDir: dir, now: () => new Date(now) });
    activations.approve(manifest, digest);
    staging = new AssistantDriverStaging({ configDir: dir });
    grants = new DriverGrantStore({ configDir: dir });
    build();
});
afterEach(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });

describe('grant gate', () => {
    it('refuses by default with driver_grant_required naming the grant, and never starts a process', async () => {
        expect(await service.invoke(worker, click)).toMatchObject({ success: false, code: 'driver_grant_required', grant: 'input' });
        expect(ports.createProcess).not.toHaveBeenCalled();
    });
    it('passes once granted, and unchecking refuses the very next call', async () => {
        grants.set('cu', { input: true });
        expect(await service.invoke(worker, click)).toMatchObject({ success: true });
        grants.set('cu', { input: false });
        expect(await service.invoke(worker, click)).toMatchObject({ code: 'driver_grant_required', grant: 'input' });
        expect(calls).toBe(1);
    });
    it('is checked before destructive staging and before the lease', async () => {
        manifest.actions.push({ id: 'wipe', tool: 'wipe', risk: 'destructive', grant: 'input' });
        expect(await service.invoke(worker, { type: 'cu', action: 'wipe' })).toMatchObject({ code: 'driver_grant_required' });
        expect(ports.actions.list()).toHaveLength(0);
        grants.set('cu', { input: true });
        await service.invoke(worker, click);
        grants.set('cu', { input: false });
        expect(await service.invoke({ ...worker, sessionId: 'other' }, click)).toMatchObject({ code: 'driver_grant_required' });
    });
    it('actions without a grant are unaffected', async () => {
        expect(await service.invoke(worker, { type: 'cu', action: 'plain' })).toMatchObject({ success: true });
    });
    it('a grant removed during schema I/O refuses that call and keeps no lease', async () => {
        grants.set('cu', { input: true });
        // The policy lookup runs after schema validation: revoke there.
        let n = 0;
        ports.policy = vi.fn(async () => { if (++n === 2) grants.set('cu', { input: false }); return {}; });
        expect(await service.invoke(worker, click)).toMatchObject({ code: 'driver_grant_required' });
        expect(ports.createProcess).not.toHaveBeenCalled();
        grants.set('cu', { input: true });
        expect(await service.invoke({ ...worker, sessionId: 'other' }, click)).toMatchObject({ success: true });
    });
    it('a missing grants port refuses every action that declares a grant', async () => {
        await service.close();
        build({ grants: undefined });
        expect(await service.invoke(worker, click)).toMatchObject({ code: 'driver_grant_required' });
        expect(await service.invoke(worker, { type: 'cu', action: 'plain' })).toMatchObject({ success: true });
    });
    it('a corrupt grants.json refuses, and writes are refused instead of overwriting it', async () => {
        grants.set('cu', { input: true });
        writeFileSync(grants.path, '{not json');
        expect(await service.invoke(worker, click)).toMatchObject({ code: 'driver_grant_required' });
        expect(() => grants.set('cu', { input: true })).toThrow();
        expect(readFileSync(grants.path, 'utf8')).toBe('{not json');
        expect(service.setGrants('cu', { input: true })).toMatchObject({ success: false, code: 'grants_unavailable' });
        expect(grants.snapshot('cu', ['input', 'shell'])).toEqual({ input: false, shell: false });
    });
    it('lease:false skips the lease check while another session holds the lease', async () => {
        grants.set('cu', { input: true, shell: true });
        expect(await service.invoke(worker, click)).toMatchObject({ success: true });
        expect(await service.invoke({ ...worker, sessionId: 'other' }, click)).toMatchObject({ code: 'lease_held' });
        expect(await service.invoke({ ...worker, sessionId: 'other' }, { type: 'cu', action: 'run' })).toMatchObject({ success: true });
        expect(service.invocations().at(-1)).toMatchObject({ action: 'run', resourceKeys: [] });
    });
    it('passes runtime.requestTimeoutMs to the managed process, and omits it otherwise', async () => {
        await service.close();
        manifest.runtime.requestTimeoutMs = 330000;
        const real = new DriverService({ ...ports, createProcess: undefined });
        grants.set('cu', { input: true });
        await real.invoke(worker, click);
        await real.close();
        expect(mockedTimeouts).toEqual([330000]);
        delete manifest.runtime.requestTimeoutMs;
        const again = new DriverService({ ...ports, createProcess: undefined });
        await again.invoke({ ...worker, sessionId: 'x' }, click);
        await again.close();
        expect(mockedTimeouts).toEqual([330000, undefined]);
    });
    it('grants survive a driver digest change', () => {
        grants.set('cu', { input: true });
        expect(new DriverGrantStore({ configDir: dir }).isGranted('cu', 'input')).toBe(true);
    });
});

describe('getGrants / setGrants', () => {
    it('lists only drivers that declare grants; no staging side effect', () => {
        const prepare = vi.spyOn(staging, 'prepare'); const write = vi.spyOn(staging, 'write');
        const res = service.getGrants() as any;
        expect(res.drivers).toEqual([expect.objectContaining({ type: 'cu', activation: 'ready', platformSupported: true,
            grants: [{ id: 'input', title: 'Input', description: 'Click and type', granted: false }, { id: 'shell', title: 'Shell', description: '', granted: false }] })]);
        expect(prepare).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
        manifest = { ...manifest, grants: undefined, actions: [{ id: 'plain', tool: 'p', risk: 'read' }] };
        expect((service.getGrants() as any).drivers).toEqual([]);
    });
    it('reports needs_approval (stagedId only when one exists) and platformSupported', () => {
        digest = `sha256:${'d'.repeat(64)}`; manifest.runtime.platforms = ['win32', 'linux', 'darwin'].filter(p => p !== process.platform) as any;
        let entry = (service.getGrants() as any).drivers[0];
        expect(entry).toMatchObject({ activation: 'needs_approval', platformSupported: false });
        expect(entry.stagedId).toBeUndefined();
        const id = staging.write(manifest, digest);
        entry = (service.getGrants() as any).drivers[0];
        expect(entry.stagedId).toBe(id);
    });
    it('reports disabled', () => {
        activations.setDisabled(manifest, digest, true);
        expect((service.getGrants() as any).drivers[0].activation).toBe('disabled');
    });
    it('rejects undeclared ids and non-boolean values with invalid_arguments, writing nothing', () => {
        expect(service.setGrants('cu', { nope: true })).toMatchObject({ code: 'invalid_arguments' });
        expect(service.setGrants('cu', { input: true, nope: true })).toMatchObject({ code: 'invalid_arguments' });
        expect(service.setGrants('cu', { input: 'yes' })).toMatchObject({ code: 'invalid_arguments' });
        expect(grants.isGranted('cu', 'input')).toBe(false);
    });
    it('trusted driver is activated by the check (even after an owner disable)', () => {
        digest = `sha256:${'e'.repeat(64)}`;
        expect(activations.isReady('cu', digest)).toBe(false);
        const res = service.setGrants('cu', { input: true }) as any;
        expect(res).toMatchObject({ success: true, activation: 'ready' });
        expect(res.grants.find((g: any) => g.id === 'input').granted).toBe(true);
        activations.setDisabled(manifest, digest, true);
        expect(service.setGrants('cu', { shell: true })).toMatchObject({ success: true, activation: 'ready' });
    });
    it('untrusted driver gets an Inbox proposal and stagedId, not an activation', () => {
        manifest._sourceTrust = 'community'; digest = `sha256:${'f'.repeat(64)}`;
        const res = service.setGrants('cu', { input: true }) as any;
        expect(res).toMatchObject({ success: true, activation: 'needs_approval', stagedId: expect.stringMatching(/^driver-activation-/) });
        expect(activations.isReady('cu', digest)).toBe(false);
    });
    it('unchecking only does not activate anything', () => {
        digest = `sha256:${'9'.repeat(64)}`;
        expect(service.setGrants('cu', { input: false })).toMatchObject({ success: true, activation: 'needs_approval' });
        expect(activations.isReady('cu', digest)).toBe(false);
    });
});

describe('manifest validation', () => {
    const base = () => ({ type: 'cu', name: 'C', category: 'driver', providerVersion: '1.0.0',
        runtime: { kind: 'mcp-stdio', command: 'node', requestTimeoutMs: 330000 },
        grants: [{ id: 'input', title: 'Input', description: 'd' }],
        actions: [{ id: 'click', tool: 'click', risk: 'write', grant: 'input', lease: true }] });
    it('accepts the new fields', () => expect(validateDriverProviderManifest(base())).toEqual({ ok: true, issues: [] }));
    it('an action.grant naming an undeclared grant is invalid', () => {
        const m = base(); m.actions[0]!.grant = 'other';
        expect(validateDriverProviderManifest(m)).toMatchObject({ ok: false, issues: [{ path: '/actions/0/grant', keyword: 'undeclaredGrant' }] });
        const none = base() as any; delete none.grants;
        expect(validateDriverProviderManifest(none).ok).toBe(false);
    });
    it('rejects duplicate grant ids, bad timeouts and more than 8 grants', () => {
        const dup = base(); dup.grants.push({ id: 'input', title: 'x', description: '' });
        expect(validateDriverProviderManifest(dup).ok).toBe(false);
        const slow = base(); slow.runtime.requestTimeoutMs = 999;
        expect(validateDriverProviderManifest(slow).ok).toBe(false);
        slow.runtime.requestTimeoutMs = 600001;
        expect(validateDriverProviderManifest(slow).ok).toBe(false);
        const many = base(); many.grants = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, title: 't', description: '' }));
        expect(validateDriverProviderManifest(many).ok).toBe(false);
    });
});
