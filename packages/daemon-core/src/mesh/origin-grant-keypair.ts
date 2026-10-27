import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';

const ORIGIN_GRANT_KEYS_FILENAME = 'artifact-origin-grant-keys.json';
export const MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH = 4;

export interface OriginGrantKeyRotationProof {
    hostDaemonId: string;
    oldPublicKey: string;
    newPublicKey: string;
    rotatedAt: number;
    nonce: string;
    signature: string;
}

interface StoredKeyPairRecord {
    publicKey: string;
    privateKey: string;
    createdAt: string;
    rotationProof?: OriginGrantKeyRotationProof;
    rotationChain?: OriginGrantKeyRotationProof[];
}

interface StoredKeyPairsFile {
    version: number;
    keys: Record<string, StoredKeyPairRecord>;
}

export interface CachedKeyPair {
    publicKey: string;
    privateKeyObj: crypto.KeyObject;
    fileMtimeMs: number;
    rotationProof?: OriginGrantKeyRotationProof;
    rotationChain?: OriginGrantKeyRotationProof[];
}

const keyPairCache = new Map<string, CachedKeyPair>();

function trimStr(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function canonGrantDaemonId(daemonId: string): string {
    const trimmed = trimStr(daemonId);
    if (!trimmed) return '';
    return canonicalDaemonId(trimmed) ?? trimmed;
}

export function parseOriginGrantPublicKeyObject(rawPublicKey: string): crypto.KeyObject | null {
    const trimmed = trimStr(rawPublicKey);
    if (!trimmed) return null;
    try {
        if (trimmed.startsWith('-----BEGIN')) {
            const keyObj = crypto.createPublicKey(trimmed);
            return keyObj.asymmetricKeyType === 'ed25519' ? keyObj : null;
        }
        const der = Buffer.from(trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
        const keyObj = crypto.createPublicKey({
            key: der,
            format: 'der',
            type: 'spki',
        });
        return keyObj.asymmetricKeyType === 'ed25519' ? keyObj : null;
    } catch {
        return null;
    }
}

export function isValidOriginGrantPublicKey(rawPublicKey: unknown): rawPublicKey is string {
    return typeof rawPublicKey === 'string' && parseOriginGrantPublicKeyObject(rawPublicKey) !== null;
}

export function canonicalOriginGrantPublicKeyBytes(rawPublicKey: unknown): Buffer | null {
    if (typeof rawPublicKey !== 'string') return null;
    const keyObj = parseOriginGrantPublicKeyObject(rawPublicKey);
    if (!keyObj) return null;
    try {
        const exported = keyObj.export({ format: 'der', type: 'spki' });
        return Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
    } catch {
        return null;
    }
}

export function canonicalizeOriginGrantPublicKey(rawPublicKey: unknown): string | null {
    const bytes = canonicalOriginGrantPublicKeyBytes(rawPublicKey);
    return bytes ? bytes.toString('base64url') : null;
}

export function originGrantPublicKeysEqual(a: unknown, b: unknown): boolean {
    const bytesA = canonicalOriginGrantPublicKeyBytes(a);
    const bytesB = canonicalOriginGrantPublicKeyBytes(b);
    if (!bytesA || !bytesB) return false;
    return bytesA.equals(bytesB);
}

export function isValidRotationProofShape(value: unknown): value is OriginGrantKeyRotationProof {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.hostDaemonId === 'string' &&
        candidate.hostDaemonId.trim().length > 0 &&
        typeof candidate.oldPublicKey === 'string' &&
        candidate.oldPublicKey.trim().length > 0 &&
        typeof candidate.newPublicKey === 'string' &&
        candidate.newPublicKey.trim().length > 0 &&
        typeof candidate.rotatedAt === 'number' &&
        Number.isFinite(candidate.rotatedAt) &&
        typeof candidate.nonce === 'string' &&
        candidate.nonce.trim().length > 0 &&
        typeof candidate.signature === 'string' &&
        candidate.signature.trim().length > 0
    );
}

function readFileMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return -1;
    }
}

