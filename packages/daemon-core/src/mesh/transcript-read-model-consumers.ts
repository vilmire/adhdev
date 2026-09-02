/**
 * transcript replica consumer roster — design §4 ("소비자 컷오버 로스터").
 *
 * The complete, enumerated set of read sites allowed to answer from the
 * `session.<safeSessionId>.transcript` replica instead of the daemon's
 * normalized `read_chat` path, in the design's consumer integration order.
 * Nothing outside this roster cuts over — mirrors the pattern
 * `mesh-read-model-consumers.ts` established for the (unrelated) mesh-ledger
 * replica, per that file's header.
 *
 * ── Why this lives in `mesh/`, not `seqscribe/` ─────────────────────────────
 * `check:boundaries` forbids `seqscribe/** -> mesh/**` so the replication
 * layer (topic policy, codec, replica store) stays producer/consumer-neutral.
 * This file is the opposite direction: it is CONSUMED by roster call sites
 * (mesh tools, MAGI, daemon reconcile — future units — and, via a type-only
 * re-export, the web-core roster adapter), never imported BY `seqscribe/**`.
 *
 * ── §8 unit 5 scope ─────────────────────────────────────────────────────────
 * This unit enables roster ids 1-2 (`web_chat_pane`,
 * `web_warm_mobile_preview`) — the web-core adapter in
 * `oss/packages/web-core/src/components/dashboard/transcript-chat-pane-adapter.ts`
 * consumes `TranscriptConsumerId`/`TranscriptConsumerFallbackReason` from
 * here (type-only — this file has zero runtime dependencies, so it is safe to
 * expose to a browser bundle via the `./mesh/transcript-read-model-consumers`
 * package export).
 *
 * ── §8 unit 6 scope ─────────────────────────────────────────────────────────
 * Roster id 3 (`mesh_read_chat_display`) is now enabled: `meshReadChat`
 * attempts a coordinator-daemon IPC replica read before its existing live P2P
 * `read_chat`, via `mesh/transcript-read-chat-adapter.ts`.
 *
 * ── §8 unit 7 scope ─────────────────────────────────────────────────────────
 * Roster ids 4-5 (`daemon_worker_status_probe`, `daemon_terminal_evidence`) are
 * now enabled. Both run INSIDE the daemon that owns the replica store, so they
 * route through `mesh/transcript-daemon-consumer-read.ts` — a direct store read
 * plus the §5.5 readiness gate — rather than unit 6's IPC pair, which exists
 * only because mcp-server is a separate process.
 *
 * ── §8 unit 8 scope ─────────────────────────────────────────────────────────
 * Roster ids 6-8 (`mcp_mesh_status_reconciliation`, `magi_approval_probe`,
 * `magi_result_collect`) are now enabled — the three mcp-server reads that
 * derive an IRREVERSIBLE decision (completion synthesis, approve click, final
 * MAGI verdict) rather than merely displaying. They route through
 * `oss/packages/mcp-server/src/tools/mesh-transcript-semantic-read.ts`, which
 * adds §5.5's semantic admission gate (per-consumer coverage + freshness
 * budget) on top of the same IPC pair unit 6 uses, and hands back the same
 * `read_chat`-shaped payload so each call site's existing evidence/kind parser
 * runs unchanged.
 *
 * With units 7 and 8 both landed, every roster id is enabled. The two share the
 * §5.5 gate but not its implementation, and deliberately so: unit 7's consumers
 * are in-process with the store, unit 8's are across a process boundary and must
 * additionally re-validate the untyped JSON that crossed it.
 */

/** The complete roster, in the design's consumer integration order (§4). */
export type TranscriptConsumerId =
    | 'web_chat_pane'
    | 'web_warm_mobile_preview'
    | 'mesh_read_chat_display'
    | 'daemon_worker_status_probe'
    | 'daemon_terminal_evidence'
    | 'mcp_mesh_status_reconciliation'
    | 'magi_approval_probe'
    | 'magi_result_collect';

/**
 * Closed fallback-reason union — design §4 "공통 라우터". Every roster
 * consumer's readiness gate answers with one of these, or `ready`. Reused
 * verbatim from `oss/packages/daemon-core/src/commands/low-family/transcript-replica.ts`,
 * which named this vocabulary first (§8 unit 3, before any roster consumer
 * existed) specifically so it would not fork later — this type is the single
 * source now that a second call site (this roster + the web adapter) needs it.
 */
