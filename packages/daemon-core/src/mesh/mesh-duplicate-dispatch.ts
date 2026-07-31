// ---------------------------------------------------------------------------
// mesh-duplicate-dispatch — the typed DUPLICATE-DISPATCH refusal contract
// ---------------------------------------------------------------------------
// When a coordinator dispatches a task to a node that is ALREADY running that
// exact task on another live session, the worker daemon refuses the second
// dispatch (the DOUBLE-DISPATCH guard in attachMeshAssignmentToInstance). That
// refusal is an APPLICATION-LEVEL answer — "you already have this, and here is
// who holds it" — not a transport failure. Treating it as a transport failure is
// what made the coordinator cancel the turn-ledger attempt and then reject the
// real worker's completion as `session_mismatch`, losing a finished task.
//
// This module is the single, dependency-free contract for that answer so the
// refusal survives the P2P wire as STRUCTURED DATA and is never recovered by
// parsing an error message. The wire preserves exactly two things about a
// handler error — `error.code` and `error.message` — so the code doubles as the
// carrier: `DUPLICATE_MESH_DISPATCH:<holderSessionId>`. Both halves are
// machine-generated and machine-read here; no natural-language text is parsed.
// ---------------------------------------------------------------------------

/** Stable machine code for "this node is already working that task". */
export const DUPLICATE_MESH_DISPATCH_CODE = 'DUPLICATE_MESH_DISPATCH';

/** The structured payload a duplicate-dispatch refusal carries back. */
export interface DuplicateMeshDispatchInfo {
    /** The LIVE session on the worker daemon that already holds (meshId, taskId). */
    holderSessionId?: string;
}

/**
 * The error the worker throws when it refuses a duplicate dispatch. Carries the
 * machine code and the holder session as real fields, so a same-process (local
 * transport) caller reads them directly without any encoding round-trip.
 */
export class DuplicateMeshDispatchError extends Error {
    readonly code = DUPLICATE_MESH_DISPATCH_CODE;
    readonly holderSessionId?: string;

    constructor(message: string, info: DuplicateMeshDispatchInfo = {}) {
        super(message);
        this.name = 'DuplicateMeshDispatchError';
        this.holderSessionId = info.holderSessionId;
    }
}

/**
 * The wire form of the code. The relay envelope carries `error.code` verbatim, so
 * appending the holder session to the code is what lets the coordinator rebind
 * across a P2P hop. Kept to a single `:` separator — session ids never contain one.
 */
export function encodeDuplicateMeshDispatchCode(holderSessionId?: string): string {
    const holder = typeof holderSessionId === 'string' ? holderSessionId.trim() : '';
    return holder ? `${DUPLICATE_MESH_DISPATCH_CODE}:${holder}` : DUPLICATE_MESH_DISPATCH_CODE;
}

/**
 * Classify a dispatch failure. Returns the structured refusal when (and only when)
 * the error is a genuine duplicate-dispatch answer — either the in-process error
 * object (local transport) or the encoded wire code (remote transport). Every other
 * failure returns null so it keeps the ordinary cancel-and-requeue path.
 *
 * Deliberately strict: it never inspects `message`. A transport error whose text
 * happens to mention a duplicate must NOT be classified as one, because rebinding on
 * a false positive would bind the ledger to a session that is not actually working
 * the task — exactly the hazard the `session_mismatch` check exists to prevent.
 */
export function classifyDuplicateMeshDispatch(err: unknown): DuplicateMeshDispatchInfo | null {
    if (!err || typeof err !== 'object') return null;
    const e = err as { code?: unknown; meshCode?: unknown; holderSessionId?: unknown };

    // Local transport: the error object itself crossed no boundary.
    if (e.code === DUPLICATE_MESH_DISPATCH_CODE) {
        const holder = typeof e.holderSessionId === 'string' ? e.holderSessionId.trim() : '';
        return holder ? { holderSessionId: holder } : {};
    }

    // Remote transport: the relay mapped the responder's `error.code` onto meshCode.
    for (const raw of [e.meshCode, e.code]) {
        if (typeof raw !== 'string') continue;
        if (raw !== DUPLICATE_MESH_DISPATCH_CODE && !raw.startsWith(`${DUPLICATE_MESH_DISPATCH_CODE}:`)) continue;
        const holder = raw.slice(DUPLICATE_MESH_DISPATCH_CODE.length + 1).trim();
        return holder ? { holderSessionId: holder } : {};
    }
    return null;
}