function readStoredKeyPairs(filePath: string): Record<string, StoredKeyPairRecord> {
    if (!fs.existsSync(filePath)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoredKeyPairsFile>;
        if (!parsed || typeof parsed !== 'object' || !parsed.keys || typeof parsed.keys !== 'object') {
            return {};
        }
        const out: Record<string, StoredKeyPairRecord> = {};
        for (const [k, v] of Object.entries(parsed.keys)) {
            if (
                v &&
                typeof v === 'object' &&
                typeof v.publicKey === 'string' &&
                v.publicKey.trim() &&
                typeof v.privateKey === 'string' &&
                v.privateKey.trim()
            ) {
                const validChain = Array.isArray(v.rotationChain)
                    ? v.rotationChain
                          .filter(isValidRotationProofShape)
                          .slice(-MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH)
                    : isValidRotationProofShape(v.rotationProof)
                      ? [v.rotationProof]
                      : undefined;
                const latestProof = isValidRotationProofShape(v.rotationProof)
                    ? v.rotationProof
                    : validChain && validChain.length > 0
                      ? validChain[validChain.length - 1]
                      : undefined;
                out[k] = {
                    publicKey: v.publicKey.trim(),
                    privateKey: v.privateKey.trim(),
                    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
                    ...(latestProof ? { rotationProof: latestProof } : {}),
                    ...(validChain && validChain.length > 0 ? { rotationChain: validChain } : {}),
                };
            }
        }
        return out;
    } catch {
        return {};
    }
}

function writeStoredKeyPairs(filePath: string, keys: Record<string, StoredKeyPairRecord>): void {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const payload: StoredKeyPairsFile = { version: 1, keys };
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, filePath);
        try {
            fs.chmodSync(filePath, 0o600);
        } catch {
            // Ignore chmod errors on unsupported filesystems.
        }
    } catch {
        // Ephemeral or read-only configDir falls back to in-memory cache.
    }
}

function buildCanonicalKeyRotationPayload(fields: {
    hostDaemonId: string;
    oldPublicKey: string;
    newPublicKey: string;
    rotatedAt: number;
    nonce: string;
}): string {
    return [
        'origin_grant_key_rotation',
        canonGrantDaemonId(fields.hostDaemonId),
        trimStr(fields.oldPublicKey),
        trimStr(fields.newPublicKey),
        String(fields.rotatedAt),
        trimStr(fields.nonce),
    ].join('\0');
}

export function getOrCreateHostKeyPair(hostDaemonId?: string, env?: NodeJS.ProcessEnv): CachedKeyPair {
    const configDir = getConfigDir(env);
    const keyId = canonGrantDaemonId(hostDaemonId ?? '') || 'default';
    const cacheKey = `${configDir}\0${keyId}`;
    const filePath = path.join(configDir, ORIGIN_GRANT_KEYS_FILENAME);
    const currentMtime = readFileMtimeMs(filePath);

    const cached = keyPairCache.get(cacheKey);
    if (cached && (currentMtime === -1 || cached.fileMtimeMs === currentMtime)) {
        return cached;
    }

    const storedAll = readStoredKeyPairs(filePath);
    const existing = storedAll[keyId];
    if (existing) {
        try {
            const privateKeyObj = crypto.createPrivateKey({
                key: Buffer.from(existing.privateKey, 'base64url'),
                format: 'der',
                type: 'pkcs8',
            });
            const entry: CachedKeyPair = {
                publicKey: existing.publicKey,
                privateKeyObj,
                fileMtimeMs: currentMtime,
                ...(existing.rotationProof ? { rotationProof: existing.rotationProof } : {}),
                ...(existing.rotationChain ? { rotationChain: existing.rotationChain } : {}),
            };
            keyPairCache.set(cacheKey, entry);
            return entry;
        } catch {
            // Regenerate if corrupt.
        }
    }

    const generated = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const publicKey = (generated.publicKey as Buffer).toString('base64url');
    const privateKey = (generated.privateKey as Buffer).toString('base64url');
    const privateKeyObj = crypto.createPrivateKey({
        key: generated.privateKey as Buffer,
        format: 'der',
        type: 'pkcs8',
    });
    storedAll[keyId] = {
        publicKey,
        privateKey,
        createdAt: new Date().toISOString(),
    };
    writeStoredKeyPairs(filePath, storedAll);
    const entry: CachedKeyPair = {
        publicKey,
        privateKeyObj,
        fileMtimeMs: readFileMtimeMs(filePath),
    };
    keyPairCache.set(cacheKey, entry);
    return entry;
}

