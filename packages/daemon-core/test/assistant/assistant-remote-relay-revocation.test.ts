/** Follower side: only an explicit host_revoked persists a revocation; stale non-explicit ones self-heal. */
import { describe, expect, it, vi } from 'vitest';
import {
    AssistantRemoteRelayPoller, REVOCATION_REFUSAL_CODES, isSelfHealableRevocationReason,
} from '../../src/assistant/assistant-remote-relay.js';
import type { RemoteCallOutcome, RemoteHostView } from '../../src/assistant/assistant-remote-host.js';

const MESH = 'mesh_x';
const target: RemoteHostView = { label: 'host', hostDaemonId: 'daemon_mach_h', hostMeshId: MESH, reachable: true };

function make(out: RemoteCallOutcome, extra: Record<string, unknown> = {}) {
    const onAccessRevoked = vi.fn();
    const onAccessRefused = vi.fn();
    const closeThread = vi.fn();
    const poller = new AssistantRemoteRelayPoller({
        openThreads: () => [{ meshId: MESH, lastSendAt: 0 }],
        remoteTarget: () => target,
        poll: async () => out,
        relay: { onRemoteCommitted: vi.fn(), observeRemote: vi.fn(), remoteUnreachable: vi.fn(), closeThread } as any,
        onAccessRevoked, onAccessRefused,
        ...extra,
    } as any);
    return { poller, onAccessRevoked, onAccessRefused, closeThread };
}
const refused = (code: string): RemoteCallOutcome => ({ ok: false, kind: 'refused', code, error: `${code} err` });

describe('follower revocation policy', () => {
    for (const code of ['remote_access_denied', 'binding_revision_mismatch', 'binding_revision_stale', 'grant_revision_stale', 'host_unavailable_transient', 'mesh_sender_not_on_roster']) {
        it(`${code} keeps the follow active: lastError recorded, no revocation`, async () => {
            const h = make(refused(code));
            await h.poller.tick();
            expect(h.onAccessRevoked).not.toHaveBeenCalled();
            expect(h.closeThread).not.toHaveBeenCalled();
            expect(h.onAccessRefused).toHaveBeenCalledWith(MESH, code, `${code} err`);
        });
    }
    it('an explicit host_revoked still revokes', async () => {
        const h = make(refused('host_revoked'));
        await h.poller.tick();
        expect(h.onAccessRevoked).toHaveBeenCalledWith(MESH, 'host_revoked', 'host_revoked err');
        expect(REVOCATION_REFUSAL_CODES.has('remote_access_denied')).toBe(false);
    });
});

describe('self-heal of a stale non-explicit revocation', () => {
    it('restores on a successful poll, never for host_revoked', async () => {
        expect(isSelfHealableRevocationReason('remote_access_denied')).toBe(true);
        expect(isSelfHealableRevocationReason('host_revoked')).toBe(false);
        const onAccessRecovered = vi.fn();
        const h = make({ ok: true, result: { success: true } } as any, { openThreads: () => [], staleRevoked: () => [{ meshId: MESH, target }], onAccessRecovered });
        await h.poller.tick();
        expect(onAccessRecovered).toHaveBeenCalledWith(MESH);
    });
    it('stays revoked (and backs off) while the host still refuses', async () => {
        const onAccessRecovered = vi.fn();
        const h = make(refused('host_revoked'), { openThreads: () => [], staleRevoked: () => [{ meshId: MESH, target }], onAccessRecovered });
        await h.poller.tick();
        expect(onAccessRecovered).not.toHaveBeenCalled();
    });
});
