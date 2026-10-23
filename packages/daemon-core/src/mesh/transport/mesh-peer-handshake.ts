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
import {
    canAcceptPeerOriginGrantPublicKey,
    recordAuthenticatedPeerOriginGrantPublicKey,
} from '../mesh-host-memory.js';
import {
    MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH,
    canonicalOriginGrantPublicKeyBytes,
    canonicalizeOriginGrantPublicKey,
    getHostKeyRotationChain,
    getHostOriginGrantPublicKey,
    getLatestHostKeyRotationProof,
    isValidOriginGrantPublicKey,
    isValidRotationProofShape,
    originGrantPublicKeysEqual,
    type OriginGrantKeyRotationProof,
} from '../origin-grant-keypair.js';
import { maskDaemonId } from './mask-daemon-id.js';

export const MESH_HANDSHAKE_PROTOCOL_VERSION = 1 as const;
export const MESH_HANDSHAKE_ORIGIN_GRANT_CAP = 'origin_grant_v1' as const;
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
    caps?: string[];
    originGrantPublicKey?: string;
    keyRotation?: OriginGrantKeyRotationProof;
    keyRotationChain?: OriginGrantKeyRotationProof[];
}
export interface MeshChallengeFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_challenge';
    nonce: string;
    proof: string;
    /** The responder's own daemon id — the initiator needs it before computing its proof. */
    daemonId: string;
    caps?: string[];
    originGrantPublicKey?: string;
    keyRotation?: OriginGrantKeyRotationProof;
    keyRotationChain?: OriginGrantKeyRotationProof[];
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
    caps?: string[];
    originGrantPublicKey?: string;
    keyRotation?: OriginGrantKeyRotationProof;
    keyRotationChain?: OriginGrantKeyRotationProof[];
    proof?: string;
}
export interface MeshErrorFrame {
    v: typeof MESH_HANDSHAKE_PROTOCOL_VERSION;
    kind: 'mesh_error';
    code: MeshHandshakeErrorCode;
}
export type MeshHandshakeFrame = MeshHelloFrame | MeshChallengeFrame | MeshProofFrame | MeshOkFrame | MeshErrorFrame;

export type HandshakeStep =
    | { status: 'pending' }
    | { status: 'ok'; meshId: string; peerDaemonId: string; peerOriginGrantPublicKey?: string }
    | { status: 'failed'; code: MeshHandshakeFailureCode };

const PENDING: HandshakeStep = { status: 'pending' };
const ERROR_CODES: ReadonlySet<string> = new Set<MeshHandshakeErrorCode>([
    'unknown_peer', 'bad_proof', 'bad_version', 'bad_frame', 'timeout',
]);

// ─── Primitives ──────────────────────────────────────────────────────────────

const CAP_SENTINEL_BYTES = 6;
const CAP_SENTINEL_PREFIX_BYTES = NONCE_BYTES - CAP_SENTINEL_BYTES;

export function mintHandshakeNonce(): string {
    return randomBytes(NONCE_BYTES).toString('base64');
}

function computeCapableNonceSentinel(
    secret: string,
    role: 'client' | 'server',
    meshId: string,
    daemonId: string,
    prefixBytes: Buffer,
): Buffer {
    const hmac = createHmac('sha256', secret);
    hmac.update(`adhdev.mesh.cap_sentinel.v1|${role}|${meshId}|${canon(daemonId)}|`, 'utf8');
    hmac.update(prefixBytes);
    return hmac.digest().subarray(0, CAP_SENTINEL_BYTES);
}

function mintCapableHandshakeNonce(
    secret: string,
    role: 'client' | 'server',
    meshId: string,
    daemonId: string,
): string {
    const prefix = randomBytes(CAP_SENTINEL_PREFIX_BYTES);
    const sentinel = computeCapableNonceSentinel(secret, role, meshId, daemonId, prefix);
    return Buffer.concat([prefix, sentinel]).toString('base64');
}

function hasCapableNonceSentinel(
    nonceBase64: string,
    secret: string,
    role: 'client' | 'server',
    meshId: string,
    daemonId: string,
): boolean {
    const raw = Buffer.from(nonceBase64, 'base64');
    if (raw.length !== NONCE_BYTES) return false;
    const prefix = raw.subarray(0, CAP_SENTINEL_PREFIX_BYTES);
    const actual = raw.subarray(CAP_SENTINEL_PREFIX_BYTES);
    const expected = computeCapableNonceSentinel(secret, role, meshId, daemonId, prefix);
    return timingSafeEqual(actual, expected);
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
    clientCaps?: readonly string[];
    serverCaps?: readonly string[];
    clientOriginGrantPublicKey?: string;
    serverOriginGrantPublicKey?: string;
    clientKeyRotation?: OriginGrantKeyRotationProof;
    serverKeyRotation?: OriginGrantKeyRotationProof;
    clientKeyRotationChain?: readonly OriginGrantKeyRotationProof[];
    serverKeyRotationChain?: readonly OriginGrantKeyRotationProof[];
}

