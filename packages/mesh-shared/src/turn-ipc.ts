/**
 * turn-ipc — typed IPC command contracts for the six commands that replace
 * mcp-server's direct `mesh-runtime.db` access (design §5 C2 "MCP server").
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2/C3, C9 row C-W6).
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * mcp-server is a second, in-process writer of `mesh-runtime.db` (~45-69
 * direct-mutation call sites, ~54 reads, per the C-W6 brief). C2 moves every
 * one of those call sites behind IPC, executed in the daemon that owns the
 * turn ledger and the seqscribe node, so mcp-server never opens the SQLite
 * file itself. This file is the WIRE CONTRACT for that IPC surface — request/
 * response shapes, closed enums, runtime decoders — shared by the daemon-core
 * command handlers (added with C-W6 proper; NOT this file) and the mcp-server
 * client (`mcp-server/src/ipc/turn-commands.ts`, this workstream).
 *
 * The six commands (§5 C2):
 *   - turn_observe     — submit one TurnEvidence; returns the reducer verdict.
 *   - mesh_record      — append a content-free scalar record (`mesh.record`
 *                         topic entry), replacing `appendLedgerEntry`.
 *   - turn_cancel       — cancel an attempt (`cancel` evidence, source `mcp_probe`
 *                         or `operator`).
 *   - operator_status   — record a fire-and-forget operator/tool-call status
 *                         (`operator_status` evidence + the former
 *                         `recordMeshCoordinatorToolCall` log write).
 *   - turn_query        — read attempt/event rows (own or fleet scope).
 *   - mesh_index_query  — read `mesh_topic_index` rows (fleet-wide, replacing
 *                         the in-memory read model / parity reads).
 *
 * CONTENT BOUNDARY
 * -----------------
 * Every request/response field is an identifier, a closed enum, a boolean, a
 * counter or a timestamp. `turn_observe` carries a `TurnEvidence`, which is
 * content-free by construction (`turn-evidence.ts`). `mesh_record` carries a
 * `ProjectedScalars` payload restricted to the SAME allow-list keys
 * `seqscribe/mesh-event-projection.ts` already reviews and ships
 * (`PROJECTED_PAYLOAD_KEYS`, 35 keys) — this file pins a STRUCTURAL COPY of
 * that key list (`MESH_RECORD_PAYLOAD_KEYS`) so mesh-shared does not import
 * daemon-core (leaf constraint), with a test asserting the two lists agree.
 * Summaries, report bodies, progress notes and modal text never travel in any
 * of these payloads — they go to the content-class `mesh.<id>.handoff` topic
 * and are referenced by `SummaryRef {topic, writer, seq}` (already declared
 * in `./turn-evidence.ts`).
 *
 * VERSIONING
 * -----------
 * Every request carries `v: 1` so a future incompatible change can be
 * detected by the responder before it tries to interpret the args.
 *
 * LAYOUT
 * -------
 * This module holds the error codes and the command registry; the per-command
 * contracts live in ./turn-ipc-{turn,mission,queue,stats}.ts (re-exported here)
 * over the shared guard primitives in ./turn-ipc-guards.ts.
 */

import { isRecord } from './protocol/envelope'
import { hasOnlyKeys, makeGuard } from './turn-ipc-guards';

export { TURN_IPC_PROTOCOL_VERSION } from './turn-ipc-guards';
export * from './turn-ipc-turn';
export * from './turn-ipc-mission';
export * from './turn-ipc-queue';
export * from './turn-ipc-stats';

// ─── error codes ────────────────────────────────────────────────────────────

/**
 * Closed error-code union every command response may carry instead of (or in
 * addition to, for the client-side wrapper) a result.
 *
 *   daemon_required      — no daemon reachable (no IPC/local transport
 *                           connection could be established). Distinct from
 *                           every other failure: it means "there is nobody to
 *                           ask", not "the ask failed."
 *   turn_ledger_unavailable — a daemon answered but its turn ledger is not
 *                           armed yet (mid-boot, mid-migration).
 *   ledger_not_owner     — the daemon that answered does not own the
 *                           attempt/mesh addressed by the request (routing
 *                           mistake, or the owner changed after a reclaim).
 *   session_busy_with_task — `turn_observe{dispatch_accepted}` was REFUSED: the
 *                           target session already holds an open mesh attempt
 *                           (≤1 open attempt per session). The error message
 *                           carries the machine token
 *                           `session_busy_with_task[task=<id> attempt=<id>]`
 *                           (daemon-core mesh-session-busy-dispatch.ts) naming
 *                           the attempt in the way. Unlike the codes above this
 *                           is a definite answer, not "the ledger is not there":
 *                           the dispatch must not be sent.
 */
export const TURN_IPC_ERROR_CODES = ['daemon_required', 'turn_ledger_unavailable', 'ledger_not_owner', 'session_busy_with_task'] as const
export type TurnIpcErrorCode = typeof TURN_IPC_ERROR_CODES[number]

export const isTurnIpcErrorCode = makeGuard(TURN_IPC_ERROR_CODES)

/** Structured failure shape a responder returns instead of a result. Never thrown across the wire — the client maps it to a typed error (see mcp-server/src/ipc/turn-commands.ts). */
export interface TurnIpcError {
    code: TurnIpcErrorCode
    /** Short machine-oriented detail, e.g. which daemon was expected. Never free text describing content. */
    detail?: string
}

export function isTurnIpcError(value: unknown): value is TurnIpcError {
    return isRecord(value) && hasOnlyKeys(value, ['code', 'detail']) && isTurnIpcErrorCode(value.code)
        && (value.detail === undefined || typeof value.detail === 'string')
}

// ─── command registry ───────────────────────────────────────────────────────

/** The complete, closed set of IPC command names this contract defines. */
export const TURN_IPC_COMMANDS = [
    'turn_observe',
    'mesh_record',
    'turn_cancel',
    'operator_status',
    'turn_query',
    'mesh_index_query',
    'mission_upsert',
    'mission_query',
    'note_upsert',
    'note_forget',
    // C-W9b additions (2026-09-24 14:00 stamp "C-W9"):
    'tool_call_record',
    'ledger_query',
    'mission_list_query',
    // C-W9a additions (the event ledger retired; the queue behind IPC):
    'record_local',
    'queue_query',
    'queue_enqueue',
    'queue_enqueue_batch',
    'queue_cancel',
    'queue_requeue',
    'direct_dispatch_record',
    'active_work_query',
    'recovery_context_query',
    // C-W9c additions (2026-09-24 19:00 stamp — the last mcp-server in-process
    // daemon-core paths: mission reads, task/mission stats, orphaned-pin
    // helpers, one prune audit):
    'task_stats_query',
    'prune_stale_direct',
    'orphaned_pin_notify',
] as const
export type TurnIpcCommand = typeof TURN_IPC_COMMANDS[number]
export const isTurnIpcCommand = makeGuard(TURN_IPC_COMMANDS)
