/**
 * `KeyedTranscriptFolder` — the reader half of the keyed chat wire (design
 * 2026-09-28 message-keyed storage §4.5, §4.9, §5.1).
 *
 * Folds `session.<id>.chat` rows into ONE committed view. Rows of a frame are
 * held as pending until that frame's `chat.commit.v2` arrives; then they are
 * applied atomically and the result is verified against the commit's live
 * count and `(id, rev)` digest. A frame that fails verification is rolled back
 * — the previous committed view keeps serving — and the folder flags a resync
 * (`needsResync`), which the caller answers by restarting its subscription
 * (a fresh `reset:true` SNAP). A reader therefore never observes a state that
 * no commit described (invariant I4): not a torn frame, not a head whose parts
 * have not all arrived.
 *
 * ── Inputs ─────────────────────────────────────────────────────────────────
 *   - `ingestSnapshot(rows)` — a `tail` SUB SNAP (always a reset). The daemon
 *     installs a selector (transcript-tail-snapshot.ts) so a SNAP is
 *     `latestPerKey(W) ∪ rowsAfter(W)`, W = the newest commit's rowid: every
 *     row up to the last commit is committed state (tombstones fold as
 *     absent), everything after it is the next frame in flight.
 *   - `ingestRows(rows)` — DELTA rows, in seq order.
 * Both take already-parsed rows (`{writer, seq, kind, payload}`);
 * `parseChatSubRow` adapts a SUB `Row`, whose `payload` is a JSON string.
 *
 * ── Outputs ────────────────────────────────────────────────────────────────
 *   - `view()` — the committed `ReplicatedTranscriptViewV2`, materialized
 *     lazily and cached until the next commit. Null until a commit verified.
 *   - `onFrame(delta)` — per applied commit: the bubbles that changed
 *     (`upserts`), the ids that disappeared (`deletes`), `meta` when it
 *     changed, and `reset:true` for a SNAP. Incremental consumers (the
 *     browser's worker→main bridge) forward only this.
 *
 * Portable (no `Buffer`, no Node builtins) — a subpath export web-core's worker
 * reuses; see transcript-keyed-codec.ts's header.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import {
    CHAT_COMMIT_KIND,
    CHAT_DEL_KIND,
    CHAT_META_KIND,
    CHAT_MSG_KIND,
    CHAT_PART_KIND,
    chatMessageFromWire,
    compareChatOrd,
    computeChatCommitDigest,
    readChatCommit,
    readChatDel,
    readChatMeta,
    readChatMsg,
    readChatPart,
    type ChatCommitV2,
    type ChatMetaV2,
    type ChatMsgV2,
    type ChatPartV2,
    type ReplicatedTranscriptMessageV2,
    type ReplicatedTranscriptViewV2,
} from './transcript-keyed-codec.js';

/** A parsed chat row (SUB `Row` with its `payload` JSON-decoded, or a `LogEntry`). */
export interface KeyedChatRow {
    readonly writer: string;
    readonly seq: number;
    readonly kind: string;
    readonly payload: unknown;
}

/** Adapt a SUB tail `Row` (`payload` is a JSON string there). Null if malformed. */
export function parseChatSubRow(row: Record<string, string | number | null>): KeyedChatRow | null {
    if (typeof row.writer !== 'string' || typeof row.kind !== 'string' || typeof row.payload !== 'string') return null;
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) return null;
    try {
        return { writer: row.writer, seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) };
    } catch {
        return null;
    }
}

export type KeyedFoldRejectReason =
    | 'malformed_row'
    | 'session_mismatch'
    | 'owner_mismatch'
    | 'foreign_writer'
    | 'digest_mismatch'
    | 'incomplete_bubble'
    | 'pending_overflow';

/** Everything a consumer needs to update incrementally after one applied commit. */
export interface KeyedTranscriptFrameDelta {
    readonly sessionId: string;
    readonly epoch: string;
    readonly frame: number;
    /** True for a SNAP: `upserts` is then the whole live set. */
    readonly reset: boolean;
    readonly upserts: readonly ReplicatedTranscriptMessageV2[];
    readonly deletes: readonly string[];
    /** The view minus `messages`, present when meta changed (always on reset). */
    readonly meta: Omit<ReplicatedTranscriptViewV2, 'messages'> | null;
}