function canon(id: string): string {
    return canonicalDaemonId(id) ?? id.trim();
}

function hasOriginGrantCap(caps: readonly string[] | undefined): boolean {
    return Array.isArray(caps) && caps.includes(MESH_HANDSHAKE_ORIGIN_GRANT_CAP);
}

function hasKeyMaterial(input: ProofInputs): boolean {
    return Boolean(
        (input.clientCaps && input.clientCaps.length > 0) ||
        (input.serverCaps && input.serverCaps.length > 0) ||
        (input.clientOriginGrantPublicKey && input.clientOriginGrantPublicKey.trim()) ||
        (input.serverOriginGrantPublicKey && input.serverOriginGrantPublicKey.trim()) ||
        input.clientKeyRotation ||
        input.serverKeyRotation ||
        (input.clientKeyRotationChain && input.clientKeyRotationChain.length > 0) ||
        (input.serverKeyRotationChain && input.serverKeyRotationChain.length > 0),
    );
}

function encodeCapsForTranscript(
    caps: readonly string[] | undefined,
    fallbackPubKey: string | undefined,
): Buffer {
    const effective =
        caps && caps.length > 0
            ? caps
            : fallbackPubKey && fallbackPubKey.trim()
              ? [MESH_HANDSHAKE_ORIGIN_GRANT_CAP]
              : [];
    return Buffer.from(effective.map((c) => c.trim()).join(','), 'utf8');
}

function encodeSpkiBytesForTranscript(rawPublicKey: string | undefined): Buffer {
    if (!rawPublicKey || !rawPublicKey.trim()) return Buffer.alloc(0);
    const canonicalBytes = canonicalOriginGrantPublicKeyBytes(rawPublicKey);
    if (canonicalBytes) return canonicalBytes;
    return Buffer.from(`invalid:${rawPublicKey.trim()}`, 'utf8');
}

function encodeRotationForTranscript(proof: OriginGrantKeyRotationProof | undefined): Buffer {
    if (!proof) return Buffer.alloc(0);
    return Buffer.from(
        [
            canon(proof.hostDaemonId),
            canonicalizeOriginGrantPublicKey(proof.oldPublicKey) ?? proof.oldPublicKey.trim(),
            canonicalizeOriginGrantPublicKey(proof.newPublicKey) ?? proof.newPublicKey.trim(),
            String(proof.rotatedAt),
            proof.nonce.trim(),
            proof.signature.trim(),
        ].join('|'),
        'utf8',
    );
}

function encodeRotationChainForTranscript(
    chain: readonly OriginGrantKeyRotationProof[] | undefined,
): Buffer {
    if (!chain || chain.length === 0) return Buffer.alloc(0);
    return Buffer.from(
        chain.map((p) => encodeRotationForTranscript(p).toString('utf8')).join(';'),
        'utf8',
    );
}

function computeTranscriptHmac(prefix: string, input: ProofInputs): string {
    const hmac = createHmac('sha256', input.secret);
    hmac.update(prefix, 'utf8');
    if (hasKeyMaterial(input)) {
        const capsC = encodeCapsForTranscript(input.clientCaps, input.clientOriginGrantPublicKey);
        const capsS = encodeCapsForTranscript(input.serverCaps, input.serverOriginGrantPublicKey);
        const clientSpki = encodeSpkiBytesForTranscript(input.clientOriginGrantPublicKey);
        const serverSpki = encodeSpkiBytesForTranscript(input.serverOriginGrantPublicKey);
        const clientRot = encodeRotationForTranscript(input.clientKeyRotation);
        const serverRot = encodeRotationForTranscript(input.serverKeyRotation);
        const clientChain = encodeRotationChainForTranscript(input.clientKeyRotationChain);
        const serverChain = encodeRotationChainForTranscript(input.serverKeyRotationChain);
        hmac.update(`|capsC:${capsC.byteLength}:`, 'utf8');
        hmac.update(capsC);
        hmac.update(`|capsS:${capsS.byteLength}:`, 'utf8');
        hmac.update(capsS);
        hmac.update(`|spkiC:${clientSpki.byteLength}:`, 'utf8');
        hmac.update(clientSpki);
        hmac.update(`|spkiS:${serverSpki.byteLength}:`, 'utf8');
        hmac.update(serverSpki);
        if (clientRot.byteLength > 0 || serverRot.byteLength > 0) {
            hmac.update(`|rotC:${clientRot.byteLength}:`, 'utf8');
            hmac.update(clientRot);
            hmac.update(`|rotS:${serverRot.byteLength}:`, 'utf8');
            hmac.update(serverRot);
        }
        if (clientChain.byteLength > 0 || serverChain.byteLength > 0) {
            hmac.update(`|chainC:${clientChain.byteLength}:`, 'utf8');
            hmac.update(clientChain);
            hmac.update(`|chainS:${serverChain.byteLength}:`, 'utf8');
            hmac.update(serverChain);
        }
    }
    return hmac.digest('base64');
}

