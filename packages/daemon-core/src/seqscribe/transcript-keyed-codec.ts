/**
 * `session.<safeSessionId>.chat` keyed wire contract — design 2026-09-28
 * (message-keyed storage) §4.2–§4.6.
 *
 * A session transcript is stored as ONE ROW PER CHANGED BUBBLE on a keyed
 * append topic (topics.ts#sessionChatPolicy), never as a whole snapshot:
 *
 *   key `m:<messageId>`    `chat.msg.v2`  bubble head (body inline when small)
 *   key `p:<messageId>:<k>` `chat.part.v2` k-th ≤24 KiB part of a large body
 *   key `m:…` / `p:…`      `chat.del.v2`  tombstone (bubble / part deleted)
 *   key `meta`             `chat.meta.v2` session presentation state
 *   key `commit`           `chat.commit.v2` frame commit (every frame)
 *
 * One observation is one FRAME: its changed parts, heads/tombstones and (when
 * changed) meta are appended first, then the commit. A reader applies a frame
 * only when its commit arrives, and only after the commit's live count and
 * digest verify (§4.5) — `KeyedTranscriptFolder` (transcript-keyed-folder.ts).
 *
 * ── This file is portable on purpose ───────────────────────────────────────
 * It is a subpath export (`@adhdev/daemon-core/seqscribe/transcript-keyed-codec`)
 * so web-core's transcript worker can reuse it without pulling daemon-core's
 * logger/fs into a browser bundle. Its only imports are `seqscribe` (JCS +
 * SHA-256, both pure JS) — no Node builtins, no `Buffer`. web-core must never
 * value-import the daemon-core ROOT barrel for any of this.
 *
 * ── Allow-list, and it must stay one (invariant I2) ────────────────────────
 * Every encoder below copies fields BY NAME. Upstream message objects carry
 * `meta` bags, `_src` reader addresses, content hashes (`providerUnitKey`,
 * `bubbleId`), paths — none of them may ride along, so there is no spread and
 * no generic object walk. `check:message-projection-parity` scans the `l2k`
 * marker below and fails on any property outside the wire allow-list.
 *
 * ── Identifiers are not content (invariant I3) ─────────────────────────────
 * `id`/`ord`/`rev`/`epoch`/`frame` and the commit digest are ids, integers
 * and a hash over `(id, rev)` pairs only. Nothing here is derived from a
 * message body except the body itself.
 */

import { jcs, sha256HexUtf8, type JsonValue } from 'seqscribe';

// ─── Kinds and keys ─────────────────────────────────────────────────────────

export const CHAT_MSG_KIND = 'chat.msg.v2';
export const CHAT_PART_KIND = 'chat.part.v2';
/** Must equal `topics.ts#CHAT_TOMBSTONE_KIND` (the policy's `keyed.tombstoneKind`). */
export const CHAT_DEL_KIND = 'chat.del.v2';
export const CHAT_META_KIND = 'chat.meta.v2';
export const CHAT_COMMIT_KIND = 'chat.commit.v2';

export const CHAT_META_KEY = 'meta';
export const CHAT_COMMIT_KEY = 'commit';

/** Log-safe session id: the first 8 chars plus the length, never the whole id. */
export function redactSessionId(id: string): string {
    return id.length <= 8 ? id : `${id.slice(0, 8)}…(${id.length})`;
}

export function chatMessageKey(messageId: string): string {
    return `m:${messageId}`;
}

export function chatPartKey(messageId: string, k: number): string {
    return `p:${messageId}:${k}`;
}

/** `{ id, k }` for a bubble key (`k` null for a head), or null for meta/commit/foreign keys. */
export function parseChatKey(key: string): { id: string; k: number | null } | null {
    if (key.startsWith('m:') && key.length > 2) return { id: key.slice(2), k: null };
    if (key.startsWith('p:')) {
        const sep = key.lastIndexOf(':');
        if (sep <= 2) return null;
        const k = Number(key.slice(sep + 1));
        if (!Number.isSafeInteger(k) || k < 0) return null;
        return { id: key.slice(2, sep), k };
    }
    return null;
}

