/**
 * Daemon-side roster router — design §4 ("공통 라우터"), §8 unit 7
 * ("daemon semantic transcript consumers"), for roster ids 4-5:
 * `daemon_worker_status_probe` and `daemon_terminal_evidence`.
 *
 * ── Why this is NOT the mcp-server helper ──────────────────────────────────
 * §8 unit 6's `mesh-transcript-replica-read.ts` lives in mcp-server, a SEPARATE
 * process that may not open `seqscribe.db` (design §4, "별도 프로세스 경계"), so
 * it goes through the `ensure_transcript_subscription`/`read_transcript_replica`
 * IPC pair. These two consumers run INSIDE the daemon that owns the store, so
 * they call `TranscriptReplicaStore` directly — the IPC hop would be the same
 * process talking to itself. The shared parts are the SOURCE type
 * (`ReplicatedTranscriptSnapshotV1`), the roster, the closed fallback union and
 * the payload adapter — all reused verbatim, not re-implemented.
 *
 * ── The readiness gate applied here (design §5.5) ──────────────────────────
 * Common conditions 1, 2, 5 and 7 of §5.5 are enforced in this module or
 * upstream of it:
 *   1. mode `primary` + roster `enabled`      → `mode_not_primary` / `consumer_not_enabled`
 *   2. node/store present, key resolvable     → `no_node`
 *   5. a complete, structurally usable revision → `no_complete_revision` / `revision_invalid`
 *   7. owner/session identity match           → enforced INSIDE the store on
 *      every accepted revision (`transcript-replica-store.ts`, the
 *      `identity.sessionId` / `producerDaemonId` checks), so a snapshot that
 *      reaches us is already owner-and-session-verified.
 * The SEMANTIC extra condition — "active/generating session은 commit age가
 * configured freshness budget 이내" — is `maxAgeMs`, supplied by each consumer
 * because the two have genuinely different budgets (see the constants below).
 *
 * ── ★ Why these consumers fall back rather than being clever ───────────────
 * Both call sites sit on the completion/re-drive path, whose one unforgivable
 * failure direction is asserting a turn ended when it has not. Every non-answer
 * here therefore returns null and the caller runs its ORIGINAL `read_chat` call
 * byte-for-byte. There is no partial answer, and never a merge of the two
 * sources (design §4: "각 read는 replica 하나 또는 legacy 하나로 전부 답하며").
 *
 * ── ★ What this hop does in production TODAY ───────────────────────────────
 * It declines, always — `CommandRouterDeps.resolveTranscriptPeer` is
 * deliberately unset (`boot/daemon-lifecycle.ts`), so no SUB is ever attached
 * and `getReplica` has no entry to serve. Observable behaviour is unchanged:
 * every read takes the legacy path with `transcriptFallbackReason:
 * 'ipc_unavailable'`/`'no_node'`. Wiring the peer resolver is a separate axis
 * (browser-authority ③); when it lands these consumers start serving with no
 * edit here.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveTranscriptMode } from '../seqscribe/transcript-mode.js';
import type {
    ReplicatedTranscriptSnapshotV1,
} from '../seqscribe/transcript-projection.js';
import type { TranscriptReplicaStore } from '../seqscribe/transcript-replica-store.js';
import {
    TRANSCRIPT_CONSUMER_ROSTER,
    type TranscriptConsumerFallbackReason,
    type TranscriptConsumerId,
} from './transcript-read-model-consumers.js';

/**
 * Freshness budget for `daemon_worker_status_probe` (roster id 4).
 *
 * This consumer's whole job is "is the worker generating RIGHT NOW", asked
 * immediately before a synth commits, so a stale answer is worse than no
 * answer: the legacy re-probe it replaces is a live round trip by construction.
 * 10s is below the 30s idle status heartbeat, so a replica that has not moved
 * within one heartbeat is refused rather than used to clear a live-generating
 * worker.
 */
export const TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS = 10_000;

/**
 * Freshness budget for `daemon_terminal_evidence` (roster id 5).
 *
 * Aligned with `TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS` (8s,
 * `mesh-terminal-admission.ts`) — the window that path already uses to decide
 * whether a transcript has been quiet long enough for message-shape evidence to
 * mean anything. A snapshot older than the quiet window cannot answer the
 * question "is the tail still growing", because its own newest bubble would
 * look quiet purely because the snapshot stopped moving.
 */
export const TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS = 8_000;

/** What a roster consumer gets back. `snapshot === null` ⇒ run the legacy read. */
export interface TranscriptConsumerReadOutcome {
    readonly snapshot: ReplicatedTranscriptSnapshotV1 | null;
    /** Null exactly when `snapshot` is non-null. */
    readonly fallbackReason: TranscriptConsumerFallbackReason | null;
}

function decline(reason: TranscriptConsumerFallbackReason): TranscriptConsumerReadOutcome {
    return { snapshot: null, fallbackReason: reason };
}