/** proofS — what the responder sends in `mesh_challenge`. */
export function computeServerProof(input: ProofInputs): string {
    return computeTranscriptHmac(
        `S|${input.clientNonce}|${input.serverNonce}|${input.meshId}|${canon(input.clientDaemonId)}|${canon(input.serverDaemonId)}`,
        input,
    );
}

/** proofC — what the initiator sends in `mesh_proof`. */
export function computeClientProof(input: ProofInputs): string {
    return computeTranscriptHmac(
        `C|${input.serverNonce}|${input.clientNonce}|${input.meshId}|${canon(input.clientDaemonId)}|${canon(input.serverDaemonId)}`,
        input,
    );
}

/** proofOk — what the responder sends in `mesh_ok` when key material is bound. */
export function computeOkProof(input: ProofInputs): string {
    return computeTranscriptHmac(
        `O|${input.clientNonce}|${input.serverNonce}|${input.meshId}|${canon(input.clientDaemonId)}|${canon(input.serverDaemonId)}`,
        input,
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

function parseOptionalCaps(
    value: unknown,
): { ok: true; value?: string[] } | { ok: false } {
    if (value === undefined) return { ok: true };
    if (!Array.isArray(value) || value.length > 16) return { ok: false };
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return { ok: false };
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > 64) return { ok: false };
        out.push(trimmed);
    }
    return { ok: true, value: out };
}

function parseOptionalOriginGrantPublicKey(
    value: unknown,
): { ok: true; value?: string } | { ok: false } {
    if (value === undefined) return { ok: true };
    if (typeof value !== 'string') return { ok: false };
    const trimmed = value.trim();
    if (!trimmed || !isValidOriginGrantPublicKey(trimmed)) return { ok: false };
    return { ok: true, value: trimmed };
}

function parseOptionalKeyRotation(
    value: unknown,
): { ok: true; value?: OriginGrantKeyRotationProof } | { ok: false } {
    if (value === undefined) return { ok: true };
    if (!isValidRotationProofShape(value)) return { ok: false };
    if (!isValidOriginGrantPublicKey(value.oldPublicKey) || !isValidOriginGrantPublicKey(value.newPublicKey)) {
        return { ok: false };
    }
    return { ok: true, value };
}

