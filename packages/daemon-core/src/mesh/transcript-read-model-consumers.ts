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
 * package export). Ids 3-8 are declared for completeness (the full roster
 * table, §4) but their readiness/routing wiring is out of this unit's scope —
 * a caller asking about them today gets `consumer_not_enabled`.
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
        note: 'Remote transcript display/compact via coordinator daemon IPC replica read — out of this unit\'s scope.',
        enabled: false,
    },
    daemon_worker_status_probe: {
        currentLocation: 'oss/packages/daemon-core/src/mesh/mesh-remote-event-pull.ts (reprobeWorkerStatus)',
        note: 'Active-session freshness/owner status re-check — out of this unit\'s scope.',
        enabled: false,
    },
    daemon_terminal_evidence: {
        currentLocation: 'oss/packages/daemon-core/src/mesh/mesh-completion-synthesis.ts',
        note: 'Acked-hold/terminal causal evidence with activity/current-turn projection — out of this unit\'s scope.',
        enabled: false,
    },
    mcp_mesh_status_reconciliation: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-internal.ts',
        note: 'Final-assistant completion synthesis over transcript evidence — out of this unit\'s scope.',
        enabled: false,
    },
    magi_approval_probe: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-magi.ts (nudgeWedgedReplica)',
        note: 'Fresh status+activeModal only, for idempotent approve — out of this unit\'s scope.',
        enabled: false,
    },
    magi_result_collect: {
        currentLocation: 'oss/packages/mcp-server/src/tools/mesh-tools-magi.ts',
        note: 'Current-turn MAGI result/evidence collection — out of this unit\'s scope.',
        enabled: false,
    },
};

/** `TRANSCRIPT_CONSUMER_ROSTER` keys, typed — for exhaustiveness checks in tests. */
export const TRANSCRIPT_CONSUMER_IDS: readonly TranscriptConsumerId[] = Object.keys(
    TRANSCRIPT_CONSUMER_ROSTER,
) as TranscriptConsumerId[];