export function getHostOriginGrantPublicKey(hostDaemonId?: string, env?: NodeJS.ProcessEnv): string {
    return getOrCreateHostKeyPair(hostDaemonId, env).publicKey;
}

export function getLatestHostKeyRotationProof(
    hostDaemonId?: string,
    env?: NodeJS.ProcessEnv,
): OriginGrantKeyRotationProof | undefined {
    return getOrCreateHostKeyPair(hostDaemonId, env).rotationProof;
}

export function getHostKeyRotationChain(
    hostDaemonId?: string,
    env?: NodeJS.ProcessEnv,
): OriginGrantKeyRotationProof[] {
    const entry = getOrCreateHostKeyPair(hostDaemonId, env);
    if (entry.rotationChain && entry.rotationChain.length > 0) {
        return [...entry.rotationChain];
    }
    return entry.rotationProof ? [entry.rotationProof] : [];
}

/**
 * Rotate the host's Ed25519 origin-grant signing keypair.
 * Immediately evicts the superseded key from the in-process keyPairCache,
 * persists the new keypair to disk (0600 atomic write), and signs a rotation
 * proof with the previous private key so peers holding the previous pinned
 * public key can verify the transition without trusting unauthenticated channels.
 */
export function rotateHostOriginGrantKeyPair(
    hostDaemonId?: string,
    opts?: { env?: NodeJS.ProcessEnv; nowMs?: number },
): {
    publicKey: string;
    previousPublicKey: string;
    rotationProof: OriginGrantKeyRotationProof;
    rotationChain: OriginGrantKeyRotationProof[];
} {
    const env = opts?.env;
    const configDir = getConfigDir(env);
    const keyId = canonGrantDaemonId(hostDaemonId ?? '') || 'default';
    const cacheKey = `${configDir}\0${keyId}`;
    const filePath = path.join(configDir, ORIGIN_GRANT_KEYS_FILENAME);

    const previous = getOrCreateHostKeyPair(hostDaemonId, env);
    // Evict superseded key from process cache immediately.
    keyPairCache.delete(cacheKey);

    const generated = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const newPublicKey = (generated.publicKey as Buffer).toString('base64url');
    const newPrivateKey = (generated.privateKey as Buffer).toString('base64url');
    const newPrivateKeyObj = crypto.createPrivateKey({
        key: generated.privateKey as Buffer,
        format: 'der',
        type: 'pkcs8',
    });

    const rotatedAt = typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonicalOldKey = canonicalizeOriginGrantPublicKey(previous.publicKey) ?? previous.publicKey;
    const canonicalRotation = buildCanonicalKeyRotationPayload({
        hostDaemonId: keyId,
        oldPublicKey: canonicalOldKey,
        newPublicKey,
        rotatedAt,
        nonce,
    });
    const signature = crypto
        .sign(null, Buffer.from(canonicalRotation, 'utf8'), previous.privateKeyObj)
        .toString('base64url');

    const rotationProof: OriginGrantKeyRotationProof = {
        hostDaemonId: keyId,
        oldPublicKey: canonicalOldKey,
        newPublicKey,
        rotatedAt,
        nonce,
        signature,
    };

    const priorChain =
        previous.rotationChain && previous.rotationChain.length > 0
            ? previous.rotationChain
            : previous.rotationProof
              ? [previous.rotationProof]
              : [];
    const rotationChain = [...priorChain, rotationProof].slice(-MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH);

    const storedAll = readStoredKeyPairs(filePath);
    storedAll[keyId] = {
        publicKey: newPublicKey,
        privateKey: newPrivateKey,
        createdAt: new Date(rotatedAt).toISOString(),
        rotationProof,
        rotationChain,
    };
    writeStoredKeyPairs(filePath, storedAll);

    const nextEntry: CachedKeyPair = {
        publicKey: newPublicKey,
        privateKeyObj: newPrivateKeyObj,
        fileMtimeMs: readFileMtimeMs(filePath),
        rotationProof,
        rotationChain,
    };
    keyPairCache.set(cacheKey, nextEntry);

    return {
        publicKey: newPublicKey,
        previousPublicKey: previous.publicKey,
        rotationProof,
        rotationChain,
    };
}

