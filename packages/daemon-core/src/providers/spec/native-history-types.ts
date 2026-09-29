/**
 * Message shapes emitted by the native-history executor.
 *
 * Split out of `native-history-executor.ts` so the tool-block modules
 * (`native-history-tool-blocks.ts`, `tool-block-expand.ts`) can name these
 * types without importing the executor itself, which would close an import
 * cycle. Also holds the executor's input/result contract. Types only — no
 * runtime code belongs here.
 */

import type { MessageSourceAddress } from '../../chat/message-source-address.js';
import type { SessionUsageTotals } from '../../shared/usage-normalize.js';
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';

/**
 * Content-free address of one tool block inside its native-history source.
 *
 * Why this exists: tool call args are capped at `TOOL_CALL_SUMMARY_MAX` and
 * results at `TOOL_RESULT_SUMMARY_MAX` (see `native-history-tool-blocks.ts`),
 * and the full text is never carried anywhere — `NativeHistoryMessage.content`
 * is the only text field, so the untruncated body simply does not reach the
 * dashboard. Rather than widen every transcript payload with text nobody
 * usually reads, this ref lets a reader ask the daemon to re-read exactly this
 * block on demand (see `expand_tool_block`).
 *
 * Every field is an integer. There is no text, no path, and no hash of content
 * here — it is content-free. It still does NOT travel the keyed replica wire
 * (`seqscribe/transcript-keyed-codec.ts`): the mtime seal changes on every
 * append, so carrying it would rewrite every past tool bubble. The wire carries
 * `expandable` instead and a replica reader expands by `messageId`, which the
 * daemon resolves back to this ref through its identity ledger.
 *
 * `sourceMtimeMs` is the freshness seal, not just an address component: an
 * expand request that carries a stale mtime is refused outright rather than
 * resolved against shifted indices, so a rotated or rewritten transcript can
 * never return a DIFFERENT tool's output under the requested ref.
 */
export interface NativeHistoryToolBlockRef {
    /** mtime of the source file at parse time — the fail-closed freshness seal. */
    sourceMtimeMs: number;
    /** 0-based index of the record within the source (jsonl line / sqlite row). */
    recordIndex: number;
    /**
     * 0-based index of the tool block within the record's content array, or
     * -1 when the record ITSELF is the tool block (codex's record-level shape,
     * which has no content array to index into).
     */
    blockIndex: number;
}

export interface NativeHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    receivedAt: number;
    kind?: string;
    /** TOOL-LABEL: the tool a `kind:'tool'` call bubble invoked (e.g. 'Write', 'run_command') — the dashboard card label. */
    toolName?: string;
    workspace?: string;
    /**
     * Present only on `kind:'tool'` bubbles whose summary was truncated —
     * absent when the block already fits, so a reader can tell "nothing more to
     * fetch" from "not addressable" without a round trip.
     */
    toolBlockRef?: NativeHistoryToolBlockRef;
    /**
     * Daemon-internal source address for the message identity ledger
     * (`chat/message-source-address.ts`). Stamped by the jsonl path only
     * (`n.<L>.<recordIndex>.<blockIndex+1>`); sqlite rows have no stable
     * address without a declared id column and fall to the aligner. Never
     * leaves the daemon.
     */
    _src?: MessageSourceAddress;
}

/** Who is reading, and which session the read must bind to. */
export interface NativeHistoryInput {
    agentType?: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    /** Daemon instance id of the reading session (== the session registry
     *  sessionId == the read path's targetSessionId). Sidecar-workspace stores
     *  (kimi) derive the transcript-claim owner token from it so two concurrent
     *  same-cwd sessions never bind the same wire.jsonl. Empty → claiming is
     *  skipped (legacy single-session behaviour). */
    instanceId?: string;
    workspace?: string;
    /** Daemon-side wall clock at the moment the session was registered.
     *  Native-history file lookups use this as the lower bound: any file
     *  whose mtime is before the current session started can't be from
     *  this session, so it's excluded from newest-recent matching. The
     *  caller (chat-history pipeline) populates this from the session
     *  registry; specs/executor never need to know how it's sourced. */
    sessionStartedAtMs?: number;
    /** Env overrides the daemon set on the spawned CLI. The mesh
     *  coordinator points hermes at a per-coordinator HERMES_HOME so
     *  the hermes process writes its state.db into a tmp directory
     *  instead of ~/.hermes. expandPath consults this map before
     *  process.env so the native-history reader follows the spawned
     *  child's view of HERMES_HOME / similar overrides; without it
     *  the reader would always look at ~/.hermes and miss every
     *  coordinator-session transcript. */
    envOverrides?: Record<string, string>;
    /** Bypass parsed JSONL reuse for completion-contract evidence reads. */
    forceRefresh?: boolean;
    args?: Record<string, unknown>;
}


export interface NativeHistoryResult {
    messages: NativeHistoryMessage[];
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
    workspace?: string;
    /**
     * Sidecar-workspace stores (kimi): how the resolved transcript was
     * attributed to this reading session.
     *   'pinned'          — exact bind by a previously pinned/claimed session id
     *   'claimed'         — exclusive claim on the single viable candidate
     *   'stale_reclaimed' — claim taken over from a demonstrably dead owner
     *   'spawn_evidence'  — unique spawn-proximity evidence (no claim identity)
     *   'legacy'          — single-candidate bind with no claim identity
     *   'ambiguous'       — FAIL CLOSED: ≥2 viable same-workspace candidates
     *   'already_claimed' — FAIL CLOSED: every viable candidate is owned by a
     *                       DIFFERENT live session
     * Undefined for non-sidecar sources (their resolution is unchanged).
     */
    attribution?: 'pinned' | 'claimed' | 'stale_reclaimed' | 'spawn_evidence' | 'legacy' | 'ambiguous' | 'already_claimed';
    /** True only when the bind rests on strong evidence (exact pin, an
     *  exclusive claim, or unique spawn-proximity evidence) — never on a
     *  newest-mtime guess. Read-path callers may persist a pin only then. */
    ownerConfirmed?: boolean;
    /** Typed fail-closed reason. 'attribution_unknown' means two or more viable
     *  same-workspace candidates could not be uniquely attributed (or all are
     *  owned by other live sessions); NO messages and NO providerSessionId are
     *  returned so no durable pin can be written from the ambiguity. */
    unavailableReason?: string;
    /** Token totals, present only when the spec declares `usage_records` and
     *  the transcript actually carried at least one matching record. */
    usage?: SessionUsageTotals;
    /**
     * (NATIVE-TURN-SIGNAL) The provider's own turn-terminal records (codex
     * task_complete / turn_aborted), when the reader for this agentType knows
     * how to find them. Undefined for every source this executor has no
     * built-in signal extraction for — those keep the message-shape inference
     * path unchanged.
     */
    turnTerminalMarkers?: NativeTurnTerminalMarker[];
}
