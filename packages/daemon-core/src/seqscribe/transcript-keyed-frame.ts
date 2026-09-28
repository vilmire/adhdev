/**
 * Producer half of the keyed chat wire: turns one `TranscriptObservation`
 * into one FRAME of `session.<id>.chat` rows — design 2026-09-28 (message-keyed
 * storage) §4.3–§4.10.
 *
 * `KeyedChatSessionState` remembers, per session, what is already durable on
 * the topic (per bubble: `rev`, a local change key, `ord`, part layout) and
 * emits ONLY the difference:
 *
 *   - a bubble whose wire fields and body are unchanged writes nothing — so
 *     re-observing an unchanged source writes 0 rows (§8.1-2);
 *   - a changed bubble writes its head, and of a large (parted) body only the
 *     parts whose text changed — a streaming append rewrites the last part;
 *   - a bubble that left the observation is tombstoned (head + its parts),
 *     except ids the ledger RETAINED because they scrolled out of a window
 *     source's view (§3.5);
 *   - `meta` is written only when it changed;
 *   - every non-empty frame ends with a `commit` carrying the live count and
 *     the `(id, rev)` digest the reader verifies (§4.5).
 *
 * The local change key (`hash`) is a SHA-1 over the encoded head fields plus
 * the body text. It never leaves this process (invariant I3) — the wire only
 * carries ids, integers and the id/rev digest.
 *
 * ── Base frames (invariant I5) ─────────────────────────────────────────────
 * A frame that rewrites every live bubble is allowed only for the four reasons
 * of §4.10 (`resync_request`, `writer_change`, `lineage_switch`,
 * `epoch_start`), recorded on the commit. Anything else that rewrites more
 * than half of the previously live bubbles trips the runtime tripwire (§8.2c):
 * `frame.tripwire` is set and the caller decides whether to throw (dev/test) or
 * count and publish (production).
 *
 * ── Restart (§4.10) ────────────────────────────────────────────────────────
 * `restore` rebuilds the published state from the topic's newest-per-key rows
 * at or below the last commit W (`scanLatestPerKey`). Rows ABOVE W belong to a
 * frame whose commit never landed (a crash mid-frame); their keys are forced
 * to be rewritten or tombstoned by the first new frame, with `rev` above
 * anything a reader may have buffered.
 *
 * No I/O here: the live append, prune and read-back are
 * `transcript-keyed-publish-runtime.ts`'s job.
 */

import { createHash } from 'node:crypto';
import { jcs, type JsonValue } from 'seqscribe';
import {
    CHAT_COMMIT_KEY,
    CHAT_COMMIT_KIND,
    CHAT_DEL_KIND,
    CHAT_LIVE_BYTES_MAX,
    CHAT_META_KEY,
    CHAT_META_KIND,
    CHAT_MSG_KIND,
    CHAT_PART_KIND,
    CHAT_PART_MAX_JCS_BYTES,
    chatJcsTextBytes,
    chatCoverageModeField,
    chatMessageFromWire,
    chatMessageKey,
    chatPartKey,
    computeChatCommitDigest,
    encodeChatDel,
    encodeChatMessageHead,
    encodeChatMeta,
    encodeChatPart,
    parseChatKey,
    readChatCommit,
    readChatDel,
    readChatMeta,
    readChatMsg,
    readChatPart,
    splitChatBody,
    type ChatBaseReason,
    type ChatCommitV2,
    type ChatMetaV2,
    type ChatMsgV2,
    type ReplicatedTranscriptMessageV2,
} from './transcript-keyed-codec.js';
import type { TranscriptObservation, TranscriptObservationMessage } from './transcript-observation.js';

// ─── Frame shape ────────────────────────────────────────────────────────────

export interface KeyedChatFrameRow {
    readonly key: string;
    readonly kind: string;
    readonly payload: JsonValue;
}

