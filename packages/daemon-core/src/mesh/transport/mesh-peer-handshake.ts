/**
 * Mesh peer handshake — mutual HMAC proof over a freshly opened WebSocket
 * (design: docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.4
 * step 4). Shared by `/ws/mesh` (RPC) and `/ws/mesh-seqscribe` (replication):
 * once `mesh_ok` lands, the raw socket is handed to that layer untouched.
 *
 * Frames (JSON text, protocol version 1):
 *
 *   C→S  { v, kind: 'mesh_hello',     meshId, daemonId, nonce }
 *   S→C  { v, kind: 'mesh_challenge', nonce, proof, daemonId }
 *   C→S  { v, kind: 'mesh_proof',     proof }
 *   S→C  { v, kind: 'mesh_ok',        daemonId }  |  { v, kind: 'mesh_error', code }
 *
 *   proofS = HMAC-SHA256(secret, 'S|' + nonceC + '|' + nonceS + '|' + meshId + '|' + canon(client) + '|' + canon(server))
 *   proofC = HMAC-SHA256(secret, 'C|' + nonceS + '|' + nonceC + '|' + meshId + '|' + canon(client) + '|' + canon(server))
 *
 * Both proofs bind BOTH nonces, the mesh id and BOTH daemon ids, so a proof
 * captured from one session (or one mesh, or one peer pair) never verifies in
 * another, and the client learns the server's identity in the challenge
 * frame before it commits its own proof. Comparison is constant-time
 * (`timingSafeEqual` on equal-length buffers).
 *
 * The two state machines (`createHandshakeInitiator` / `createHandshakeResponder`)
 * are pure and transport-independent: feed them frames, read the step they
 * return. `performMeshHandshake` is the one ws-flavoured helper that drives a
 * machine over a socket, bounds it with a timeout, and detaches every
 * listener it added before resolving — the caller gets the socket back with
 * no leftover handlers.
 *
 * ── Unknown peers ───────────────────────────────────────────────────────────
 * A responder whose `resolveSecret` returns null answers `unknown_peer`
 * after doing the same HMAC work it would do for a known peer (against a
 * per-responder decoy key), and uses ONE code for "no such mesh" and "no
 * such peer in that mesh": the hello cannot be used to enumerate meshes.
 *
 * ── Hygiene ─────────────────────────────────────────────────────────────────
 * Secrets never appear in frames, logs or errors. Log lines use
 * `maskDaemonId` for ids.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { canonicalDaemonId } from '@adhdev/mesh-shared';
import { LOG } from '../../logging/logger.js';
import { maskDaemonId } from './mask-daemon-id.js';

export const MESH_HANDSHAKE_PROTOCOL_VERSION = 1 as const;
export const MESH_HANDSHAKE_DEFAULT_TIMEOUT_MS = 5_000;
/** WebSocket close code used when the handshake fails or times out. */
export const MESH_HANDSHAKE_CLOSE_CODE = 4401;
const NONCE_BYTES = 16;

/** Error codes carried on the wire by `mesh_error`. */
export type MeshHandshakeErrorCode = 'unknown_peer' | 'bad_proof' | 'bad_version' | 'bad_frame' | 'timeout';
/** Local failure codes: the wire codes plus "the socket went away first". */
export type MeshHandshakeFailureCode = MeshHandshakeErrorCode | 'socket_closed';

export interface MeshHelloFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_hello';
    meshId: string;
    daemonId: string;
    /** 16 random bytes, base64. */
    nonce: string;
}
export interface MeshChallengeFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_challenge';
    nonce: string;
    proof: string;
    /** The responder's own daemon id — the initiator needs it before computing its proof. */
    daemonId: string;
}
export interface MeshProofFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_proof';
    proof: string;
}
export interface MeshOkFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_ok';
    daemonId: string;
}
export interface MeshErrorFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_error';
    code: MeshHandshakeErrorCode;
}
export type MeshHandshakeFrame = MeshHelloFrame | MeshChallengeFrame | MeshProofFrame | MeshOkFrame | MeshErrorFrame;

