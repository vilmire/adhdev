import * as crypto from 'node:crypto';
import { daemonIdsEquivalent, meshNodeIdMatches, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { ArtifactRecord } from '../../artifacts/index.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import type { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { resolveForwardedWorkerIdentity } from '../../mesh/worker-report-forwarded.js';
import type { CommandRouterResult } from '../router.js';

export const ARTIFACT_ORIGIN_FETCH_GRANT_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_TRACKED_NONCES = 4_096;

const PROCESS_GRANT_SECRET = crypto.randomBytes(32);

interface TrackedGrantNonce {
    canonicalPayload: string;
    expiresAt: number;
}

const issuedGrantNonces = new Map<string, TrackedGrantNonce>();

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

function buildCanonicalGrantPayload( fields: {
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
        fields.hostDaemonId,
        fields.originDaemonId,
        fields.artifactId,
        fields.requesterSessionId,
        fields.requesterTaskId,
        fields.requesterAttemptId,
        String(fields.issuedAt),
        String(fields.expiresAt),
        fields.nonce,
    ].join('\0');
}

function signCanonicalGrantPayload(canonicalPayload: string): string {
    return crypto
        .createHmac('sha256', PROCESS_GRANT_SECRET)
        .update(canonicalPayload, 'utf8')
        .digest('hex');
}

function pruneExpiredGrantNonces(nowMs: number): void {
    if (issuedGrantNonces.size < MAX_TRACKED_NONCES) return;
    for (const [nonce, entry] of issuedGrantNonces) {
        if (entry.expiresAt <= nowMs) {
            issuedGrantNonces.delete(nonce);
        }
    }
    while (issuedGrantNonces.size >= MAX_TRACKED_NONCES) {
        const oldestKey = issuedGrantNonces.keys().next().value;
        if (oldestKey === undefined) break;
        issuedGrantNonces.delete(oldestKey);
    }
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
    const base = {
        meshId: args.meshId.trim(),
        hostDaemonId: args.hostDaemonId.trim(),
        originDaemonId: args.originDaemonId.trim(),
        artifactId: args.artifactId.trim(),
        requesterSessionId: args.requesterSessionId.trim(),
        requesterTaskId: args.requesterTaskId.trim(),
        requesterAttemptId: args.requesterAttemptId.trim(),
        issuedAt,
        expiresAt,
        nonce,
    };
    const canonicalPayload = buildCanonicalGrantPayload(base);
    const signature = signCanonicalGrantPayload(canonicalPayload);
    pruneExpiredGrantNonces(issuedAt);
    issuedGrantNonces.set(nonce, { canonicalPayload, expiresAt });
    return {
        ...base,
        signature,
    };
}

export function verifyArtifactOriginFetchGrant(
    rawGrant: unknown,
    expected: {
        meshId: string;
        hostDaemonId: string;
        originDaemonId: string;
        artifactId: string;
        requesterSessionId: string;
    },
    nowMs = Date.now(),
): { ok: true; grant: ArtifactOriginFetchGrant } | { ok: false; reason: string } {
    if (!rawGrant || typeof rawGrant !== 'object') {
        return { ok: false, reason: 'missing_or_malformed_grant' };
    }
    const candidate = rawGrant as Record<string, unknown>;
    const meshId = typeof candidate.meshId === 'string' ? candidate.meshId.trim() : '';
    const hostDaemonId = typeof candidate.hostDaemonId === 'string' ? candidate.hostDaemonId.trim() : '';
    const originDaemonId = typeof candidate.originDaemonId === 'string' ? candidate.originDaemonId.trim() : '';
    const artifactId = typeof candidate.artifactId === 'string' ? candidate.artifactId.trim() : '';
    const requesterSessionId = typeof candidate.requesterSessionId === 'string' ? candidate.requesterSessionId.trim() : '';
    const requesterTaskId = typeof candidate.requesterTaskId === 'string' ? candidate.requesterTaskId.trim() : '';
    const requesterAttemptId = typeof candidate.requesterAttemptId === 'string' ? candidate.requesterAttemptId.trim() : '';
    const nonce = typeof candidate.nonce === 'string' ? candidate.nonce.trim() : '';
    const signature = typeof candidate.signature === 'string' ? candidate.signature.trim() : '';
    const issuedAt = typeof candidate.issuedAt === 'number' && Number.isFinite(candidate.issuedAt) ? candidate.issuedAt : NaN;
    const expiresAt = typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : NaN;

    if (
        !meshId ||
        !hostDaemonId ||
        !originDaemonId ||
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

    if (expiresAt <= issuedAt || nowMs > expiresAt || issuedAt > nowMs + MAX_CLOCK_SKEW_MS) {
        return { ok: false, reason: 'expired_or_invalid_grant_window' };
    }

    if (
        meshId !== expected.meshId.trim() ||
        hostDaemonId !== expected.hostDaemonId.trim() ||
        originDaemonId !== expected.originDaemonId.trim() ||
        artifactId !== expected.artifactId.trim() ||
        requesterSessionId !== expected.requesterSessionId.trim()
    ) {
        return { ok: false, reason: 'grant_scope_mismatch' };
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
    const expectedSignature = signCanonicalGrantPayload(canonicalPayload);
    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return { ok: false, reason: 'invalid_grant_signature' };
    }

    const tracked = issuedGrantNonces.get(nonce);
    if (!tracked || tracked.canonicalPayload !== canonicalPayload || tracked.expiresAt < nowMs) {
        return { ok: false, reason: 'unrecognized_or_expired_grant_nonce' };
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

function trimStr(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
    getMeshStore: () => MeshRuntimeStore;
}): CommandRouterResult | null {
    const { args, record, meshIdToVerify, hostDaemonId, selfDaemonId, senderDaemonId, isSelfHost, nodes, getMeshStore } = params;
    const requesterSessionId = trimStr(args?.requesterSessionId);
    if (!requesterSessionId) {
        return { success: false, code: 'artifact_access_denied', error: 'artifact_fetch_origin requires an authorized requesting worker session (artifact_access_denied)' };
    }
    const hasGrantArg = args?.originFetchGrant !== undefined && args?.originFetchGrant !== null;
    if (hasGrantArg) {
        const grantCheck = verifyArtifactOriginFetchGrant(args.originFetchGrant, {
            meshId: meshIdToVerify,
            hostDaemonId,
            originDaemonId: selfDaemonId || trimStr(record.originDaemonId) || '',
            artifactId: record.artifactId,
            requesterSessionId,
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
        typeof args?.requesterGeneration === 'number' && Number.isSafeInteger(args.requesterGeneration) ? args.requesterGeneration : undefined;
    const nodeDaemonId = (nodeId: string) => {
        const node = nodes.find((n: any) => meshNodeIdMatches(n, nodeId) || trimStr(n?.id) === nodeId || trimStr(n?.nodeId) === nodeId);
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
    const queueEntry = meshStore.findQueueEntryById(meshIdToVerify, workerOwner.taskId) as Record<string, unknown> | null;
    if (!queueEntry || (trimStr(queueEntry.status) && trimStr(queueEntry.status) !== 'assigned')) {
        return { success: false, code: 'artifact_access_denied', error: `Worker task "${workerOwner.taskId}" is not actively assigned on host (artifact_access_denied)` };
    }
    const assignedSession = trimStr(queueEntry.assignedSessionId);
    if (assignedSession && !sessionIdsEquivalent(assignedSession, workerOwner.sessionId)) {
        return { success: false, code: 'artifact_access_denied', error: `Worker task "${workerOwner.taskId}" is not assigned to "${workerOwner.sessionId}" (artifact_access_denied)` };
    }
    if (!sessionIdsEquivalent(record.sessionId, workerOwner.sessionId)) {
        const queuePayload = (queueEntry.payload ?? {}) as Record<string, unknown>;
        const workerMissionId = trimStr(queueEntry.missionId) || trimStr(queuePayload.missionId) || '';
        const rawInputIds = Array.isArray(queueEntry.inputArtifactIds)
            ? queueEntry.inputArtifactIds
            : Array.isArray(queuePayload.inputArtifactIds)
              ? queuePayload.inputArtifactIds
              : [];
        const allowedSet = new Set(rawInputIds.map((id: unknown) => trimStr(id)).filter((id: string) => id.length > 0));
        let recMissionId = trimStr(record.missionId);
        if (!recMissionId && record.taskId) {
            try {
                const pe = meshStore.findQueueEntryById(record.meshId || meshIdToVerify, record.taskId) as Record<string, unknown> | null;
                recMissionId = trimStr(pe?.missionId) || trimStr((pe?.payload as Record<string, unknown> | undefined)?.missionId);
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
