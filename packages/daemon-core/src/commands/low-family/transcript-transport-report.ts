/**
 * RF-ROUTER LOW family — `report_transcript_transport`.
 *
 * G2 transcript-transport selection counter (design §7e, `writer-gc.ts`'s
 * sibling `seqscribe/transcript-transport-selection.ts` — see that module's
 * header for the full "why a new signal" reasoning). The browser dashboard
 * calls this once per subscription health transition
 * (`session-chat-tail-controller.ts`'s `syncLegacySubscription()`) to report
 * which transport it is actually running: the seqscribe replica lane, or the
 * legacy `session.chat_tail` push subscription. Sent over the existing P2P
 * `type:'command'` frame (`packages/daemon-cloud/src/daemon-p2p/
 * data-channel-router.ts` `handleP2PCommand`), the same channel every other
 * low-family command already uses — no new transport, per CLAUDE.md's
 * "Cloud dashboard transport policy" (P2P only, no WS/REST fallback for
 * dashboard commands).
 *
 * Content boundary: `selection` is a closed two-value enum
 * (`'replica' | 'legacy'`), never free text. Anything else is rejected
 * without incrementing a counter — this command must never become a place a
 * future caller can smuggle an arbitrary string into a daemon-side counter
 * key.
 */

import { recordTranscriptTransportSelection } from '../../seqscribe/transcript-transport-selection.js';
import type { LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';

function readSelection(args: any): 'replica' | 'legacy' | null {
    const selection = args?.selection;
    return selection === 'replica' || selection === 'legacy' ? selection : null;
}

export const transcriptTransportReportHandlers: Record<string, LowFamilyHandler> = {
    report_transcript_transport: async (_ctx, args) => {
        const selection = readSelection(args);
        if (!selection) return { success: false, error: "selection must be 'replica' or 'legacy'" };
        recordTranscriptTransportSelection(selection);
        return { success: true };
    },
};

// No `sources` restriction (third arg omitted) — default is ALL sources,
// deliberately matching this file's sibling `transcript-replica.ts`
// (`ensure_transcript_subscription`/`read_transcript_replica`, also
// unrestricted). This command must be reachable from every transport a
// dashboard actually uses to reach the daemon — cloud P2P
// (`type:'command'` frame) and standalone WS alike — unlike the turn-ledger
// IPC commands (`turn-ledger-ipc.ts`, `sources: ['ipc']`), which are
// deliberately MCP-server-only. There is no legitimate caller this command
// should refuse.
export const transcriptTransportReportSpecs = defineCommandSpecs('low', transcriptTransportReportHandlers, {}, { meshSender: 'authenticated_peer' });