export interface KeyedTranscriptFolderOptions {
    /** Reject rows describing another session (defense in depth beyond the topic name). */
    readonly expectedSessionId?: string;
    /** Reject commits by another producer daemon (`daemonIdsEquivalent`). */
    readonly expectedOwnerDaemonId?: string;
    readonly onFrame?: (delta: KeyedTranscriptFrameDelta) => void;
}

export interface KeyedTranscriptFolderStats {
    readonly commitsApplied: number;
    readonly rejectedRows: number;
    readonly digestMismatches: number;
    readonly tornFramesDropped: number;
    readonly lastRejectReason: KeyedFoldRejectReason | null;
}

interface CommittedState {
    heads: Map<string, ChatMsgV2>;
    parts: Map<string, Map<number, ChatPartV2>>;
    meta: ChatMetaV2 | null;
    commit: ChatCommitV2 | null;
}

function emptyState(): CommittedState {
    return { heads: new Map(), parts: new Map(), meta: null, commit: null };
}

/** Upper bound on buffered frames / rows awaiting their commit. */
const PENDING_FRAMES_MAX = 8;
const PENDING_ROWS_MAX = 50_000;

function frameKey(epoch: string, frame: number): string {
    return `${epoch}\u0000${frame}`;
}

function frameOf(payload: unknown): { epoch: string; frame: number } | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const raw = payload as Record<string, unknown>;
    if (typeof raw.epoch !== 'string' || typeof raw.frame !== 'number' || !Number.isSafeInteger(raw.frame)) return null;
    return { epoch: raw.epoch, frame: raw.frame };
}

/** One undo record: the prior value of a touched slot (undefined = absent). */
type UndoOp =
    | { t: 'head'; id: string; prev: ChatMsgV2 | undefined }
    | { t: 'part'; id: string; k: number; prev: ChatPartV2 | undefined }
    | { t: 'meta'; prev: ChatMetaV2 | null }
    | { t: 'commit'; prev: ChatCommitV2 | null };

export class KeyedTranscriptFolder {
    private state: CommittedState = emptyState();
    private pending = new Map<string, KeyedChatRow[]>();
    private pendingRows = 0;
    private cachedView: ReplicatedTranscriptViewV2 | null = null;
    private resync: KeyedFoldRejectReason | null = null;
    private counters = {
        commitsApplied: 0,
        rejectedRows: 0,
        digestMismatches: 0,
        tornFramesDropped: 0,
        lastRejectReason: null as KeyedFoldRejectReason | null,
    };

    constructor(private readonly options: KeyedTranscriptFolderOptions = {}) {}

    /** The committed view, or null before the first verified commit. */
    view(): ReplicatedTranscriptViewV2 | null {
        if (!this.state.commit || !this.state.meta) return null;
        if (!this.cachedView) this.cachedView = this.materialize();
        return this.cachedView;
    }

    /** The last applied commit (identity/diagnostics). */
    lastCommit(): ChatCommitV2 | null {
        return this.state.commit;
    }

    /** Set when a frame failed verification — restart the subscription (SNAP reset). */
    get needsResync(): KeyedFoldRejectReason | null {
        return this.resync;
    }

    stats(): KeyedTranscriptFolderStats {
        return { ...this.counters };
    }

