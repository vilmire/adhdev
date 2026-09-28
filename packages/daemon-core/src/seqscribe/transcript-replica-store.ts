/**
 * `TranscriptReplicaStore` — the daemon-side subscriber of remote sessions'
 * keyed chat topics (design 2026-09-28 message-keyed storage §5.2; lifecycle
 * from the 2026-08-29 transcript design §3.7).
 *
 * One instance per daemon process, keyed by `(ownerDaemonId, rawSessionId)`.
 * Each key holds a `tail` SUB on `session.<id>.chat` and a
 * `KeyedTranscriptFolder` fed by it; `getReplica` serves the folder's last
 * VERIFIED commit (`lastGood` semantics — a frame that fails the commit
 * digest never becomes visible, the previous one keeps serving).
 *
 * ── SUB is the only legal live read here ────────────────────────────────────
 * `subscribe(peer, {view:'tail', params:{topic}})` exclusively — never
 * `onEntry`, never `scanEntries` (parity's job). The owner installs a SNAP
 * selector (transcript-tail-snapshot.ts) so every SNAP is the committed
 * newest-per-key state plus the frame in flight; a SNAP always resets.
 *
 * ── Resync ─────────────────────────────────────────────────────────────────
 * When the folder flags a resync (digest mismatch, torn SNAP, owner/session
 * mismatch on a commit) the SUB is closed and reopened, which yields a fresh
 * `reset:true` SNAP. The same reason three times in a row asks the owner for
 * one base frame (`request_transcript_base`) through the injected
 * `requestBase` hook — there is no server path for it.
 *
 * ── Defense in depth ───────────────────────────────────────────────────────
 * The folder is constructed with the CALLER's expected session id and owner
 * daemon id, so a commit or meta describing anything else is rejected before
 * it can become visible — design §3.5's "entry의 raw sessionId와 owner/writer도
 * 다시 검사" applied at the store layer.
 */

