/**
 * turn-commands — typed client for the six C-W6 IPC commands
 * (`@adhdev/mesh-shared` `turn-ipc.ts`), executed in the daemon that owns the
 * turn ledger and the seqscribe node.
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph).
 *
 * SCOPE: this file is the CLIENT only. It calls through the existing
 * `CommandTransport` (`../transports/mode.js` — `IpcTransport` for the cloud
 * daemon, `LocalTransport` for standalone HTTP) exactly the way every other
 * mesh tool does via `commandForNode`/`ctx.transport.command()`
 * (`../tools/mesh-tools-internal.ts`). It does NOT add a new transport, does
 * not touch daemon-core (the responder-side `CommandSpec`s for these six
 * commands land with C-W6 proper, in daemon-core, by a different workstream),
 * and does not touch any `mesh-tools-*.ts` file — migrating call sites onto
 * this client is also C-W6 proper's job, not this pre-work.
 *
 * DAEMON-LESS FAILURE
 * --------------------
 * Today neither transport's `command()` distinguishes "could not connect" from
 * any other failure — both surface a thrown `Error` with only a free-text
 * `.message` (`ipc.ts`: "Cannot connect to daemon IPC at …", "Daemon IPC
 * connection closed: …"; `local.ts`: `describeFetchFailure` wraps a fetch
 * abort/timeout/connection-refused). There is no `.code` on either. This
 * client CANNOT change that (daemon-core and the transports are out of this
 * workstream's ownership), so `classifyTransportFailure` below is a
 * BEST-EFFORT client-side classifier: it pattern-matches the known message
 * shapes emitted by both transports today and by `IpcConnectionLoadGuard`'s
 * structured `{code: 'ipc_busy'|'rate_limited', error, retryAfterMs?}`
 * rejections (`@adhdev/daemon-core` `ipc-protocol.ts` — these arrive as a
 * plain thrown `Error` too, since `IpcTransport`'s `sendIpcCommand` only ever
 * preserves `payload.error` as the message, never `payload.code`). A future
 * change that adds `.code` to the transport's thrown errors would let this
 * classifier drop the string matching in favor of a direct check — call that
 * out explicitly if/when it happens, rather than layering more patterns on.
 */

import {
    IPC_BUSY_ERROR_CODE,
    IPC_RATE_LIMITED_ERROR_CODE,
} from '@adhdev/daemon-core';
import {
    decodeMeshIndexQueryResponse,
    decodeMeshRecordResponse,
    decodeMissionQueryResponse,
    decodeMissionUpsertResponse,
    decodeNoteForgetResponse,
    decodeNoteUpsertResponse,
    decodeOperatorStatusResponse,
    decodeTurnCancelResponse,
    decodeTurnObserveResponse,
    decodeTurnQueryResponse,
    isTurnIpcErrorCode,
    TURN_IPC_PROTOCOL_VERSION,
    type MeshIndexQueryRequest,
    type MeshIndexQueryResponse,
    type MeshRecordRequest,
    type MeshRecordResponse,
    type MissionQueryRequest,
    type MissionQueryResponse,
    type MissionUpsertRequest,
    type MissionUpsertResponse,
    type NoteForgetRequest,
    type NoteForgetResponse,
    type NoteUpsertRequest,
    type NoteUpsertResponse,
    type OperatorStatusRequest,
    type OperatorStatusResponse,
    type TurnCancelRequest,
    type TurnCancelResponse,
    type TurnIpcCommand,
    type TurnIpcErrorCode,
    type TurnObserveRequest,
    type TurnObserveResponse,
    type TurnQueryRequest,
    type TurnQueryResponse,
} from '@adhdev/mesh-shared';

import type { CommandTransport } from '../transports/mode.js';

// ─── error type ─────────────────────────────────────────────────────────────

/**
 * Thrown by every function in this file on a command failure. `code` is
 * always populated: a structured daemon rejection is passed through as-is;
 * an unrecognized transport failure is classified best-effort (see file
 * header) and otherwise falls back to `turn_ledger_unavailable` — the
 * "something is wrong, but not a routing/ownership mismatch" default, since
 * `ledger_not_owner` and `daemon_required` both mean something the classifier
 * can name precisely when it applies.
 */
export class TurnIpcCommandError extends Error {
    readonly code: TurnIpcErrorCode | 'ipc_busy' | 'rate_limited';
    readonly command: TurnIpcCommand;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;