/**
 * Structural verification of the fields these two consumers actually read.
 *
 * ★ An allow-list assertion of the REQUIRED shape, never a deny-list
 * sanitizer — same discipline as §8 unit 6's `isUsableSnapshot`. Duplicated
 * rather than shared because the two live in different packages (mcp-server
 * cannot import daemon-core internals beyond the public barrel) and, more
 * importantly, because the field sets differ: this one additionally requires
 * `messages` entries to be objects, since the terminal-evidence consumer walks
 * them with `countTrailingToolActivityAfterFinalAssistant`.
 */
function isUsableSnapshot(value: unknown): value is ReplicatedTranscriptSnapshotV1 {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Record<string, unknown>;
    if (snapshot.schemaVersion !== 1) return false;
    if (typeof snapshot.sessionId !== 'string' || !snapshot.sessionId) return false;
    if (typeof snapshot.status !== 'string' || !snapshot.status) return false;
    if (typeof snapshot.observedAt !== 'string' || !snapshot.observedAt) return false;
    if (typeof snapshot.revision !== 'number') return false;
    if (!Array.isArray(snapshot.messages)) return false;
    if (snapshot.messages.some(message => !message || typeof message !== 'object')) return false;
    const coverage = snapshot.coverage as Record<string, unknown> | undefined;
    if (!coverage || typeof coverage !== 'object') return false;
    if (typeof coverage.totalMessageCount !== 'number') return false;
    if (typeof coverage.omittedBefore !== 'boolean') return false;
    if (!snapshot.provenance || typeof snapshot.provenance !== 'object') return false;
    return true;
}

export interface TranscriptConsumerReadRequest {
    readonly consumerId: Extract<
        TranscriptConsumerId,
        'daemon_worker_status_probe' | 'daemon_terminal_evidence'
    >;
    /** The daemon that OWNS the session — the replica key's other half. */
    readonly ownerDaemonId: string | undefined;
    readonly rawSessionId: string | undefined;
    /** Commit-age budget (§5.5 semantic condition). */
    readonly maxAgeMs: number;
    readonly store: TranscriptReplicaStore | null | undefined;
    /** Injected for tests; production passes nothing and gets the real clock. */
    readonly nowMs?: number;
    readonly env?: NodeJS.ProcessEnv;
}

/**
 * The single routing point for roster ids 4-5. Pure apart from the store read
 * and the clock; never throws.
 *
 * ★ Status is NOT derived here, only carried. `snapshot.status` and
 * `snapshot.providerObservedStatus` were produced by `read-chat-presentation`'s
 * `effectiveStatus` on the producer side — the same single authority §8 unit
 * 6's adapter header documents. A second normalization on the consumer side
 * would be a second authority for the same surface.
 */
export function readTranscriptForDaemonConsumer(
    request: TranscriptConsumerReadRequest,
): TranscriptConsumerReadOutcome {
    // §5.5 condition 1 — mode + roster enablement.
    if (resolveTranscriptMode(request.env ?? process.env) !== 'primary') {
        return decline('mode_not_primary');
    }
    if (!TRANSCRIPT_CONSUMER_ROSTER[request.consumerId].enabled) {
        return decline('consumer_not_enabled');
    }

    // §5.5 condition 2 — a store and a complete key.
    const ownerDaemonId = request.ownerDaemonId?.trim();
    const rawSessionId = request.rawSessionId?.trim();
    if (!ownerDaemonId || !rawSessionId) return decline('no_node');
    if (!request.store) return decline('no_node');

    let read;
    try {
        read = request.store.getReplica({ ownerDaemonId, rawSessionId });
    } catch {
        // A store read is pure in-memory, so a throw here is a defect rather
        // than an expected miss — but this path must never propagate one into
        // the completion loop. Degrade like any other non-answer.
        return decline('stats_error');
    }
    if (!read.available) {
        // The store's miss vocabulary (`no_subscription` / `no_complete_
        // revision`) is its own, and `no_subscription` is NOT in the design's
        // closed union. To a caller both mean the same thing — "no usable
        // revision, run the legacy read" — so they collapse onto the union
        // member that exists rather than widening it.
        return decline('no_complete_revision');
    }
    if (!isUsableSnapshot(read.snapshot)) return decline('revision_invalid');

    // §5.5 condition 7 is enforced inside the store, but re-assert the owner
    // half here: the store compares the ASSEMBLED identity, and this is the
    // caller-facing contract that the snapshot answers for the key we asked
    // about. Equivalence-aware, never `===` — daemon ids travel in several
    // forms (`mach_X` / `daemon_mach_X`), the canon-identity defect class.
    if (!daemonIdsEquivalent(read.identity.producerDaemonId, ownerDaemonId)) {
        return decline('owner_mismatch');
    }
    if (read.snapshot.sessionId !== rawSessionId) return decline('owner_mismatch');

    // §5.5 semantic condition — commit age within the consumer's budget. An
    // unparseable `observedAt` is refused rather than treated as fresh: this
    // path may not invent freshness it cannot prove.
    const observedAtMs = Date.parse(read.snapshot.observedAt);
    if (!Number.isFinite(observedAtMs)) return decline('revision_invalid');
    const nowMs = request.nowMs ?? Date.now();
    if (nowMs - observedAtMs > request.maxAgeMs) return decline('stale_active_session');

    return { snapshot: read.snapshot, fallbackReason: null };
}
