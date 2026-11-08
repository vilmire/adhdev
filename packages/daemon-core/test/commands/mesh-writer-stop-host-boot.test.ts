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

describe('stopExactMeshWriter force (owner decision: the stop must end past the ledger bound)', () => {
    const forced: CancelDispatchRequest = { ...request, inspectOnly: false, force: true } as any;
    const record = (over: Record<string, unknown> = {}) => ({ sessionId: 'sess-1', runtimeKey: 'rk-1', startedAt: 1234, lifecycle: 'running',
        meta: { meshNodeFor: 'm1', meshActiveAssignment: { taskId: 't1', attemptId: 'a1', generation: 0, dispatchNonce: 0 } }, ...over });
    const control = (records: unknown[], stop: (sessionId: string, expected: any) => unknown = () => ({ lifecycle: 'stopping' })) => {
        const calls: any[] = [];
        return { calls, listSessions: async () => records, resolveHostBootId: () => 'boot-A',
            stopSessionIfExpected: async (sessionId: string, expected: any) => { calls.push({ sessionId, expected }); return stop(sessionId, expected); } };
    };

    it('stops through the host compare-and-stop with the record\'s exact assignment and answers a quiescent forced receipt, ignoring tree ambiguity', async () => {
        const c = control([record()]);
        const res: any = await stopExactMeshWriter(host(c), forced);
        expect(res).toMatchObject({ success: true, quiescent: true, forced: true, stopRequestId: 'stop-1', attemptId: 'a1' });
        expect(typeof res.incarnation).toBe('string');
        expect(c.calls).toEqual([{ sessionId: 'sess-1', expected: { sessionId: 'sess-1', hostBootId: 'boot-A', runtimeKey: 'rk-1', startedAt: 1234,
            taskId: 't1', attemptId: 'a1', generation: 0, dispatchNonce: 0 } }]);
    });
    it('without force the same request still never reaches the host stop (inspect-only stays pending)', async () => {
        const c = control([record()]);
        const res = await stopExactMeshWriter(host(c, [{ runtimeId: 'sess-1' }]), { ...forced, force: false, inspectOnly: true } as any);
        expect(res).toMatchObject({ success: false, code: 'writer_checkpoint_pending' });
        expect(c.calls).toHaveLength(0);
    });
    it('refuses a session another attempt owns or another mesh runs', async () => {
        for (const r of [record({ meta: { meshNodeFor: 'm1', meshActiveAssignment: { taskId: 't9', attemptId: 'other', generation: 0, dispatchNonce: 0 } } }),
            record({ meta: { meshNodeFor: 'other-mesh' } })]) {
            const c = control([r]);
            expect(await stopExactMeshWriter(host(c), forced)).toMatchObject({ success: false, reason: 'foreign_or_unbound_writer' });
            expect(c.calls).toHaveLength(0);
        }
    });
    it('answers an absence receipt when the host no longer lists the session, and pends when the host refuses the stop', async () => {
        expect(await stopExactMeshWriter(host(control([])), forced)).toMatchObject({ success: true, quiescent: true, evidence: { kind: 'host_session_absent', hostBootId: 'boot-A' } });
        expect(await stopExactMeshWriter(host(control([record()], () => null)), forced)).toMatchObject({ success: false, reason: 'force_stop_unconfirmed' });
        expect(await stopExactMeshWriter(host(undefined), forced)).toMatchObject({ success: false, reason: 'force_host_unavailable' });
    });
});
