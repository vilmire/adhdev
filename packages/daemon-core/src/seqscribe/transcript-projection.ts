/**
 * `session.<safeSessionId>.transcript` payload contract (design §2.4, §3.3).
 *
 * `ReplicatedTranscriptSnapshotV1` is the ONLY shape that may ever cross the
 * transcript wire. It is a closed allow-list, not a convenience DTO — the same
 * discipline `projectMeshLedgerEntry` (mesh-event-projection.ts) applies to
 * `mesh.<id>.events`, and for the same reason: the source objects upstream
 * (`ChatMessage`, `SessionTurnPresentation`, native-history provenance) carry
 * `Record<string, unknown>` meta bags, `sourcePath`, workspace paths and
 * arbitrary debug fields that must NEVER reach this content topic's wire
 * bytes, because — unlike the mesh ledger's metadata-class topic — a bug here
 * is a content-class over-share, not merely a routing leak.
 *
 * ── Why this file imports nothing from `mesh/` or `commands/` ──────────────
 * `check:boundaries` forbids `seqscribe/** -> mesh/**` so this layer stays
 * producer-neutral (see the header note in topics.ts and the boundary script's
 * own error message). `encodeTranscriptSnapshot` below therefore takes a
 * STRUCTURAL candidate type that mirrors the real upstream shapes
 * (`ChatMessage`, `SessionTurnPresentation`) field-for-field without an import
 * edge — exactly the pattern `projectMeshLedgerEntry` uses for
 * `MeshLedgerEntry`. The mesh-side roster consumers (§8 units 5-8) are
 * responsible for adapting their real objects to this candidate shape; this
 * file only has to encode allow-listed fields correctly once they arrive.
 *
 * ── This is an allow-list, and it must stay one ────────────────────────────
 * ★ Never rewrite the encoder as a deny-list (`delete candidate.sourcePath`,
 * an `Omit<>`, a regex over key names). A deny-list silently ships every field
 * a future caller adds upstream. Fields are copied by NAME here, or they do
 * not travel — and `ReplicatedTranscriptSnapshotV1` has no index signature, so
 * a consumer reaching for an unlisted field is a compile error, not a runtime
 * `undefined`.
 *
 * ── Content vs. identity ────────────────────────────────────────────────────
 * `messages[].content` here is already a NORMALIZED STRING. Producer-side
 * normalization of `MessagePart[]` (and any other pre-wire shaping — turn
 * projection selection, coverage windowing) is the `TranscriptObservation`
 * choke point's job (§8 unit 2, "single observation publisher"), out of scope
 * for this unit. This module only encodes a candidate that already has a
 * string `content`.
 */

import { jcs, sha256HexUtf8, type JsonValue } from 'seqscribe';

// ─── Wire types (the closed allow-list) ─────────────────────────────────────

export type TranscriptMessageBubbleState = 'draft' | 'streaming' | 'final' | 'removed';

export interface ReplicatedTranscriptMessageV1 {
    readonly role: string;
    readonly kind: string;
    readonly content: string;
    readonly receivedAt: number | null;
    readonly timestamp: number | null;
    readonly turnKey: string | null;
    /**
     * Monotonic per-(session, source) integer (`providers/transcript-v2.ts`
     * A2.3) — the ONE per-MESSAGE identity field on this wire.
     *
     * Why it is here: `turnKey` is turn-grained, so it cannot distinguish the
     * bubbles inside a turn, and consumers that needed per-message identity had
     * to fall back to a content hash. `sequence` is a bare integer — no content,
     * no path, no session-derived hash — so it carries none of the content-class
     * risk that keeps `providerUnitKey` (a content hash) deliberately off this
     * wire.
     *
     * `null` means UNKNOWN, never 0: a pre-widening producer omits the field
     * entirely, and a consumer that read absence as 0 would mis-order or
     * mis-seam a mixed-version fleet. Consumers must treat null as "no ordinal
     * available" and fall back, not as an ordinal.
     */
    readonly sequence: number | null;
    readonly bubbleState: TranscriptMessageBubbleState | null;
    readonly senderName: string | null;
    readonly toolName: string | null;
    /** `meta.streaming` only — the rest of `ChatMessage.meta` never travels. */
    readonly streaming: boolean | null;
}

export type TranscriptTerminalOutcome = 'completed' | 'failed' | 'cancelled' | 'stalled';

export interface ReplicatedTranscriptTerminalMarkerV1 {
    readonly receivedAt: number;
    readonly outcome: TranscriptTerminalOutcome;
    readonly turnId: string | null;
    /** Content-class summary text — still allow-listed by name, not shape. */
    readonly summary: string | null;
}