// ─── Size bounds ────────────────────────────────────────────────────────────

/**
 * A body larger than this (JCS-escaped UTF-8 bytes) is split into parts of at
 * most this size (§4.6). 24 KiB keeps a part entry far below seqscribe's
 * 64 KiB `MAX_ENTRY_BYTES` and — even for a worst-case all-backslash body,
 * whose SUB row payload is escaped a second time — below `MAX_ROW_BYTES`.
 */
export const CHAT_PART_MAX_JCS_BYTES = 24 * 1024;

/**
 * Live bytes kept per session (owner decision Q1, §11). Beyond it the oldest
 * bubbles are tombstoned and `coverage.omittedBefore` turns true; the full
 * record stays in the provider's own history file.
 */
export const CHAT_LIVE_BYTES_MAX = 16 * 1024 * 1024;

/** Presentation strings in `meta` are bounded so the entry stays far below 64 KiB. */
export const CHAT_META_TEXT_MAX = 16 * 1024;
const CHAT_META_LABEL_MAX = 1024;
const CHAT_META_LIST_MAX = 32;
/** Terminal markers carried on meta (§4.3). */
export const CHAT_TERMINAL_MARKERS_MAX = 32;

// ─── Wire payloads ──────────────────────────────────────────────────────────

export type ChatBubbleState = 'draft' | 'streaming' | 'final' | 'removed';

export type ChatMsgBodyV2 =
    | { readonly text: string }
    | { readonly parts: number; readonly partRevs: readonly number[] };

export interface ChatMsgV2 {
    readonly v: 2;
    readonly id: string;
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
    /** Fractional-index order key (§4.4) — the transcript is sorted by it. */
    readonly ord: string;
    readonly role: string;
    readonly kind: string;
    /** Turn grouping only — never bubble identity. */
    readonly turnKey: string | null;
    readonly bubbleState: ChatBubbleState | null;
    readonly streaming: boolean | null;
    readonly senderName: string | null;
    readonly toolName: string | null;
    readonly receivedAt: number | null;
    readonly timestamp: number | null;
    /** A truncated tool bubble the daemon can expand by `messageId` (§5.9). */
    readonly expandable: boolean;
    /** The natural id this bubble adopted by source handoff (§3.4), else null. */
    readonly srcId: string | null;
    readonly body: ChatMsgBodyV2;
}

export interface ChatPartV2 {
    readonly v: 2;
    readonly id: string;
    readonly k: number;
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
    readonly text: string;
}

export interface ChatDelV2 {
    readonly v: 2;
    readonly id: string;
    /** Part index for a part tombstone; null for a bubble tombstone. */
    readonly k: number | null;
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
}

export interface ChatModalV2 {
    readonly message: string;
    readonly buttons: readonly string[];
}

export interface ChatPromptV2 {
    readonly message: string;
    readonly options: readonly string[];
}