function parseOptionalKeyRotationChain(
    value: unknown,
): { ok: true; value?: OriginGrantKeyRotationProof[] } | { ok: false } {
    if (value === undefined) return { ok: true };
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH) {
        return { ok: false };
    }
    const out: OriginGrantKeyRotationProof[] = [];
    for (const item of value) {
        const parsed = parseOptionalKeyRotation(item);
        if (!parsed.ok || !parsed.value) return { ok: false };
        out.push(parsed.value);
    }
    return { ok: true, value: out };
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
        case 'mesh_hello': {
            if (!isNonEmptyString(obj.meshId) || !isNonEmptyString(obj.daemonId) || !isNonce(obj.nonce)) {
                return { error: 'bad_frame' };
            }
            const caps = parseOptionalCaps(obj.caps);
            const pubKey = parseOptionalOriginGrantPublicKey(obj.originGrantPublicKey);
            const rotation = parseOptionalKeyRotation(obj.keyRotation);
            const rotationChain = parseOptionalKeyRotationChain(obj.keyRotationChain);
            if (!caps.ok || !pubKey.ok || !rotation.ok || !rotationChain.ok) return { error: 'bad_frame' };
            return {
                v: 1,
                kind: 'mesh_hello',
                meshId: obj.meshId,
                daemonId: obj.daemonId,
                nonce: obj.nonce,
                ...(caps.value ? { caps: caps.value } : {}),
                ...(pubKey.value ? { originGrantPublicKey: pubKey.value } : {}),
                ...(rotation.value ? { keyRotation: rotation.value } : {}),
                ...(rotationChain.value ? { keyRotationChain: rotationChain.value } : {}),
            };
        }
        case 'mesh_challenge': {
            if (!isNonce(obj.nonce) || !isNonEmptyString(obj.proof) || !isNonEmptyString(obj.daemonId)) {
                return { error: 'bad_frame' };
            }
            const caps = parseOptionalCaps(obj.caps);
            const pubKey = parseOptionalOriginGrantPublicKey(obj.originGrantPublicKey);
            const rotation = parseOptionalKeyRotation(obj.keyRotation);
            const rotationChain = parseOptionalKeyRotationChain(obj.keyRotationChain);
            if (!caps.ok || !pubKey.ok || !rotation.ok || !rotationChain.ok) return { error: 'bad_frame' };
            return {
                v: 1,
                kind: 'mesh_challenge',
                nonce: obj.nonce,
                proof: obj.proof,
                daemonId: obj.daemonId,
                ...(caps.value ? { caps: caps.value } : {}),
                ...(pubKey.value ? { originGrantPublicKey: pubKey.value } : {}),
                ...(rotation.value ? { keyRotation: rotation.value } : {}),
                ...(rotationChain.value ? { keyRotationChain: rotationChain.value } : {}),
            };
        }
        case 'mesh_proof':
            if (!isNonEmptyString(obj.proof)) return { error: 'bad_frame' };
            if (
                obj.originGrantPublicKey !== undefined ||
                obj.keyRotation !== undefined ||
                obj.keyRotationChain !== undefined ||
                obj.caps !== undefined
            ) {
                return { error: 'bad_frame' };
            }
            return { v: 1, kind: 'mesh_proof', proof: obj.proof };
        case 'mesh_ok': {
            if (!isNonEmptyString(obj.daemonId)) return { error: 'bad_frame' };
            if (obj.proof !== undefined && !isNonEmptyString(obj.proof)) return { error: 'bad_frame' };
            const caps = parseOptionalCaps(obj.caps);
            const pubKey = parseOptionalOriginGrantPublicKey(obj.originGrantPublicKey);
            const rotation = parseOptionalKeyRotation(obj.keyRotation);
            const rotationChain = parseOptionalKeyRotationChain(obj.keyRotationChain);
            if (!caps.ok || !pubKey.ok || !rotation.ok || !rotationChain.ok) return { error: 'bad_frame' };
            return {
                v: 1,
                kind: 'mesh_ok',
                daemonId: obj.daemonId,
                ...(caps.value ? { caps: caps.value } : {}),
                ...(pubKey.value ? { originGrantPublicKey: pubKey.value } : {}),
                ...(rotation.value ? { keyRotation: rotation.value } : {}),
                ...(rotationChain.value ? { keyRotationChain: rotationChain.value } : {}),
                ...(isNonEmptyString(obj.proof) ? { proof: obj.proof } : {}),
            };
        }
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

function rotationProofsEquivalent(
    a: OriginGrantKeyRotationProof | undefined,
    b: OriginGrantKeyRotationProof | undefined,
): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return encodeRotationForTranscript(a).equals(encodeRotationForTranscript(b));
}

function rotationChainsEquivalent(
    a: readonly OriginGrantKeyRotationProof[] | undefined,
    b: readonly OriginGrantKeyRotationProof[] | undefined,
): boolean {
    if ((!a || a.length === 0) && (!b || b.length === 0)) return true;
    if (!a || !b || a.length !== b.length) return false;
    return encodeRotationChainForTranscript(a).equals(encodeRotationChainForTranscript(b));
}

function capsEquivalent(
    a: readonly string[] | undefined,
    b: readonly string[] | undefined,
): boolean {
    if ((!a || a.length === 0) && (!b || b.length === 0)) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, idx) => v === b[idx]);
}

// ─── Initiator (client / member side) ────────────────────────────────────────

export interface HandshakeInitiatorOptions {
    meshId: string;
    /** This daemon's id (either form). */
    daemonId: string;
    /** When set, a challenge from any other daemon id fails with `bad_proof`. */
    serverDaemonIdExpected?: string;
    secret: string;
    caps?: string[];
    originGrantPublicKey?: string;
    keyRotation?: OriginGrantKeyRotationProof;
    keyRotationChain?: OriginGrantKeyRotationProof[];
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
    const localCaps =
        opts.caps !== undefined
            ? opts.caps
            : opts.originGrantPublicKey
              ? [MESH_HANDSHAKE_ORIGIN_GRANT_CAP]
              : undefined;
    const localHasOriginGrantCap = hasOriginGrantCap(localCaps);
    const clientNonce = localHasOriginGrantCap
        ? mintCapableHandshakeNonce(opts.secret, 'client', opts.meshId, opts.daemonId)
        : mintHandshakeNonce();
    const localPubKey = localHasOriginGrantCap ? opts.originGrantPublicKey : undefined;
    const localRotation = localHasOriginGrantCap ? opts.keyRotation : undefined;
    const localRotationChain =
        localHasOriginGrantCap && opts.keyRotationChain && opts.keyRotationChain.length > 0
            ? opts.keyRotationChain
            : undefined;

