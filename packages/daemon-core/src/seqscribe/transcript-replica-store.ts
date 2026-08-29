/**
 * `TranscriptReplicaStore` — the subscriber half of §8 unit 3 ("dynamic
 * transcript activation + daemon replica store"), design §3.7.
 *
 * One instance per daemon process (constructed once at boot alongside the
 * seqscribe node, like `createFleetStatusPeerViewConsumer`). Keyed by
 * `(ownerDaemonId, rawSessionId)` — design §3.7: "current complete snapshot +
 * revision identity/hash · one in-flight revision buffer, byte/row/time caps
 * · SUB cursor/epoch, last SNAP reset reason, last commit time · readiness/
 * fallback reason과 parity state". The in-flight buffer and byte/row caps are
 * already `TranscriptRevisionAssembler`'s job (transcript-revision-codec.ts,
 * §8 unit 1) — this class owns the SUB lifecycle and the per-key assembler
 * instance, not a second copy of that bookkeeping.
 *
 * ── SUB is the only legal ring read here too ────────────────────────────────
 * Same constraint `fleet-status-peer-view.ts`'s header documents for
 * `fleet.status`: `session.*.transcript` is `retention: {mode:'ring'}`, and
 * the library rejects durable `onEntry` registration on ring/none retention
 * with ERR_MISUSE. So `ensureSubscription` below uses
 * `handle.node.subscribe(peer, {view:'tail', params:{topic}})` exclusively —
 * never `onEntry`, never `scanEntries` (that is
 * transcript-parity-actual.ts's job, and ONLY for parity/audit — design §3.3:
 * "live consumer는 built-in tail SUB/SNAP/DELTA를 사용하고 scanEntries로
 * polling하지 않는다").
 *
 * ── Row payload is a JSON STRING here, unlike scanEntries' LogEntry ────────
 * SUB rows are seqscribe's flat `Row` shape (`Record<string, string | number |
 * null>`) — `payload` arrives JSON-encoded, exactly as
 * `fleet-status-peer-view.ts#parseTailRow` documents. `transcript-parity-
 * actual.ts` reads `LogEntry.payload` instead, which the library hands back
 * ALREADY PARSED — the two paths are not interchangeable and this file must
 * not reuse the other's row adapter.
 *
 * ── Defense in depth beyond the codec's own checks ─────────────────────────
 * `TranscriptRevisionAssembler` (constructed here WITHOUT an
 * `expectedOwnerWriterId` — this unit does not yet have a prior, trusted
 * writerId for a session it is subscribing to for the first time; see the
 * header note below) already rejects a spliced begin/commit pair and a
 * snapshot whose body `sessionId` disagrees with the envelope identity. What
 * it does NOT know is what THIS CALLER expected to be subscribing to before
 * the first byte arrived. So after every `status:'complete'` this store
 * additionally checks the assembled identity against the caller-supplied
 * `(ownerDaemonId, rawSessionId)` key — design §3.5's "entry의 raw sessionId와
 * owner/writer도 다시 검사" applied at the STORE layer, independent of the
 * codec-internal self-consistency checks.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { PeerHandle, Row, Subscription } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { ensureSessionTranscriptTopic } from './transcript-activation.js';
import type { ReplicatedTranscriptSnapshotV1 } from './transcript-projection.js';
import {
    TranscriptRevisionAssembler,
    type TranscriptRevisionIdentity,
    type TranscriptRevisionRejectReason,
} from './transcript-revision-codec.js';
import type { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

export const TRANSCRIPT_REPLICA_SUB_VIEW = 'tail';

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

export type TranscriptReplicaReadResult =
    | { readonly available: false; readonly reason: 'no_subscription' | 'no_complete_revision' }
    | {
          readonly available: true;
          readonly snapshot: ReplicatedTranscriptSnapshotV1;
          readonly identity: TranscriptRevisionIdentity;
      };

interface ActiveEntry {
    generation: number;
    assembler: TranscriptRevisionAssembler;
    subscription: Subscription;
    unsubscribeSnapshot: () => void;
    unsubscribeDelta: () => void;
    /**
     * The store's OWN last-verified-good complete revision — deliberately NOT
     * the same slot as `assembler.getLatestComplete()`. The assembler
     * overwrites its internal `complete` unconditionally the moment a
     * begin/chunk/commit set round-trips (it has no notion of "the caller's
     * expected owner"); this store-level slot is only ever updated AFTER the
     * additional owner/session re-check below passes, so a spliced-but-self-
     * consistent revision claiming the wrong producer never becomes visible
     * through `getReplica` — the prior good complete (if any) keeps serving,
     * matching design §3.4's "commit 전까지는 직전 complete snapshot을 계속
     * 제공한다" extended to a revision that fails THIS store's cross-check.
     */
    lastGood: { snapshot: ReplicatedTranscriptSnapshotV1; identity: TranscriptRevisionIdentity } | null;
    /** Bumped on every rejected row — diagnostics only, never gates a read. */
    rejectedRows: number;
    lastRejectReason: TranscriptRevisionRejectReason | 'owner_mismatch' | 'session_mismatch' | null;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parse one SUB tail row into the assembler's row shape, or null if malformed. */