/** Scalar mirror of `SessionTurnPresentation` (the same 17 fields the v1 wire carried). */
export interface ChatTurnV2 {
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

export type ChatTerminalOutcome = 'completed' | 'failed' | 'cancelled' | 'stalled';

export interface ChatTerminalMarkerV2 {
    readonly receivedAt: number;
    readonly outcome: ChatTerminalOutcome;
    readonly turnId: string | null;
    readonly summary: string | null;
}

/** Scalar-only provenance: `sourcePath`/workspace are excluded by name (§2.4). */
export interface ChatProvenanceV2 {
    readonly messageSource: string | null;
    readonly transcriptProvenance: string | null;
}

export type ChatCoverageMode = 'full' | 'tail' | 'window' | 'current-turn';

export interface ChatCoverageV2 {
    readonly mode: ChatCoverageMode;
    /** True when bubbles before the live set were omitted (window source, or the §11 Q1 live cap). */
    readonly omittedBefore: boolean;
}

export interface ChatMetaV2 {
    readonly v: 2;
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
    readonly sessionId: string;
    readonly historySessionId: string | null;
    readonly providerType: string;
    readonly providerSessionId: string | null;
    readonly producerDaemonId: string;
    readonly status: string;
    readonly providerObservedStatus: string | null;
    readonly title: string | null;
    readonly activeModal: ChatModalV2 | null;
    readonly activeInteractivePrompt: ChatPromptV2 | null;
    readonly turn: ChatTurnV2 | null;
    readonly provenance: ChatProvenanceV2;
    readonly terminalMarkers: readonly ChatTerminalMarkerV2[];
    readonly coverage: ChatCoverageV2;
    /** The producer's message identity ledger epoch `E` (§4.10 rebuild). */
    readonly ledgerEpoch: string;
}

export type ChatBaseReason = 'epoch_start' | 'writer_change' | 'lineage_switch' | 'resync_request';

export interface ChatCommitV2 {
    readonly v: 2;
    readonly sessionId: string;
    readonly writer: string;
    readonly producerDaemonId: string;
    readonly epoch: string;
    readonly frame: number;
    readonly observedAt: string;
    readonly liveCount: number;
    readonly metaRev: number;
    /** `computeChatCommitDigest` over the live `(id, rev)` set and `metaRev`. */
    readonly digest: string;
    readonly basis: 'delta' | 'base';
    readonly baseReason: ChatBaseReason | null;
}

// ─── Materialized view (what every consumer reads) ──────────────────────────

/** One bubble of the folded view. Sorted by `ord` in `ReplicatedTranscriptViewV2.messages`. */
export interface ReplicatedTranscriptMessageV2 {
    readonly messageId: string;
    readonly ord: string;
    readonly rev: number;
    readonly role: string;
    readonly kind: string;
    readonly content: string;
    readonly receivedAt: number | null;
    readonly timestamp: number | null;
    readonly turnKey: string | null;
    readonly bubbleState: ChatBubbleState | null;
    readonly senderName: string | null;
    readonly toolName: string | null;
    readonly streaming: boolean | null;
    readonly expandable: boolean;
    readonly srcId: string | null;
}

/** Coverage as a consumer sees it: the wire's mode/omittedBefore plus live counts. */
export interface ReplicatedTranscriptViewCoverageV2 extends ChatCoverageV2 {
    readonly totalMessageCount: number;
    readonly returnedMessageCount: number;
}

/**
 * The folded, committed state of one session (design §5.1). Every consumer
 * reads this one shape; the removed v1 whole-snapshot type has no union here
 * (§6).
 */
export interface ReplicatedTranscriptViewV2 {
    readonly schemaVersion: 2;

    readonly sessionId: string;
    readonly historySessionId: string | null;
    readonly providerType: string;
    readonly providerSessionId: string | null;
    readonly producerDaemonId: string;
    readonly producerWriterId: string;
    /** Producer epoch + frame of the commit this view reflects. */
    readonly epoch: string;
    readonly frame: number;
    readonly observedAt: string;

    readonly status: string;
    readonly providerObservedStatus: string | null;
    readonly title: string | null;
    readonly activeModal: ChatModalV2 | null;
    readonly activeInteractivePrompt: ChatPromptV2 | null;
    readonly turn: ChatTurnV2 | null;
    readonly provenance: ChatProvenanceV2;

