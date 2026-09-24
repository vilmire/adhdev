/**
 * The ONE reader of a mesh relay answer (`dispatchMeshCommand(...)` result).
 *
 * The remote daemon's handler returns a `CommandRouterResult` (an object with a
 * boolean `success`), but the relay may hand it back wrapped (`{ result }` /
 * `{ payload }`, the mesh RPC envelope and the IPC `ext:command_result` shape),
 * and a stale or buggy peer may answer with anything at all. Every forwarder
 * used to pass the raw answer through (`forwarded ?? { success: false }`), so a
 * malformed answer reached the caller as-is — `undefined` success, a string, a
 * doubly-wrapped envelope the caller then misread as a failure (or a success).
 *
 * `unwrapMeshRelayResult` descends at most {@link MAX_RELAY_UNWRAP_DEPTH}
 * levels of `{ result }` / `{ payload }` and returns the first object carrying
 * a boolean `success`. Anything else becomes the typed failure
 * `{ success: false, error: 'relay_result_malformed', detail }` with ONE warn
 * line naming the command and the peer.
 */
import { LOG } from '../logging/logger.js';

export const MAX_RELAY_UNWRAP_DEPTH = 4;

export type MeshRelayResult = Record<string, unknown> & { success: boolean };

export interface MeshRelayMalformed {
    [key: string]: unknown;
    success: false;
    error: 'relay_result_malformed';
    detail: string;
    command?: string;
    peerDaemonId?: string;
}

function describe(raw: unknown): string {
    if (raw === null) return 'null';
    if (Array.isArray(raw)) return 'an array';
    if (typeof raw !== 'object') return `a ${typeof raw}`;
    const keys = Object.keys(raw as Record<string, unknown>).slice(0, 6);
    return `an object without a boolean success (keys: ${keys.length > 0 ? keys.join(', ') : 'none'})`;
}

/**
 * The handler's own answer object inside a relay answer, or null when there is
 * none within {@link MAX_RELAY_UNWRAP_DEPTH} levels.
 */
export function findMeshRelayAnswer(raw: unknown): MeshRelayResult | null {
    let cursor: unknown = raw;
    for (let depth = 0; depth <= MAX_RELAY_UNWRAP_DEPTH && cursor && typeof cursor === 'object' && !Array.isArray(cursor); depth++) {
        const rec = cursor as Record<string, unknown>;
        if (typeof rec.success === 'boolean') return rec as MeshRelayResult;
        if (depth === MAX_RELAY_UNWRAP_DEPTH) break;
        if (rec.result && typeof rec.result === 'object') { cursor = rec.result; continue; }
        if (rec.payload && typeof rec.payload === 'object') { cursor = rec.payload; continue; }
        break;
    }
    return null;
}

/**
 * Validate a relay answer: the handler's own `{ success: boolean, … }` object,
 * or the typed `relay_result_malformed` failure (+ one WARN line).
 */
export function unwrapMeshRelayResult(
    raw: unknown,
    context: { command: string; peerDaemonId?: string },
): MeshRelayResult | MeshRelayMalformed {
    const answer = findMeshRelayAnswer(raw);
    if (answer) return answer;
    const detail = `the ${context.command} relay answer from ${context.peerDaemonId ? context.peerDaemonId.slice(0, 24) : 'the remote daemon'} was ${describe(raw)}`;
    LOG.warn('MeshRelay', `Malformed relay result: ${detail}`);
    return {
        success: false,
        error: 'relay_result_malformed',
        detail,
        command: context.command,
        ...(context.peerDaemonId ? { peerDaemonId: context.peerDaemonId } : {}),
    };
}
