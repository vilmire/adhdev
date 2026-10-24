import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHostRecord } from '@adhdev/session-host-core';
import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';

const host = vi.hoisted(() => ({ record: {} as any, requests: [] as any[], rejectMeta: false, stopSupported: true,
    waitMeta: null as Promise<void> | null }));
vi.mock('@adhdev/session-host-core', async importOriginal => {
    const original = await importOriginal<typeof import('@adhdev/session-host-core')>();
    return { ...original, SessionHostClient: class {
        async connect() {}
        async close() {}
        onEvent() { return () => {}; }
        onDisconnect() { return () => {}; }
        async request(r: any) {
            host.requests.push(r);
            if (r.type === 'list_sessions') return { success: true, result: [structuredClone(host.record)] };
            if (r.type === 'get_snapshot') return { success: true, result: { seq: 0, text: '', truncated: false } };
            if (r.type === 'update_session_meta') {
                await host.waitMeta;
                if (host.rejectMeta) return { success: false, error: 'metadata write rejected' };
                host.record.meta = { ...host.record.meta, ...r.payload.meta };
            }
            if (r.type === 'stop_mesh_writer') return { success: host.stopSupported, error: host.stopSupported ? undefined : 'unknown request' };
            return { success: true, result: structuredClone(host.record) };
        }
    } };
});

beforeEach(() => {
    host.requests = []; host.rejectMeta = false; host.stopSupported = true; host.waitMeta = null;
    host.record = { sessionId: 'writer', runtimeKey: 'kernel-incarnation', startedAt: 123456, osPid: 417, lifecycle: 'running',
        providerType: 'antigravity-cli', workspace: '/fake/worktree', writeOwner: { clientId: 'source-client', ownerType: 'agent' },
        attachedClients: [], meta: {}, buffer: { scrollbackBytes: 0, snapshotSeq: 0 } } as SessionHostRecord;
});
async function transport() {
    const t = new SessionHostPtyTransportFactory({ clientId: 'source-client', runtimeId: 'writer', providerType: 'antigravity-cli',
        workspace: '/fake/worktree', attachExisting: true }).spawn('fake-provider', [], { cwd: '/fake/worktree', env: {}, cols: 80, rows: 24 });
    await t.ready;
    return t;
}

describe('fresh native assignment acknowledgement without a real host or process', () => {
    it('waits for the queued metadata write, then verifies a fresh exact native record', async () => {
        const t = await transport();
        let release!: () => void;
        host.waitMeta = new Promise<void>(resolve => { release = resolve; });
        const expected = { meshActiveAttemptRef: { attemptId: 'attempt', generation: 1 } };
        t.updateMeta!(expected);
        let done = false;
        const check = t.verifyMeta!(expected).then(r => { done = true; return r; });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(done).toBe(false);
        release(); expect(await check).toBe(true);
        expect(host.requests.at(-1).type).toBe('list_sessions');
    });
    it('a failed native metadata write grants no attach proof', async () => {
        const t = await transport(); host.rejectMeta = true;
        t.updateMeta!({ meshActiveAttemptRef: { attemptId: 'attempt', generation: 1 } });
        expect(await t.verifyMeta!({ meshActiveAttemptRef: { attemptId: 'attempt', generation: 1 } })).toBe(false);
    });
    it.each(['foreign_write_owner','new_runtime'] as const)('refuses %s as native attach proof', async mode => {
        const t = await transport();
        if (mode === 'foreign_write_owner') host.record.writeOwner.clientId = 'foreign-client';
        else host.record.runtimeKey = 'replacement-incarnation';
        expect(await t.verifyMeta!({})).toBe(false);
    });
    it('uses only the new atomic stop verb; an old host receives no generic stop or input fallback', async () => {
        const t = await transport(); host.stopSupported = false;
        const assignment = { meshId: 'mesh', nodeId: 'node', taskId: 'task', attemptId: 'attempt', generation: 0, dispatchNonce: 1, ownerDaemonId: 'owner' };
        expect(await t.stopMeshWriter!({ runtimeKey: 'kernel-incarnation', startedAt: 123456, osPid: 417, providerType: 'antigravity-cli', assignment })).toBe(false);
        expect(host.requests.at(-1)).toMatchObject({ type: 'stop_mesh_writer', payload: { sessionId: 'writer', clientId: 'source-client', assignment } });
        expect(host.requests.some(r => r.type === 'stop_session' || r.type === 'send_input')).toBe(false);
    });
});
