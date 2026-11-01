import { describe, expect, it } from 'vitest';
import { stopExactMeshWriter } from '../../src/commands/mesh-writer-stop.js';
import type { CancelDispatchRequest } from '../../src/mesh/turn-ledger/effects.js';

const request: CancelDispatchRequest = { sessionId: 'sess-1', meshId: 'm1', taskId: 't1', attemptId: 'a1', generation: 0, dispatchNonce: 0,
    messageId: null, nodeId: 'n1', providerType: 'codex-cli', ownerDaemonId: 'owner', stopRequestId: 'stop-1', inspectOnly: true } as any;

function host(control: unknown, records: Array<{ runtimeId: string }> = []) {
    return { adapters: new Map(), deps: { getInstanceManager: () => ({ getInstance: () => undefined }),
        ...(control ? { idleSessionLifetimeControl: control } : {}), listHostedCliRuntimes: async () => records } } as any;
}

describe('stopExactMeshWriter host_session_absent carries the host boot id', () => {
    it('adds hostBootId from resolveHostBootId to the absence evidence', async () => {
        const res: any = await stopExactMeshWriter(host({ resolveHostBootId: () => 'boot-A' }), request);
        expect(res).toMatchObject({ success: true, quiescent: true, evidence: { kind: 'host_session_absent', sessionId: 'sess-1', hostBootId: 'boot-A' } });
    });
    it('falls back to getDiagnostics().hostBootId', async () => {
        const res: any = await stopExactMeshWriter(host({ getDiagnostics: async () => ({ hostBootId: 'boot-D', hostStartedAt: 1 }) }), request);
        expect(res.evidence.hostBootId).toBe('boot-D');
    });
    it('stays pending when the boot id cannot be resolved (no control / throws / null)', async () => {
        for (const control of [undefined, { resolveHostBootId: () => null }, { resolveHostBootId: () => { throw new Error('x'); } }]) {
            expect(await stopExactMeshWriter(host(control), request)).toMatchObject({ success: false, code: 'writer_checkpoint_pending' });
        }
    });
    it('stays pending when the host restarted during the census (boot id changed)', async () => {
        let n = 0;
        const res = await stopExactMeshWriter(host({ resolveHostBootId: () => (++n === 1 ? 'boot-A' : 'boot-B') }), request);
        expect(res).toMatchObject({ success: false, code: 'writer_checkpoint_pending' });
    });
    it('still pends (no receipt) when the host lists the session', async () => {
        expect(await stopExactMeshWriter(host({ resolveHostBootId: () => 'boot-A' }, [{ runtimeId: 'sess-1' }]), request))
            .toMatchObject({ success: false, reason: expect.stringContaining('host still reports session') });
    });
});
