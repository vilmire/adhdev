/**
 * RF-ROUTER LOW family — `ensure_transcript_subscription` / `read_transcript_replica`
 * / `request_transcript_base`.
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
 * These fallback reason strings are drawn from `TranscriptConsumerFallbackReason`
 * (`mesh/transcript-read-model-consumers.ts`), the closed union design §4
 * defines for EVERY roster consumer's fallback — reused now, before any
 * roster consumer existed, so the vocabulary would not fork later. §8 unit 5
 * adds the first two roster consumers (`web_chat_pane`,
 * `web_warm_mobile_preview`) against that same type.
 *
 * `request_transcript_base` is the OWNER side of the keyed chat resync path
 * (design 2026-09-28 §5.2): a reader whose folder keeps failing a commit
 * digest asks the producing daemon for one `resync_request` base frame. It
 * travels the same peer command path as the other two (never the server) and
 * carries only a session id.
 */

import type { TranscriptConsumerFallbackReason } from '../../mesh/transcript-read-model-consumers.js';
import type { LowFamilyHandler } from './types.js';
import { requestTranscriptBaseFrame } from '../../seqscribe/transcript-publisher.js';
import { defineCommandSpecs } from '../command-registry.js';

function readKeyArgs(args: any): { ownerDaemonId: string; rawSessionId: string } | null {
    const ownerDaemonId = typeof args?.ownerDaemonId === 'string' ? args.ownerDaemonId.trim() : '';
    const rawSessionId = typeof args?.rawSessionId === 'string' ? args.rawSessionId.trim()
        : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
    if (!ownerDaemonId || !rawSessionId) return null;
    return { ownerDaemonId, rawSessionId };
}

// `no_node` and `ipc_unavailable` are both in `TranscriptConsumerFallbackReason`
// — asserted here so a future rename of either literal in the roster type
// fails this file's typecheck instead of silently drifting.
const NO_NODE: TranscriptConsumerFallbackReason = 'no_node';
const IPC_UNAVAILABLE: TranscriptConsumerFallbackReason = 'ipc_unavailable';

export const transcriptReplicaHandlers: Record<string, LowFamilyHandler> = {
    ensure_transcript_subscription: async (ctx, args) => {
        const key = readKeyArgs(args);
        if (!key) return { success: false, error: 'ownerDaemonId and rawSessionId required' };

        const store = ctx.deps.getTranscriptReplicaStore?.();
        if (!store) return { success: true, ready: false, reason: NO_NODE };

        const resolvePeer = ctx.deps.resolveTranscriptPeer;
        if (!resolvePeer) return { success: true, ready: false, reason: IPC_UNAVAILABLE };

        let peer;
        try {
            peer = await resolvePeer(key.ownerDaemonId);
        } catch {
            return { success: true, ready: false, reason: IPC_UNAVAILABLE };
        }
        if (!peer) return { success: true, ready: false, reason: IPC_UNAVAILABLE };

        const result = store.ensureSubscription(key, peer);
        if (!result.ok) return { success: true, ready: false, reason: result.reason };
        return { success: true, ready: true, alreadySubscribed: result.alreadySubscribed };
    },

    read_transcript_replica: async (ctx, args) => {
        const key = readKeyArgs(args);
        if (!key) return { success: false, error: 'ownerDaemonId and rawSessionId required' };

        const store = ctx.deps.getTranscriptReplicaStore?.();
        if (!store) return { success: true, available: false, reason: NO_NODE };

        const read = store.getReplica(key);
        if (!read.available) return { success: true, available: false, reason: read.reason };
        return { success: true, available: true, view: read.view, identity: read.identity };
    },

    request_transcript_base: async (_ctx, args) => {
        const rawSessionId = typeof args?.rawSessionId === 'string' ? args.rawSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!rawSessionId) return { success: false, error: 'rawSessionId required' };
        return { success: true, accepted: requestTranscriptBaseFrame(rawSessionId) };
    },
};

export const transcriptReplicaSpecs = defineCommandSpecs('low', transcriptReplicaHandlers, {}, { meshSender: 'authenticated_peer' });