    readonly messages: readonly ReplicatedTranscriptMessageV2[];
    readonly terminalMarkers: readonly ChatTerminalMarkerV2[];
    readonly coverage: ReplicatedTranscriptViewCoverageV2;
}

// ─── Candidates (loosely typed producer shapes) ─────────────────────────────

/**
 * One observed bubble as the producer hands it over: the normalized message
 * plus the identity the read_chat choke point assigned (`messageId`, `ord`).
 * Loosely typed like every candidate — the encoder coerces field by field.
 */
export interface ChatMessageCandidate {
    readonly messageId?: unknown;
    readonly ord?: unknown;
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
    readonly expandable?: unknown;
    readonly meta?: unknown;
    readonly [extra: string]: unknown;
}

/** Producer-stamped, non-content fields of a head (§4.3). */
export interface ChatMessageStamp {
    readonly id: string;
    readonly ord: string;
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
    readonly srcId: string | null;
    readonly body: ChatMsgBodyV2;
}

export interface ChatMetaCandidate {
    readonly sessionId: string;
    readonly historySessionId?: unknown;
    readonly providerType: string;
    readonly providerSessionId?: unknown;
    readonly status: string;
    readonly providerObservedStatus?: unknown;
    readonly title?: unknown;
    readonly activeModal?: unknown;
    readonly activeInteractivePrompt?: unknown;
    readonly turn?: unknown;
    readonly provenance?: unknown;
    readonly terminalMarkers?: unknown;
    readonly [extra: string]: unknown;
}

export interface ChatMetaStamp {
    readonly rev: number;
    readonly epoch: string;
    readonly frame: number;
    readonly producerDaemonId: string;
    readonly ledgerEpoch: string;
    readonly coverage: ChatCoverageV2;
}

// ─── Scalar coercers ────────────────────────────────────────────────────────

function stringField(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function boundedString(value: unknown, max: number): string | null {
    const s = stringField(value);
    return s === null ? null : s.length > max ? s.slice(0, max) : s;
}

function numberField(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const BUBBLE_STATES: readonly ChatBubbleState[] = ['draft', 'streaming', 'final', 'removed'];

function bubbleStateField(value: unknown): ChatBubbleState | null {
    return typeof value === 'string' && (BUBBLE_STATES as readonly string[]).includes(value)
        ? (value as ChatBubbleState)
        : null;
}

const TERMINAL_OUTCOMES: readonly ChatTerminalOutcome[] = ['completed', 'failed', 'cancelled', 'stalled'];

function terminalOutcomeField(value: unknown): ChatTerminalOutcome {
    return typeof value === 'string' && (TERMINAL_OUTCOMES as readonly string[]).includes(value)
        ? (value as ChatTerminalOutcome)
        : 'stalled';
}

const COVERAGE_MODES: readonly ChatCoverageMode[] = ['full', 'tail', 'window', 'current-turn'];

export function chatCoverageModeField(value: unknown): ChatCoverageMode {
    return typeof value === 'string' && (COVERAGE_MODES as readonly string[]).includes(value)
        ? (value as ChatCoverageMode)
        : 'full';
}

function boundedStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        out.push(item.length > CHAT_META_LABEL_MAX ? item.slice(0, CHAT_META_LABEL_MAX) : item);
        if (out.length >= CHAT_META_LIST_MAX) break;
    }
    return out;
}

// ─── Encoders (by-name allow-lists — never a spread) ────────────────────────

/**
 * @message-projection l2k
 *
 * The keyed transcript wire head. Every field is copied BY NAME; `id`/`ord`/
 * `rev`/`epoch`/`frame`/`srcId`/`body` come from the producer's stamp, never
 * from the candidate. `providerUnitKey`, `bubbleId`, `_src`, `toolBlockRef`,
 * `sequence` and the rest of `meta` do not travel.
 */
export function encodeChatMessageHead(candidate: ChatMessageCandidate, stamp: ChatMessageStamp): ChatMsgV2 {
    const meta = recordField(candidate.meta);
    return {
        v: 2,
        id: stamp.id,
        rev: stamp.rev,
        epoch: stamp.epoch,
        frame: stamp.frame,
        ord: stamp.ord,
        role: stringField(candidate.role) ?? 'unknown',
        kind: stringField(candidate.kind) ?? 'standard',
        turnKey: stringField(candidate.turnKey) ?? stringField(candidate._turnKey),
        bubbleState: bubbleStateField(candidate.bubbleState),
        streaming: meta ? booleanField(meta.streaming) : null,
        senderName: stringField(candidate.senderName),
        toolName: stringField(candidate.toolName),
        receivedAt: numberField(candidate.receivedAt),
        timestamp: numberField(candidate.timestamp),
        expandable: candidate.expandable === true,
        srcId: stamp.srcId,
        body: stamp.body,
    };
}

export function encodeChatPart(id: string, k: number, rev: number, epoch: string, frame: number, text: string): ChatPartV2 {
    return { v: 2, id, k, rev, epoch, frame, text };
}

export function encodeChatDel(id: string, k: number | null, rev: number, epoch: string, frame: number): ChatDelV2 {
    return { v: 2, id, k, rev, epoch, frame };
}

function encodeModal(value: unknown): ChatModalV2 | null {
    const raw = recordField(value);
    if (!raw) return null;
    const message = boundedString(raw.message, CHAT_META_TEXT_MAX);
    if (message === null) return null;
    return { message, buttons: boundedStringList(raw.buttons) };
}

function encodePrompt(value: unknown): ChatPromptV2 | null {
    const raw = recordField(value);
    if (!raw) return null;
    const message = boundedString(raw.message, CHAT_META_TEXT_MAX);
    if (message === null) return null;
    return { message, options: boundedStringList(raw.options) };
}

function encodeTurn(value: unknown): ChatTurnV2 | null {
    const raw = recordField(value);
    if (!raw) return null;
    return {
        authority: stringField(raw.authority) ?? 'provider_fsm_fallback',
        status: stringField(raw.status) ?? 'idle',
        stage: stringField(raw.stage),
        terminalOutcome: stringField(raw.terminalOutcome),
        terminalReason: stringField(raw.terminalReason),
        meshId: stringField(raw.meshId),
        taskId: stringField(raw.taskId),
        attemptId: stringField(raw.attemptId),
        attemptSeq: numberField(raw.attemptSeq),
        sessionId: stringField(raw.sessionId),
        nodeId: stringField(raw.nodeId),
        providerType: stringField(raw.providerType),
        acceptedAt: stringField(raw.acceptedAt),
        deliveredAt: stringField(raw.deliveredAt),
        consumedAt: stringField(raw.consumedAt),
        terminalAt: stringField(raw.terminalAt),
        updatedAt: stringField(raw.updatedAt),
    };
}

/**
 * `messageSource` is produced as an OBJECT upstream
 * (`buildCliMessageSourceProvenance`); only its closed-enum `selected` scalar
 * travels — every other key (paths, staleness) stays behind.
 */
function provenanceScalar(value: unknown): string | null {
    if (typeof value === 'string') return value;
    const raw = recordField(value);
    return raw ? stringField(raw.selected) : null;
}

function encodeProvenance(value: unknown): ChatProvenanceV2 {
    const raw = recordField(value);
    return {
        messageSource: provenanceScalar(raw?.messageSource),
        transcriptProvenance: provenanceScalar(raw?.transcriptProvenance),
    };
}

function encodeTerminalMarkers(value: unknown): ChatTerminalMarkerV2[] {
    if (!Array.isArray(value)) return [];
    const out: ChatTerminalMarkerV2[] = [];
    for (const item of value) {
        const raw = recordField(item);
        if (!raw) continue;
        out.push({
            receivedAt: numberField(raw.receivedAt) ?? 0,
            outcome: terminalOutcomeField(raw.outcome),
            turnId: boundedString(raw.turnId, CHAT_META_LABEL_MAX),
            summary: boundedString(raw.summary, CHAT_META_LABEL_MAX),
        });
        if (out.length >= CHAT_TERMINAL_MARKERS_MAX) break;
    }
    return out;
}

/** The session presentation entry (§4.3), by name. Written only when it changed. */
export function encodeChatMeta(candidate: ChatMetaCandidate, stamp: ChatMetaStamp): ChatMetaV2 {
    return {
        v: 2,
        rev: stamp.rev,
        epoch: stamp.epoch,
        frame: stamp.frame,
        sessionId: candidate.sessionId,
        historySessionId: stringField(candidate.historySessionId),
        providerType: candidate.providerType,
        providerSessionId: stringField(candidate.providerSessionId),
        producerDaemonId: stamp.producerDaemonId,
        status: candidate.status,
        providerObservedStatus: stringField(candidate.providerObservedStatus),
        title: boundedString(candidate.title, CHAT_META_LABEL_MAX),
        activeModal: encodeModal(candidate.activeModal),
        activeInteractivePrompt: encodePrompt(candidate.activeInteractivePrompt),
        turn: encodeTurn(candidate.turn),
        provenance: encodeProvenance(candidate.provenance),
        terminalMarkers: encodeTerminalMarkers(candidate.terminalMarkers),
        coverage: { mode: stamp.coverage.mode, omittedBefore: stamp.coverage.omittedBefore },
        ledgerEpoch: stamp.ledgerEpoch,
    };
}

// ─── Digest ─────────────────────────────────────────────────────────────────

/**
 * The commit digest (§4.3): SHA-256 over the JCS of the live `(id, rev)` pairs
 * sorted by id, plus `metaRev`. Ids and integers only — no content.
 */
export function computeChatCommitDigest(live: Iterable<readonly [string, number]>, metaRev: number): string {
    const pairs = Array.from(live, ([id, rev]) => [id, rev] as [string, number]);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return sha256HexUtf8(jcs({ live: pairs, metaRev } as unknown as JsonValue));
}

// ─── Body splitting (§4.6) ──────────────────────────────────────────────────

/**
 * Byte length a code point occupies inside a JCS string literal (UTF-8 of the
 * escaped form). Mirrors ECMAScript `JSON.stringify` string escaping, which
 * JCS adopts: `"`/`\` and the short control escapes take 2 bytes, other C0
 * controls and lone surrogates take 6 (`\uXXXX`).
 */
function jcsCodePointBytes(cp: number): number {
    if (cp === 0x22 || cp === 0x5c) return 2;
    if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp >= 0xd800 && cp <= 0xdfff) return 6;
    if (cp < 0x10000) return 3;
    return 4;
}