    /**
     * A SNAP: rebuild from scratch. Rows up to and including the LAST commit are
     * the committed baseline (verified against that commit); rows after it are
     * pending. A SNAP that fails verification leaves the previous view in place
     * and flags a resync.
     */
    ingestSnapshot(rows: readonly KeyedChatRow[]): KeyedTranscriptFrameDelta | null {
        let lastCommitAt = -1;
        let commit: ChatCommitV2 | null = null;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i].kind !== CHAT_COMMIT_KIND) continue;
            const parsed = readChatCommit(rows[i].payload);
            if (parsed && parsed.writer === rows[i].writer) {
                lastCommitAt = i;
                commit = parsed;
                break;
            }
        }
        this.pending.clear();
        this.pendingRows = 0;
        if (!commit) {
            if (rows.length === 0) {
                // An empty topic: nothing has been published (or all of it was
                // pruned) — there is no committed view to show.
                this.state = emptyState();
                this.cachedView = null;
                this.resync = null;
            }
            for (const row of rows) this.stash(row);
            return null;
        }
        const rejected = this.checkCommitIdentity(commit);
        if (rejected) {
            this.reject(rejected, true);
            return null;
        }
        const next = emptyState();
        for (let i = 0; i < lastCommitAt; i += 1) {
            const row = rows[i];
            if (row.writer !== commit.writer) continue;
            this.applyRow(next, row, null);
        }
        const verdict = this.verify(next, commit);
        if (verdict) {
            this.counters.digestMismatches += verdict === 'digest_mismatch' ? 1 : 0;
            this.reject(verdict, true);
            return null;
        }
        next.commit = commit;
        this.state = next;
        this.cachedView = null;
        this.resync = null;
        this.counters.commitsApplied++;
        for (let i = lastCommitAt + 1; i < rows.length; i += 1) this.stash(rows[i]);
        const view = this.view();
        const delta: KeyedTranscriptFrameDelta = {
            sessionId: commit.sessionId,
            epoch: commit.epoch,
            frame: commit.frame,
            reset: true,
            upserts: view ? view.messages : [],
            deletes: [],
            meta: view ? this.materializeMeta() : null,
        };
        this.options.onFrame?.(delta);
        return delta;
    }

    /** DELTA rows. Returns the delta of every commit applied by this batch. */
    ingestRows(rows: readonly KeyedChatRow[]): KeyedTranscriptFrameDelta[] {
        const out: KeyedTranscriptFrameDelta[] = [];
        for (const row of rows) {
            if (row.kind === CHAT_COMMIT_KIND) {
                const delta = this.ingestCommit(row);
                if (delta) out.push(delta);
            } else {
                this.stash(row);
            }
        }
        return out;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private stash(row: KeyedChatRow): void {
        if (row.kind === CHAT_COMMIT_KIND) return;
        const at = frameOf(row.payload);
        if (!at) {
            this.reject('malformed_row', false);
            return;
        }
        const key = frameKey(at.epoch, at.frame);
        let list = this.pending.get(key);
        if (!list) {
            list = [];
            this.pending.set(key, list);
            // Oldest frames are the torn ones; a commit that never comes must
            // not grow this without bound.
            while (this.pending.size > PENDING_FRAMES_MAX) {
                const oldest = this.pending.keys().next().value as string;
                this.pendingRows -= this.pending.get(oldest)!.length;
                this.pending.delete(oldest);
                this.counters.tornFramesDropped++;
            }
        }
        list.push(row);
        this.pendingRows += 1;
        if (this.pendingRows > PENDING_ROWS_MAX) {
            this.pending.clear();
            this.pendingRows = 0;
            this.reject('pending_overflow', true);
        }
    }

    private checkCommitIdentity(commit: ChatCommitV2): KeyedFoldRejectReason | null {
        if (this.options.expectedSessionId !== undefined && commit.sessionId !== this.options.expectedSessionId) {
            return 'session_mismatch';
        }
        if (
            this.options.expectedOwnerDaemonId !== undefined &&
            !daemonIdsEquivalent(commit.producerDaemonId, this.options.expectedOwnerDaemonId)
        ) {
            return 'owner_mismatch';
        }
        return null;
    }

    private ingestCommit(row: KeyedChatRow): KeyedTranscriptFrameDelta | null {
        const commit = readChatCommit(row.payload);
        if (!commit || commit.writer !== row.writer) {
            this.reject('malformed_row', false);
            return null;
        }
        const rejected = this.checkCommitIdentity(commit);
        if (rejected) {
            this.reject(rejected, false);
            return null;
        }
        const key = frameKey(commit.epoch, commit.frame);
        const rows = (this.pending.get(key) ?? []).filter((r) => r.writer === commit.writer);
        // Everything buffered for this epoch up to this frame is now either
        // applied or torn; frames of any other epoch are torn (a producer that
        // restarted mid-frame never commits them).
        for (const [k, list] of Array.from(this.pending)) {
            const [epoch, frameText] = k.split('\u0000');
            if (epoch !== commit.epoch || Number(frameText) <= commit.frame) {
                if (k !== key) this.counters.tornFramesDropped++;
                this.pendingRows -= list.length;
                this.pending.delete(k);
            }
        }

        // A new writer's commit replaces the previous writer's state wholesale
        // (§4.11): its first frame is a base frame carrying every live bubble.
        const writerChanged = this.state.commit !== null && this.state.commit.writer !== commit.writer;
        if (writerChanged) {
            const next = emptyState();
            for (const r of rows) this.applyRow(next, r, null);
            const verdict = this.verify(next, commit);
            if (verdict) {
                this.counters.digestMismatches += verdict === 'digest_mismatch' ? 1 : 0;
                this.reject(verdict, true);
                return null;
            }
            next.commit = commit;
            this.state = next;
            this.cachedView = null;
            this.resync = null;
            this.counters.commitsApplied++;
            const view = this.view();
            const delta: KeyedTranscriptFrameDelta = {
                sessionId: commit.sessionId,
                epoch: commit.epoch,
                frame: commit.frame,
                reset: true,
                upserts: view ? view.messages : [],
                deletes: [],
                meta: view ? this.materializeMeta() : null,
            };
            this.options.onFrame?.(delta);
            return delta;
        }

        const undo: UndoOp[] = [];
        const touched = new Set<string>();
        let metaChanged = false;
        for (const r of rows) {
            const effect = this.applyRow(this.state, r, undo);
            if (effect === 'meta') metaChanged = true;
            else if (effect) touched.add(effect);
        }
        const verdict = this.verify(this.state, commit);
        if (verdict) {
            this.rollback(undo);
            this.counters.digestMismatches += verdict === 'digest_mismatch' ? 1 : 0;
            this.reject(verdict, true);
            return null;
        }
        undo.push({ t: 'commit', prev: this.state.commit });
        const first = this.state.commit === null;
        this.state.commit = commit;
        this.cachedView = null;
        this.resync = null;
        this.counters.commitsApplied++;

        const upserts: ReplicatedTranscriptMessageV2[] = [];
        const deletes: string[] = [];
        for (const id of touched) {
            const message = this.materializeMessage(id);
            if (message) upserts.push(message);
            else deletes.push(id);
        }
        upserts.sort(compareChatOrd);
        const view = first ? this.view() : null;
        const delta: KeyedTranscriptFrameDelta = {
            sessionId: commit.sessionId,
            epoch: commit.epoch,
            frame: commit.frame,
            reset: first,
            upserts: first && view ? view.messages : upserts,
            deletes: first ? [] : deletes,
            meta: first || metaChanged ? this.materializeMeta() : null,
        };
        this.options.onFrame?.(delta);
        return delta;
    }

    /**
     * Apply one non-commit row to `state`. Returns the bubble id it touched,
     * `'meta'`, or null. Rows of an unknown kind are ignored (forward
     * compatibility), malformed ones are counted.
     */
    private applyRow(state: CommittedState, row: KeyedChatRow, undo: UndoOp[] | null): string | 'meta' | null {
        switch (row.kind) {
            case CHAT_MSG_KIND: {
                const head = readChatMsg(row.payload);
                if (!head) return this.malformed();
                undo?.push({ t: 'head', id: head.id, prev: state.heads.get(head.id) });
                state.heads.set(head.id, head);
                if ('text' in head.body) this.dropParts(state, head.id, 0, undo);
                else this.dropParts(state, head.id, head.body.parts, undo);
                return head.id;
            }
            case CHAT_PART_KIND: {
                const part = readChatPart(row.payload);
                if (!part) return this.malformed();
                let map = state.parts.get(part.id);
                if (!map) {
                    map = new Map();
                    state.parts.set(part.id, map);
                }
                undo?.push({ t: 'part', id: part.id, k: part.k, prev: map.get(part.k) });
                map.set(part.k, part);
                return part.id;
            }
            case CHAT_DEL_KIND: {
                const del = readChatDel(row.payload);
                if (!del) return this.malformed();
                if (del.k === null) {
                    undo?.push({ t: 'head', id: del.id, prev: state.heads.get(del.id) });
                    state.heads.delete(del.id);
                    this.dropParts(state, del.id, 0, undo);
                } else {
                    const map = state.parts.get(del.id);
                    if (map?.has(del.k)) {
                        undo?.push({ t: 'part', id: del.id, k: del.k, prev: map.get(del.k) });
                        map.delete(del.k);
                    }
                }
                return del.id;
            }
            case CHAT_META_KIND: {
                const meta = readChatMeta(row.payload);
                if (!meta) return this.malformed();
                if (this.options.expectedSessionId !== undefined && meta.sessionId !== this.options.expectedSessionId) {
                    this.reject('session_mismatch', false);
                    return null;
                }
                undo?.push({ t: 'meta', prev: state.meta });
                state.meta = meta;
                return 'meta';
            }
            default:
                return null;
        }
    }

    private malformed(): null {
        this.reject('malformed_row', false);
        return null;
    }

    /** Drop part slots `k >= from` of a bubble (fewer parts, inline body, or deletion). */
    private dropParts(state: CommittedState, id: string, from: number, undo: UndoOp[] | null): void {
        const map = state.parts.get(id);
        if (!map) return;
        for (const k of Array.from(map.keys())) {
            if (k < from) continue;
            undo?.push({ t: 'part', id, k, prev: map.get(k) });
            map.delete(k);
        }
        if (map.size === 0) state.parts.delete(id);
    }

    private rollback(undo: UndoOp[]): void {
        for (let i = undo.length - 1; i >= 0; i -= 1) {
            const op = undo[i];
            if (op.t === 'head') {
                if (op.prev) this.state.heads.set(op.id, op.prev);
                else this.state.heads.delete(op.id);
            } else if (op.t === 'part') {
                let map = this.state.parts.get(op.id);
                if (op.prev) {
                    if (!map) {
                        map = new Map();
                        this.state.parts.set(op.id, map);
                    }
                    map.set(op.k, op.prev);
                } else if (map) {
                    map.delete(op.k);
                    if (map.size === 0) this.state.parts.delete(op.id);
                }
            } else if (op.t === 'meta') {
                this.state.meta = op.prev;
            } else {
                this.state.commit = op.prev;
            }
        }
    }

    /** Commit verification (§4.5): displayable bubbles, live count, digest. */
    private verify(state: CommittedState, commit: ChatCommitV2): KeyedFoldRejectReason | null {
        for (const head of state.heads.values()) {
            if ('text' in head.body) continue;
            const map = state.parts.get(head.id);
            for (let k = 0; k < head.body.parts; k += 1) {
                if (map?.get(k)?.rev !== head.body.partRevs[k]) return 'incomplete_bubble';
            }
        }
        const metaRev = state.meta?.rev ?? 0;
        if (state.heads.size !== commit.liveCount || metaRev !== commit.metaRev) return 'digest_mismatch';
        const digest = computeChatCommitDigest(
            Array.from(state.heads.values(), (h) => [h.id, h.rev] as const),
            metaRev,
        );
        return digest === commit.digest ? null : 'digest_mismatch';
    }

    private reject(reason: KeyedFoldRejectReason, needsResync: boolean): void {
        this.counters.rejectedRows++;
        this.counters.lastRejectReason = reason;
        if (needsResync) this.resync = reason;
    }

    private bodyOf(head: ChatMsgV2): string {
        if ('text' in head.body) return head.body.text;
        const map = this.state.parts.get(head.id);
        let text = '';
        for (let k = 0; k < head.body.parts; k += 1) text += map?.get(k)?.text ?? '';
        return text;
    }

    private materializeMessage(id: string): ReplicatedTranscriptMessageV2 | null {
        const head = this.state.heads.get(id);
        return head ? chatMessageFromWire(head, this.bodyOf(head)) : null;
    }

    private materialize(): ReplicatedTranscriptViewV2 {
        const messages = Array.from(this.state.heads.values(), (head) => chatMessageFromWire(head, this.bodyOf(head)));
        messages.sort(compareChatOrd);
        return { ...this.materializeMeta(), messages };
    }

    /** The view without `messages` — O(1) in the transcript size. */
    private materializeMeta(): Omit<ReplicatedTranscriptViewV2, 'messages'> {
        const commit = this.state.commit!;
        const meta = this.state.meta!;
        const live = this.state.heads.size;
        return {
            schemaVersion: 2,
            sessionId: meta.sessionId,
            historySessionId: meta.historySessionId,
            providerType: meta.providerType,
            providerSessionId: meta.providerSessionId,
            producerDaemonId: commit.producerDaemonId,
            producerWriterId: commit.writer,
            epoch: commit.epoch,
            frame: commit.frame,
            observedAt: commit.observedAt,
            status: meta.status,
            providerObservedStatus: meta.providerObservedStatus,
            title: meta.title,
            activeModal: meta.activeModal,
            activeInteractivePrompt: meta.activeInteractivePrompt,
            turn: meta.turn,
            provenance: meta.provenance,
            terminalMarkers: meta.terminalMarkers,
            coverage: {
                mode: meta.coverage.mode,
                omittedBefore: meta.coverage.omittedBefore,
                totalMessageCount: live,
                returnedMessageCount: live,
            },
        };
    }
}