export type TranscriptCoverageMode = 'full' | 'tail' | 'current-turn';

export interface ReplicatedTranscriptCoverageV1 {
    readonly mode: TranscriptCoverageMode;
    readonly totalMessageCount: number;
    readonly returnedMessageCount: number;
    readonly omittedBefore: boolean;
}

/**
 * Scalar-only provenance. `sourcePath` and workspace path are DELIBERATELY
 * absent — §2.4 excludes them by name, and there is no index signature here
 * to smuggle them back in under a different key.
 */
export interface ReplicatedTranscriptProvenanceV1 {
    readonly messageSource: string | null;
    readonly transcriptProvenance: string | null;
}

export interface ReplicatedTranscriptModalV1 {
    readonly message: string;
    readonly buttons: readonly string[];
}

export interface ReplicatedTranscriptPromptV1 {
    readonly message: string;
    readonly options: readonly string[];
}

/**
 * Structural mirror of the scalar subset of `SessionTurnPresentation`
 * (mesh/mesh-turn-presentation.ts) that read_chat/roster consumers actually
 * read. Not imported (see header) — every field here is already a closed
 * scalar/enum/nullable on the source type, so the mirror is exact.
 */
export interface ReplicatedTranscriptTurnV1 {
    readonly authority: string;
    readonly status: string;
    readonly stage: string | null;
    readonly terminalOutcome: string | null;
    readonly terminalReason: string | null;
    readonly meshId: string | null;
    readonly taskId: string | null;
    readonly attemptId: string | null;
    readonly attemptSeq: number | null;
    readonly sessionId: string | null;
    readonly nodeId: string | null;
    readonly providerType: string | null;
    readonly acceptedAt: string | null;
    readonly deliveredAt: string | null;
    readonly consumedAt: string | null;
    readonly terminalAt: string | null;
    readonly updatedAt: string | null;
}

export interface ReplicatedTranscriptSnapshotV1 {
    readonly schemaVersion: 1;

    // identity
    readonly sessionId: string;
    readonly historySessionId: string | null;
    readonly providerType: string;
    readonly providerSessionId: string | null;
    readonly producerDaemonId: string;
    readonly producerWriterId: string;
    readonly producerEpoch: string;
    readonly revision: number;
    readonly observedAt: string;

    // presentation
    readonly status: string;
    readonly providerObservedStatus: string | null;
    readonly title: string | null;
    readonly activeModal: ReplicatedTranscriptModalV1 | null;
    readonly activeInteractivePrompt: ReplicatedTranscriptPromptV1 | null;
    readonly turn: ReplicatedTranscriptTurnV1 | null;

    // provenance
    readonly provenance: ReplicatedTranscriptProvenanceV1;

    // content
    readonly messages: readonly ReplicatedTranscriptMessageV1[];
    readonly terminalMarkers: readonly ReplicatedTranscriptTerminalMarkerV1[];

    // coverage
    readonly coverage: ReplicatedTranscriptCoverageV1;
}

// ─── Candidate types (loosely typed upstream shapes) ────────────────────────