export type TranscriptConsumerFallbackReason =
    | 'mode_not_primary'
    | 'consumer_not_enabled'
    | 'no_node'
    | 'authority_unavailable'
    | 'topic_undefined'
    | 'topic_not_granted'
    | 'owner_mismatch'
    | 'no_complete_revision'
    | 'revision_invalid'
    | 'projection_oversize'
    | 'coverage_insufficient'
    | 'stale_active_session'
    | 'quarantined'
    | 'parity_mismatch'
    | 'ipc_unavailable'
    | 'stats_error';

export interface TranscriptConsumerRosterEntry {
    /** Where the current (pre-cutover) read lives — file:line, for traceability. */
    readonly currentLocation: string;
    /** One-line description of what this consumer needs and why it is lossless. */
    readonly note: string;
    /** Whether THIS unit wires the consumer's replica routing. */
    readonly enabled: boolean;
}

/** The full roster table (§4) — id → current call site + enablement state. */
export const TRANSCRIPT_CONSUMER_ROSTER: Readonly<Record<TranscriptConsumerId, TranscriptConsumerRosterEntry>> = {
    web_chat_pane: {
        currentLocation: 'oss/packages/web-core/src/components/dashboard/session-chat-tail-controller.ts',
        note: 'Live pane transcript authority + history merge; allow-list preserves every field SessionChatTailUpdate consumers read.',
        enabled: true,
    },
    web_warm_mobile_preview: {
        currentLocation: 'oss/packages/web-core/src/components/dashboard/session-chat-tail-controller.ts (useWarmSessionChatTailControllers)',
        note: 'Selector over the SAME warm controller snapshot web_chat_pane reads — no separate subscription.',
        enabled: true,
    },
    mesh_read_chat_display: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-session.ts (meshReadChat)',
        note: 'Remote transcript display/compact via coordinator daemon IPC replica read; mapTranscriptSnapshotToReadChatPayload keeps compact/full on one shape, so both branches are at parity with the live read.',
        enabled: true,
    },
    daemon_worker_status_probe: {
        currentLocation: 'oss/packages/daemon-core/src/mesh/mesh-remote-event-pull.ts (reprobeWorkerStatus)',
        note: 'Active-session freshness/owner status re-check. Reads ONE field — `payload.status` — which the wire carries verbatim as `snapshot.status` (the producer\'s own effectiveStatus, not a re-derivation), so the read is exactly lossless. Remote nodes only; a declined replica read falls through to the identical legacy read_chat, preserving null\'s fail-open meaning.',
        enabled: true,
    },
    daemon_terminal_evidence: {
        currentLocation: 'oss/packages/daemon-core/src/mesh/mesh-completion-synthesis.ts (fetchAssignedTaskChatTail)',
        note: 'Acked-hold/terminal causal evidence. Every field the extractors read (role/kind/content/senderName/meta.streaming/timestamp/receivedAt, status, providerObservedStatus, activeModal, turn, providerSessionId) survives the projection. ★ NOT lossless in one direction: `turnTerminalMarkers` is deliberately omitted (the wire carries no native markers — see mapTerminalEvidencePayload), so a replica read takes the legacy message-shape admission rules instead of strong native-marker evidence. Weaker evidence, same veto direction.',
        enabled: true,
    },
    mcp_mesh_status_reconciliation: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-internal.ts (reconcileDirectDispatchesFromTranscriptEvidence)',
        note: 'Final-assistant completion synthesis; the replica feeds the SAME readFinalAssistantTranscriptEvidence + hasTrailingToolActivityAfterFinalAssistant parsers as the live read, so the activity-after-final veto and synthesis idempotency are unchanged. Needs activity kinds in order, so tail-only coverage declines.',
        enabled: true,
    },
    magi_approval_probe: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-magi.ts (nudgeWedgedReplica)',
        note: 'Fresh status+activeModal only, for idempotent approve. Irreversible act, so admission requires a snapshot inside the freshness budget (design §5.5); resolve_action stays a live RPC.',
        enabled: true,
    },
    magi_result_collect: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-magi.ts (tryResolveReplica)',
        note: 'Current-turn MAGI result/evidence collection; the replica runs the SAME parseFirstMagiCandidateForKind, and current-turn coverage is required so the FIX#1 cross-turn mis-attribution guard is not lost.',
        enabled: true,
    },
};

/** `TRANSCRIPT_CONSUMER_ROSTER` keys, typed — for exhaustiveness checks in tests. */
export const TRANSCRIPT_CONSUMER_IDS: readonly TranscriptConsumerId[] = Object.keys(
    TRANSCRIPT_CONSUMER_ROSTER,
) as TranscriptConsumerId[];