    let serverNonce = '';
    let serverDaemonId = '';
    let negotiatedOriginGrant = false;
    let serverCaps: string[] | undefined;
    let serverOriginGrantPublicKey: string | undefined;
    let serverKeyRotation: OriginGrantKeyRotationProof | undefined;
    let serverKeyRotationChain: OriginGrantKeyRotationProof[] | undefined;

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
                ...(localCaps && localCaps.length > 0 ? { caps: [...localCaps] } : {}),
                ...(localPubKey ? { originGrantPublicKey: localPubKey } : {}),
                ...(localRotation ? { keyRotation: localRotation } : {}),
                ...(localRotationChain ? { keyRotationChain: [...localRotationChain] } : {}),
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

                const peerHasCap = hasOriginGrantCap(parsed.caps);
                const peerSentKeyMaterial = Boolean(
                    parsed.originGrantPublicKey || parsed.keyRotation || parsed.keyRotationChain,
                );
                // If the peer sent key material on mesh_challenge without the capability flag,
                // a relay stripped caps (or the frame is inconsistent) -> fail closed.
                if (peerSentKeyMaterial && !peerHasCap) {
                    return fail('bad_proof', true);
                }
                // If both this initiator and the responder advertise origin_grant_v1,
                // the responder MUST provide its originGrantPublicKey and bound proofS.
                // (If a relay stripped caps from mesh_hello, the responder sent caps: ['origin_grant_v1']
                // without originGrantPublicKey / with legacy proofS, which is caught right here!)
                if (localHasOriginGrantCap && peerHasCap && !parsed.originGrantPublicKey) {
                    return fail('bad_proof', true);
                }
                // If the responder's nonce carries our HMAC capability sentinel, the responder
                // is origin_grant_v1-capable; missing caps on mesh_challenge means a relay stripped caps.
                if (
                    localHasOriginGrantCap &&
                    !peerHasCap &&
                    hasCapableNonceSentinel(parsed.nonce, opts.secret, 'server', opts.meshId, parsed.daemonId)
                ) {
                    return fail('bad_proof', true);
                }

                negotiatedOriginGrant = localHasOriginGrantCap && peerHasCap;

                const inputs: ProofInputs = negotiatedOriginGrant
                    ? {
                          secret: opts.secret,
                          clientNonce,
                          serverNonce: parsed.nonce,
                          meshId: opts.meshId,
                          clientDaemonId: opts.daemonId,
                          serverDaemonId: parsed.daemonId,
                          clientCaps: localCaps,
                          serverCaps: parsed.caps,
                          clientOriginGrantPublicKey: localPubKey,
                          serverOriginGrantPublicKey: parsed.originGrantPublicKey,
                          clientKeyRotation: localRotation,
                          serverKeyRotation: parsed.keyRotation,
                          clientKeyRotationChain: localRotationChain,
                          serverKeyRotationChain: parsed.keyRotationChain,
                      }
                    : {
                          secret: opts.secret,
                          clientNonce,
                          serverNonce: parsed.nonce,
                          meshId: opts.meshId,
                          clientDaemonId: opts.daemonId,
                          serverDaemonId: parsed.daemonId,
                      };

                if (!proofsEqual(computeServerProof(inputs), parsed.proof)) return fail('bad_proof', true);

                if (negotiatedOriginGrant && parsed.originGrantPublicKey) {
                    if (
                        !canAcceptPeerOriginGrantPublicKey(
                            opts.meshId,
                            canon(parsed.daemonId),
                            parsed.originGrantPublicKey,
                            {
                                rotationProof: parsed.keyRotation,
                                rotationChain: parsed.keyRotationChain,
                            },
                        )
                    ) {
                        return fail('bad_proof', true);
                    }
                    serverCaps = parsed.caps;
                    serverOriginGrantPublicKey = parsed.originGrantPublicKey;
                    serverKeyRotation = parsed.keyRotation;
                    serverKeyRotationChain = parsed.keyRotationChain;
                } else {
                    serverCaps = undefined;
                    serverOriginGrantPublicKey = undefined;
                    serverKeyRotation = undefined;
                    serverKeyRotationChain = undefined;
                }

