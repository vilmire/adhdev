/**
 * `mesh_read_chat_display` roster adapter — design §4 (roster id 3), §8 unit 6
 * ("mesh_read_chat remote display cutover").
 *
 * Maps a verified-complete `ReplicatedTranscriptSnapshotV1` (§8 unit 1's closed
 * wire allow-list) into the exact payload shape the daemon's `read_chat`
 * command result already has — the object `meshReadChat`
 * (`oss/packages/mcp-server/src/tools/mesh-tools-session.ts`) hands to
 * `compactChatPayload`/`annotateRapidReadChatAdvisory` and, for `compact=false`,
 * serializes verbatim. Keeping the shape identical is what makes the design's
 * "compact/full parity" acceptance item mechanical rather than a second
 * formatter: BOTH branches run over the same object graph, so neither
 * `compactChatPayload`'s tail/summary/toolSummaries lift nor the full-payload
 * JSON needs a replica-specific code path.
 *
 * This mirrors §8 unit 5's `transcript-chat-pane-adapter.ts` (web-core), which
 * does the same job against `SessionChatTailUpdate` instead. Two adapters
 * rather than one because the two consumers' target shapes genuinely differ
 * (`SessionChatTailUpdate` is a push envelope with `topic`/`key`/`seq`;
 * `read_chat`'s result is a command payload with `totalMessages`/
 * `providerObservedStatus`/`turn`) — the shared part is the SOURCE type, not
 * the destination.
 *
 * ── Status is NOT recomputed here (design §5.2) ────────────────────────────
 * ★ `snapshot.status` was already produced by `read-chat-presentation.ts`'s
 * `effectiveStatus` (`:202-215`) — i.e. AFTER the Stage 6 turn-authority
 * decision (`resolveSessionTurnPresentation` → `turn_reducer` override →
 * `normalizeReadChatCommandStatus` → the waiting_approval/modal contract
 * guard), and the observation is built from that same `effectiveStatus` at
 * `:278`. This adapter therefore copies `status` and `turn` straight through
 * and MUST NOT derive, re-normalize, or second-guess either. A parallel status
 * computation here would be a second authority for the same surface — exactly
 * what the `provider_fsm_fallback` stage-max-age demotion in
 * `mesh-turn-presentation.ts` exists to arbitrate, and it can only arbitrate
 * if there is one producer.
 *
 * ── What does NOT round-trip, and why that is acceptable here ──────────────
 * `debugReadChat` is a diagnostic block `read_chat` attaches only when the
 * caller asked for it; it is not on the transcript wire allow-list (§2.4) and
 * `mesh_read_chat` never requests it. Absent, both branches simply omit the key.
 *
 * The rich `messageSource` object (`{selected, fallbackReason, nativeSource,
 * returnedCount}`) reduces to the single allow-listed scalar `provenance.
 * messageSource`, reconstructed as `{selected}` — the same narrowing §8 unit
 * 5's adapter documents. `compactChatPayload` never reads `messageSource`, so
 * the compact branch is bit-identical; the full branch loses only the
 * diagnostic sub-fields. `transcriptProvenance` gets the same treatment.
 *
 * `activeInteractivePrompt` carries `{message, options}` — the allow-listed
 * `ReplicatedTranscriptPromptV1`. It cannot reconstruct the full
 * `InteractivePrompt` needed to ANSWER a prompt, but answering is a live
 * daemon RPC on a different verb regardless of transcript source, and
 * `mesh_read_chat` is a DISPLAY surface (roster note: "Remote transcript
 * display/compact"), so this is a display-lossless reduction.
 */

import type {
    ReplicatedTranscriptMessageV1,
    ReplicatedTranscriptSnapshotV1,
} from '../seqscribe/transcript-projection.js';

/**
 * One roster-mapped message, in the `ChatMessage`-ish shape the mcp-server
 * compactor reads (`isCoordinatorVisibleMessage`/`messageContent`, chat-
 * compact.ts). `turnKey` is the wire's only stable-identity field (§2.4), so
 * it stands in for the richer `bubbleId`/`providerUnitKey`/`id` a live
 * `read_chat` message carries.
 *
 * ★ `meta.streaming` is reconstructed from the allow-listed `streaming` scalar
 * ONLY when it is non-null. Never synthesize a `meta` object otherwise:
 * `isCoordinatorVisibleMessage` inspects `meta.internal`/`meta.debug`/
 * `meta.userVisible`, and an always-present `meta` would be a new (empty)
 * object on every message where the live path had none.
 */
