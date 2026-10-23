import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalDaemonId, daemonIdsEquivalent, meshNodeIdMatches, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { ArtifactRecord } from '../../artifacts/index.js';
import { getConfigDir } from '../../config/config.js';
import { readAuthenticatedPeerOriginGrantPublicKey } from '../../mesh/mesh-host-memory.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import type { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { getPeerSecret } from '../../mesh/transport/mesh-peer-secrets.js';
import {
    findWorkerTaskTokenForSession,
    verifyWorkerSessionBind,
    type WorkerTokenExchangeResult,
} from '../../mesh/worker-mcp-isolation.js';
import { resolveForwardedWorkerIdentity } from '../../mesh/worker-report-forwarded.js';
import type { CommandRouterResult } from '../router.js';

export const ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS = 60_000;
export const MAX_ORIGIN_GRANT_CLOCK_SKEW_MS = 30_000;
const MAX_TRACKED_NONCES = 4_096;
const ORIGIN_GRANT_KEYS_FILENAME = 'artifact-origin-grant-keys.json';

interface StoredKeyPairRecord {
    publicKey: string;
    privateKey: string;
    createdAt: string;
}

interface StoredKeyPairsFile {
    version: number;
    keys: Record<string, StoredKeyPairRecord>;
}

interface CachedKeyPair {
    publicKey: string;
    privateKeyObj: crypto.KeyObject;
}

const keyPairCache = new Map<string, CachedKeyPair>();

interface ConsumedGrantNonceEntry {
    canonicalPayload: string;
    expiresAt: number;
}

const consumedOriginGrantNonces = new Map<string, ConsumedGrantNonceEntry>();

export interface ArtifactOriginFetchGrant {
    meshId: string;
    hostDaemonId: string;
    originDaemonId: string;
    artifactId: string;
    requesterSessionId: string;
    requesterTaskId: string;
    requesterAttemptId: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
    signature: string;
}