                serverNonce = parsed.nonce;
                serverDaemonId = parsed.daemonId;
                state = 'awaiting_ok';
                opts.send({
                    v: MESH_HANDSHAKE_PROTOCOL_VERSION,
                    kind: 'mesh_proof',
                    proof: computeClientProof(inputs),
                });
                return PENDING;
            }

            // awaiting_ok
            if (parsed.kind !== 'mesh_ok') return fail('bad_frame', true);
            if (canon(parsed.daemonId) !== canon(serverDaemonId) || !serverNonce) return fail('bad_frame', true);

            if (!negotiatedOriginGrant) {
                // Legacy fallback: reject unexpected key material or proof injection on mesh_ok,
                // and NEVER pin or accept a key from an old handshake.
                if (
                    parsed.originGrantPublicKey !== undefined ||
                    parsed.keyRotation !== undefined ||
                    parsed.keyRotationChain !== undefined ||
                    parsed.proof !== undefined ||
                    hasOriginGrantCap(parsed.caps)
                ) {
                    return fail('bad_proof', true);
                }
                state = 'done';
                step = {
                    status: 'ok',
                    meshId: opts.meshId,
                    peerDaemonId: canon(serverDaemonId),
                };
                return step;
            }

            // Negotiated origin_grant_v1: mesh_ok must carry matching caps, key, rotation, and proofOk.
            if (!hasOriginGrantCap(parsed.caps) || !capsEquivalent(parsed.caps, serverCaps)) {
                return fail('bad_proof', true);
            }
            if (!originGrantPublicKeysEqual(serverOriginGrantPublicKey, parsed.originGrantPublicKey)) {
                return fail('bad_proof', true);
            }
            if (parsed.keyRotation && !rotationProofsEquivalent(parsed.keyRotation, serverKeyRotation)) {
                return fail('bad_proof', true);
            }
            if (
                parsed.keyRotationChain &&
                !rotationChainsEquivalent(parsed.keyRotationChain, serverKeyRotationChain)
            ) {
                return fail('bad_proof', true);
            }
            const okInputs: ProofInputs = {
                secret: opts.secret,
                clientNonce,
                serverNonce,
                meshId: opts.meshId,
                clientDaemonId: opts.daemonId,
                serverDaemonId,
                clientCaps: localCaps,
                serverCaps: parsed.caps ?? serverCaps,
                clientOriginGrantPublicKey: localPubKey,
                serverOriginGrantPublicKey: parsed.originGrantPublicKey ?? serverOriginGrantPublicKey,
                clientKeyRotation: localRotation,
                serverKeyRotation: parsed.keyRotation ?? serverKeyRotation,
                clientKeyRotationChain: localRotationChain,
                serverKeyRotationChain: parsed.keyRotationChain ?? serverKeyRotationChain,
            };
            if (!proofsEqual(computeOkProof(okInputs), parsed.proof)) {
                return fail('bad_proof', true);
            }
            const peerPubKey = parsed.originGrantPublicKey || serverOriginGrantPublicKey;
            const validPeerPubKey = peerPubKey && isValidOriginGrantPublicKey(peerPubKey) ? peerPubKey : undefined;
            if (validPeerPubKey) {
                const recorded = recordAuthenticatedPeerOriginGrantPublicKey(
                    opts.meshId,
                    canon(serverDaemonId),
                    validPeerPubKey,
                    {
                        rotationProof: parsed.keyRotation ?? serverKeyRotation,
                        rotationChain: parsed.keyRotationChain ?? serverKeyRotationChain,
                    },
                );
                if (!recorded) return fail('bad_proof', true);
            }
            state = 'done';
            step = {
                status: 'ok',
                meshId: opts.meshId,
                peerDaemonId: canon(serverDaemonId),
                ...(validPeerPubKey ? { peerOriginGrantPublicKey: validPeerPubKey } : {}),
            };
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
    caps?: string[];
    originGrantPublicKey?: string;
    keyRotation?: OriginGrantKeyRotationProof;
    keyRotationChain?: OriginGrantKeyRotationProof[];
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
    const localCaps =
        opts.caps !== undefined
            ? opts.caps
            : opts.originGrantPublicKey
              ? [MESH_HANDSHAKE_ORIGIN_GRANT_CAP]
              : undefined;
    const localHasOriginGrantCap = hasOriginGrantCap(localCaps);
    const localPubKey = localHasOriginGrantCap ? opts.originGrantPublicKey : undefined;
    const localRotation = localHasOriginGrantCap ? opts.keyRotation : undefined;
    const localRotationChain =
        localHasOriginGrantCap && opts.keyRotationChain && opts.keyRotationChain.length > 0
            ? opts.keyRotationChain
            : undefined;

    let expectedClientProof = '';
    let expectedOkProof: string | undefined;
    let meshId = '';
    let peerDaemonId = '';
    let negotiatedOriginGrant = false;
    let clientOriginGrantPublicKey: string | undefined;
    let clientKeyRotation: OriginGrantKeyRotationProof | undefined;
    let clientKeyRotationChain: OriginGrantKeyRotationProof[] | undefined;

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
                const serverNonce =
                    localHasOriginGrantCap && secret
                        ? mintCapableHandshakeNonce(secret, 'server', parsed.meshId, opts.localDaemonId)
                        : mintHandshakeNonce();

                const clientHasCap = hasOriginGrantCap(parsed.caps);
                const clientSentKeyMaterial = Boolean(
                    parsed.originGrantPublicKey || parsed.keyRotation || parsed.keyRotationChain,
                );

                // If the client sent key material without the capability flag, or advertised
                // origin_grant_v1 without an originGrantPublicKey, or its nonce carries the
                // capability sentinel while caps is missing, a relay tampered with mesh_hello.
                if (localHasOriginGrantCap) {
                    if (clientSentKeyMaterial && !clientHasCap) {
                        if (secret === null || secret === '') return fail('unknown_peer', true);
                        return fail('bad_proof', true);
                    }
                    if (clientHasCap && !parsed.originGrantPublicKey) {
                        if (secret === null || secret === '') return fail('unknown_peer', true);
                        return fail('bad_proof', true);
                    }
                    if (
                        !clientHasCap &&
                        secret &&
                        hasCapableNonceSentinel(parsed.nonce, secret, 'client', parsed.meshId, parsed.daemonId)
                    ) {
                        return fail('bad_proof', true);
                    }
                }

                negotiatedOriginGrant = Boolean(
                    localHasOriginGrantCap && clientHasCap && localPubKey && parsed.originGrantPublicKey,
                );

                const inputs: ProofInputs = negotiatedOriginGrant
                    ? {
                          secret: secret ?? decoySecret,
                          clientNonce: parsed.nonce,
                          serverNonce,
                          meshId: parsed.meshId,
                          clientDaemonId: parsed.daemonId,
                          serverDaemonId: opts.localDaemonId,
                          clientCaps: parsed.caps,
                          serverCaps: localCaps,
                          clientOriginGrantPublicKey: parsed.originGrantPublicKey,
                          serverOriginGrantPublicKey: localPubKey,
                          clientKeyRotation: parsed.keyRotation,
                          serverKeyRotation: localRotation,
                          clientKeyRotationChain: parsed.keyRotationChain,
                          serverKeyRotationChain: localRotationChain,
                      }
                    : {
                          secret: secret ?? decoySecret,
                          clientNonce: parsed.nonce,
                          serverNonce,
                          meshId: parsed.meshId,
                          clientDaemonId: parsed.daemonId,
                          serverDaemonId: opts.localDaemonId,
                      };

                const serverProof = computeServerProof(inputs);
                const clientProof = computeClientProof(inputs);
                const okProof = negotiatedOriginGrant ? computeOkProof(inputs) : undefined;
                if (secret === null || secret === '') {
                    // Same work as the known-peer path (two HMACs + one compare), one code.
                    proofsEqual(serverProof, clientProof);
                    return fail('unknown_peer', true);
                }
                expectedClientProof = clientProof;
                expectedOkProof = okProof;
                meshId = parsed.meshId;
                peerDaemonId = canonicalPeer;
                clientOriginGrantPublicKey = negotiatedOriginGrant ? parsed.originGrantPublicKey : undefined;
                clientKeyRotation = negotiatedOriginGrant ? parsed.keyRotation : undefined;
                clientKeyRotationChain = negotiatedOriginGrant ? parsed.keyRotationChain : undefined;
                state = 'awaiting_proof';
                opts.send({
                    v: MESH_HANDSHAKE_PROTOCOL_VERSION,
                    kind: 'mesh_challenge',
                    nonce: serverNonce,
                    proof: serverProof,
                    daemonId: opts.localDaemonId,
                    // Always advertise local capabilities on mesh_challenge when localHasOriginGrantCap is true:
                    // an old initiator ignores unknown fields, whereas a new initiator whose mesh_hello was
                    // stripped of caps+key by a relay sees the server's capability and detects the downgrade!
                    ...(localCaps && localCaps.length > 0 ? { caps: [...localCaps] } : {}),
                    ...(negotiatedOriginGrant && localPubKey ? { originGrantPublicKey: localPubKey } : {}),
                    ...(negotiatedOriginGrant && localRotation ? { keyRotation: localRotation } : {}),
                    ...(negotiatedOriginGrant && localRotationChain
                        ? { keyRotationChain: [...localRotationChain] }
                        : {}),
                });
                return PENDING;
            }

            // awaiting_proof
            if (parsed.kind !== 'mesh_proof') return fail('bad_frame', true);
            if (!proofsEqual(expectedClientProof, parsed.proof)) return fail('bad_proof', true);
            const validClientPubKey =
                negotiatedOriginGrant &&
                clientOriginGrantPublicKey &&
                isValidOriginGrantPublicKey(clientOriginGrantPublicKey)
                    ? clientOriginGrantPublicKey
                    : undefined;
            if (validClientPubKey) {
                const recorded = recordAuthenticatedPeerOriginGrantPublicKey(
                    meshId,
                    peerDaemonId,
                    validClientPubKey,
                    {
                        rotationProof: clientKeyRotation,
                        rotationChain: clientKeyRotationChain,
                    },
                );
                if (!recorded) return fail('bad_proof', true);
            }
            state = 'done';
            step = {
                status: 'ok',
                meshId,
                peerDaemonId,
                ...(validClientPubKey ? { peerOriginGrantPublicKey: validClientPubKey } : {}),
            };
            opts.send({
                v: MESH_HANDSHAKE_PROTOCOL_VERSION,
                kind: 'mesh_ok',
                daemonId: opts.localDaemonId,
                ...(negotiatedOriginGrant && localCaps && localCaps.length > 0 ? { caps: [...localCaps] } : {}),
                ...(negotiatedOriginGrant && localPubKey ? { originGrantPublicKey: localPubKey } : {}),
                ...(negotiatedOriginGrant && localRotation ? { keyRotation: localRotation } : {}),
                ...(negotiatedOriginGrant && localRotationChain
                    ? { keyRotationChain: [...localRotationChain] }
                    : {}),
                ...(negotiatedOriginGrant && expectedOkProof ? { proof: expectedOkProof } : {}),
            });
            return step;
        },
    };
}

