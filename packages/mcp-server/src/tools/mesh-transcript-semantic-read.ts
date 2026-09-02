/**
 * mcp-server SEMANTIC transcript replica reads — design §4 (roster ids 6, 7, 8),
 * §8 unit 8 ("mcp semantic transcript consumers").
 *
 * Roster ids 6-8 are the three mcp-server reads that do NOT merely display a
 * transcript but derive an IRREVERSIBLE decision from it:
 *
 *   6 `mcp_mesh_status_reconciliation` — synthesizes a task COMPLETION
 *   7 `magi_approval_probe`            — clicks APPROVE on a live modal
 *   8 `magi_result_collect`            — locks a replica's final MAGI verdict
 *
 * That is the whole reason this module exists separately from §8 unit 6's
 * `mesh-transcript-replica-read.ts` instead of reusing it verbatim. Unit 6's
 * consumer is a DISPLAY surface: if its snapshot is a little stale or covers
 * the wrong window, the user sees a slightly old transcript and asks again.
 * These three consumers cannot be wrong that way — a stale snapshot approves a
 * modal that is no longer on screen, or promotes a previous turn's assistant
 * bubble into "the task completed". Design §5.5's semantic-consumer clause says
 * exactly this: an active session's commit age must be inside a freshness
 * budget, and "stale idle UI는 표시할 수 있지만 ... irreversible 판단에는
 * 쓰지 않는다".
 *
 * ── What is SHARED with unit 6, deliberately ───────────────────────────────
 * The IPC pair (`ensure_transcript_subscription` / `read_transcript_replica`),
 * the process-boundary rule (§4 "별도 프로세스 경계": mcp-server never opens
 * `seqscribe.db`; the coordinator daemon owns it), and the payload shape
 * (`mapTranscriptSnapshotToReadChatPayload`). Producing the SAME `read_chat`-
 * shaped payload is what lets all three call sites keep their existing parsers
 * — `readFinalAssistantTranscriptEvidence`, `hasTrailingToolActivityAfter
 * FinalAssistant`, `magiReadIndicatesApprovalWedge`,
 * `parseFirstMagiCandidateForKind` — completely untouched. The design's
 * acceptance item for each of these rows is "기존 evidence parser를 그대로
 * 적용" / "기존 kind parser 실행" / "approve idempotency 불변"; running the
 * replica through a second, parallel parser would violate all three at once.
 *
 * ── What is ADDED over unit 6: the admission gate ──────────────────────────
 * Per-consumer `coverage` and `freshness` requirements from §4's roster table,
 * checked BEFORE the payload is handed back. Every failure returns
 * `{payload: null, fallbackReason}` — the caller then runs its pre-existing
 * legacy `read_chat` path unchanged. Nothing here ever throws, and nothing here
 * ever returns a "partial" answer: design §4's router contract is that a read
 * is answered by the replica OR by legacy, never by merging the two inside one
 * live window.
 *
 * ── ★ Why the fallback is NOT removed ──────────────────────────────────────
 * `CommandRouterDeps.resolveTranscriptPeer` is deliberately unset at
 * `daemon-core/src/boot/daemon-lifecycle.ts` (see its doc comment), so in
 * production TODAY every one of these reads declines with
 * `ipc_unavailable` and takes its legacy path. That is the designed state for
 * this unit, not a defect: wiring the peer resolver belongs to the transport
 * packages that own the peer map (`daemon-cloud` / `daemon-standalone`). What
 * unit 8 owns is that the admission gate and the fallback ORDER are correct, so
 * that when the resolver lands these three consumers start serving with no edit
 * here. The `fallbackReason` is how an operator sees it flip.
 */

import {
    mapTranscriptSnapshotToReadChatPayload,
    type ReplicatedTranscriptSnapshotV1,
    type TranscriptReadChatPayload,
} from '@adhdev/daemon-core';
import {
    TRANSCRIPT_CONSUMER_ROSTER,
    type TranscriptConsumerFallbackReason,
    type TranscriptConsumerId,
} from '@adhdev/daemon-core/mesh/transcript-read-model-consumers';

/** Narrow local-command capability — same rationale as unit 6's transport type. */
export interface TranscriptReplicaTransport {
    command(type: string, args?: Record<string, unknown>): Promise<any>;
}

export interface SemanticTranscriptReadOutcome {
    /** Null when the replica may not answer — the caller runs its legacy read. */
    readonly payload: TranscriptReadChatPayload | null;
    /** Closed-union reason for the decline; null on success. */
    readonly fallbackReason: TranscriptConsumerFallbackReason | null;
}

