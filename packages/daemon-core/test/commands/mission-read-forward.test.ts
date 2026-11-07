import { describe, expect, it, vi } from 'vitest';
import { withMissionReadForward, MISSION_READ_FORWARDED_KEY, missionReadRelaySpecs } from '../../src/commands/low-family/mission-read-forward.js';

const SELF = 'daemon_mach_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST = 'daemon_mach_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function ctxFor(meshHost: Record<string, unknown> | undefined, dispatch?: (...a: any[]) => Promise<unknown>) {
    return {
        deps: { statusInstanceId: SELF, ...(dispatch ? { dispatchMeshCommand: dispatch } : {}) },
        getMeshForCommand: async () => ({ mesh: { id: 'm1', nodes: [], ...(meshHost ? { meshHost } : {}) } }),
    } as any;
}
const localRun = vi.fn(async (_ctx: any, args: any) => ({ success: true, missions: ['local'], seenArgs: args }));

describe('mission reads on a non-host daemon (live 2026-11-07: a former host served its pre-handoff copy)', () => {
    it('a member forwards the read to the host and returns the host answer', async () => {
        const dispatch = vi.fn(async () => ({ success: true, missions: ['from-host'] }));
        localRun.mockClear();
        const run = withMissionReadForward('mission_query', localRun);
        const res: any = await run(ctxFor({ role: 'member', hostDaemonId: HOST }, dispatch), { v: 1, meshId: 'm1' });
        expect(dispatch).toHaveBeenCalledWith(HOST, 'mission_read_relay', { meshId: 'm1', command: 'mission_query', args: { v: 1, meshId: 'm1' } });
        expect(res.missions).toEqual(['from-host']);
        expect(localRun).not.toHaveBeenCalled();
    });
    it('a former host that handed off (fenced) forwards to the new host', async () => {
        const dispatch = vi.fn(async () => ({ success: true, missions: ['from-new-host'] }));
        const run = withMissionReadForward('mission_list_query', localRun);
        const res: any = await run(ctxFor({ role: 'host', hostDaemonId: SELF, handoffFence: { epoch: 2 }, handedOffTo: { daemonId: HOST, epoch: 2 } }, dispatch), { meshId: 'm1' });
        expect(dispatch.mock.calls[0][0]).toBe(HOST);
        expect(res.missions).toEqual(['from-new-host']);
    });
    it('the host reads its own store', async () => {
        const dispatch = vi.fn();
        localRun.mockClear();
        const run = withMissionReadForward('mission_query', localRun);
        const res: any = await run(ctxFor({ role: 'host', hostDaemonId: SELF }, dispatch), { meshId: 'm1' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(res.missions).toEqual(['local']);
    });
    it('a read that already crossed the relay runs locally without the marker (never bounces)', async () => {
        const dispatch = vi.fn();
        localRun.mockClear();
        const run = withMissionReadForward('mission_query', localRun);
        const res: any = await run(ctxFor({ role: 'member', hostDaemonId: HOST }, dispatch), { meshId: 'm1', [MISSION_READ_FORWARDED_KEY]: true });
        expect(dispatch).not.toHaveBeenCalled();
        expect(res.seenArgs).toEqual({ meshId: 'm1' });
    });
    it('an unreachable host fails loudly instead of serving the stale local copy', async () => {
        const dispatch = vi.fn(async () => { throw new Error('peer offline'); });
        localRun.mockClear();
        const run = withMissionReadForward('mission_query', localRun);
        const res: any = await run(ctxFor({ role: 'member', hostDaemonId: HOST }, dispatch), { meshId: 'm1' });
        expect(res.success).toBe(false);
        expect(res.code).toBe('mesh_host_unreachable');
        expect(localRun).not.toHaveBeenCalled();
    });
    it('the host relay runs only mission reads, locally, never forwarding again', async () => {
        const dispatch = vi.fn();
        localRun.mockClear();
        withMissionReadForward('mission_query', localRun);
        const relay = missionReadRelaySpecs[0];
        expect(relay.sources).toEqual(['mesh']);
        const host = ctxFor({ role: 'host', hostDaemonId: SELF }, dispatch);
        const ok: any = await relay.run(host, { meshId: 'm1', command: 'mission_query', args: { meshId: 'm1' } });
        expect(dispatch).not.toHaveBeenCalled();
        expect(ok.seenArgs).toEqual({ meshId: 'm1' });
        // writes / other commands are refused
        expect(((await relay.run(host, { meshId: 'm1', command: 'mission_upsert', args: { meshId: 'm1' } })) as any).code).toBe('mission_read_relay_refused');
        // the gate authorised the top-level mesh: a different nested mesh (or none) is refused
        expect(((await relay.run(host, { meshId: 'm1', command: 'mission_query', args: { meshId: 'other' } })) as any).code).toBe('mission_read_relay_refused');
        expect(((await relay.run(host, { command: 'mission_query', args: { meshId: 'm1' } })) as any).code).toBe('mission_read_relay_refused');
        // a daemon that is not the host of that mesh does not answer
        localRun.mockClear();
        expect(((await relay.run(ctxFor({ role: 'member', hostDaemonId: HOST }, dispatch), { meshId: 'm1', command: 'mission_query', args: { meshId: 'm1' } })) as any).code).toBe('mission_read_relay_refused');
        expect(localRun).not.toHaveBeenCalled();
    });
});