export function verifyOriginGrantKeyRotationProof(
    rawProof: unknown,
    expected: {
        hostDaemonId: string;
        currentPinnedPublicKey: string;
    },
): { ok: true; newPublicKey: string; proof: OriginGrantKeyRotationProof } | { ok: false; reason: string } {
    if (!isValidRotationProofShape(rawProof)) {
        return { ok: false, reason: 'invalid_rotation_proof_shape' };
    }
    const expectedHost = trimStr(expected.hostDaemonId);
    const currentKey = trimStr(expected.currentPinnedPublicKey);
    if (!expectedHost || !currentKey) {
        return { ok: false, reason: 'missing_expected_host_or_pinned_key' };
    }
    if (!daemonIdsEquivalent(rawProof.hostDaemonId, expectedHost)) {
        return { ok: false, reason: 'rotation_host_mismatch' };
    }
    const oldPubKeyObj = parseOriginGrantPublicKeyObject(currentKey);
    if (!oldPubKeyObj) {
        return { ok: false, reason: 'rotation_pinned_key_invalid' };
    }
    if (!originGrantPublicKeysEqual(rawProof.oldPublicKey, currentKey)) {
        return { ok: false, reason: 'rotation_old_key_mismatch' };
    }
    const newPublicKey = trimStr(rawProof.newPublicKey);
    if (
        !newPublicKey ||
        !isValidOriginGrantPublicKey(newPublicKey) ||
        originGrantPublicKeysEqual(newPublicKey, currentKey)
    ) {
        return { ok: false, reason: 'rotation_new_key_invalid' };
    }
    try {
        const normalizedSig = rawProof.signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const sigBuf = Buffer.from(normalizedSig, 'base64url');
        if (sigBuf.byteLength !== 64) {
            return { ok: false, reason: 'rotation_signature_invalid' };
        }
        const canonicalOld = canonicalizeOriginGrantPublicKey(rawProof.oldPublicKey) ?? trimStr(rawProof.oldPublicKey);
        const canonicalNew = canonicalizeOriginGrantPublicKey(newPublicKey) ?? newPublicKey;
        const candidatePayloads = [
            buildCanonicalKeyRotationPayload({
                hostDaemonId: rawProof.hostDaemonId,
                oldPublicKey: canonicalOld,
                newPublicKey: canonicalNew,
                rotatedAt: rawProof.rotatedAt,
                nonce: rawProof.nonce,
            }),
            buildCanonicalKeyRotationPayload({
                hostDaemonId: rawProof.hostDaemonId,
                oldPublicKey: trimStr(rawProof.oldPublicKey),
                newPublicKey,
                rotatedAt: rawProof.rotatedAt,
                nonce: rawProof.nonce,
            }),
        ];
        const verified = candidatePayloads.some((payload) =>
            crypto.verify(null, Buffer.from(payload, 'utf8'), oldPubKeyObj, sigBuf),
        );
        if (!verified) {
            return { ok: false, reason: 'rotation_signature_invalid' };
        }
        return { ok: true, newPublicKey: canonicalNew, proof: rawProof };
    } catch {
        return { ok: false, reason: 'rotation_signature_invalid' };
    }
}