export type HandshakeStep =
    | { status: 'pending' }
    | { status: 'ok'; meshId: string; peerDaemonId: string }
    | { status: 'failed'; code: MeshHandshakeFailureCode };

const PENDING: HandshakeStep = { status: 'pending' };
const ERROR_CODES: ReadonlySet<string> = new Set<MeshHandshakeErrorCode>([
    'unknown_peer', 'bad_proof', 'bad_version', 'bad_frame', 'timeout',
]);

// ─── Primitives ──────────────────────────────────────────────────────────────

export function mintHandshakeNonce(): string {
    return randomBytes(NONCE_BYTES).toString('base64');
}

function isNonce(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    return Buffer.from(value, 'base64').length === NONCE_BYTES;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

export interface ProofInputs {
    secret: string;
    clientNonce: string;
    serverNonce: string;
    meshId: string;
    /** Either form; canonicalised inside. */
    clientDaemonId: string;
    serverDaemonId: string;
}

function canon(id: string): string {
    return canonicalDaemonId(id) ?? id.trim();
}

function hmacBase64(secret: string, message: string): string {
    return createHmac('sha256', secret).update(message, 'utf8').digest('base64');
}

/** proofS — what the responder sends in `mesh_challenge`. */
export function computeServerProof(input: ProofInputs): string {
    return hmacBase64(
        input.secret,
        `S|${input.clientNonce}|${input.serverNonce}|${input.meshId}|${canon(input.clientDaemonId)}|${canon(input.serverDaemonId)}`,
    );
}

/** proofC — what the initiator sends in `mesh_proof`. */
export function computeClientProof(input: ProofInputs): string {
    return hmacBase64(
        input.secret,
        `C|${input.serverNonce}|${input.clientNonce}|${input.meshId}|${canon(input.clientDaemonId)}|${canon(input.serverDaemonId)}`,
    );
}

/** Constant-time equality of two base64 proofs; unequal lengths are simply false. */
export function proofsEqual(expected: string, actual: unknown): boolean {
    if (typeof actual !== 'string') return false;
    const a = Buffer.from(expected, 'base64');
    const b = Buffer.from(actual, 'base64');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * Parse an inbound frame. Returns the typed frame, or a failure code:
 * `bad_version` when the object carries a `v` we do not speak, `bad_frame`
 * for anything else that is not a well-formed handshake frame.
 */
export function parseHandshakeFrame(raw: unknown): MeshHandshakeFrame | { error: MeshHandshakeErrorCode } {
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return { error: 'bad_frame' };
        }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'bad_frame' };
    const obj = value as Record<string, unknown>;
    if (obj.v !== MESH_HANDSHAKE_PROTOCOL_VERSION) return { error: 'bad_version' };
    switch (obj.kind) {
        case 'mesh_hello':
            if (!isNonEmptyString(obj.meshId) || !isNonEmptyString(obj.daemonId) || !isNonce(obj.nonce)) {
                return { error: 'bad_frame' };
            }
            return { v: 1, kind: 'mesh_hello', meshId: obj.meshId, daemonId: obj.daemonId, nonce: obj.nonce };
        case 'mesh_challenge':
            if (!isNonce(obj.nonce) || !isNonEmptyString(obj.proof) || !isNonEmptyString(obj.daemonId)) {
                return { error: 'bad_frame' };
            }
            return { v: 1, kind: 'mesh_challenge', nonce: obj.nonce, proof: obj.proof, daemonId: obj.daemonId };
        case 'mesh_proof':
            if (!isNonEmptyString(obj.proof)) return { error: 'bad_frame' };
            return { v: 1, kind: 'mesh_proof', proof: obj.proof };
        case 'mesh_ok':
            if (!isNonEmptyString(obj.daemonId)) return { error: 'bad_frame' };
            return { v: 1, kind: 'mesh_ok', daemonId: obj.daemonId };
        case 'mesh_error':
            if (typeof obj.code !== 'string' || !ERROR_CODES.has(obj.code)) return { error: 'bad_frame' };
            return { v: 1, kind: 'mesh_error', code: obj.code as MeshHandshakeErrorCode };
        default:
            return { error: 'bad_frame' };
    }
}