export interface KeyedChatFrame {
    readonly sessionId: string;
    readonly epoch: string;
    readonly frame: number;
    /** In append order: parts, heads/tombstones, meta, commit (last). */
    readonly rows: readonly KeyedChatFrameRow[];
    readonly commit: ChatCommitV2;
    /** Heads written (upserts + tombstones). */
    readonly changedBubbles: number;
    /** Heads rewritten for ids that were already live before this frame. */
    readonly rewrittenBubbles: number;
    /** Live bubbles before this frame. */
    readonly priorLive: number;
    /** Approximate JCS bytes of all rows (payloads only). */
    readonly bytes: number;
    /** Rows that replace an existing key (compaction trigger input, §4.8). */
    readonly supersededRows: number;
    readonly supersededBytes: number;
    /** A bubble reached `bubbleState:'final'` in this frame (compaction trigger). */
    readonly finalized: boolean;
    /** The §11 Q1 live cap tombstoned bubbles in this frame. */
    readonly capped: boolean;
    /** A delta frame that rewrote more than half of the previously live bubbles (§8.2c). */
    readonly tripwire: boolean;
    /** A base frame arrived within 10 minutes of the previous one (§4.10). */
    readonly baseRateExceeded: boolean;
    /** The live `(id, rev)` set this frame commits — parity's expected side. */
    readonly live: ReadonlyMap<string, number>;
    /** The observation's bubbles as a reader will materialize them (parity). */
    expectedMessages(): ReplicatedTranscriptMessageV2[];
}

/** One persisted row as `scanLatestPerKey`/`rowsAfter` returns it. */
export interface PersistedChatRow {
    readonly key: string;
    readonly kind: string;
    readonly writer: string;
    readonly payload: unknown;
}

/** What the runtime read back from the topic for `restore`. */
export interface PersistedChatState {
    /** Newest-per-key rows at or below the last commit (W). Empty when nothing is committed. */
    readonly committed: readonly PersistedChatRow[];
    /** Newest-per-key rows above W — a frame whose commit never landed. */
    readonly torn: readonly PersistedChatRow[];
}

export interface KeyedChatBuildContext {
    readonly writerId: string;
    readonly producerDaemonId: string;
    readonly observedAt: string;
    /** Wall clock (ms) for the base-frame rate check. */
    readonly nowMs: number;
    /** A positively confirmed clear/new session (the empty-guard is the caller's job). */
    readonly verifiedClear?: boolean;
}

export type KeyedChatBuildResult =
    | { readonly status: 'frame'; readonly frame: KeyedChatFrame }
    | { readonly status: 'unchanged' }
    | { readonly status: 'unidentified' };

// ─── Local change keys (never on the wire) ──────────────────────────────────

function sha1(text: string): string {
    return createHash('sha1').update(text).digest('base64');
}

/** Head fields that make a bubble "changed", minus the per-write stamp. */
function headChangeKey(head: ChatMsgV2, text: string): string {
    const fields = {
        ord: head.ord,
        role: head.role,
        kind: head.kind,
        turnKey: head.turnKey,
        bubbleState: head.bubbleState,
        streaming: head.streaming,
        senderName: head.senderName,
        toolName: head.toolName,
        receivedAt: head.receivedAt,
        timestamp: head.timestamp,
        expandable: head.expandable,
        srcId: head.srcId,
    };
    return sha1(`${jcs(fields as unknown as JsonValue)}\u0000${text}`);
}

function metaChangeKey(meta: ChatMetaV2): string {
    return sha1(jcs({ ...meta, rev: 0, epoch: '', frame: 0 } as unknown as JsonValue));
}

function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

/** Fixed per-bubble allowance for head fields when accounting live bytes. */
const HEAD_OVERHEAD_BYTES = 256;

/** §8.2c: a delta frame may not rewrite more than this share of the prior live set. */
const TRIPWIRE_REWRITE_SHARE = 0.5;
/** …and only once the session is big enough for the share to mean anything. */
const TRIPWIRE_MIN_LIVE = 8;
/** §4.10: at most one base frame per session per this window before it is an anomaly. */
export const CHAT_BASE_FRAME_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** Last `rev` of recently deleted ids, so a revived id keeps `rev` monotonic. */
const DELETED_REV_MEMORY = 256;

// ─── Session state ──────────────────────────────────────────────────────────

interface PublishedBubble {
    readonly rev: number;
    readonly hash: string;
    readonly ord: string;
    /** Per-part change keys; empty for an inline body. */
    readonly partHashes: readonly string[];
    readonly partRevs: readonly number[];
    readonly bytes: number;
    readonly final: boolean;
}

