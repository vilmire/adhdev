import { describe, it, expect } from 'vitest';
import { OPERATOR_RECOVERY_TARGET as t } from '@adhdev/session-host-core';
import { MeshRpcEndpoint } from '../../src/mesh/transport/mesh-rpc-endpoint.js';
import type { Peer } from '../../src/mesh/transport/mesh-rpc-protocol.js';
import { SessionHostServer } from '../../../session-host-daemon/src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
class Endpoint extends MeshRpcEndpoint {
    put(peer: Peer) { this.peers.set(peer.daemonId, peer); }
    failure(message: string): any { return new Error(message); }
    noteRequestTimeout() {} emitPeerOpen() {} flushConnectQueue() {}
    bind(peer: Peer, mapped: () => boolean) { return this.boundRecoveryPeer(peer, {
        namespace: t.namespace, hostBootId: 'expected-native-boot', workerDaemonId: t.workerDaemonId,
        endpoint: `/fixture/adhdev-preview-session-host-${t.namespace}.sock` }, 'f'.repeat(64), mapped); }
    reply(peer: Peer, id: string, result: unknown) { this.handleIncomingResponse(peer, { v: 1, kind: 'rpc_res', id, ok: true, result }); }
}
describe('actual mesh RPC recovery adapter', () => {
    it('public capture reads the real transport map and invalidates replacement', () => {
        const endpoint = new Endpoint();
        const peer = { daemonId: t.workerDaemonId, state: 'connected', authEpoch: 1, attempt: 1,
            createdAt: 'fixture', dc: { isOpen: () => true } } as any;
        endpoint.put(peer);
        const captured = endpoint.captureRecoveryPeer(t.workerDaemonId, { namespace: t.namespace,
            workerDaemonId: t.workerDaemonId, hostBootId: 'fixture', endpoint: '/fixture' }, 'f'.repeat(64))!;
        expect(captured.isCurrent()).toBe(true);
        endpoint.put({ ...peer });
        expect(captured.isCurrent()).toBe(false);
    });

    for (const mode of ['current', 'replaced', 'auth-rollover'] as const) {
        it(`binds response to the captured authenticated channel: ${mode}`, async () => {
            const endpoint = new Endpoint(); let mapped = true;
            const root = mkdtempSync(join(tmpdir(), 'recovery-rpc-host-'));
            const host = new SessionHostServer({ storageRootDir: root, instanceConfigDir: root });
            const peer = { daemonId: t.workerDaemonId, state: 'connected', authEpoch: 1, attempt: 1,
                createdAt: 'fixture-created', openedAt: 'fixture-opened', inflight: new Map(), consecutiveTimeouts: 0,
                dc: { isOpen: () => true, sendMessage: (text: string) => {
                    const req = JSON.parse(text);
                    if (req.kind !== 'rpc_req') return;
                    expect(req.command).toBe('mesh_operator_recovery_census');
                    const result = host.collectRecoveryCensus(req.args.nonce, req.args.fenceDigest);
                    queueMicrotask(() => {
                        if (mode === 'replaced') mapped = false;
                        if (mode === 'auth-rollover') peer.authEpoch++;
                        endpoint.reply(peer as any, req.id, { success: true, result });
                    });
                } } };
            const adapter = endpoint.bind(peer as any, () => mapped)!;
            const reply = adapter.requestPhysicalProof('a'.repeat(64));
            if (mode === 'current') expect((await reply).verdict).toBe('UNKNOWN');
            else await expect(reply).rejects.toThrow('authenticated_peer_changed');
            expect(peer.inflight.size).toBe(0);
        });
    }
    it('refuses an unavailable or foreign peer without dialing or sending', () => {
        const endpoint = new Endpoint();
        expect(endpoint.bind({ daemonId: 'foreign' } as any, () => true)).toBeNull();
        expect(endpoint.bind({ daemonId: t.workerDaemonId, state: 'connecting' } as any, () => true)).toBeNull();
        expect(endpoint.bind({ daemonId: t.workerDaemonId, state: 'connected', dc: { isOpen: () => true } } as any, () => true)).toBeNull();
    });
});