function isParseError(result: ReturnType<typeof parseHandshakeFrame>): result is { error: MeshHandshakeErrorCode } {
    return 'error' in result;
}

function errorFrame(code: MeshHandshakeErrorCode): MeshErrorFrame {
    return { v: MESH_HANDSHAKE_PROTOCOL_VERSION, kind: 'mesh_error', code };
}

// ─── Initiator (client / member side) ────────────────────────────────────────

export interface HandshakeInitiatorOptions {
    meshId: string;
    /** This daemon's id (either form). */
    daemonId: string;
    /** When set, a challenge from any other daemon id fails with `bad_proof`. */
    serverDaemonIdExpected?: string;
    secret: string;
    send(frame: MeshHandshakeFrame): void;
}

export interface HandshakeInitiator {
    /** Sends `mesh_hello`. Idempotent — a second call is a no-op. */
    start(): void;
    onFrame(frame: unknown): HandshakeStep;
    /** Current step without feeding a frame. */
    current(): HandshakeStep;
}

export function createHandshakeInitiator(opts: HandshakeInitiatorOptions): HandshakeInitiator {
    type State = 'idle' | 'awaiting_challenge' | 'awaiting_ok' | 'done';
    let state: State = 'idle';
    let step: HandshakeStep = PENDING;
    const clientNonce = mintHandshakeNonce();
    let serverNonce = '';
    let serverDaemonId = '';

    const fail = (code: MeshHandshakeFailureCode, notifyPeer: boolean): HandshakeStep => {
        state = 'done';
        step = { status: 'failed', code };
        if (notifyPeer && code !== 'socket_closed') {
            try {
                opts.send(errorFrame(code));
            } catch {
                /* peer already gone — the failure is what matters */
            }
        }
        return step;
    };

    return {
        start() {
            if (state !== 'idle') return;
            state = 'awaiting_challenge';
            opts.send({
                v: MESH_HANDSHAKE_PROTOCOL_VERSION,
                kind: 'mesh_hello',
                meshId: opts.meshId,
                daemonId: opts.daemonId,
                nonce: clientNonce,
            });
        },
        current: () => step,
        onFrame(raw) {
            if (state === 'done') return fail('bad_frame', false);
            const parsed = parseHandshakeFrame(raw);
            if (isParseError(parsed)) return fail(parsed.error, true);
            if (parsed.kind === 'mesh_error') return fail(parsed.code, false);
            if (state === 'idle') return fail('bad_frame', true);

            if (state === 'awaiting_challenge') {
                if (parsed.kind !== 'mesh_challenge') return fail('bad_frame', true);
                if (opts.serverDaemonIdExpected && canon(opts.serverDaemonIdExpected) !== canon(parsed.daemonId)) {
                    return fail('bad_proof', true);
                }
                const inputs: ProofInputs = {
                    secret: opts.secret,
                    clientNonce,
                    serverNonce: parsed.nonce,
                    meshId: opts.meshId,
                    clientDaemonId: opts.daemonId,
                    serverDaemonId: parsed.daemonId,
                };
                if (!proofsEqual(computeServerProof(inputs), parsed.proof)) return fail('bad_proof', true);
                serverNonce = parsed.nonce;
                serverDaemonId = parsed.daemonId;
                state = 'awaiting_ok';
                opts.send({ v: MESH_HANDSHAKE_PROTOCOL_VERSION, kind: 'mesh_proof', proof: computeClientProof(inputs) });
                return PENDING;
            }

            // awaiting_ok
            if (parsed.kind !== 'mesh_ok') return fail('bad_frame', true);
            if (canon(parsed.daemonId) !== canon(serverDaemonId) || !serverNonce) return fail('bad_frame', true);
            state = 'done';
            step = { status: 'ok', meshId: opts.meshId, peerDaemonId: canon(serverDaemonId) };
            return step;
        },
    };
}

// ─── Responder (server / host side) ──────────────────────────────────────────

export interface HandshakeResponderOptions {
    /** This daemon's id (either form). */
    localDaemonId: string;
    /** Secret for (meshId, canonical peer id), or null when unknown. */
    resolveSecret(meshId: string, daemonId: string): string | null;
    send(frame: MeshHandshakeFrame): void;
}