const STAGED = Symbol('keyedChatStaged');

/** What `commit` applies once the frame's rows are durable. */
interface StagedFrame {
    readonly staged: Map<string, PublishedBubble>;
    readonly deleted: Map<string, number>;
    readonly metaRev: number;
    readonly metaHash: string;
    readonly historySessionId: string | null;
    readonly basis: 'delta' | 'base';
}

interface EncodedBubble {
    readonly message: TranscriptObservationMessage;
    readonly id: string;
    readonly ord: string;
    readonly text: string;
    readonly bytes: number;
}

export class KeyedChatSessionState {
    private bubbles = new Map<string, PublishedBubble>();
    private metaRev = 0;
    private metaHash: string | null = null;
    private historySessionId: string | null | undefined = undefined;
    private frameNo = 0;
    private readonly deletedRevs = new Map<string, number>();
    /** Keys above W at restore: id → highest rev seen, and their part indexes. */
    private tornIds = new Map<string, number>();
    private tornParts = new Map<string, Set<number>>();
    private tornMetaRev: number | null = null;
    private pendingBase: ChatBaseReason | null = null;
    private restoredNonEmpty = false;
    private firstFrame = true;
    private lastBaseAtMs: number | null = null;
    /** Bubbles written by another writer at restore; a base frame supersedes them. */
    private otherWriterRows = false;

    constructor(
        readonly sessionId: string,
        readonly epoch: string,
    ) {}

    get liveCount(): number {
        return this.bubbles.size;
    }

    get frame(): number {
        return this.frameNo;
    }

    /** Ask for a full rewrite on the next frame (a reader's digest-mismatch report). */
    requestBase(reason: ChatBaseReason): void {
        this.pendingBase = reason;
    }

    /**
     * Rebuild the published state from the topic (§4.10). Call once, before the
     * first `build`. `writerId` is this process's writer: rows committed by any
     * other writer make the first frame a `writer_change` base frame.
     */
    restore(persisted: PersistedChatState, writerId: string): void {
        const heads = new Map<string, { head: ChatMsgV2; writer: string }>();
        const parts = new Map<string, Map<number, { text: string; rev: number }>>();
        let commitWriter: string | null = null;
        for (const row of persisted.committed) {
            if (row.kind === CHAT_MSG_KIND) {
                const head = readChatMsg(row.payload);
                if (head) heads.set(head.id, { head, writer: row.writer });
            } else if (row.kind === CHAT_PART_KIND) {
                const part = readChatPart(row.payload);
                if (!part) continue;
                let map = parts.get(part.id);
                if (!map) parts.set(part.id, (map = new Map()));
                map.set(part.k, { text: part.text, rev: part.rev });
            } else if (row.kind === CHAT_DEL_KIND) {
                const del = readChatDel(row.payload);
                if (del && del.k === null) this.rememberDeleted(del.id, del.rev);
            } else if (row.kind === CHAT_META_KIND) {
                const meta = readChatMeta(row.payload);
                if (meta) {
                    this.metaRev = meta.rev;
                    this.metaHash = metaChangeKey(meta);
                    this.historySessionId = meta.historySessionId;
                }
            } else if (row.kind === CHAT_COMMIT_KIND) {
                const commit = readChatCommit(row.payload);
                if (commit) {
                    commitWriter = commit.writer;
                    // Same producer epoch (this process re-restoring after a
                    // failed append): keep numbering frames forward, so a
                    // reader never sees a frame number reused within an epoch.
                    if (commit.epoch === this.epoch) this.frameNo = Math.max(this.frameNo, commit.frame);
                }
            }
        }
        for (const { head, writer } of heads.values()) {
            if (writer !== writerId) this.otherWriterRows = true;
            let text: string;
            let partHashes: string[] = [];
            let partRevs: number[] = [];
            if ('text' in head.body) {
                text = head.body.text;
            } else {
                const map = parts.get(head.id);
                const pieces: string[] = [];
                let complete = true;
                for (let k = 0; k < head.body.parts; k += 1) {
                    const piece = map?.get(k);
                    if (!piece || piece.rev !== head.body.partRevs[k]) complete = false;
                    pieces.push(piece?.text ?? '');
                }
                text = pieces.join('');
                partHashes = pieces.map((piece) => sha1(piece));
                partRevs = [...head.body.partRevs];
                // A head whose parts are not all present cannot be trusted as a
                // baseline: force it through the torn path.
                if (!complete) this.markTorn(head.id, head.rev, map ? Array.from(map.keys()) : []);
            }
            this.bubbles.set(head.id, {
                rev: head.rev,
                hash: headChangeKey(head, text),
                ord: head.ord,
                partHashes,
                partRevs,
                bytes: utf8Bytes(text) + HEAD_OVERHEAD_BYTES,
                final: head.bubbleState === 'final',
            });
        }
        for (const row of persisted.torn) {
            const parsed = parseChatKey(row.key);
            if (row.key === CHAT_META_KEY) {
                const meta = readChatMeta(row.payload);
                this.tornMetaRev = Math.max(this.tornMetaRev ?? 0, meta?.rev ?? 0, this.metaRev);
                continue;
            }
            const tornAt = row.payload as { epoch?: unknown; frame?: unknown } | null;
            if (tornAt && tornAt.epoch === this.epoch && typeof tornAt.frame === 'number') {
                this.frameNo = Math.max(this.frameNo, tornAt.frame);
            }
            if (!parsed) continue;
            const rev = typeof (row.payload as { rev?: unknown })?.rev === 'number' ? (row.payload as { rev: number }).rev : 0;
            this.markTorn(parsed.id, rev, parsed.k === null ? [] : [parsed.k]);
        }
        if (commitWriter !== null && commitWriter !== writerId) this.otherWriterRows = true;
        if (this.otherWriterRows) this.pendingBase = 'writer_change';
        this.restoredNonEmpty = this.bubbles.size > 0;
    }

