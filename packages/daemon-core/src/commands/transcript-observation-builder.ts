/**
 * Builds a `TranscriptObservation` (seqscribe/transcript-observation.ts) from
 * the real `ChatMessage[]`/`SessionTurnPresentation` shapes `read_chat`'s
 * last mile already has in hand (design §5.2, §8 unit 2), stamping each bubble
 * with the identity the message identity ledger assigned at the same choke
 * point (keyed storage 2026-09-28 §3.3): `messageId`, `ord`, adopted `srcId`.
 *
 * Lives in `commands/`, NOT `seqscribe/`, because it needs
 * `providers/contracts.ts#flattenContent` and `check:boundaries` forbids
 * `seqscribe/** -> providers/**` value imports. `commands/**` carries no such
 * restriction.
 */

import type { ChatMessage } from '../types.js';
import { flattenContent } from '../providers/contracts.js';
import type { SessionTurnPresentation } from '../mesh/mesh-turn-presentation.js';
import type { MessageIdentityAssignment } from '../chat/message-identity-ledger.js';
import type {
    TranscriptObservation,
    TranscriptObservationMessage,
} from '../seqscribe/transcript-observation.js';

/** The choke point's identity output for this read (null when the ledger failed). */
export interface TranscriptObservationIdentity {
    readonly assignments: ReadonlyMap<ChatMessage, MessageIdentityAssignment>;
    /** Ids a window source scrolled out of view — kept, not deleted (§3.5). */
    readonly retainedIds: readonly string[];
    readonly ledgerEpoch: string;
}

export interface BuildTranscriptObservationInput {
    readonly sessionId: string;
    readonly historySessionId?: string | null;
    readonly providerType: string;
    readonly providerSessionId?: string | null;
    readonly status: string;
    readonly providerObservedStatus: string | null;
    readonly title?: string | null;
    readonly activeModal?: unknown;
    readonly activeInteractivePrompt?: unknown;
    /** Pass only when the reducer is the status authority (design §5.2 mirrors read-chat-presentation.ts's own gate). */
    readonly turn: SessionTurnPresentation | null;
    readonly provenance?: {
        readonly messageSource?: unknown;
        readonly transcriptProvenance?: unknown;
    };
    /**
     * The FULL (untailed) message set — the choke point runs BEFORE
     * `buildFullTail`'s tailLimit slicing (design §5.2: "tail slicing 전에").
     */
    readonly messages: readonly ChatMessage[];
    readonly identity?: TranscriptObservationIdentity | null;
    readonly coverage: { readonly mode: 'full' | 'window'; readonly omittedBefore: boolean };
}

/**
 * @message-projection l3 identity
 * @message-projection-excludes providerUnitKey: this narrowing feeds the keyed replica wire, which excludes it by design — it embeds a content hash.
 * @message-projection-excludes bubbleId: same reason; per-bubble identity on the keyed wire is the ledger's `messageId`.
 * @message-projection-excludes sequence: the keyed wire orders bubbles by the ledger's `ord`, never by a reader ordinal.
 * @message-projection-excludes toolBlockRef: mtime-sealed, so carrying it would rewrite every past tool bubble on each append; the keyed wire carries `expandable` and expand resolves by messageId through the ledger.
 * @message-projection-excludes _src: daemon-internal reader address for the message identity ledger; it must never reach the replica wire.
 *
 * The single observation publisher's narrowing. Widening the downstream wire
 * encoder's allow-list alone is NOT enough — a field has to survive here first
 * or the encoder only ever sees undefined.
 */
function flattenMessage(message: ChatMessage, identity: MessageIdentityAssignment | undefined): TranscriptObservationMessage {
    const meta = message.meta && typeof message.meta === 'object' ? message.meta : undefined;
    return {
        messageId: identity?.messageId,
        ord: identity?.ord,
        srcId: identity?.srcId ?? null,
        role: message.role,
        kind: message.kind,
        content: flattenContent(message.content),
        receivedAt: message.receivedAt,
        timestamp: message.timestamp,
        turnKey: message._turnKey,
        bubbleState: message.bubbleState,
        senderName: message.senderName,
        // TOOL-LABEL (2026-09-25): the invoked tool's name rides the wire so the
        // dashboard tool card can label the bubble ('Write', 'run_command') —
        // `meta.label` never travels (only `meta.streaming` does), so this typed
        // field is the only way the label reaches the durable transcript lane.
        toolName: typeof message.toolName === 'string' && message.toolName ? message.toolName : undefined,
        // (TOOL-EXPAND) Only the affordance travels: a truncated tool bubble the
        // daemon can expand. The address itself stays on the ledger entry
        // (design §5.9) — see the `toolBlockRef` exclusion above.
        expandable: message.kind === 'tool' && !!message.toolBlockRef,
        meta,
    };
}

/**
 * Pure — no I/O, no seqscribe node, no throw on malformed input (a message
 * whose content cannot be flattened just becomes an empty string; this must
 * never be the thing that breaks a read_chat response). Structural provenance
 * fields are copied by name only, matching the allow-list discipline the keyed
 * encoder (`encodeChatMeta`) re-applies downstream.
 */
export function buildTranscriptObservationFromReadChat(
    input: BuildTranscriptObservationInput,
): TranscriptObservation | null {
    if (!input.sessionId || !input.providerType) return null;
    return {
        sessionId: input.sessionId,
        historySessionId: input.historySessionId ?? null,
        providerType: input.providerType,
        providerSessionId: input.providerSessionId ?? null,

        status: input.status,
        providerObservedStatus: input.providerObservedStatus,
        title: input.title ?? null,
        activeModal: input.activeModal ?? null,
        activeInteractivePrompt: input.activeInteractivePrompt ?? null,
        turn: input.turn as unknown as TranscriptObservation['turn'],

        provenance: input.provenance,
        messages: input.messages.map((message) => flattenMessage(message, input.identity?.assignments.get(message))),
        terminalMarkers: [],
        coverage: {
            mode: input.coverage.mode,
            omittedBefore: input.coverage.omittedBefore,
            ...(input.identity && input.identity.retainedIds.length > 0 ? { retainedMessageIds: input.identity.retainedIds } : {}),
        },
        ...(input.identity ? { ledgerEpoch: input.identity.ledgerEpoch } : {}),
    };
}