export interface HandshakeResponder {
    onFrame(frame: unknown): HandshakeStep;
    current(): HandshakeStep;
}

export function createHandshakeResponder(opts: HandshakeResponderOptions): HandshakeResponder {
    type State = 'awaiting_hello' | 'awaiting_proof' | 'done';
    let state: State = 'awaiting_hello';
    let step: HandshakeStep = PENDING;
    // Per-responder decoy key: an unknown peer costs the same HMAC work as a
    // known one, so timing does not distinguish "no such mesh/peer".
    const decoySecret = randomBytes(32).toString('base64');
    let expectedClientProof = '';
    let meshId = '';
    let peerDaemonId = '';

    const fail = (code: MeshHandshakeFailureCode, notifyPeer: boolean): HandshakeStep => {
        state = 'done';
        step = { status: 'failed', code };
        if (notifyPeer && code !== 'socket_closed') {
            try {
                opts.send(errorFrame(code));
            } catch {
                /* peer already gone */
            }
        }
        return step;
    };

    return {
        current: () => step,
        onFrame(raw) {
            if (state === 'done') return fail('bad_frame', false);
            const parsed = parseHandshakeFrame(raw);
            if (isParseError(parsed)) return fail(parsed.error, true);
            if (parsed.kind === 'mesh_error') return fail(parsed.code, false);

            if (state === 'awaiting_hello') {
                if (parsed.kind !== 'mesh_hello') return fail('bad_frame', true);
                const canonicalPeer = canon(parsed.daemonId);
                const secret = opts.resolveSecret(parsed.meshId, canonicalPeer);
                const serverNonce = mintHandshakeNonce();
                const inputs: ProofInputs = {
                    secret: secret ?? decoySecret,
                    clientNonce: parsed.nonce,
                    serverNonce,
                    meshId: parsed.meshId,
                    clientDaemonId: parsed.daemonId,
                    serverDaemonId: opts.localDaemonId,
                };
                const serverProof = computeServerProof(inputs);
                const clientProof = computeClientProof(inputs);
                if (secret === null || secret === '') {
                    // Same work as the known-peer path (two HMACs + one compare), one code.
                    proofsEqual(serverProof, clientProof);
                    return fail('unknown_peer', true);
                }
                expectedClientProof = clientProof;
                meshId = parsed.meshId;
                peerDaemonId = canonicalPeer;
                state = 'awaiting_proof';
                opts.send({
                    v: MESH_HANDSHAKE_PROTOCOL_VERSION,
                    kind: 'mesh_challenge',
                    nonce: serverNonce,
                    proof: serverProof,
                    daemonId: opts.localDaemonId,
                });
                return PENDING;
            }

            // awaiting_proof
            if (parsed.kind !== 'mesh_proof') return fail('bad_frame', true);
            if (!proofsEqual(expectedClientProof, parsed.proof)) return fail('bad_proof', true);
            state = 'done';
            step = { status: 'ok', meshId, peerDaemonId };
            opts.send({ v: MESH_HANDSHAKE_PROTOCOL_VERSION, kind: 'mesh_ok', daemonId: opts.localDaemonId });
            return step;
        },
    };
}

// ─── ws helper ───────────────────────────────────────────────────────────────

/** The subset of `ws`'s WebSocket this helper touches (EventEmitter-style on/off). */
export interface WebSocketLike {
    readyState: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(event: string, listener: (...args: any[]) => void): unknown;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export class MeshHandshakeError extends Error {
    readonly code: MeshHandshakeFailureCode;
    constructor(code: MeshHandshakeFailureCode, message?: string) {
        super(message ?? `mesh handshake failed: ${code}`);
        this.name = 'MeshHandshakeError';
        this.code = code;
    }
}

export type PerformMeshHandshakeOptions =
    | { side: 'initiator'; options: Omit<HandshakeInitiatorOptions, 'send'> }
    | { side: 'responder'; options: Omit<HandshakeResponderOptions, 'send'> };

export interface MeshHandshakeResult {
    meshId: string;
    peerDaemonId: string;
}

function rawDataToString(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Array.isArray(data) && data.every((d) => Buffer.isBuffer(d))) return Buffer.concat(data).toString('utf8');
    return null;
}