function mapTranscriptMessage(message: ReplicatedTranscriptMessageV1): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
        role: message.role,
        kind: message.kind,
        content: message.content,
    };
    if (message.receivedAt !== null) mapped.receivedAt = message.receivedAt;
    if (message.timestamp !== null) mapped.timestamp = message.timestamp;
    if (message.bubbleState !== null) mapped.bubbleState = message.bubbleState;
    if (message.senderName !== null) mapped.senderName = message.senderName;
    if (message.toolName !== null) mapped.toolName = message.toolName;
    if (message.turnKey !== null) {
        mapped.bubbleId = message.turnKey;
        mapped._turnKey = message.turnKey;
    }
    if (message.streaming !== null) mapped.meta = { streaming: message.streaming };
    return mapped;
}

/** The (necessarily narrower) provenance reconstruction — see this file's header. */
function mapProvenanceScalar(value: string | null): Record<string, unknown> | undefined {
    return value ? { selected: value } : undefined;
}

/**
 * The replica-sourced twin of a `read_chat` command result.
 *
 * `transcriptReadSource` is the single-source-of-truth telemetry field
 * (design §5.6) — same field name §8 unit 5's adapter stamps, so one grep
 * finds every replica-answered surface. `omittedBefore`/`stale` are the
 * CALLER's SNAP-reset/freshness decision (§3.7, §5.5) carried onto the
 * payload, not computed from the snapshot here.
 */
export interface TranscriptReadChatPayload {
    success: true;
    status: string;
    providerObservedStatus: string | null;
    providerSessionId: string | null;
    historySessionId?: string;
    title?: string;
    activeModal: { message: string; buttons: string[] } | null;
    activeInteractivePrompt: { message: string; options: string[] } | null;
    messages: Record<string, unknown>[];
    totalMessages: number;
    turn?: Record<string, unknown>;
    messageSource?: Record<string, unknown>;
    transcriptProvenance?: Record<string, unknown>;
    /** Ring/SNAP-reset discontinuity — design §3.7's "이전 내용 생략" signal. */
    omittedBefore: boolean;
    /** Design §5.5's "stale idle UI" — a replica read whose freshness gate did not hold. */
    stale: boolean;
    transcriptReadSource: 'replica';
    /** Revision identity, for operator diagnostics (§8 unit 10). Non-content scalars. */
    replicaRevision: number;
    replicaObservedAt: string;
}

/**
 * Map one verified-complete replica snapshot into the `read_chat` payload
 * shape. Pure: no I/O, no clock, no status derivation (see header).
 *
 * `totalMessages` comes from `coverage.totalMessageCount` — the FULL observed
 * count before any tail slicing — matching `read_chat`'s own `sync.totalMessages`
 * semantics rather than `messages.length`. `compactChatPayload` overwrites its
 * own `totalMessages` from the array it received, so this field only matters
 * to the `compact=false` branch, which is exactly where the untailed count is
 * the honest answer.
 */
export function mapTranscriptSnapshotToReadChatPayload(
    snapshot: ReplicatedTranscriptSnapshotV1,
    options: { omittedBefore: boolean; stale: boolean },
): TranscriptReadChatPayload {
    const messageSource = mapProvenanceScalar(snapshot.provenance.messageSource);
    const transcriptProvenance = mapProvenanceScalar(snapshot.provenance.transcriptProvenance);
    return {
        success: true,
        status: snapshot.status,
        providerObservedStatus: snapshot.providerObservedStatus,
        providerSessionId: snapshot.providerSessionId,
        ...(snapshot.historySessionId ? { historySessionId: snapshot.historySessionId } : {}),
        ...(snapshot.title ? { title: snapshot.title } : {}),
        activeModal: snapshot.activeModal
            ? { message: snapshot.activeModal.message, buttons: [...snapshot.activeModal.buttons] }
            : null,
        activeInteractivePrompt: snapshot.activeInteractivePrompt
            ? {
                message: snapshot.activeInteractivePrompt.message,
                options: [...snapshot.activeInteractivePrompt.options],
            }
            : null,
        messages: snapshot.messages.map(mapTranscriptMessage),
        totalMessages: snapshot.coverage.totalMessageCount,
        // Absent turn projection stays absent — `read_chat` omits the key on the
        // provider-FSM fallback and `slimTurnPresentation` returns null for it,
        // so a fabricated empty `turn` would break that contract.
        ...(snapshot.turn ? { turn: { ...snapshot.turn } } : {}),
        ...(messageSource ? { messageSource } : {}),
        ...(transcriptProvenance ? { transcriptProvenance } : {}),
        omittedBefore: options.omittedBefore,
        stale: options.stale,
        transcriptReadSource: 'replica',
        replicaRevision: snapshot.revision,
        replicaObservedAt: snapshot.observedAt,
    };
}