function resolveDefaultKeyRotation(
    daemonId: string,
    effectivePublicKey: string | undefined,
    explicitRotation: OriginGrantKeyRotationProof | undefined,
): OriginGrantKeyRotationProof | undefined {
    if (explicitRotation) return explicitRotation;
    if (!effectivePublicKey) return undefined;
    const latest = getLatestHostKeyRotationProof(daemonId);
    if (!latest) return undefined;
    return originGrantPublicKeysEqual(latest.newPublicKey, effectivePublicKey) ? latest : undefined;
}

function resolveDefaultKeyRotationChain(
    daemonId: string,
    effectivePublicKey: string | undefined,
    explicitChain: OriginGrantKeyRotationProof[] | undefined,
): OriginGrantKeyRotationProof[] | undefined {
    if (explicitChain && explicitChain.length > 0) return explicitChain;
    if (!effectivePublicKey) return undefined;
    const chain = getHostKeyRotationChain(daemonId);
    if (chain.length === 0) return undefined;
    const last = chain[chain.length - 1]!;
    return originGrantPublicKeysEqual(last.newPublicKey, effectivePublicKey) ? chain : undefined;
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
            ? (() => {
                const initOpts = opts as Omit<HandshakeInitiatorOptions, 'send'>;
                const legacyDisabled =
                    (initOpts.caps !== undefined && !hasOriginGrantCap(initOpts.caps)) ||
                    initOpts.originGrantPublicKey === '';
                const effectiveKey = legacyDisabled
                    ? undefined
                    : initOpts.originGrantPublicKey || getHostOriginGrantPublicKey(initOpts.daemonId);
                const effectiveCaps =
                    initOpts.caps !== undefined
                        ? initOpts.caps
                        : effectiveKey
                          ? [MESH_HANDSHAKE_ORIGIN_GRANT_CAP]
                          : undefined;
                const effectiveRotation = resolveDefaultKeyRotation(initOpts.daemonId, effectiveKey, initOpts.keyRotation);
                const effectiveChain = resolveDefaultKeyRotationChain(
                    initOpts.daemonId,
                    effectiveKey,
                    initOpts.keyRotationChain,
                );
                return createHandshakeInitiator({
                    ...initOpts,
                    ...(effectiveCaps !== undefined ? { caps: effectiveCaps } : {}),
                    originGrantPublicKey: effectiveKey,
                    ...(effectiveRotation ? { keyRotation: effectiveRotation } : {}),
                    ...(effectiveChain ? { keyRotationChain: effectiveChain } : {}),
                    send,
                });
            })()
            : (() => {
                const respOpts = opts as Omit<HandshakeResponderOptions, 'send'>;
                const legacyDisabled =
                    (respOpts.caps !== undefined && !hasOriginGrantCap(respOpts.caps)) ||
                    respOpts.originGrantPublicKey === '';
                const effectiveKey = legacyDisabled
                    ? undefined
                    : respOpts.originGrantPublicKey || getHostOriginGrantPublicKey(respOpts.localDaemonId);
                const effectiveCaps =
                    respOpts.caps !== undefined
                        ? respOpts.caps
                        : effectiveKey
                          ? [MESH_HANDSHAKE_ORIGIN_GRANT_CAP]
                          : undefined;
                const effectiveRotation = resolveDefaultKeyRotation(
                    respOpts.localDaemonId,
                    effectiveKey,
                    respOpts.keyRotation,
                );
                const effectiveChain = resolveDefaultKeyRotationChain(
                    respOpts.localDaemonId,
                    effectiveKey,
                    respOpts.keyRotationChain,
                );
                return createHandshakeResponder({
                    ...respOpts,
                    ...(effectiveCaps !== undefined ? { caps: effectiveCaps } : {}),
                    originGrantPublicKey: effectiveKey,
                    ...(effectiveRotation ? { keyRotation: effectiveRotation } : {}),
                    ...(effectiveChain ? { keyRotationChain: effectiveChain } : {}),
                    send,
                });
            })();

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