/**
 * Freshness budget for a semantic read, in milliseconds (design §5.5's
 * "configured freshness budget").
 *
 * ★ Why a consumer-side clock here, when the display adapter's header forbids
 * recomputing `status`: those are different KINDS of derivation. Recomputing
 * `status` would be a second AUTHORITY over a field the producer already
 * decided. This is an ADMISSION gate — it does not change any field of the
 * snapshot, it only decides whether this consumer is allowed to act on it. The
 * store has no staleness signal of its own to defer to (`getReplica` returns
 * `{snapshot, identity}` only), and §5.5 places the freshness requirement on
 * the consumer for exactly this reason: the budget that is safe for an approval
 * click is not the budget that is safe for a chat pane.
 *
 * 30s: an approval modal and a just-finished turn are both events the producer
 * publishes on a dirty trigger, so a healthy replica is seconds old. A budget
 * an order of magnitude above that tolerates coalescing/clock skew while still
 * refusing a snapshot from a previous poll cycle.
 */
export const SEMANTIC_TRANSCRIPT_FRESHNESS_BUDGET_MS = 30_000;

export interface SemanticTranscriptReadRequest {
    /** Roster id — gates on `TRANSCRIPT_CONSUMER_ROSTER[id].enabled`. */
    readonly consumerId: TranscriptConsumerId;
    readonly ownerDaemonId: string;
    readonly rawSessionId: string;
    /**
     * Coverage modes this consumer's parser can be correct over (§4's
     * "coverage가 tail뿐이면 legacy"). A snapshot outside the set declines with
     * `coverage_insufficient`.
     */
    readonly acceptCoverage: readonly ('full' | 'tail' | 'current-turn')[];
    /**
     * Require `observedAt` inside the freshness budget. True for every
     * irreversible decision (§5.5). When false the snapshot's age is not
     * checked — reserved for reads whose wrongness is recoverable.
     */
    readonly requireFresh: boolean;
    /** Injectable clock so freshness is testable without faking time globally. */
    readonly nowMs?: number;
    /**
     * Injectable roster, defaulting to the real `TRANSCRIPT_CONSUMER_ROSTER`.
     * Exists so a test can pin the "disabled consumer does no IPC" behaviour
     * without borrowing whichever id happens to still be disabled — the roster
     * is fully enabled now that units 7 and 8 have landed, and coupling that
     * assertion to another unit's progress made it fail the moment unit 7
     * merged. Production callers never pass this.
     */
    readonly roster?: Readonly<Record<TranscriptConsumerId, { readonly enabled: boolean }>>;
}

function unwrap(result: any): any {
    // Mirrors unit 6's local `unwrap` (and `unwrapCommandPayload`): the IPC layer
    // sometimes nests the handler's object one level down. Kept local so this
    // module has no dependency on the mesh-tools barrel.
    if (result && typeof result === 'object') {
        if (result.payload && typeof result.payload === 'object') return result.payload;
        if (result.result && typeof result.result === 'object') return result.result;
    }
    return result;
}

const FALLBACK_REASONS = new Set<string>([
    'mode_not_primary', 'consumer_not_enabled', 'no_node', 'authority_unavailable',
    'topic_undefined', 'topic_not_granted', 'owner_mismatch', 'no_complete_revision',
    'revision_invalid', 'projection_oversize', 'coverage_insufficient',
    'stale_active_session', 'quarantined', 'parity_mismatch', 'ipc_unavailable',
    'stats_error',
]);

/**
 * Coerce a daemon-supplied reason into the closed union. A reason that is not a
 * union member is NOT passed through: §4 defines the vocabulary as closed so
 * that fallback telemetry can be counted, and a daemon on a different version
 * must not be able to widen it from across the process boundary.
 */
function narrowReason(value: any, fallback: TranscriptConsumerFallbackReason): TranscriptConsumerFallbackReason {
    const raw = typeof value?.reason === 'string' ? value.reason.trim() : '';
    return FALLBACK_REASONS.has(raw) ? (raw as TranscriptConsumerFallbackReason) : fallback;
}

/**
 * Structural allow-list over the untyped JSON that crossed the process
 * boundary — identical in spirit to unit 6's `isUsableSnapshot`, plus the two
 * fields only the semantic consumers read (`coverage.mode`, `activeModal`
 * shape). ★ Allow-list, never a deny-list sanitizer: it asserts the required
 * shape and refuses otherwise, so a projection regression falls back to legacy
 * instead of feeding a half-empty transcript into a completion synthesis.
 */