import type { PeerHandle, Row, Subscription } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { ensureSessionChatTopic } from './transcript-activation.js';
import type { ChatCommitV2, ReplicatedTranscriptViewV2 } from './transcript-keyed-codec.js';
import {
    KeyedTranscriptFolder,
    parseChatSubRow,
    type KeyedChatRow,
    type KeyedFoldRejectReason,
} from './transcript-keyed-folder.js';
import type { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

export const TRANSCRIPT_REPLICA_SUB_VIEW = 'tail';

/** Consecutive resyncs for the same reason before asking the owner for a base frame. */
export const TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER = 3;

export interface TranscriptReplicaKey {
    readonly ownerDaemonId: string;
    readonly rawSessionId: string;
}

function replicaKeyString(key: TranscriptReplicaKey): string {
    return `${key.ownerDaemonId}:${key.rawSessionId}`;
}

export type TranscriptSubscribeRejectReason =
    | 'raw_session_id_conflict'
    | 'authority_unavailable'
    | 'define_failed'
    | 'subscribe_failed';

export type TranscriptSubscribeResult =
    | { readonly ok: true; readonly alreadySubscribed: boolean }
    | { readonly ok: false; readonly reason: TranscriptSubscribeRejectReason };

/** Identity of the commit a replica view reflects — non-content scalars. */
export interface TranscriptReplicaCommitIdentity {
    readonly sessionId: string;
    readonly producerDaemonId: string;
    readonly producerWriterId: string;
    readonly epoch: string;
    readonly frame: number;
    readonly observedAt: string;
}

export type TranscriptReplicaReadResult =
    | { readonly available: false; readonly reason: 'no_subscription' | 'no_complete_revision' }
    | {
          readonly available: true;
          readonly view: ReplicatedTranscriptViewV2;
          readonly identity: TranscriptReplicaCommitIdentity;
      };

export interface TranscriptReplicaStoreHooks {
    /** Ask the owner for one base frame (`request_transcript_base`, §5.2). */
    requestBase?(key: TranscriptReplicaKey): void;
}

export interface TranscriptReplicaStoreCounters {
    /** Subscriptions restarted after a folder resync. */
    resubscribes: number;
    /** Base-frame requests sent to owners. */
    baseRequests: number;
    /** Commits rejected by digest/count verification (`chatDigestMismatch`). */
    digestMismatches: number;
}

interface ActiveEntry {
    generation: number;
    peer: PeerHandle;
    topic: string;
    folder: KeyedTranscriptFolder;
    subscription: Subscription | null;
    unsubscribeSnapshot: (() => void) | null;
    unsubscribeDelta: (() => void) | null;
    /** Bumped on every rejected row — diagnostics only, never gates a read. */
    rejectedRows: number;
    lastRejectReason: KeyedFoldRejectReason | 'malformed_row' | null;
    resyncStreak: { reason: KeyedFoldRejectReason; count: number } | null;
    resyncScheduled: boolean;
}

function identityOf(commit: ChatCommitV2, view: ReplicatedTranscriptViewV2): TranscriptReplicaCommitIdentity {
    return {
        sessionId: view.sessionId,
        producerDaemonId: commit.producerDaemonId,
        producerWriterId: commit.writer,
        epoch: commit.epoch,
        frame: commit.frame,
        observedAt: commit.observedAt,
    };
}

export class TranscriptReplicaStore {
    private readonly active = new Map<string, ActiveEntry>();
    private nextGeneration = 1;
    private stopped = false;
    private readonly counters: TranscriptReplicaStoreCounters = { resubscribes: 0, baseRequests: 0, digestMismatches: 0 };

    constructor(
        private readonly node: SeqscribeNodeHandle,
        private readonly claims: TranscriptTopicClaimRegistry,
        private hooks: TranscriptReplicaStoreHooks = {},
    ) {}

    /**
     * Late-bind the base-frame requester: the store is built with the node,
     * before the host's mesh dispatch exists (boot S7 binds it).
     */
    setBaseRequester(requestBase: ((key: TranscriptReplicaKey) => void) | null): void {
        this.hooks = { ...this.hooks, requestBase: requestBase ?? undefined };
    }

    /**
     * Define the topic locally (both ends must independently define) and attach
     * a `tail` SUB to `peer` for `key`. Idempotent per key.
     */
    ensureSubscription(key: TranscriptReplicaKey, peer: PeerHandle): TranscriptSubscribeResult {
        if (this.stopped) return { ok: false, reason: 'subscribe_failed' };

        const activation = ensureSessionChatTopic(this.node, this.claims, key.rawSessionId, key.ownerDaemonId);
        if (!activation.ok) return { ok: false, reason: activation.reason };

        const keyStr = replicaKeyString(key);
        if (this.active.has(keyStr)) return { ok: true, alreadySubscribed: true };

        const entry: ActiveEntry = {
            generation: this.nextGeneration++,
            peer,
            topic: activation.topic,
            folder: new KeyedTranscriptFolder({ expectedSessionId: key.rawSessionId, expectedOwnerDaemonId: key.ownerDaemonId }),
            subscription: null,
            unsubscribeSnapshot: null,
            unsubscribeDelta: null,
            rejectedRows: 0,
            lastRejectReason: null,
            resyncStreak: null,
            resyncScheduled: false,
        };
        if (!this.attach(key, entry)) return { ok: false, reason: 'subscribe_failed' };
        this.active.set(keyStr, entry);
        return { ok: true, alreadySubscribed: false };
    }

    private attach(key: TranscriptReplicaKey, entry: ActiveEntry): boolean {
        const keyStr = replicaKeyString(key);
        const generation = entry.generation;
        const parse = (rows: readonly Row[]): KeyedChatRow[] => {
            const out: KeyedChatRow[] = [];
            for (const row of rows) {
                const parsed = parseChatSubRow(row);
                if (parsed) out.push(parsed);
                else {
                    entry.rejectedRows++;
                    entry.lastRejectReason = 'malformed_row';
                }
            }
            return out;
        };
        const after = (rejectedBefore: number): void => {
            const current = this.active.get(keyStr);
            if (current !== entry || entry.generation !== generation) return;
            const stats = entry.folder.stats();
            entry.rejectedRows += stats.rejectedRows - rejectedBefore;
            entry.lastRejectReason = stats.lastRejectReason ?? entry.lastRejectReason;
            const reason = entry.folder.needsResync;
            if (!reason) {
                entry.resyncStreak = null;
                return;
            }
            // Only a rejection that happened in THIS batch counts toward the
            // streak — later rows arriving before the resubscribe must not.
            if (stats.rejectedRows > rejectedBefore) this.scheduleResync(key, entry, reason);
        };
        try {
            const subscription = this.node.node.subscribe(entry.peer, {
                view: TRANSCRIPT_REPLICA_SUB_VIEW,
                params: { topic: entry.topic },
            });
            entry.subscription = subscription;
            entry.unsubscribeSnapshot = subscription.onSnapshot((rows) => {
                if (entry.generation !== generation) return;
                const before = entry.folder.stats().rejectedRows;
                entry.folder.ingestSnapshot(parse(rows));
                after(before);
            });
            entry.unsubscribeDelta = subscription.onDelta((changes) => {
                if (entry.generation !== generation) return;
                const before = entry.folder.stats().rejectedRows;
                entry.folder.ingestRows(parse(changes.upserts));
                after(before);
            });
            return true;
        } catch (error) {
            this.detachSub(entry);
            LOG.warn(
                'Seqscribe',
                `transcript replica subscribe failed topic=${entry.topic}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
    }

    private detachSub(entry: ActiveEntry): void {
        try { entry.unsubscribeSnapshot?.(); } catch { /* noop */ }
        try { entry.unsubscribeDelta?.(); } catch { /* noop */ }
        try { entry.subscription?.close(); } catch { /* peer may already be closed */ }
        entry.unsubscribeSnapshot = null;
        entry.unsubscribeDelta = null;
        entry.subscription = null;
    }

    /** Restart the SUB (→ fresh reset SNAP); escalate a repeating reason to a base request. */
    private scheduleResync(key: TranscriptReplicaKey, entry: ActiveEntry, reason: KeyedFoldRejectReason): void {
        if (reason === 'digest_mismatch') this.counters.digestMismatches++;
        entry.resyncStreak =
            entry.resyncStreak?.reason === reason
                ? { reason, count: entry.resyncStreak.count + 1 }
                : { reason, count: 1 };
        if (entry.resyncStreak.count >= TRANSCRIPT_REPLICA_BASE_REQUEST_AFTER) {
            entry.resyncStreak = null;
            this.counters.baseRequests++;
            LOG.warn('Seqscribe', `transcript replica requesting a base frame topic=${entry.topic} reason=${reason}`);
            try { this.hooks.requestBase?.(key); } catch { /* best-effort */ }
        }
        if (entry.resyncScheduled) return;
        entry.resyncScheduled = true;
        const keyStr = replicaKeyString(key);
        const timer = setTimeout(() => {
            entry.resyncScheduled = false;
            if (this.stopped || this.active.get(keyStr) !== entry) return;
            this.detachSub(entry);
            entry.generation = this.nextGeneration++;
            // Keep the folder: its last verified view keeps serving until the
            // new SNAP verifies (the folder swaps only on a verified commit).
            this.counters.resubscribes++;
            if (!this.attach(key, entry)) this.active.delete(keyStr);
        }, 0);
        timer.unref?.();
    }

    /** Close one key's SUB and drop its folder. */
    detachSubscription(key: TranscriptReplicaKey): void {
        const keyStr = replicaKeyString(key);
        const entry = this.active.get(keyStr);
        if (!entry) return;
        this.active.delete(keyStr);
        this.detachSub(entry);
    }

    /** Pure in-memory read — the `read_transcript_replica` IPC's data source. */
    getReplica(key: TranscriptReplicaKey): TranscriptReplicaReadResult {
        const entry = this.active.get(replicaKeyString(key));
        if (!entry) return { available: false, reason: 'no_subscription' };
        const view = entry.folder.view();
        const commit = entry.folder.lastCommit();
        if (!view || !commit) return { available: false, reason: 'no_complete_revision' };
        return { available: true, view, identity: identityOf(commit, view) };
    }

    /** Diagnostics only — never gates a read. */
    diagnostics(key: TranscriptReplicaKey): { subscribed: boolean; rejectedRows: number; lastRejectReason: string | null } {
        const entry = this.active.get(replicaKeyString(key));
        if (!entry) return { subscribed: false, rejectedRows: 0, lastRejectReason: null };
        return { subscribed: true, rejectedRows: entry.rejectedRows, lastRejectReason: entry.lastRejectReason };
    }

    /** Local-only counters (`chatDigestMismatch` among them). */
    getCounters(): TranscriptReplicaStoreCounters {
        return { ...this.counters };
    }

    /** Close every SUB — daemon shutdown, before `node.close()`. */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const [keyStr, entry] of Array.from(this.active)) {
            this.active.delete(keyStr);
            this.detachSub(entry);
        }
    }
}
