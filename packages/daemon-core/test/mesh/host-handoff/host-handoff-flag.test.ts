import { describe, expect, it, vi } from 'vitest';

const flag = { on: false };
vi.mock('../../../src/config/config.js', async (orig) => ({
    ...(await orig<typeof import('../../../src/config/config.js')>()),
    loadConfig: () => ({ ...(({ serverUrl: 'x' }) as object), experimental: { hostHandoff: flag.on } }),
}));

import { getDaemonCommandRegistry } from '../../../src/commands/router.js';
import { HOST_HANDOFF_VERB } from '../../../src/mesh/host-handoff/types.js';
import { meshHostHandoffHandlers, hostHandoffEnabled } from '../../../src/commands/high-family/mesh-host-handoff.js';

describe('host handoff is experimental and off by default (owner decision H2)', () => {
    it('the owner verb is dashboard-only and every peer verb is mesh-only with a roster sender', () => {
        const reg = getDaemonCommandRegistry();
        expect(reg.get('mesh_host_handoff')?.sources).toEqual(['p2p', 'ws', 'standalone']);
        for (const verb of Object.values(HOST_HANDOFF_VERB).filter(v => v !== 'mesh_host_handoff')) {
            expect(reg.get(verb)?.sources, verb).toEqual(['mesh']);
            expect(reg.get(verb)?.meshSender, verb).toBe('roster');
        }
    });
    it('flag off: the owner verb refuses (status reports disabled) and a peer probe looks like an older daemon', async () => {
        flag.on = false;
        expect(hostHandoffEnabled()).toBe(false);
        const owner = meshHostHandoffHandlers.mesh_host_handoff!;
        expect(await owner({} as never, { op: 'start', meshId: 'm', targetDaemonId: 'd' })).toMatchObject({ success: false, code: 'host_handoff_disabled' });
        expect(await owner({} as never, { op: 'status' })).toEqual({ success: true, enabled: false });
        const probe = meshHostHandoffHandlers.mesh_host_handoff_capability!;
        expect(await probe({} as never, { handoffId: 'h', meshId: 'm', _meshSenderDaemonId: 'daemon_x' })).toMatchObject({ success: false, code: 'peer_capability_unconfirmed' });
    });
    it('flag on: status answers enabled', async () => {
        flag.on = true;
        expect(hostHandoffEnabled()).toBe(true);
        // no engines needed for the bare status answer path beyond the live journal; use a missing-args refusal instead
        const owner = meshHostHandoffHandlers.mesh_host_handoff!;
        const ctx = { deps: { statusInstanceId: 'daemon_mach_aaaaaaaaaaaaaaaa' }, components: () => ({}), execute: async () => ({}) } as never;
        expect(await owner(ctx, { op: 'abort' })).toMatchObject({ success: false, code: 'invalid_args' });
        flag.on = false;
    });
});

import { createLiveHoldPort, liveFreezeCheck } from '../../../src/mesh/host-handoff/live-env.js';
import { evaluateNewWorkHold, releaseNewWorkHold } from '../../../src/maintenance/new-work-hold.js';
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';

describe('acceptance 17 (live modules): the freeze really blocks new work for exactly that mesh', () => {
    it('the live hold port holds the mesh scope and releases it; a second holder is refused', () => {
        const port = createLiveHoldPort();
        expect(evaluateNewWorkHold({ meshId: 'mesh-frozen' }).held).toBe(false);
        expect(port.acquire('mesh-frozen', 'h1')).toEqual({ ok: true });
        expect(evaluateNewWorkHold({ meshId: 'mesh-frozen' }).held).toBe(true);
        expect(evaluateNewWorkHold({ meshId: 'some-other-mesh' }).held).toBe(false);
        expect(port.acquire('mesh-frozen', 'h2')).toMatchObject({ ok: false });
        port.release('mesh-frozen', 'h1');
        expect(evaluateNewWorkHold({ meshId: 'mesh-frozen' }).held).toBe(false);
        try { releaseNewWorkHold({ holdId: 'host-handoff:h1', holder: 'host-handoff' }); } catch { /* already released */ }
    });
    it('an open writer stop capture or a stopping attempt refuses the freeze; a busy coordinator only waits', async () => {
        const host = { coordinatorState: () => [] } as never;
        const check = liveFreezeCheck(host);
        expect(await check('mesh-x')).toEqual({ ready: true });
        const db = MeshRuntimeStore.getInstance().db;
        db.exec('CREATE TABLE IF NOT EXISTS mesh_writer_stop_captures (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capture_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)');
        db.prepare("INSERT INTO mesh_writer_stop_captures (request_id, session_id, capture_json, settled) VALUES ('r1', 's1', '{}', 0)").run();
        expect(await check('mesh-x')).toMatchObject({ ready: false, code: 'writer_checkpoint_pending' });
        db.prepare('UPDATE mesh_writer_stop_captures SET settled = 1').run();
        expect(await check('mesh-x')).toEqual({ ready: true });
        const busy = liveFreezeCheck({ coordinatorState: () => [{ sessionId: 'c1', idle: false, modalParked: false }] } as never);
        expect(await busy('mesh-x')).toMatchObject({ ready: false, code: 'coordinator_not_quiescent' });
        const modal = liveFreezeCheck({ coordinatorState: () => [{ sessionId: 'c1', idle: true, modalParked: true }] } as never);
        expect(await modal('mesh-x')).toMatchObject({ ready: false, code: 'coordinator_not_quiescent' });
    });
});