function isUsableSnapshot(value: any): value is ReplicatedTranscriptSnapshotV1 {
    if (!value || typeof value !== 'object') return false;
    if (value.schemaVersion !== 1) return false;
    if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
    if (typeof value.status !== 'string' || !value.status) return false;
    if (!Array.isArray(value.messages)) return false;
    if (!value.coverage || typeof value.coverage !== 'object') return false;
    if (typeof value.coverage.mode !== 'string' || !value.coverage.mode) return false;
    if (typeof value.coverage.totalMessageCount !== 'number') return false;
    if (typeof value.coverage.omittedBefore !== 'boolean') return false;
    if (!value.provenance || typeof value.provenance !== 'object') return false;
    if (typeof value.revision !== 'number') return false;
    if (typeof value.observedAt !== 'string' || !value.observedAt) return false;
    // `activeModal` is optional but, when present, must be the allow-listed
    // shape — `magi_approval_probe` decides an approve click from it.
    const modal = value.activeModal;
    if (modal !== null && modal !== undefined) {
        if (typeof modal !== 'object') return false;
        if (typeof modal.message !== 'string') return false;
        if (!Array.isArray(modal.buttons)) return false;
    }
    return true;
}

/**
 * Attempt the replica hop for one semantic consumer. Returns
 * `{payload: null, fallbackReason}` for every non-answer; never throws.
 */
export async function readTranscriptReplicaForSemanticConsumer(
    transport: TranscriptReplicaTransport,
    request: SemanticTranscriptReadRequest,
): Promise<SemanticTranscriptReadOutcome> {
    // Roster gate FIRST (§4: "roster 밖 코드는 replica를 읽을 수 없다"). Checked
    // before any IPC so a disabled consumer costs nothing and, critically, so
    // flipping a roster entry back to `enabled:false` fully disables the cutover
    // — that is the injection lever the design's acceptance list requires.
    if (!(request.roster ?? TRANSCRIPT_CONSUMER_ROSTER)[request.consumerId]?.enabled) {
        return { payload: null, fallbackReason: 'consumer_not_enabled' };
    }
    if (!request.ownerDaemonId || !request.rawSessionId) {
        return { payload: null, fallbackReason: 'no_node' };
    }

    const key = { ownerDaemonId: request.ownerDaemonId, rawSessionId: request.rawSessionId };

    // A not-ready ensure is not fatal on its own (an earlier read may have left
    // a SUB with a complete revision), but it is the reason we report if the
    // read then misses too — same ordering as unit 6.
    let ensureReason: TranscriptConsumerFallbackReason | null = null;
    try {
        const ensured = unwrap(await transport.command('ensure_transcript_subscription', key));
        if (ensured?.ready !== true) ensureReason = narrowReason(ensured, 'ipc_unavailable');
    } catch {
        ensureReason = 'ipc_unavailable';
    }

    let read: any;
    try {
        read = unwrap(await transport.command('read_transcript_replica', key));
    } catch {
        return { payload: null, fallbackReason: ensureReason ?? 'ipc_unavailable' };
    }

    if (read?.available !== true) {
        return { payload: null, fallbackReason: ensureReason ?? narrowReason(read, 'no_complete_revision') };
    }
    if (!isUsableSnapshot(read.snapshot)) {
        return { payload: null, fallbackReason: 'revision_invalid' };
    }

    const snapshot = read.snapshot;

    // ── Coverage admission (§4 roster rows 6/8) ─────────────────────────────
    // `magi_result_collect` must read the CURRENT turn: the whole FIX#1
    // cross-turn mis-attribution guard at its call site exists because a
    // whole-session tail's newest kind-valid JSON can belong to an EARLIER turn.
    // A replica that only covers a tail is exactly that hazard, so it declines.
    if (!request.acceptCoverage.includes(snapshot.coverage.mode)) {
        return { payload: null, fallbackReason: 'coverage_insufficient' };
    }

    // ── Freshness admission (§5.5 semantic-consumer clause) ─────────────────
    if (request.requireFresh) {
        const observedMs = Date.parse(snapshot.observedAt);
        const now = request.nowMs ?? Date.now();
        // An unparseable timestamp is treated as stale, not as "fresh enough":
        // failing closed is the only safe direction for an irreversible act.
        if (!Number.isFinite(observedMs) || now - observedMs > SEMANTIC_TRANSCRIPT_FRESHNESS_BUDGET_MS) {
            return { payload: null, fallbackReason: 'stale_active_session' };
        }
    }

    return {
        payload: mapTranscriptSnapshotToReadChatPayload(snapshot, {
            omittedBefore: snapshot.coverage.omittedBefore,
            stale: read.stale === true,
        }),
        fallbackReason: null,
    };
}