    private markTorn(id: string, rev: number, partIndexes: readonly number[]): void {
        this.tornIds.set(id, Math.max(this.tornIds.get(id) ?? 0, rev));
        if (partIndexes.length > 0) {
            let set = this.tornParts.get(id);
            if (!set) this.tornParts.set(id, (set = new Set()));
            for (const k of partIndexes) set.add(k);
        }
    }

    private rememberDeleted(id: string, rev: number): void {
        this.deletedRevs.delete(id);
        this.deletedRevs.set(id, rev);
        while (this.deletedRevs.size > DELETED_REV_MEMORY) {
            this.deletedRevs.delete(this.deletedRevs.keys().next().value as string);
        }
    }

    /**
     * Build the next frame, or report that nothing changed. The returned frame
     * is NOT applied: call `commit(frame)` once its rows are durably appended,
     * and drop this state (re-`restore` on the next observation) if the append
     * failed.
     */
    build(observation: TranscriptObservation, ctx: KeyedChatBuildContext): KeyedChatBuildResult {
        // ── desired live set ────────────────────────────────────────────────
        const observed: EncodedBubble[] = [];
        const seen = new Set<string>();
        for (const message of observation.messages) {
            const id = typeof message.messageId === 'string' ? message.messageId : '';
            const ord = typeof message.ord === 'string' ? message.ord : '';
            if (!id || !ord) return { status: 'unidentified' };
            if (seen.has(id)) continue;
            seen.add(id);
            const text = typeof message.content === 'string' ? message.content : '';
            observed.push({ message, id, ord, text, bytes: utf8Bytes(text) + HEAD_OVERHEAD_BYTES });
        }
        const retained = new Set<string>();
        for (const id of observation.coverage.retainedMessageIds ?? []) {
            if (!seen.has(id) && this.bubbles.has(id)) retained.add(id);
        }
        if (ctx.verifiedClear) retained.clear();

        // ── §11 Q1 live cap: tombstone the oldest bubbles beyond 16 MiB ──────
        const byOrd: Array<{ id: string; ord: string; bytes: number }> = [
            ...observed.map((b) => ({ id: b.id, ord: b.ord, bytes: b.bytes })),
            ...Array.from(retained, (id) => {
                const b = this.bubbles.get(id)!;
                return { id, ord: b.ord, bytes: b.bytes };
            }),
        ];
        let total = byOrd.reduce((sum, b) => sum + b.bytes, 0);
        const capped = new Set<string>();
        if (total > CHAT_LIVE_BYTES_MAX) {
            byOrd.sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.id < b.id ? -1 : 1));
            for (let i = 0; i < byOrd.length - 1 && total > CHAT_LIVE_BYTES_MAX; i += 1) {
                capped.add(byOrd[i].id);
                total -= byOrd[i].bytes;
            }
        }
        const omittedBefore =
            capped.size > 0 || retained.size > 0 || observation.coverage.omittedBefore === true;

        // ── base frame decision ─────────────────────────────────────────────
        const nextHistory = typeof observation.historySessionId === 'string' ? observation.historySessionId : null;
        let baseReason: ChatBaseReason | null = this.pendingBase;
        if (
            !baseReason &&
            this.historySessionId !== undefined &&
            this.historySessionId !== null &&
            nextHistory !== null &&
            nextHistory !== this.historySessionId
        ) {
            baseReason = 'lineage_switch';
        }
        const forceAll = baseReason === 'resync_request' || baseReason === 'writer_change';

        const epoch = this.epoch;
        const frameNo = this.frameNo + 1;
        const partRows: KeyedChatFrameRow[] = [];
        const headRows: KeyedChatFrameRow[] = [];
        const staged = new Map<string, PublishedBubble>();
        const deleted = new Map<string, number>();
        let supersededRows = 0;
        let supersededBytes = 0;
        let rewritten = 0;
        let finalized = false;

        const nextRev = (id: string, prior: PublishedBubble | undefined): number =>
            Math.max(prior?.rev ?? 0, this.tornIds.get(id) ?? 0, this.deletedRevs.get(id) ?? 0) + 1;

        // ── upserts ─────────────────────────────────────────────────────────
        for (const bubble of observed) {
            if (capped.has(bubble.id)) continue;
            const prior = this.bubbles.get(bubble.id);
            const probe = encodeChatMessageHead(bubble.message, {
                id: bubble.id,
                ord: bubble.ord,
                rev: 0,
                epoch: '',
                frame: 0,
                srcId: typeof bubble.message.srcId === 'string' ? bubble.message.srcId : null,
                body: { text: '' },
            });
            const hash = headChangeKey(probe, bubble.text);
            const torn = this.tornIds.has(bubble.id);
            if (prior && prior.hash === hash && !forceAll && !torn) continue;
            const rev = nextRev(bubble.id, prior);
            const pieces =
                chatJcsTextBytes(bubble.text) <= CHAT_PART_MAX_JCS_BYTES ? null : splitChatBody(bubble.text);
            const partHashes: string[] = [];
            const partRevs: number[] = [];
            if (pieces) {
                for (let k = 0; k < pieces.length; k += 1) {
                    const partHash = sha1(pieces[k]);
                    const unchanged =
                        !forceAll && !torn && prior !== undefined && prior.partHashes[k] === partHash;
                    partHashes.push(partHash);
                    if (unchanged) {
                        partRevs.push(prior!.partRevs[k]);
                        continue;
                    }
                    partRevs.push(rev);
                    partRows.push({
                        key: chatPartKey(bubble.id, k),
                        kind: CHAT_PART_KIND,
                        payload: encodeChatPart(bubble.id, k, rev, epoch, frameNo, pieces[k]) as unknown as JsonValue,
                    });
                    if (prior && k < prior.partHashes.length) {
                        supersededRows += 1;
                        supersededBytes += Math.min(pieces[k].length, CHAT_PART_MAX_JCS_BYTES);
                    }
                }
            }
            // Parts the bubble no longer has (shrunk, went inline) and parts a
            // torn frame left above the watermark.
            const staleParts = new Set<number>();
            for (let k = pieces ? pieces.length : 0; k < (prior?.partHashes.length ?? 0); k += 1) staleParts.add(k);
            for (const k of this.tornParts.get(bubble.id) ?? []) if (k >= (pieces ? pieces.length : 0)) staleParts.add(k);
            for (const k of staleParts) {
                headRows.push({
                    key: chatPartKey(bubble.id, k),
                    kind: CHAT_DEL_KIND,
                    payload: encodeChatDel(bubble.id, k, rev, epoch, frameNo) as unknown as JsonValue,
                });
                supersededRows += 1;
            }
            const head = encodeChatMessageHead(bubble.message, {
                id: bubble.id,
                ord: bubble.ord,
                rev,
                epoch,
                frame: frameNo,
                srcId: probe.srcId,
                body: pieces ? { parts: pieces.length, partRevs } : { text: bubble.text },
            });
            headRows.push({ key: chatMessageKey(bubble.id), kind: CHAT_MSG_KIND, payload: head as unknown as JsonValue });
            if (prior) {
                rewritten += 1;
                supersededRows += 1;
                supersededBytes += pieces ? 512 : prior.bytes;
            }
            const final = head.bubbleState === 'final';
            if (final && !prior?.final) finalized = true;
            staged.set(bubble.id, {
                rev,
                hash,
                ord: bubble.ord,
                partHashes,
                partRevs,
                bytes: bubble.bytes,
                final,
            });
        }

        // ── deletions ───────────────────────────────────────────────────────
        const tombstone = (id: string, prior: PublishedBubble | undefined): void => {
            const rev = nextRev(id, prior);
            const partCount = Math.max(prior?.partHashes.length ?? 0, 0);
            const parts = new Set<number>();
            for (let k = 0; k < partCount; k += 1) parts.add(k);
            for (const k of this.tornParts.get(id) ?? []) parts.add(k);
            for (const k of parts) {
                headRows.push({
                    key: chatPartKey(id, k),
                    kind: CHAT_DEL_KIND,
                    payload: encodeChatDel(id, k, rev, epoch, frameNo) as unknown as JsonValue,
                });
                supersededRows += 1;
            }
            headRows.push({
                key: chatMessageKey(id),
                kind: CHAT_DEL_KIND,
                payload: encodeChatDel(id, null, rev, epoch, frameNo) as unknown as JsonValue,
            });
            supersededRows += 1;
            supersededBytes += prior?.bytes ?? 0;
            deleted.set(id, rev);
        };
        for (const [id, prior] of this.bubbles) {
            if ((seen.has(id) && !capped.has(id)) || (retained.has(id) && !capped.has(id))) continue;
            tombstone(id, prior);
        }
        // Torn keys of bubbles that are neither live nor desired.
        for (const id of this.tornIds.keys()) {
            if (staged.has(id) || deleted.has(id) || this.bubbles.has(id) || (seen.has(id) && !capped.has(id))) continue;
            tombstone(id, undefined);
        }

        // ── meta ────────────────────────────────────────────────────────────
        const coverageMode = chatCoverageModeField(observation.coverage.mode);
        const metaProbe = encodeChatMeta(observation, {
            rev: 0,
            epoch: '',
            frame: 0,
            producerDaemonId: ctx.producerDaemonId,
            ledgerEpoch: typeof observation.ledgerEpoch === 'string' ? observation.ledgerEpoch : '',
            coverage: { mode: coverageMode, omittedBefore },
        });
        const metaHash = metaChangeKey(metaProbe);
        let metaRow: KeyedChatFrameRow | null = null;
        let metaRev = this.metaRev;
        if (metaHash !== this.metaHash || forceAll || this.tornMetaRev !== null) {
            metaRev = Math.max(this.metaRev, this.tornMetaRev ?? 0) + 1;
            const meta: ChatMetaV2 = { ...metaProbe, rev: metaRev, epoch, frame: frameNo };
            metaRow = { key: CHAT_META_KEY, kind: CHAT_META_KIND, payload: meta as unknown as JsonValue };
            if (this.metaHash !== null) supersededRows += 1;
        }

        if (partRows.length === 0 && headRows.length === 0 && metaRow === null) {
            return { status: 'unchanged' };
        }

        // ── live set + commit ───────────────────────────────────────────────
        const live = new Map<string, number>();
        for (const [id, b] of this.bubbles) live.set(id, b.rev);
        for (const [id, b] of staged) live.set(id, b.rev);
        for (const id of deleted.keys()) live.delete(id);
        const priorLive = this.bubbles.size;
        if (!baseReason && this.firstFrame && this.restoredNonEmpty && priorLive > 0 && rewritten > priorLive * TRIPWIRE_REWRITE_SHARE) {
            // The ledger could not be rebuilt from the topic (it was created
            // before the node was ready, or the mode was off) — a one-time,
            // labelled rewrite rather than an anomaly.
            baseReason = 'epoch_start';
        }
        const basis: 'delta' | 'base' = baseReason ? 'base' : 'delta';
        const tripwire =
            basis === 'delta' && priorLive >= TRIPWIRE_MIN_LIVE && rewritten > priorLive * TRIPWIRE_REWRITE_SHARE;
        const baseRateExceeded =
            basis === 'base' && this.lastBaseAtMs !== null && ctx.nowMs - this.lastBaseAtMs < CHAT_BASE_FRAME_MIN_INTERVAL_MS;

        const commit: ChatCommitV2 = {
            v: 2,
            sessionId: observation.sessionId,
            writer: ctx.writerId,
            producerDaemonId: ctx.producerDaemonId,
            epoch,
            frame: frameNo,
            observedAt: ctx.observedAt,
            liveCount: live.size,
            metaRev,
            digest: computeChatCommitDigest(live, metaRev),
            basis,
            baseReason,
        };
        const rows: KeyedChatFrameRow[] = [
            ...partRows,
            ...headRows,
            ...(metaRow ? [metaRow] : []),
            { key: CHAT_COMMIT_KEY, kind: CHAT_COMMIT_KIND, payload: commit as unknown as JsonValue },
        ];
        let bytes = 0;
        for (const row of rows) bytes += jcsBytesOf(row.payload);
        supersededRows += 1; // the previous commit

        const staging: StagedFrame = {
            staged,
            deleted,
            metaRev,
            metaHash,
            historySessionId: nextHistory ?? this.historySessionId ?? null,
            basis,
        };
        const frame: KeyedChatFrame & { [STAGED]: StagedFrame } = {
            sessionId: this.sessionId,
            epoch,
            frame: frameNo,
            rows,
            commit,
            changedBubbles: headRows.filter((r) => parseChatKey(r.key)?.k === null).length,
            rewrittenBubbles: rewritten,
            priorLive,
            bytes,
            supersededRows,
            supersededBytes,
            finalized,
            capped: capped.size > 0,
            tripwire,
            baseRateExceeded,
            live,
            expectedMessages: () =>
                observed
                    .filter((b) => live.has(b.id))
                    .map((b) => {
                        const head = encodeChatMessageHead(b.message, {
                            id: b.id,
                            ord: b.ord,
                            rev: live.get(b.id)!,
                            epoch,
                            frame: frameNo,
                            srcId: typeof b.message.srcId === 'string' ? b.message.srcId : null,
                            body: { text: b.text },
                        });
                        return chatMessageFromWire(head, b.text);
                    }),
            [STAGED]: staging,
        };
        return { status: 'frame', frame };
    }

    /** Apply a frame whose rows are durably appended. */
    commit(frame: KeyedChatFrame, nowMs: number): void {
        const staging = (frame as KeyedChatFrame & { [STAGED]?: StagedFrame })[STAGED];
        if (!staging || frame.frame !== this.frameNo + 1) return;
        for (const [id, bubble] of staging.staged) {
            this.bubbles.set(id, bubble);
            this.deletedRevs.delete(id);
        }
        for (const [id, rev] of staging.deleted) {
            this.bubbles.delete(id);
            this.rememberDeleted(id, rev);
        }
        this.metaRev = staging.metaRev;
        this.metaHash = staging.metaHash;
        this.historySessionId = staging.historySessionId;
        this.frameNo = frame.frame;
        this.tornIds.clear();
        this.tornParts.clear();
        this.tornMetaRev = null;
        this.pendingBase = null;
        this.firstFrame = false;
        if (staging.basis === 'base') {
            this.lastBaseAtMs = nowMs;
            // The base frame rewrote every live key under this writer; the
            // runtime prunes the other writer's rows once, right after it.
            this.otherWriterRows = false;
        }
    }

    /** Live bytes the session currently holds (§11 Q1 accounting). */
    liveBytes(): number {
        let total = 0;
        for (const b of this.bubbles.values()) total += b.bytes;
        return total;
    }

    /** Live ids (tests/diagnostics). */
    liveIds(): string[] {
        return Array.from(this.bubbles.keys());
    }
}

function jcsBytesOf(payload: JsonValue): number {
    return utf8Bytes(jcs(payload));
}