    constructor(
        code: TurnIpcCommandError['code'],
        command: TurnIpcCommand,
        message: string,
        opts?: { retryAfterMs?: number; cause?: unknown },
    ) {
        super(message);
        this.name = 'TurnIpcCommandError';
        this.code = code;
        this.command = command;
        this.retryAfterMs = opts?.retryAfterMs;
        this.cause = opts?.cause;
    }
}

// ─── daemon-less / overload classification (best-effort — see file header) ──

// Substrings from IpcTransport's own thrown-error messages (transports/ipc.ts)
// and LocalTransport's describeFetchFailure (transports/local.ts) that mean
// "no daemon was reachable to ask", as opposed to a semantic command failure.
const CONNECTION_FAILURE_PATTERNS = [
    /cannot connect to daemon ipc/i,
    /daemon ipc connection closed/i,
    /websocket is not available in this node runtime/i,
    /failed to create ipc connection/i,
    /status fetch failed/i,
    /command .* failed: \d+/i, // LocalTransport HTTP non-2xx (connection succeeded, daemon rejected — still "unreachable to serve this")
    /econnrefused/i,
    /fetch failed/i,
    // LocalTransport's describeFetchFailure (transports/local.ts) renames a
    // TimeoutError/AbortError into this exact phrase — the original error name
    // never survives into the message, so matching "timeouterror" literally
    // (as this pattern list once did) never fires. "did not respond" is the
    // stable substring both its timeout branches share.
    /did not respond\)/i,
];

function isConnectionFailureMessage(message: string): boolean {
    return CONNECTION_FAILURE_PATTERNS.some((re) => re.test(message));
}

/**
 * Classify a thrown transport error into this contract's error code. Exported
 * so a caller building its own error-handling (rather than using the wrapper
 * functions below) can reuse the same classification.
 */
export function classifyTransportFailure(command: TurnIpcCommand, error: unknown): TurnIpcCommandError {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown transport failure');
    if (message.includes(IPC_BUSY_ERROR_CODE)) {
        return new TurnIpcCommandError('ipc_busy', command, message, { cause: error });
    }
    if (message.includes(IPC_RATE_LIMITED_ERROR_CODE)) {
        return new TurnIpcCommandError('rate_limited', command, message, { cause: error });
    }
    if (isConnectionFailureMessage(message)) {
        return new TurnIpcCommandError('daemon_required', command, message, { cause: error });
    }
    return new TurnIpcCommandError('turn_ledger_unavailable', command, message, { cause: error });
}

// ─── generic dispatch ────────────────────────────────────────────────────────

/**
 * BUGFIX (found during C-W6 migration, 2026-09-23): every daemon-side handler
 * in `turn-ledger-ipc.ts` (the responder, landed alongside this client) returns
 * `{success: true, ...response}` or `{success: false, error, code?}` — the same
 * envelope every other `CommandTransport.command()` verb in this codebase
 * returns (`unwrapCommandPayload` exists precisely because callers routinely
 * see this shape). The wire-contract decoders in `@adhdev/mesh-shared`
 * (`isMissionUpsertResponse` etc.) use `hasOnlyKeys` and therefore reject the
 * envelope outright — `decodeMissionUpsertResponse({success:true, mission})`
 * returns `null` even for a perfectly well-formed daemon response. This
 * function strips the envelope BEFORE handing the inner value to the
 * contract's decoder, and turns a `{success:false}` envelope into a typed
 * `TurnIpcCommandError` carrying the daemon's own `code` when it supplied one
 * (falling back to `turn_ledger_unavailable`, matching `classifyTransportFailure`'s
 * own default) instead of masking it as a generic decode failure.
 */
function unwrapEnvelope(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string; code?: TurnIpcErrorCode } {
    if (raw !== null && typeof raw === 'object' && 'success' in (raw as Record<string, unknown>)) {
        const { success, error, code, ...rest } = raw as { success: unknown; error?: unknown; code?: unknown; [k: string]: unknown };
        if (success === false) {
            return {
                ok: false,
                error: typeof error === 'string' ? error : 'command rejected (no error message)',
                ...(typeof code === 'string' && isTurnIpcErrorCode(code) ? { code } : {}),
            };
        }
        return { ok: true, value: rest };
    }
    // No `success` key at all — pass the raw value through unchanged (defensive:
    // a future responder that returns the bare response shape directly still works).
    return { ok: true, value: raw };
}