export function verifyOriginGrantKeyRotationChain(
    input: {
        rotationProof?: unknown;
        rotationChain?: unknown;
    },
    expected: {
        hostDaemonId: string;
        currentPinnedPublicKey: string;
        targetPublicKey?: string;
    },
):
    | { ok: true; newPublicKey: string; proof: OriginGrantKeyRotationProof; chain: OriginGrantKeyRotationProof[] }
    | { ok: false; reason: string; code?: string; error?: string } {
    const rawList: unknown[] = [];
    if (Array.isArray(input.rotationChain) && input.rotationChain.length > 0) {
        if (input.rotationChain.length > MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH) {
            return {
                ok: false,
                reason: 'rotation_chain_too_long',
                code: 're_pair_required',
                error: `Origin-grant rotation chain length (${input.rotationChain.length}) exceeds maximum (${MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH}); re-pair required (re_pair_required)`,
            };
        }
        rawList.push(...input.rotationChain);
    } else if (input.rotationProof !== undefined) {
        rawList.push(input.rotationProof);
    } else {
        return { ok: false, reason: 'invalid_rotation_proof_shape' };
    }

    const proofs: OriginGrantKeyRotationProof[] = [];
    for (const item of rawList) {
        if (!isValidRotationProofShape(item)) {
            return { ok: false, reason: 'invalid_rotation_proof_shape' };
        }
        proofs.push(item);
    }

    const startIdx = proofs.findIndex((p) =>
        originGrantPublicKeysEqual(p.oldPublicKey, expected.currentPinnedPublicKey),
    );
    if (startIdx === -1) {
        if (proofs.length >= MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH) {
            let chainInternallyValid = true;
            for (let i = 0; i < proofs.length; i++) {
                const p = proofs[i]!;
                const stepKey = i === 0 ? p.oldPublicKey : proofs[i - 1]!.newPublicKey;
                const step = verifyOriginGrantKeyRotationProof(p, {
                    hostDaemonId: expected.hostDaemonId,
                    currentPinnedPublicKey: stepKey,
                });
                if (!step.ok) {
                    chainInternallyValid = false;
                    break;
                }
            }
            if (chainInternallyValid) {
                const peerLabel = canonGrantDaemonId(expected.hostDaemonId) || trimStr(expected.hostDaemonId);
                return {
                    ok: false,
                    reason: 're_pair_required',
                    code: 're_pair_required',
                    error: `Peer ${peerLabel} missed more than ${MAX_ORIGIN_GRANT_ROTATION_CHAIN_LENGTH} origin-grant key rotations; re-pair required (re_pair_required)`,
                };
            }
        }
        return { ok: false, reason: 'rotation_old_key_mismatch' };
    }

    let workingKey = expected.currentPinnedPublicKey;
    const verifiedSteps: OriginGrantKeyRotationProof[] = [];
    for (let i = startIdx; i < proofs.length; i++) {
        const step = verifyOriginGrantKeyRotationProof(proofs[i], {
            hostDaemonId: expected.hostDaemonId,
            currentPinnedPublicKey: workingKey,
        });
        if (!step.ok) return step;
        workingKey = step.newPublicKey;
        verifiedSteps.push(step.proof);
    }

    if (
        expected.targetPublicKey !== undefined &&
        !originGrantPublicKeysEqual(workingKey, expected.targetPublicKey)
    ) {
        return { ok: false, reason: 'rotation_new_key_mismatch' };
    }

    return {
        ok: true,
        newPublicKey: workingKey,
        proof: verifiedSteps[verifiedSteps.length - 1]!,
        chain: verifiedSteps,
    };
}

export function __resetOriginGrantKeyPairCacheForTest(): void {
    keyPairCache.clear();
}