export interface TranscriptSnapshotCandidateMessage {
    readonly role?: unknown;
    readonly kind?: unknown;
    readonly content: string;
    readonly receivedAt?: unknown;
    readonly timestamp?: unknown;
    readonly turnKey?: unknown;
    readonly _turnKey?: unknown;
    readonly bubbleState?: unknown;
    readonly senderName?: unknown;
    readonly toolName?: unknown;
    readonly meta?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidateTerminalMarker {
    readonly receivedAt: number;
    readonly outcome: unknown;
    readonly turnId?: unknown;
    readonly summary?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidateCoverage {
    readonly mode: unknown;
    readonly totalMessageCount: unknown;
    readonly returnedMessageCount: unknown;
    readonly omittedBefore: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidateProvenance {
    readonly messageSource?: unknown;
    readonly transcriptProvenance?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidateModal {
    readonly message?: unknown;
    readonly buttons?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidatePrompt {
    readonly message?: unknown;
    readonly options?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidateTurn {
    readonly authority?: unknown;
    readonly status?: unknown;
    readonly stage?: unknown;
    readonly terminalOutcome?: unknown;
    readonly terminalReason?: unknown;
    readonly meshId?: unknown;
    readonly taskId?: unknown;
    readonly attemptId?: unknown;
    readonly attemptSeq?: unknown;
    readonly sessionId?: unknown;
    readonly nodeId?: unknown;
    readonly providerType?: unknown;
    readonly acceptedAt?: unknown;
    readonly deliveredAt?: unknown;
    readonly consumedAt?: unknown;
    readonly terminalAt?: unknown;
    readonly updatedAt?: unknown;
    readonly [extra: string]: unknown;
}

export interface TranscriptSnapshotCandidate {
    readonly sessionId: string;
    readonly historySessionId?: unknown;
    readonly providerType: string;
    readonly providerSessionId?: unknown;
    readonly producerDaemonId: string;
    readonly producerWriterId: string;
    readonly producerEpoch: string;
    readonly revision: number;
    readonly observedAt: string;

    readonly status: string;
    readonly providerObservedStatus?: unknown;
    readonly title?: unknown;
    readonly activeModal?: TranscriptSnapshotCandidateModal | null;
    readonly activeInteractivePrompt?: TranscriptSnapshotCandidatePrompt | null;
    readonly turn?: TranscriptSnapshotCandidateTurn | null;

    readonly provenance?: TranscriptSnapshotCandidateProvenance;
    readonly messages: readonly TranscriptSnapshotCandidateMessage[];
    readonly terminalMarkers?: readonly TranscriptSnapshotCandidateTerminalMarker[];
    readonly coverage: TranscriptSnapshotCandidateCoverage;

    readonly [extra: string]: unknown;
}

// ─── Scalar coercers (allow-list building blocks) ───────────────────────────

function stringField(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function numberField(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

const BUBBLE_STATES: readonly TranscriptMessageBubbleState[] = ['draft', 'streaming', 'final', 'removed'];

function bubbleStateField(value: unknown): TranscriptMessageBubbleState | null {
    return typeof value === 'string' && (BUBBLE_STATES as readonly string[]).includes(value)
        ? (value as TranscriptMessageBubbleState)
        : null;
}

const TERMINAL_OUTCOMES: readonly TranscriptTerminalOutcome[] = ['completed', 'failed', 'cancelled', 'stalled'];

function terminalOutcomeField(value: unknown): TranscriptTerminalOutcome {
    return typeof value === 'string' && (TERMINAL_OUTCOMES as readonly string[]).includes(value)
        ? (value as TranscriptTerminalOutcome)
        : 'stalled';
}

const COVERAGE_MODES: readonly TranscriptCoverageMode[] = ['full', 'tail', 'current-turn'];

function coverageModeField(value: unknown): TranscriptCoverageMode {
    return typeof value === 'string' && (COVERAGE_MODES as readonly string[]).includes(value)
        ? (value as TranscriptCoverageMode)
        : 'tail';
}

function stringArrayField(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

// ─── Encoders (allow-list copy by name — never a deny-list) ────────────────

export function encodeTranscriptMessage(candidate: TranscriptSnapshotCandidateMessage): ReplicatedTranscriptMessageV1 {
    const meta = candidate.meta;
    const streaming =
        meta && typeof meta === 'object' && !Array.isArray(meta)
            ? booleanField((meta as Record<string, unknown>).streaming)
            : null;
    return {
        role: stringField(candidate.role) ?? 'unknown',
        kind: stringField(candidate.kind) ?? 'standard',
        content: candidate.content,
        receivedAt: numberField(candidate.receivedAt),
        timestamp: numberField(candidate.timestamp),
        turnKey: stringField(candidate.turnKey) ?? stringField(candidate._turnKey),
        // Absent/non-numeric → null (UNKNOWN), never 0. See the field's doc on
        // `ReplicatedTranscriptMessageV1`.
        sequence: numberField(candidate.sequence),
        bubbleState: bubbleStateField(candidate.bubbleState),
        senderName: stringField(candidate.senderName),
        toolName: stringField(candidate.toolName),
        streaming,
    };
}

export function encodeTranscriptTerminalMarker(
    candidate: TranscriptSnapshotCandidateTerminalMarker,
): ReplicatedTranscriptTerminalMarkerV1 {
    return {
        receivedAt: numberField(candidate.receivedAt) ?? 0,
        outcome: terminalOutcomeField(candidate.outcome),
        turnId: stringField(candidate.turnId),
        summary: stringField(candidate.summary),
    };
}

export function encodeTranscriptCoverage(
    candidate: TranscriptSnapshotCandidateCoverage,
): ReplicatedTranscriptCoverageV1 {
    return {
        mode: coverageModeField(candidate.mode),
        totalMessageCount: numberField(candidate.totalMessageCount) ?? 0,
        returnedMessageCount: numberField(candidate.returnedMessageCount) ?? 0,
        omittedBefore: booleanField(candidate.omittedBefore) ?? false,
    };
}

export function encodeTranscriptProvenance(
    candidate: TranscriptSnapshotCandidateProvenance | undefined,
): ReplicatedTranscriptProvenanceV1 {
    return {
        messageSource: stringField(candidate?.messageSource),
        transcriptProvenance: stringField(candidate?.transcriptProvenance),
    };
}

function encodeTranscriptModal(
    candidate: TranscriptSnapshotCandidateModal | null | undefined,
): ReplicatedTranscriptModalV1 | null {
    if (!candidate) return null;
    const message = stringField(candidate.message);
    if (message === null) return null;
    return { message, buttons: stringArrayField(candidate.buttons) };
}

function encodeTranscriptPrompt(
    candidate: TranscriptSnapshotCandidatePrompt | null | undefined,
): ReplicatedTranscriptPromptV1 | null {
    if (!candidate) return null;
    const message = stringField(candidate.message);
    if (message === null) return null;
    return { message, options: stringArrayField(candidate.options) };
}

function encodeTranscriptTurn(
    candidate: TranscriptSnapshotCandidateTurn | null | undefined,
): ReplicatedTranscriptTurnV1 | null {
    if (!candidate) return null;
    return {
        authority: stringField(candidate.authority) ?? 'provider_fsm_fallback',
        status: stringField(candidate.status) ?? 'idle',
        stage: stringField(candidate.stage),
        terminalOutcome: stringField(candidate.terminalOutcome),
        terminalReason: stringField(candidate.terminalReason),
        meshId: stringField(candidate.meshId),
        taskId: stringField(candidate.taskId),
        attemptId: stringField(candidate.attemptId),
        attemptSeq: numberField(candidate.attemptSeq),
        sessionId: stringField(candidate.sessionId),
        nodeId: stringField(candidate.nodeId),
        providerType: stringField(candidate.providerType),
        acceptedAt: stringField(candidate.acceptedAt),
        deliveredAt: stringField(candidate.deliveredAt),
        consumedAt: stringField(candidate.consumedAt),
        terminalAt: stringField(candidate.terminalAt),
        updatedAt: stringField(candidate.updatedAt),
    };
}

/**
 * Project a candidate snapshot down to the closed wire envelope.
 *
 * Total: every field is copied BY NAME from a fixed list. A candidate carrying
 * `sourcePath`, `workspace`, `env`, `debug`, an API key under some unexpected
 * key, or any other field not named above simply has nothing read from it —
 * there is no generic object walk here to accidentally forward it.
 */
export function encodeTranscriptSnapshot(candidate: TranscriptSnapshotCandidate): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,

        sessionId: candidate.sessionId,
        historySessionId: stringField(candidate.historySessionId),
        providerType: candidate.providerType,
        providerSessionId: stringField(candidate.providerSessionId),
        producerDaemonId: candidate.producerDaemonId,
        producerWriterId: candidate.producerWriterId,
        producerEpoch: candidate.producerEpoch,
        revision: candidate.revision,
        observedAt: candidate.observedAt,

        status: candidate.status,
        providerObservedStatus: stringField(candidate.providerObservedStatus),
        title: stringField(candidate.title),
        activeModal: encodeTranscriptModal(candidate.activeModal),
        activeInteractivePrompt: encodeTranscriptPrompt(candidate.activeInteractivePrompt),
        turn: encodeTranscriptTurn(candidate.turn),

        provenance: encodeTranscriptProvenance(candidate.provenance),

        messages: candidate.messages.map(encodeTranscriptMessage),
        terminalMarkers: (candidate.terminalMarkers ?? []).map(encodeTranscriptTerminalMarker),

        coverage: encodeTranscriptCoverage(candidate.coverage),
    };
}

// ─── Canonicalization / hashing ─────────────────────────────────────────────

/**
 * JCS-canonical serialization of an already-encoded snapshot. Both sides of
 * the wire (encoder here, assembler in transcript-revision-codec.ts) MUST use
 * this — never `JSON.stringify` — so producer and subscriber agree on exactly
 * the same bytes for the same logical snapshot regardless of key insertion
 * order.
 */
export function canonicalizeTranscriptSnapshot(snapshot: ReplicatedTranscriptSnapshotV1): string {
    return jcs(snapshot as unknown as JsonValue);
}

/** SHA-256 hex digest of the snapshot's canonical JSON, over UTF-8 bytes. */
export function hashTranscriptSnapshot(snapshot: ReplicatedTranscriptSnapshotV1): string {
    return sha256HexUtf8(canonicalizeTranscriptSnapshot(snapshot));
}
