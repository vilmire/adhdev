import { describe, expect, it, vi } from 'vitest';
import { transcriptReplicaHandlers } from '../../../src/commands/low-family/transcript-replica.js';
import type { LowFamilyContext } from '../../../src/commands/low-family/types.js';

/**
 * §8 unit 3 — `ensure_transcript_subscription` / `read_transcript_replica`
 * daemon-local commands (design §4, "별도 프로세스 경계"). No roster consumer
 * calls these yet (§8 units 5-8); this pins the closed fallback-reason
 * vocabulary and the safe-no-op-when-unwired behavior for
 * `resolveTranscriptPeer` (not supplied in this unit — see router.ts's doc
 * comment on that dep).
 */

function ctx(overrides: Partial<LowFamilyContext['deps']> = {}): LowFamilyContext {
    return { deps: overrides as LowFamilyContext['deps'] };
}

describe('ensure_transcript_subscription', () => {
    it('requires ownerDaemonId and rawSessionId', async () => {
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(ctx(), {});
        expect(result).toEqual({ success: false, error: 'ownerDaemonId and rawSessionId required' });
    });

    it('no_node when the replica store getter is absent (node failed to open)', async () => {
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx(),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, ready: false, reason: 'no_node' });
    });

    it('ipc_unavailable when no peer resolver is wired — the honest state for THIS unit', async () => {
        const store = { ensureSubscription: vi.fn() };
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx({ getTranscriptReplicaStore: () => store as any }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, ready: false, reason: 'ipc_unavailable' });
        expect(store.ensureSubscription).not.toHaveBeenCalled();
    });

    it('ipc_unavailable when the resolver returns null (no live peer for that owner)', async () => {
        const store = { ensureSubscription: vi.fn() };
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx({ getTranscriptReplicaStore: () => store as any, resolveTranscriptPeer: async () => null }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, ready: false, reason: 'ipc_unavailable' });
    });

    it('ipc_unavailable (not a throw) when the resolver rejects', async () => {
        const store = { ensureSubscription: vi.fn() };
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx({ getTranscriptReplicaStore: () => store as any, resolveTranscriptPeer: async () => { throw new Error('boom'); } }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, ready: false, reason: 'ipc_unavailable' });
    });

    it('delegates to the store once a peer resolves, and surfaces its ok/reason', async () => {
        const peer = { peerId: 'daemon-owner' };
        const store = { ensureSubscription: vi.fn().mockReturnValue({ ok: true, alreadySubscribed: false }) };
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx({ getTranscriptReplicaStore: () => store as any, resolveTranscriptPeer: async () => peer as any }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(store.ensureSubscription).toHaveBeenCalledWith({ ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' }, peer);
        expect(result).toEqual({ success: true, ready: true, alreadySubscribed: false });
    });

    it('surfaces a store-side rejection reason (e.g. raw_session_id_conflict) without treating it as an error', async () => {
        const peer = { peerId: 'daemon-owner' };
        const store = { ensureSubscription: vi.fn().mockReturnValue({ ok: false, reason: 'raw_session_id_conflict' }) };
        const result = await transcriptReplicaHandlers.ensure_transcript_subscription!(
            ctx({ getTranscriptReplicaStore: () => store as any, resolveTranscriptPeer: async () => peer as any }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, ready: false, reason: 'raw_session_id_conflict' });
    });
});

describe('read_transcript_replica', () => {
    it('requires ownerDaemonId and rawSessionId', async () => {
        const result = await transcriptReplicaHandlers.read_transcript_replica!(ctx(), { rawSessionId: 'sess-1' });
        expect(result).toEqual({ success: false, error: 'ownerDaemonId and rawSessionId required' });
    });

    it('no_node when the replica store getter is absent', async () => {
        const result = await transcriptReplicaHandlers.read_transcript_replica!(
            ctx(),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, available: false, reason: 'no_node' });
    });

    it('reads through to the store and returns its unavailable reason', async () => {
        const store = { getReplica: vi.fn().mockReturnValue({ available: false, reason: 'no_complete_revision' }) };
        const result = await transcriptReplicaHandlers.read_transcript_replica!(
            ctx({ getTranscriptReplicaStore: () => store as any }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(store.getReplica).toHaveBeenCalledWith({ ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' });
        expect(result).toEqual({ success: true, available: false, reason: 'no_complete_revision' });
    });

    it('returns the snapshot+identity when the store has a complete revision', async () => {
        const snapshot = { schemaVersion: 1, sessionId: 'sess-1' };
        const identity = { sessionId: 'sess-1', producerDaemonId: 'daemon-owner', producerWriterId: 'w', producerEpoch: 'e', revision: 1 };
        const store = { getReplica: vi.fn().mockReturnValue({ available: true, snapshot, identity }) };
        const result = await transcriptReplicaHandlers.read_transcript_replica!(
            ctx({ getTranscriptReplicaStore: () => store as any }),
            { ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' },
        );
        expect(result).toEqual({ success: true, available: true, snapshot, identity });
    });

    it('accepts sessionId as an alias for rawSessionId', async () => {
        const store = { getReplica: vi.fn().mockReturnValue({ available: false, reason: 'no_subscription' }) };
        await transcriptReplicaHandlers.read_transcript_replica!(
            ctx({ getTranscriptReplicaStore: () => store as any }),
            { ownerDaemonId: 'daemon-owner', sessionId: 'sess-1' },
        );
        expect(store.getReplica).toHaveBeenCalledWith({ ownerDaemonId: 'daemon-owner', rawSessionId: 'sess-1' });
    });
});
