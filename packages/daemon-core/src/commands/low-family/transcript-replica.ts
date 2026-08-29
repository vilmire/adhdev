/**
 * RF-ROUTER LOW family — `ensure_transcript_subscription` / `read_transcript_replica`.
 *
 * Design §4 ("별도 프로세스 경계"): mcp-server must not open `seqscribe.db`
 * itself (single-process ownership, node.ts's header) — it reads a remote
 * session's transcript replica through the daemon that DOES hold the node,
 * over the existing local IPC transport, via these two commands. §8 unit 3
 * builds the commands themselves; roster consumer cutover (§8 units 5-8) is
 * what actually calls them from mcp-server/mesh tools — out of scope here.
 *
 * ★ `ensure_transcript_subscription` needs a live `PeerHandle` for the remote
 * session's owning daemon to attach a SUB to. That connection lives in the
 * TRANSPORT layer (`packages/daemon-cloud`'s peer map, the standalone WS
 * equivalent) which daemon-core does not reach into — see
 * `CommandRouterDeps.resolveTranscriptPeer`'s doc comment (router.ts). No
 * caller supplies it in this unit, so the command answers `ipc_unavailable`
 * rather than pretending to succeed; a later unit wires the resolver from
 * whichever daemon owns the peer map.
 *
 * These fallback reason strings are drawn from the closed union design §4
 * defines for EVERY roster consumer's fallback ("mode_not_primary |
 * consumer_not_enabled | no_node | authority_unavailable | topic_undefined |
 * topic_not_granted | owner_mismatch | no_complete_revision |
 * revision_invalid | projection_oversize | coverage_insufficient |
 * stale_active_session | quarantined | parity_mismatch | ipc_unavailable |
 * stats_error") — reused now, before any roster consumer exists, so the
 * vocabulary does not fork later.
 */

import type { LowFamilyHandler } from './types.js';

function readKeyArgs(args: any): { ownerDaemonId: string; rawSessionId: string } | null {
    const ownerDaemonId = typeof args?.ownerDaemonId === 'string' ? args.ownerDaemonId.trim() : '';
    const rawSessionId = typeof args?.rawSessionId === 'string' ? args.rawSessionId.trim()
        : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
    if (!ownerDaemonId || !rawSessionId) return null;
    return { ownerDaemonId, rawSessionId };
}

export const transcriptReplicaHandlers: Record<string, LowFamilyHandler> = {
    ensure_transcript_subscription: async (ctx, args) => {
        const key = readKeyArgs(args);
        if (!key) return { success: false, error: 'ownerDaemonId and rawSessionId required' };

        const store = ctx.deps.getTranscriptReplicaStore?.();
        if (!store) return { success: true, ready: false, reason: 'no_node' };

        const resolvePeer = ctx.deps.resolveTranscriptPeer;
        if (!resolvePeer) return { success: true, ready: false, reason: 'ipc_unavailable' };

        let peer;
        try {
            peer = await resolvePeer(key.ownerDaemonId);
        } catch {
            return { success: true, ready: false, reason: 'ipc_unavailable' };
        }
        if (!peer) return { success: true, ready: false, reason: 'ipc_unavailable' };

        const result = store.ensureSubscription(key, peer);
        if (!result.ok) return { success: true, ready: false, reason: result.reason };
        return { success: true, ready: true, alreadySubscribed: result.alreadySubscribed };
    },

    read_transcript_replica: async (ctx, args) => {
        const key = readKeyArgs(args);
        if (!key) return { success: false, error: 'ownerDaemonId and rawSessionId required' };

        const store = ctx.deps.getTranscriptReplicaStore?.();
        if (!store) return { success: true, available: false, reason: 'no_node' };

        const read = store.getReplica(key);
        if (!read.available) return { success: true, available: false, reason: read.reason };
        return { success: true, available: true, snapshot: read.snapshot, identity: read.identity };
    },
};