function parseReplicaRow(row: Row): { writer: string; seq: number; kind: string; payload: unknown } | null {
    if (typeof row.writer !== 'string' || !isFiniteNonNegativeInt(row.seq) || typeof row.kind !== 'string') {
        return null;
    }
    if (typeof row.payload !== 'string') return null;
    try {
        return { writer: row.writer, seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) };
    } catch {
        return null;
    }
}

export class TranscriptReplicaStore {
    private readonly active = new Map<string, ActiveEntry>();
    private nextGeneration = 1;
    private stopped = false;

    constructor(
        private readonly node: SeqscribeNodeHandle,
        private readonly claims: TranscriptTopicClaimRegistry,
    ) {}

    /**
     * Define the topic locally (both ends must independently define — design
     * §3.1) and attach a `tail` SUB to `peer` for `key`. Idempotent per key:
     * a second call with the SAME key re-derives readiness without tearing
     * down a healthy subscription; a call with a DIFFERENT peer object for an
     * ALREADY-subscribed key first closes the stale subscription (peer
     * reconnect case).
     */
    ensureSubscription(key: TranscriptReplicaKey, peer: PeerHandle): TranscriptSubscribeResult {
        if (this.stopped) return { ok: false, reason: 'subscribe_failed' };

        const activation = ensureSessionTranscriptTopic(this.node, this.claims, key.rawSessionId, key.ownerDaemonId);
        if (!activation.ok) {
            return { ok: false, reason: activation.reason };
        }

        const keyStr = replicaKeyString(key);
        const existing = this.active.get(keyStr);
        if (existing) return { ok: true, alreadySubscribed: true };

        const generation = this.nextGeneration++;
        const assembler = new TranscriptRevisionAssembler();
        let subscription: Subscription | null = null;
        let unsubscribeSnapshot: (() => void) | null = null;
        let unsubscribeDelta: (() => void) | null = null;

        const ingest = (rows: readonly Row[]): void => {
            const current = this.active.get(keyStr);
            if (!current || current.generation !== generation) return;
            for (const row of rows) {
                const parsed = parseReplicaRow(row);
                if (!parsed) {
                    current.rejectedRows++;
                    continue;
                }
                const result = current.assembler.ingestRow(parsed);
                if (result.status === 'rejected') {
                    current.rejectedRows++;
                    current.lastRejectReason = result.reason;
                    continue;
                }
                if (result.status !== 'complete') continue;

                // Store-level re-check (see header): the assembler already
                // verified begin/commit/snapshot self-consistency; this
                // additionally verifies the result matches what THIS CALLER
                // asked to subscribe to.
                if (result.identity.sessionId !== key.rawSessionId) {
                    current.rejectedRows++;
                    current.lastRejectReason = 'session_mismatch';
                    LOG.warn(
                        'Seqscribe',
                        `transcript replica session mismatch expected=${key.rawSessionId.length <= 8 ? key.rawSessionId : `${key.rawSessionId.slice(0, 8)}…`} — discarding revision`,
                    );
                    continue;
                }
                if (!daemonIdsEquivalent(result.identity.producerDaemonId, key.ownerDaemonId)) {
                    current.rejectedRows++;
                    current.lastRejectReason = 'owner_mismatch';
                    LOG.warn('Seqscribe', 'transcript replica owner mismatch — discarding revision');
                    continue;
                }
                // Accepted: promote to the store's OWN last-good slot (see
                // ActiveEntry#lastGood's doc comment for why `getReplica` reads
                // this, not `assembler.getLatestComplete()` directly).
                current.lastGood = { snapshot: result.snapshot, identity: result.identity };
            }
        };

        try {
            subscription = this.node.node.subscribe(peer, {
                view: TRANSCRIPT_REPLICA_SUB_VIEW,
                params: { topic: activation.topic },
            });
            unsubscribeSnapshot = subscription.onSnapshot((rows) => ingest(rows));
            unsubscribeDelta = subscription.onDelta((changes) => ingest(changes.upserts));
        } catch (error) {
            try { unsubscribeSnapshot?.(); } catch { /* noop */ }
            try { unsubscribeDelta?.(); } catch { /* noop */ }
            try { subscription?.close(); } catch { /* noop */ }
            LOG.warn(
                'Seqscribe',
                `transcript replica subscribe failed topic=${activation.topic}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { ok: false, reason: 'subscribe_failed' };
        }

        this.active.set(keyStr, {
            generation,
            assembler,
            subscription,
            unsubscribeSnapshot,
            unsubscribeDelta,
            lastGood: null,
            rejectedRows: 0,
            lastRejectReason: null,
        });
        return { ok: true, alreadySubscribed: false };
    }

    /** Close one key's SUB and drop its assembler state. */
    detachSubscription(key: TranscriptReplicaKey): void {
        const keyStr = replicaKeyString(key);
        const entry = this.active.get(keyStr);
        if (!entry) return;
        this.active.delete(keyStr);
        try { entry.unsubscribeSnapshot(); } catch { /* noop */ }
        try { entry.unsubscribeDelta(); } catch { /* noop */ }
        try { entry.subscription.close(); } catch { /* peer may already be closed */ }
    }

    /** Pure in-memory read — the `read_transcript_replica` IPC's data source. */
    getReplica(key: TranscriptReplicaKey): TranscriptReplicaReadResult {
        const entry = this.active.get(replicaKeyString(key));
        if (!entry) return { available: false, reason: 'no_subscription' };
        if (!entry.lastGood) return { available: false, reason: 'no_complete_revision' };
        return { available: true, snapshot: entry.lastGood.snapshot, identity: entry.lastGood.identity };
    }

    /** Diagnostics only — never gates a read. */
    diagnostics(key: TranscriptReplicaKey): { subscribed: boolean; rejectedRows: number; lastRejectReason: string | null } {
        const entry = this.active.get(replicaKeyString(key));
        if (!entry) return { subscribed: false, rejectedRows: 0, lastRejectReason: null };
        return { subscribed: true, rejectedRows: entry.rejectedRows, lastRejectReason: entry.lastRejectReason };
    }

    /** Close every SUB — daemon shutdown, before `node.close()`. */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const keyStr of Array.from(this.active.keys())) {
            const entry = this.active.get(keyStr)!;
            this.active.delete(keyStr);
            try { entry.unsubscribeSnapshot(); } catch { /* noop */ }
            try { entry.unsubscribeDelta(); } catch { /* noop */ }
            try { entry.subscription.close(); } catch { /* noop */ }
        }
    }
}