/**
 * Drive one side of the handshake over a socket. Attaches temporary
 * `open`/`message`/`close`/`error` listeners, feeds frames to the state
 * machine, and on ANY outcome removes every listener it added before
 * settling — so the caller can hand the bare socket to the RPC or seqscribe
 * layer. Failure and timeout close the socket with `MESH_HANDSHAKE_CLOSE_CODE`
 * (4401) and reject with a `MeshHandshakeError` carrying the code.
 */
export function performMeshHandshake(
    socket: WebSocketLike,
    side: 'initiator',
    opts: Omit<HandshakeInitiatorOptions, 'send'>,
    timeoutMs?: number,
): Promise<MeshHandshakeResult>;
export function performMeshHandshake(
    socket: WebSocketLike,
    side: 'responder',
    opts: Omit<HandshakeResponderOptions, 'send'>,
    timeoutMs?: number,
): Promise<MeshHandshakeResult>;
export function performMeshHandshake(
    socket: WebSocketLike,
    side: 'initiator' | 'responder',
    opts: Omit<HandshakeInitiatorOptions, 'send'> | Omit<HandshakeResponderOptions, 'send'>,
    timeoutMs: number = MESH_HANDSHAKE_DEFAULT_TIMEOUT_MS,
): Promise<MeshHandshakeResult> {
    return new Promise<MeshHandshakeResult>((resolve, reject) => {
        let settled = false;
        const send = (frame: MeshHandshakeFrame): void => {
            if (socket.readyState !== WS_OPEN) return;
            socket.send(JSON.stringify(frame));
        };
        const machine: { onFrame(frame: unknown): HandshakeStep; start?(): void } = side === 'initiator'
            ? createHandshakeInitiator({ ...(opts as Omit<HandshakeInitiatorOptions, 'send'>), send })
            : createHandshakeResponder({ ...(opts as Omit<HandshakeResponderOptions, 'send'>), send });

        const detach = (): void => {
            socket.off('open', onOpen);
            socket.off('message', onMessage);
            socket.off('close', onClose);
            socket.off('error', onError);
            clearTimeout(timer);
        };
        const settleOk = (result: MeshHandshakeResult): void => {
            if (settled) return;
            settled = true;
            detach();
            resolve(result);
        };
        const settleFail = (code: MeshHandshakeFailureCode, detail?: string): void => {
            if (settled) return;
            settled = true;
            detach();
            LOG.debug('MeshHandshake', `${side} handshake failed (${code})${detail ? `: ${detail}` : ''}`);
            try {
                socket.close(MESH_HANDSHAKE_CLOSE_CODE, code);
            } catch {
                /* already closed */
            }
            reject(new MeshHandshakeError(code));
        };
        const applyStep = (step: HandshakeStep): void => {
            if (step.status === 'ok') {
                LOG.debug('MeshHandshake', `${side} handshake ok with ${maskDaemonId(step.peerDaemonId)} (mesh ${step.meshId})`);
                settleOk({ meshId: step.meshId, peerDaemonId: step.peerDaemonId });
            } else if (step.status === 'failed') {
                settleFail(step.code);
            }
        };

        const onOpen = (): void => {
            machine.start?.();
        };
        const onMessage = (data: unknown): void => {
            const text = rawDataToString(data);
            if (text === null) {
                applyStep(machine.onFrame({}));
                return;
            }
            applyStep(machine.onFrame(text));
        };
        const onClose = (): void => {
            settleFail('socket_closed');
        };
        const onError = (err: unknown): void => {
            settleFail('socket_closed', err instanceof Error ? err.message : undefined);
        };
        const timer = setTimeout(() => {
            send(errorFrame('timeout'));
            settleFail('timeout');
        }, timeoutMs);

        socket.on('open', onOpen);
        socket.on('message', onMessage);
        socket.on('close', onClose);
        socket.on('error', onError);

        if (socket.readyState === WS_OPEN) {
            machine.start?.();
        } else if (socket.readyState !== WS_CONNECTING) {
            settleFail('socket_closed');
        }
    });
}