async function dispatch<Req extends { v: typeof TURN_IPC_PROTOCOL_VERSION }, Res>(
    transport: CommandTransport,
    command: TurnIpcCommand,
    request: Req,
    decodeResponse: (value: unknown) => Res | null,
): Promise<Res> {
    let raw: unknown;
    try {
        raw = await transport.command(command, request as unknown as Record<string, unknown>);
    } catch (error) {
        throw classifyTransportFailure(command, error);
    }
    const unwrapped = unwrapEnvelope(raw);
    if (!unwrapped.ok) {
        throw new TurnIpcCommandError(unwrapped.code ?? 'turn_ledger_unavailable', command, unwrapped.error);
    }
    const decoded = decodeResponse(unwrapped.value);
    if (decoded === null) {
        throw new TurnIpcCommandError(
            'turn_ledger_unavailable',
            command,
            `${command} response failed decode (unexpected shape from daemon)`,
        );
    }
    return decoded;
}

// ─── one function per command ────────────────────────────────────────────────

/** Submit one TurnEvidence to the owning daemon's turn ledger; returns the reducer verdict. */
export async function turnObserve(
    transport: CommandTransport,
    args: Omit<TurnObserveRequest, 'v'>,
): Promise<TurnObserveResponse> {
    return dispatch(transport, 'turn_observe', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnObserveResponse);
}

/** Append one content-free scalar record to `mesh.<id>.events` (replaces `appendLedgerEntry`). */
export async function meshRecord(
    transport: CommandTransport,
    args: Omit<MeshRecordRequest, 'v'>,
): Promise<MeshRecordResponse> {
    return dispatch(transport, 'mesh_record', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMeshRecordResponse);
}

/** Cancel an attempt by attemptId or taskId (exactly one). */
export async function turnCancel(
    transport: CommandTransport,
    args: Omit<TurnCancelRequest, 'v'>,
): Promise<TurnCancelResponse> {
    return dispatch(transport, 'turn_cancel', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnCancelResponse);
}

/** Record a fire-and-forget operator/tool-call status (replaces `recordMeshCoordinatorToolCall`). */
export async function operatorStatus(
    transport: CommandTransport,
    args: Omit<OperatorStatusRequest, 'v'>,
): Promise<OperatorStatusResponse> {
    return dispatch(transport, 'operator_status', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeOperatorStatusResponse);
}

/** Read attempt/event rows, own or fleet scope depending on the caller's filters. */
export async function turnQuery(
    transport: CommandTransport,
    args: Omit<TurnQueryRequest, 'v'>,
): Promise<TurnQueryResponse> {
    return dispatch(transport, 'turn_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeTurnQueryResponse);
}

/** Read `mesh_topic_index` rows (fleet-wide replication index). */
export async function meshIndexQuery(
    transport: CommandTransport,
    args: Omit<MeshIndexQueryRequest, 'v'>,
): Promise<MeshIndexQueryResponse> {
    return dispatch(transport, 'mesh_index_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMeshIndexQueryResponse);
}

/**
 * Create/update a mission (replaces the in-process `upsertMeshMission`). Added
 * during C-W6 (was missing from the C-W6 pre-work client — turn-ipc.ts's wire
 * contract already had `mission_upsert`/`mission_query` from the 2026-09-23
 * "missions have no home in the six commands" decision, but no wrapper
 * function called them yet).
 */
export async function missionUpsert(
    transport: CommandTransport,
    args: Omit<MissionUpsertRequest, 'v'>,
): Promise<MissionUpsertResponse> {
    return dispatch(transport, 'mission_upsert', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMissionUpsertResponse);
}

/** List/read missions for a mesh (replaces the in-process `getMeshMissions`/`getMeshMission`). */
export async function missionQuery(
    transport: CommandTransport,
    args: Omit<MissionQueryRequest, 'v'>,
): Promise<MissionQueryResponse> {
    return dispatch(transport, 'mission_query', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeMissionQueryResponse);
}

/**
 * Record a coordinator operating note on the owning daemon (C-W8; replaces the
 * in-process `appendLedgerEntry('coordinator_operating_note')`). Free text over
 * local IPC — the daemon keeps it in `mesh_operating_notes`, never on a topic.
 */
export async function noteUpsert(
    transport: CommandTransport,
    args: Omit<NoteUpsertRequest, 'v'>,
): Promise<NoteUpsertResponse> {
    return dispatch(transport, 'note_upsert', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeNoteUpsertResponse);
}

/** Retract operating notes by id and/or exact text (C-W8; replaces the in-process `tombstoneOperatingNote`). */
export async function noteForget(
    transport: CommandTransport,
    args: Omit<NoteForgetRequest, 'v'>,
): Promise<NoteForgetResponse> {
    return dispatch(transport, 'note_forget', { v: TURN_IPC_PROTOCOL_VERSION, ...args }, decodeNoteForgetResponse);
}