function trimStr(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function canonGrantDaemonId(daemonId: string): string {
    const trimmed = trimStr(daemonId);
    if (!trimmed) return '';
    return canonicalDaemonId(trimmed) ?? trimmed;
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
                out[k] = {
                    publicKey: v.publicKey.trim(),
                    privateKey: v.privateKey.trim(),
                    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
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
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
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

function getOrCreateHostKeyPair(hostDaemonId?: string, env?: NodeJS.ProcessEnv): CachedKeyPair {
    const configDir = getConfigDir(env);
    const keyId = canonGrantDaemonId(hostDaemonId ?? '') || 'default';
    const cacheKey = `${configDir}\0${keyId}`;
    const cached = keyPairCache.get(cacheKey);
    if (cached) return cached;

    const filePath = path.join(configDir, ORIGIN_GRANT_KEYS_FILENAME);
    const storedAll = readStoredKeyPairs(filePath);
    const existing = storedAll[keyId];
    if (existing) {
        try {
            const privateKeyObj = crypto.createPrivateKey({
                key: Buffer.from(existing.privateKey, 'base64url'),
                format: 'der',
                type: 'pkcs8',
            });
            const entry: CachedKeyPair = { publicKey: existing.publicKey, privateKeyObj };
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
    const entry: CachedKeyPair = { publicKey, privateKeyObj };
    keyPairCache.set(cacheKey, entry);
    return entry;
}

export function getHostOriginGrantPublicKey(hostDaemonId?: string, env?: NodeJS.ProcessEnv): string {
    return getOrCreateHostKeyPair(hostDaemonId, env).publicKey;
}

function parsePublicKeyObject(rawPublicKey: string): crypto.KeyObject | null {
    const trimmed = trimStr(rawPublicKey);
    if (!trimmed) return null;
    try {
        if (trimmed.startsWith('-----BEGIN')) {
            return crypto.createPublicKey(trimmed);
        }
        const der = Buffer.from(trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
        return crypto.createPublicKey({
            key: der,
            format: 'der',
            type: 'spki',
        });
    } catch {
        return null;
    }
}

function buildCanonicalGrantPayload(fields: {
    meshId: string;
    hostDaemonId: string;
    originDaemonId: string;
    artifactId: string;
    requesterSessionId: string;
    requesterTaskId: string;
    requesterAttemptId: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
}): string {
    return [
        fields.meshId,
        canonGrantDaemonId(fields.hostDaemonId),
        canonGrantDaemonId(fields.originDaemonId),
        fields.artifactId,
        fields.requesterSessionId,
        fields.requesterTaskId,
        fields.requesterAttemptId,
        String(fields.issuedAt),
        String(fields.expiresAt),
        fields.nonce,
    ].join('\0');
}

function signCanonicalGrantPayload(canonicalPayload: string, hostDaemonId: string): string {
    const { privateKeyObj } = getOrCreateHostKeyPair(hostDaemonId);
    return crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKeyObj).toString('base64url');
}

function verifyCanonicalGrantSignature(
    canonicalPayload: string,
    signature: string,
    hostPublicKey: string,
): boolean {
    const pubKeyObj = parsePublicKeyObject(hostPublicKey);
    if (!pubKeyObj) return false;
    try {
        const normalizedSig = signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const sigBuf = Buffer.from(normalizedSig, 'base64url');
        if (sigBuf.byteLength !== 64) return false;
        return crypto.verify(null, Buffer.from(canonicalPayload, 'utf8'), pubKeyObj, sigBuf);
    } catch {
        return false;
    }
}

function pruneExpiredConsumedNonces(nowMs: number): void {
    for (const [nonce, entry] of consumedOriginGrantNonces) {
        if (entry.expiresAt <= nowMs) {
            consumedOriginGrantNonces.delete(nonce);
        }
    }
    while (consumedOriginGrantNonces.size >= MAX_TRACKED_NONCES) {
        const oldestKey = consumedOriginGrantNonces.keys().next().value;
        if (oldestKey === undefined) break;
        consumedOriginGrantNonces.delete(oldestKey);
    }
}

export interface GrantNonceStoreDb {
    prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): unknown;
    };
    exec?(sql: string): unknown;
}

function consumeOriginGrantNonce(
    nonce: string,
    meshId: string,
    canonicalPayload: string,
    expiresAt: number,
    nowMs: number,
    db?: GrantNonceStoreDb | null,
): boolean {
    pruneExpiredConsumedNonces(nowMs);
    const inMem = consumedOriginGrantNonces.get(nonce);
    if (inMem && inMem.expiresAt > nowMs) {
        return false;
    }

    if (db) {
        try {
            if (typeof db.exec === 'function') {
                db.exec(
                    `CREATE TABLE IF NOT EXISTS consumed_artifact_origin_grant_nonces (
                        nonce TEXT PRIMARY KEY,
                        mesh_id TEXT NOT NULL,
                        canonical_payload TEXT NOT NULL,
                        expires_at INTEGER NOT NULL
                    )`,
                );
            } else {
                db.prepare(
                    `CREATE TABLE IF NOT EXISTS consumed_artifact_origin_grant_nonces (
                        nonce TEXT PRIMARY KEY,
                        mesh_id TEXT NOT NULL,
                        canonical_payload TEXT NOT NULL,
                        expires_at INTEGER NOT NULL
                    )`,
                ).run();
            }
            db.prepare('DELETE FROM consumed_artifact_origin_grant_nonces WHERE expires_at <= ?').run(nowMs);
            const existing = db
                .prepare('SELECT nonce, expires_at FROM consumed_artifact_origin_grant_nonces WHERE nonce = ?')
                .get(nonce) as { nonce?: string; expires_at?: number } | undefined;
            if (existing && typeof existing.expires_at === 'number' && existing.expires_at > nowMs) {
                consumedOriginGrantNonces.set(nonce, { canonicalPayload, expiresAt: existing.expires_at });
                return false;
            }
            db.prepare(
                `INSERT OR REPLACE INTO consumed_artifact_origin_grant_nonces (nonce, mesh_id, canonical_payload, expires_at)
                 VALUES (?, ?, ?, ?)`,
            ).run(nonce, meshId, canonicalPayload, expiresAt);
        } catch {
            return false;
        }
    }

    consumedOriginGrantNonces.set(nonce, { canonicalPayload, expiresAt });
    return true;
}

export function __resetOriginGrantStateForTest(): void {
    consumedOriginGrantNonces.clear();
    keyPairCache.clear();
}

export function mintArtifactOriginFetchGrant(args: {
    meshId: string;
    hostDaemonId: string;
    originDaemonId: string;
    artifactId: string;
    requesterSessionId: string;
    requesterTaskId: string;
    requesterAttemptId: string;
    nowMs?: number;
    ttlMs?: number;
}): ArtifactOriginFetchGrant {
    const issuedAt = typeof args.nowMs === 'number' && Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const ttlMs = typeof args.ttlMs === 'number' && args.ttlMs > 0 ? args.ttlMs : ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS;
    const expiresAt = issuedAt + ttlMs;
    const nonce = crypto.randomBytes(16).toString('hex');
    const hostDaemonId = canonGrantDaemonId(args.hostDaemonId);
    const originDaemonId = canonGrantDaemonId(args.originDaemonId);
    const base = {
        meshId: args.meshId.trim(),
        hostDaemonId,
        originDaemonId,
        artifactId: args.artifactId.trim(),
        requesterSessionId: args.requesterSessionId.trim(),
        requesterTaskId: args.requesterTaskId.trim(),
        requesterAttemptId: args.requesterAttemptId.trim(),
        issuedAt,
        expiresAt,
        nonce,
    };
    const canonicalPayload = buildCanonicalGrantPayload(base);
    const signature = signCanonicalGrantPayload(canonicalPayload, hostDaemonId);
    return {
        ...base,
        signature,
    };
}

export function resolveTrustedHostOriginGrantPublicKey(params: {
    meshObj?: any;
    meshId: string;
    hostDaemonId: string;
    selfDaemonId?: string;
    isSelfHost?: boolean;
}): string {
    const meshId = trimStr(params.meshId);
    const hostDaemonId = trimStr(params.hostDaemonId);
    if (!meshId || !hostDaemonId) return '';

    const fromMeshHost = trimStr(params.meshObj?.meshHost?.originGrantPublicKey);
    if (fromMeshHost) return fromMeshHost;

    const nodes: any[] = Array.isArray(params.meshObj?.nodes) ? params.meshObj.nodes : [];
    for (const node of nodes) {
        const nd = readMeshNodeDaemonId(node) || trimStr(node?.daemonId);
        if (nd && daemonIdsEquivalent(nd, hostDaemonId)) {
            const nodeKey = trimStr(node?.originGrantPublicKey);
            if (nodeKey) return nodeKey;
        }
    }

    const fromHostMemory = readAuthenticatedPeerOriginGrantPublicKey(meshId, hostDaemonId);
    if (fromHostMemory) return fromHostMemory;

    const fromPeerSecret = getPeerSecret(meshId, hostDaemonId)?.originGrantPublicKey;
    if (trimStr(fromPeerSecret)) return trimStr(fromPeerSecret);

    if (params.isSelfHost && params.selfDaemonId && daemonIdsEquivalent(hostDaemonId, params.selfDaemonId)) {
        return getHostOriginGrantPublicKey(hostDaemonId);
    }

    return '';
}

export function verifyArtifactOriginFetchGrant(
    rawGrant: unknown,
    expected: {
        meshId: string;
        hostDaemonId: string;
        originDaemonId: string;
        artifactId: string;
        requesterSessionId: string;
        requesterTaskId?: string;
        requesterAttemptId?: string;
        hostPublicKey?: string;
        consumeNonce?: boolean;
        nonceStoreDb?: GrantNonceStoreDb | null;
    },
    nowMs = Date.now(),
): { ok: true; grant: ArtifactOriginFetchGrant } | { ok: false; reason: string } {
    if (!rawGrant || typeof rawGrant !== 'object') {
        return { ok: false, reason: 'missing_or_malformed_grant' };
    }
    const candidate = rawGrant as Record<string, unknown>;
    const meshId = trimStr(candidate.meshId);
    const rawHostDaemonId = trimStr(candidate.hostDaemonId);
    const rawOriginDaemonId = trimStr(candidate.originDaemonId);
    const artifactId = trimStr(candidate.artifactId);
    const requesterSessionId = trimStr(candidate.requesterSessionId);
    const requesterTaskId = trimStr(candidate.requesterTaskId);
    const requesterAttemptId = trimStr(candidate.requesterAttemptId);
    const nonce = trimStr(candidate.nonce);
    const signature = trimStr(candidate.signature);
    const issuedAt = typeof candidate.issuedAt === 'number' && Number.isFinite(candidate.issuedAt) ? candidate.issuedAt : NaN;
    const expiresAt = typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : NaN;

    if (
        !meshId ||
        !rawHostDaemonId ||
        !rawOriginDaemonId ||
        !artifactId ||
        !requesterSessionId ||
        !requesterTaskId ||
        !requesterAttemptId ||
        !nonce ||
        !signature ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt)
    ) {
        return { ok: false, reason: 'incomplete_grant_fields' };
    }

    if (expiresAt <= issuedAt || nowMs > expiresAt || issuedAt > nowMs + MAX_ORIGIN_GRANT_CLOCK_SKEW_MS) {
        return { ok: false, reason: 'expired_or_invalid_grant_window' };
    }

    const hostDaemonId = canonGrantDaemonId(rawHostDaemonId);
    const originDaemonId = canonGrantDaemonId(rawOriginDaemonId);
    const expectedHostDaemonId = canonGrantDaemonId(expected.hostDaemonId);
    const expectedOriginDaemonId = canonGrantDaemonId(expected.originDaemonId);

    if (
        meshId !== expected.meshId.trim() ||
        !expectedHostDaemonId ||
        !expectedOriginDaemonId ||
        !daemonIdsEquivalent(hostDaemonId, expectedHostDaemonId) ||
        hostDaemonId !== expectedHostDaemonId ||
        !daemonIdsEquivalent(originDaemonId, expectedOriginDaemonId) ||
        originDaemonId !== expectedOriginDaemonId ||
        artifactId !== expected.artifactId.trim() ||
        !sessionIdsEquivalent(requesterSessionId, expected.requesterSessionId.trim())
    ) {
        return { ok: false, reason: 'grant_scope_mismatch' };
    }

    if (expected.requesterTaskId !== undefined) {
        const expTask = expected.requesterTaskId.trim();
        if (!expTask || requesterTaskId !== expTask) {
            return { ok: false, reason: 'grant_task_or_attempt_mismatch' };
        }
    }
    if (expected.requesterAttemptId !== undefined) {
        const expAttempt = expected.requesterAttemptId.trim();
        if (!expAttempt || requesterAttemptId !== expAttempt) {
            return { ok: false, reason: 'grant_task_or_attempt_mismatch' };
        }
    }

    const trustedPublicKey =
        trimStr(expected.hostPublicKey) ||
        resolveTrustedHostOriginGrantPublicKey({
            meshId,
            hostDaemonId,
        });
    if (!trustedPublicKey) {
        return { ok: false, reason: 'untrusted_or_missing_host_public_key' };
    }

    const canonicalPayload = buildCanonicalGrantPayload({
        meshId,
        hostDaemonId,
        originDaemonId,
        artifactId,
        requesterSessionId,
        requesterTaskId,
        requesterAttemptId,
        issuedAt,
        expiresAt,
        nonce,
    });
    if (!verifyCanonicalGrantSignature(canonicalPayload, signature, trustedPublicKey)) {
        return { ok: false, reason: 'invalid_grant_signature' };
    }

    if (expected.consumeNonce !== false) {
        const consumed = consumeOriginGrantNonce(
            nonce,
            meshId,
            canonicalPayload,
            expiresAt,
            nowMs,
            expected.nonceStoreDb,
        );
        if (!consumed) {
            return { ok: false, reason: 'replayed_grant_nonce' };
        }
    }

    return {
        ok: true,
        grant: {
            meshId,
            hostDaemonId,
            originDaemonId,
            artifactId,
            requesterSessionId,
            requesterTaskId,
            requesterAttemptId,
            issuedAt,
            expiresAt,
            nonce,
            signature,
        },
    };
}

/**
 * Verify that a worker's attempt is currently non-terminal AND is the latest
 * attempt for its task in the authoritative host turn-attempt ledger.
 */
export function verifyActiveHostWorkerLedgerAttempt(
    meshStore: MeshRuntimeStore,
    args: {
        meshId: string;
        taskId: string;
        sessionId: string;
        attemptId?: string | null;
    },
): { ok: true; attemptId: string } | { ok: false; code: 'stale_attempt' | 'artifact_access_denied'; error: string } {
    const latestAttempt = meshStore.turnStore().findLatestAttemptForTask(args.meshId, args.taskId) ?? null;
    if (!latestAttempt) {
        return {
            ok: false,
            code: 'artifact_access_denied',
            error: `Artifact access refused: no active ledger attempt exists for task '${args.taskId}'`,
        };
    }
    if (latestAttempt.terminal) {
        return {
            ok: false,
            code: 'stale_attempt',
            error: `Artifact access refused: attempt '${latestAttempt.attemptId}' for task '${args.taskId}' is already terminal (${latestAttempt.state})`,
        };
    }
    if (latestAttempt.sessionId !== args.sessionId) {
        return {
            ok: false,
            code: 'artifact_access_denied',
            error: `Artifact access refused: latest attempt for task '${args.taskId}' belongs to a different worker session`,
        };
    }
    const requestedAttemptId = typeof args.attemptId === 'string' && args.attemptId.trim().length > 0
        ? args.attemptId.trim()
        : null;
    if (requestedAttemptId && latestAttempt.attemptId !== requestedAttemptId) {
        return {
            ok: false,
            code: 'stale_attempt',
            error: `Artifact access refused: attempt '${requestedAttemptId}' has been superseded by '${latestAttempt.attemptId}'`,
        };
    }
    if (requestedAttemptId) {
        const specificAttempt = meshStore.turnStore().getAttempt(requestedAttemptId) ?? null;
        if (
            !specificAttempt ||
            specificAttempt.terminal ||
            specificAttempt.attemptId !== latestAttempt.attemptId ||
            specificAttempt.sessionId !== args.sessionId ||
            specificAttempt.meshId !== args.meshId ||
            specificAttempt.taskId !== args.taskId
        ) {
            return {
                ok: false,
                code: 'stale_attempt',
                error: `Artifact access refused: attempt '${requestedAttemptId}' is not active`,
            };
        }
    }
    return { ok: true, attemptId: latestAttempt.attemptId };
}

export function verifyLocalWorkerQueueAndLedgerFence(params: {
    meshStore: MeshRuntimeStore;
    identity: WorkerTokenExchangeResult;
    workerSessionId: string;
    explicitTaskId: string;
    explicitAttemptId: string;
    rawBind: unknown;
}): { ok: true; attemptId: string } | { ok: false; result: CommandRouterResult } {
    const { meshStore, identity, workerSessionId, explicitTaskId, explicitAttemptId, rawBind } = params;
    if (explicitTaskId && explicitTaskId !== identity.taskId) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'task_mismatch',
                error: `Worker credential belongs to task "${identity.taskId}", not "${explicitTaskId}" (task_mismatch)`,
            },
        };
    }
    if (explicitAttemptId && identity.attemptId && explicitAttemptId !== identity.attemptId) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'stale_attempt',
                error: `Worker credential attempt "${identity.attemptId}" does not match requested attempt "${explicitAttemptId}" (stale_attempt)`,
            },
        };
    }

    let queueAssignedAttemptId = '';
    let queueTaskAttemptId = '';
    try {
        const assigned = meshStore.findAssignedBySession(identity.meshId, workerSessionId) as Record<
            string,
            unknown
        > | null;
        if (assigned) {
            const assignedId = trimStr(assigned.id);
            if (assignedId && assignedId !== identity.taskId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'task_mismatch',
                        error: `Worker session "${workerSessionId}" is assigned to task "${assignedId}", not "${identity.taskId}" (task_mismatch)`,
                    },
                };
            }
            const assignedStatus = trimStr(assigned.status);
            if (assignedStatus && assignedStatus !== 'assigned') {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Task "${identity.taskId}" is no longer actively assigned (stale_attempt)`,
                    },
                };
            }
            queueAssignedAttemptId =
                trimStr(assigned.attemptId) ||
                trimStr((assigned.payload as Record<string, unknown> | undefined)?.attemptId);
            if (queueAssignedAttemptId && identity.attemptId && queueAssignedAttemptId !== identity.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker credential attempt "${identity.attemptId}" does not match assigned attempt "${queueAssignedAttemptId}" (stale_attempt)`,
                    },
                };
            }
            if (queueAssignedAttemptId && explicitAttemptId && queueAssignedAttemptId !== explicitAttemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Requested attempt "${explicitAttemptId}" does not match assigned attempt "${queueAssignedAttemptId}" (stale_attempt)`,
                    },
                };
            }
        }

        const taskEntry = meshStore.findQueueEntryById(identity.meshId, identity.taskId) as Record<
            string,
            unknown
        > | null;
        if (!taskEntry) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: `Worker task "${identity.taskId}" has no active queue assignment (unauthenticated)`,
                },
            };
        }

        const taskStatus = trimStr(taskEntry.status);
        if (taskStatus !== 'assigned') {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Task "${identity.taskId}" is not in assigned state (status="${taskStatus || 'unknown'}") (stale_attempt)`,
                },
            };
        }
        const taskAssignedSession = trimStr(taskEntry.assignedSessionId);
        if (!taskAssignedSession || !sessionIdsEquivalent(taskAssignedSession, workerSessionId)) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Task "${identity.taskId}" is assigned to session "${taskAssignedSession}", not "${workerSessionId}" (artifact_session_mismatch)`,
                },
            };
        }
        queueTaskAttemptId =
            trimStr(taskEntry.attemptId) ||
            trimStr((taskEntry.payload as Record<string, unknown> | undefined)?.attemptId);
        if (queueTaskAttemptId && identity.attemptId && queueTaskAttemptId !== identity.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Worker credential attempt "${identity.attemptId}" is stale for task "${identity.taskId}" (current attempt "${queueTaskAttemptId}") (stale_attempt)`,
                },
            };
        }
        if (queueTaskAttemptId && explicitAttemptId && queueTaskAttemptId !== explicitAttemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Requested attempt "${explicitAttemptId}" is stale for task "${identity.taskId}" (current attempt "${queueTaskAttemptId}") (stale_attempt)`,
                },
            };
        }
        if (
            queueAssignedAttemptId &&
            queueTaskAttemptId &&
            queueAssignedAttemptId !== queueTaskAttemptId
        ) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Queue attempt mismatch between assigned row ("${queueAssignedAttemptId}") and task row ("${queueTaskAttemptId}") (stale_attempt)`,
                },
            };
        }
        if (!assigned || trimStr(assigned.id) !== identity.taskId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: `Worker session "${workerSessionId}" has no active queue assignment for task "${identity.taskId}" (unauthenticated)`,
                },
            };
        }
    } catch {
        return {
            ok: false,
            result: {
                success: false,
                code: 'unauthenticated',
                error: 'Authoritative queue assignment store is unavailable (unauthenticated)',
            },
        };
    }

    try {
        const turns = meshStore.turnStore?.();
        if (!turns) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: 'Authoritative turn attempt ledger is unavailable (unauthenticated)',
                },
            };
        }

        const latestAttempt = turns.findLatestAttemptForTask?.(identity.meshId, identity.taskId) ?? null;
        if (latestAttempt) {
            if (latestAttempt.terminal) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Latest attempt "${latestAttempt.attemptId}" for task "${identity.taskId}" is already terminal (stale_attempt)`,
                    },
                };
            }
            if (
                !latestAttempt.sessionId ||
                !sessionIdsEquivalent(latestAttempt.sessionId, workerSessionId)
            ) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'artifact_session_mismatch',
                        error: `Latest attempt "${latestAttempt.attemptId}" belongs to session "${latestAttempt.sessionId ?? ''}", not "${workerSessionId}" (artifact_session_mismatch)`,
                    },
                };
            }
        }

        const targetAttemptId = identity.attemptId || explicitAttemptId;
        const credAttempt = targetAttemptId
            ? (turns.getAttempt?.(targetAttemptId) ?? null)
            : latestAttempt;

        if (
            !credAttempt ||
            credAttempt.meshId !== identity.meshId ||
            credAttempt.taskId !== identity.taskId
        ) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: `Worker credential has no active turn attempt in ledger for task "${identity.taskId}" (unauthenticated)`,
                },
            };
        }

        if (credAttempt.terminal) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Worker credential attempt "${credAttempt.attemptId}" is terminal (stale_attempt)`,
                },
            };
        }

        if (!credAttempt.sessionId || !sessionIdsEquivalent(credAttempt.sessionId, workerSessionId)) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Worker credential attempt "${credAttempt.attemptId}" belongs to session "${credAttempt.sessionId ?? ''}", not "${workerSessionId}" (artifact_session_mismatch)`,
                },
            };
        }

        if (!latestAttempt || latestAttempt.attemptId !== credAttempt.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Worker credential attempt "${credAttempt.attemptId}" was superseded by attempt "${latestAttempt?.attemptId ?? 'none'}" (stale_attempt)`,
                },
            };
        }

        if (explicitAttemptId && explicitAttemptId !== latestAttempt.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Requested attempt "${explicitAttemptId}" does not match current ledger attempt "${latestAttempt.attemptId}" (stale_attempt)`,
                },
            };
        }

        if (queueAssignedAttemptId && queueAssignedAttemptId !== latestAttempt.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Assigned queue attempt "${queueAssignedAttemptId}" does not match current ledger attempt "${latestAttempt.attemptId}" (stale_attempt)`,
                },
            };
        }

        if (queueTaskAttemptId && queueTaskAttemptId !== latestAttempt.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Task queue attempt "${queueTaskAttemptId}" does not match current ledger attempt "${latestAttempt.attemptId}" (stale_attempt)`,
                },
            };
        }

        if (latestAttempt.attemptNo > 0 && !identity.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Retry attempt "${latestAttempt.attemptId}" requires an attempt-scoped worker credential (stale_attempt)`,
                },
            };
        }

        if (typeof rawBind === 'string' && rawBind.trim().length > 0 && latestAttempt.attemptNo > 0) {
            const liveTok = findWorkerTaskTokenForSession(
                identity.meshId,
                identity.taskId,
                workerSessionId,
            );
            if (liveTok && liveTok.attemptId !== latestAttempt.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker bind resolves to superseded attempt "${liveTok.attemptId ?? 'unscoped'}" instead of "${latestAttempt.attemptId}" (stale_attempt)`,
                    },
                };
            }
            if (!liveTok) {
                const binding = verifyWorkerSessionBind(rawBind);
                const acceptedAtMs =
                    typeof latestAttempt.acceptedAt === 'number' ? latestAttempt.acceptedAt : NaN;
                if (binding && Number.isFinite(acceptedAtMs) && binding.mintedAtMs < acceptedAtMs) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Worker bind was minted before retry attempt "${latestAttempt.attemptId}" without a fresh attempt token (stale_attempt)`,
                        },
                    };
                }
            }
        }
        return { ok: true, attemptId: latestAttempt.attemptId };
    } catch {
        return {
            ok: false,
            result: {
                success: false,
                code: 'unauthenticated',
                error: 'Failed to verify worker credential against turn attempt ledger (unauthenticated)',
            },
        };
    }
}