/** JCS-escaped UTF-8 byte length of `text` as a string literal body (no quotes). */
export function chatJcsTextBytes(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                bytes += 4;
                i += 1;
                continue;
            }
        }
        bytes += jcsCodePointBytes(c);
    }
    return bytes;
}

/**
 * Split a body into parts of at most `maxBytes` JCS bytes each, cutting only
 * on code point boundaries (a surrogate pair is never split). A body that fits
 * returns a single element. Never truncates: `parts.join('') === text`.
 */
export function splitChatBody(text: string, maxBytes: number = CHAT_PART_MAX_JCS_BYTES): string[] {
    const parts: string[] = [];
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < text.length; ) {
        const c = text.charCodeAt(i);
        let width = 1;
        let cpBytes: number;
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                width = 2;
                cpBytes = 4;
            } else {
                cpBytes = jcsCodePointBytes(c);
            }
        } else {
            cpBytes = jcsCodePointBytes(c);
        }
        if (bytes + cpBytes > maxBytes && i > start) {
            parts.push(text.slice(start, i));
            start = i;
            bytes = 0;
        }
        bytes += cpBytes;
        i += width;
    }
    parts.push(text.slice(start));
    return parts;
}

// ─── Payload readers (shared by the folder and the producer's restore) ──────

function isRev(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Shape-check a `chat.msg.v2` payload; null when malformed. */
export function readChatMsg(payload: unknown): ChatMsgV2 | null {
    const raw = recordField(payload);
    if (!raw || raw.v !== 2 || typeof raw.id !== 'string' || !raw.id) return null;
    if (!isRev(raw.rev) || typeof raw.epoch !== 'string' || !isRev(raw.frame) || typeof raw.ord !== 'string') return null;
    const body = recordField(raw.body);
    if (!body) return null;
    if (typeof body.text !== 'string') {
        if (!isRev(body.parts) || body.parts < 1 || !Array.isArray(body.partRevs) || body.partRevs.length !== body.parts) return null;
        if (!body.partRevs.every(isRev)) return null;
    }
    return raw as unknown as ChatMsgV2;
}

export function readChatPart(payload: unknown): ChatPartV2 | null {
    const raw = recordField(payload);
    if (!raw || raw.v !== 2 || typeof raw.id !== 'string' || !isRev(raw.k) || !isRev(raw.rev)) return null;
    if (typeof raw.epoch !== 'string' || !isRev(raw.frame) || typeof raw.text !== 'string') return null;
    return raw as unknown as ChatPartV2;
}

export function readChatDel(payload: unknown): ChatDelV2 | null {
    const raw = recordField(payload);
    if (!raw || raw.v !== 2 || typeof raw.id !== 'string' || !isRev(raw.rev)) return null;
    if (typeof raw.epoch !== 'string' || !isRev(raw.frame)) return null;
    if (raw.k !== null && !isRev(raw.k)) return null;
    return raw as unknown as ChatDelV2;
}

export function readChatMeta(payload: unknown): ChatMetaV2 | null {
    const raw = recordField(payload);
    if (!raw || raw.v !== 2 || !isRev(raw.rev) || typeof raw.epoch !== 'string' || !isRev(raw.frame)) return null;
    if (typeof raw.sessionId !== 'string' || typeof raw.providerType !== 'string' || typeof raw.status !== 'string') return null;
    if (typeof raw.producerDaemonId !== 'string' || !recordField(raw.coverage) || !recordField(raw.provenance)) return null;
    return raw as unknown as ChatMetaV2;
}

export function readChatCommit(payload: unknown): ChatCommitV2 | null {
    const raw = recordField(payload);
    if (!raw || raw.v !== 2 || typeof raw.sessionId !== 'string' || typeof raw.writer !== 'string') return null;
    if (typeof raw.producerDaemonId !== 'string' || typeof raw.epoch !== 'string' || !isRev(raw.frame)) return null;
    if (!isRev(raw.liveCount) || !isRev(raw.metaRev) || typeof raw.digest !== 'string') return null;
    if (raw.basis !== 'delta' && raw.basis !== 'base') return null;
    return raw as unknown as ChatCommitV2;
}

/**
 * @message-projection l2k-decode
 *
 * Wire head (+ its assembled body) → the view message consumers read. By
 * name, like the encoder: `id` becomes `messageId`, every other allow-listed
 * field is read off the wire head.
 */
export function chatMessageFromWire(head: ChatMsgV2, content: string): ReplicatedTranscriptMessageV2 {
    return {
        messageId: head.id,
        ord: head.ord,
        rev: head.rev,
        role: head.role,
        kind: head.kind,
        content,
        receivedAt: head.receivedAt,
        timestamp: head.timestamp,
        turnKey: head.turnKey,
        bubbleState: head.bubbleState,
        senderName: head.senderName,
        toolName: head.toolName,
        streaming: head.streaming,
        expandable: head.expandable === true,
        srcId: head.srcId,
    };
}

/** Ascending `ord` order (plain code-unit compare, the fractional-index contract). */
export function compareChatOrd(a: { ord: string; messageId: string }, b: { ord: string; messageId: string }): number {
    if (a.ord !== b.ord) return a.ord < b.ord ? -1 : 1;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}
