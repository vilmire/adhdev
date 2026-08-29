/**
 * Builds a `TranscriptObservation` (seqscribe/transcript-observation.ts) from
 * the real `ChatMessage[]`/`SessionTurnPresentation` shapes `read_chat`'s
 * last mile already has in hand (design §5.2, §8 unit 2).
 *
 * Lives in `commands/`, NOT `seqscribe/`, because it needs
 * `providers/contracts.ts#flattenContent` — the producer-side MessagePart[]
 * normalization transcript-projection.ts's header explicitly defers to this
 * unit — and `check:boundaries` forbids `seqscribe/** -> providers/**` value
 * imports. `commands/**` carries no such restriction.
 */

import type { ChatMessage } from '../types.js';
import { flattenContent } from '../providers/contracts.js';
import type { SessionTurnPresentation } from '../mesh/mesh-turn-presentation.js';
import type {
    TranscriptObservation,
} from '../seqscribe/transcript-observation.js';
import type {
    TranscriptSnapshotCandidateCoverage,
    TranscriptSnapshotCandidateModal,
    TranscriptSnapshotCandidatePrompt,
} from '../seqscribe/transcript-projection.js';

export interface BuildTranscriptObservationInput {
    readonly sessionId: string;
    readonly historySessionId?: string | null;
    readonly providerType: string;
    readonly providerSessionId?: string | null;
    readonly status: string;
    readonly providerObservedStatus: string | null;
    readonly title?: string | null;
    readonly activeModal?: TranscriptSnapshotCandidateModal | null;
    readonly activeInteractivePrompt?: TranscriptSnapshotCandidatePrompt | null;
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
    readonly coverage: TranscriptSnapshotCandidateCoverage;
}

function flattenMessage(message: ChatMessage): TranscriptObservation['messages'][number] {
    const meta = message.meta && typeof message.meta === 'object' ? message.meta : undefined;
    return {
        role: message.role,
        kind: message.kind,
        content: flattenContent(message.content),
        receivedAt: message.receivedAt,
        timestamp: message.timestamp,
        turnKey: message._turnKey,
        bubbleState: message.bubbleState,
        senderName: message.senderName,
        toolName: undefined,
        meta,
    };
}

/**
 * Pure — no I/O, no seqscribe node, no throw on malformed input (a message
 * whose content cannot be flattened just becomes an empty string; this must
 * never be the thing that breaks a read_chat response). Structural provenance
 * fields are copied by name only, matching the allow-list discipline
 * `encodeTranscriptSnapshot` re-applies downstream.
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
        messages: input.messages.map(flattenMessage),
        terminalMarkers: [],
        coverage: input.coverage,
    };
}