export function authorizeWorkerOriginFetch(params: {
    args: any;
    record: ArtifactRecord;
    meshIdToVerify: string;
    hostDaemonId: string;
    selfDaemonId: string;
    senderDaemonId: string;
    isSelfHost: boolean;
    nodes: any[];
    meshObj?: any;
    getMeshStore: () => MeshRuntimeStore;
}): CommandRouterResult | null {
    const {
        args,
        record,
        meshIdToVerify,
        hostDaemonId,
        selfDaemonId,
        senderDaemonId,
        isSelfHost,
        nodes,
        meshObj,
        getMeshStore,
    } = params;
    const requesterSessionId = trimStr(args?.requesterSessionId);
    if (!requesterSessionId) {
        return {
            success: false,
            code: 'artifact_access_denied',
            error: 'artifact_fetch_origin requires an authorized requesting worker session (artifact_access_denied)',
        };
    }
    const hasGrantArg = args?.originFetchGrant !== undefined && args?.originFetchGrant !== null;
    if (hasGrantArg) {
        let nonceStoreDb: GrantNonceStoreDb | null = null;
        try {
            nonceStoreDb = getMeshStore()?.db ?? null;
        } catch {
            nonceStoreDb = null;
        }
        const trustedHostPublicKey = resolveTrustedHostOriginGrantPublicKey({
            meshObj,
            meshId: meshIdToVerify,
            hostDaemonId,
            selfDaemonId,
            isSelfHost,
        });
        const grantCheck = verifyArtifactOriginFetchGrant(args.originFetchGrant, {
            meshId: meshIdToVerify,
            hostDaemonId,
            originDaemonId: selfDaemonId || trimStr(record.originDaemonId) || '',
            artifactId: record.artifactId,
            requesterSessionId,
            requesterTaskId: trimStr(args?.requesterTaskId),
            requesterAttemptId: trimStr(args?.requesterAttemptId),
            hostPublicKey: trustedHostPublicKey,
            consumeNonce: true,
            nonceStoreDb,
        });
        if (!grantCheck.ok) {
            return {
                success: false,
                code: 'artifact_access_denied',
                error: `Host originFetchGrant verification failed (${grantCheck.reason}) (artifact_access_denied)`,
            };
        }
    }
    if (!isSelfHost) {
        if (!hasGrantArg) {
            return {
                success: false,
                code: 'artifact_access_denied',
                error: `Cross-origin worker fetch of artifact "${record.artifactId}" requires a verified host originFetchGrant (artifact_access_denied)`,
            };
        }
        return null;
    }

    const requesterTaskId = trimStr(args?.requesterTaskId) || undefined;
    const requesterAttemptId = trimStr(args?.requesterAttemptId) || undefined;
    const requesterGeneration =
        typeof args?.requesterGeneration === 'number' && Number.isSafeInteger(args.requesterGeneration)
            ? args.requesterGeneration
            : undefined;
    const nodeDaemonId = (nodeId: string) => {
        const node = nodes.find(
            (n: any) =>
                meshNodeIdMatches(n, nodeId) ||
                trimStr(n?.id) === nodeId ||
                trimStr(n?.nodeId) === nodeId,
        );
        return node ? readMeshNodeDaemonId(node) || trimStr(node?.daemonId) : undefined;
    };
    const isSelfDaemon = selfDaemonId ? (d: string) => daemonIdsEquivalent(d, selfDaemonId) : undefined;
    const resolvedWorker = resolveForwardedWorkerIdentity(
        {
            meshId: meshIdToVerify,
            sessionId: requesterSessionId,
            ...(requesterTaskId ? { taskId: requesterTaskId } : {}),
            ...(requesterAttemptId ? { attemptId: requesterAttemptId } : {}),
            ...(requesterGeneration !== undefined ? { generation: requesterGeneration } : {}),
        },
        { senderDaemonId, nodeDaemonId },
        Date.now(),
        isSelfDaemon,
    );
    if ('refused' in resolvedWorker || !('live' in resolvedWorker)) {
        return {
            success: false,
            code: 'artifact_access_denied',
            error: `Worker session "${requesterSessionId}" is not authorized to fetch artifact "${record.artifactId}" (artifact_access_denied)`,
        };
    }
    const workerOwner = resolvedWorker.live;
    const meshStore = getMeshStore();
    const ledgerCheck = verifyActiveHostWorkerLedgerAttempt(meshStore, {
        meshId: meshIdToVerify,
        taskId: workerOwner.taskId,
        sessionId: workerOwner.sessionId,
        attemptId: requesterAttemptId || workerOwner.attemptId,
    });
    if (!ledgerCheck.ok) {
        return { success: false, code: 'artifact_access_denied', error: ledgerCheck.error };
    }
    const queueEntry = meshStore.findQueueEntryById(meshIdToVerify, workerOwner.taskId) as Record<
        string,
        unknown
    > | null;
    if (!queueEntry || (trimStr(queueEntry.status) && trimStr(queueEntry.status) !== 'assigned')) {
        return {
            success: false,
            code: 'artifact_access_denied',
            error: `Worker task "${workerOwner.taskId}" is not actively assigned on host (artifact_access_denied)`,
        };
    }
    const assignedSession = trimStr(queueEntry.assignedSessionId);
    if (assignedSession && !sessionIdsEquivalent(assignedSession, workerOwner.sessionId)) {
        return {
            success: false,
            code: 'artifact_access_denied',
            error: `Worker task "${workerOwner.taskId}" is not assigned to "${workerOwner.sessionId}" (artifact_access_denied)`,
        };
    }
    if (!sessionIdsEquivalent(record.sessionId, workerOwner.sessionId)) {
        const queuePayload = (queueEntry.payload ?? {}) as Record<string, unknown>;
        const workerMissionId = trimStr(queueEntry.missionId) || trimStr(queuePayload.missionId) || '';
        const rawInputIds = Array.isArray(queueEntry.inputArtifactIds)
            ? queueEntry.inputArtifactIds
            : Array.isArray(queuePayload.inputArtifactIds)
              ? queuePayload.inputArtifactIds
              : [];
        const allowedSet = new Set(
            rawInputIds.map((id: unknown) => trimStr(id)).filter((id: string) => id.length > 0),
        );
        let recMissionId = trimStr(record.missionId);
        if (!recMissionId && record.taskId) {
            try {
                const pe = meshStore.findQueueEntryById(
                    record.meshId || meshIdToVerify,
                    record.taskId,
                ) as Record<string, unknown> | null;
                recMissionId =
                    trimStr(pe?.missionId) ||
                    trimStr((pe?.payload as Record<string, unknown> | undefined)?.missionId);
            } catch {
                recMissionId = '';
            }
        }
        const sameMission = Boolean(workerMissionId && recMissionId && workerMissionId === recMissionId);
        const sameMesh = !record.meshId || record.meshId === meshIdToVerify;
        if (!sameMission || !sameMesh || !allowedSet.has(record.artifactId)) {
            return {
                success: false,
                code: 'artifact_access_denied',
                error: `Worker session "${workerOwner.sessionId}" is not authorized to fetch artifact "${record.artifactId}" outside its OD-4 task scope (artifact_access_denied)`,
            };
        }
    }
    return null;
}
