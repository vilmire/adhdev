/**
 * Physical ownership for a writer on ANOTHER machine.
 *
 * The host admits writers, but it can only look at its own disk: attesting a member's
 * checkout path locally fails (ENOENT) or, worse, attests an unrelated local folder.
 * So the machine that holds the checkout attests it (`mesh_attest_node_ownership`) and
 * the host keeps that answer. The claim runs synchronously inside a store transaction,
 * so the answer is fetched ahead of time: the first claim attempt starts the request
 * and is held as `remote_attestation_pending`; the next claim attempt uses the answer.
 */
import { daemonIdsEquivalent, meshNodeIdMatches, type OwnedPathsDeclaration, type PhysicalOwnershipScope } from '@adhdev/mesh-shared';
import { getMachineId } from '../config/config.js';
import { LOG } from '../logging/logger.js';

export const MESH_ATTEST_NODE_OWNERSHIP = 'mesh_attest_node_ownership' as const;
export const REMOTE_ATTESTATION_TIMEOUT_MS = 15_000;
/** A held answer is reused this long; the claim stores it on the row, so it is short-lived by design. */
const ANSWER_TTL_MS = 60_000;
/** A refused or failed request is retried after this long. */
const FAILURE_RETRY_MS = 15_000;
const MAX_ENTRIES = 256;

export type RemoteOwnershipProof = { scope: PhysicalOwnershipScope } | { error: string };

export interface RemoteOwnershipTarget {
    meshId: string;
    nodeId: string;
    daemonId: string;
    workspace: string;
    repoIdentity: string;
    phase: 'source' | 'integration';
    paths: OwnedPathsDeclaration;
    sessionId?: string;
}

type Dispatch = (daemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>;

interface Entry { at: number; proof?: RemoteOwnershipProof; pending?: Promise<RemoteOwnershipProof> }
const entries = new Map<string, Entry>();

function keyOf(t: RemoteOwnershipTarget): string {
    return JSON.stringify([t.meshId, t.nodeId, t.daemonId, t.workspace, t.phase, t.paths.paths, t.sessionId ?? '']);
}

function unwrap(raw: unknown): Record<string, unknown> | null {
    let v: any = raw;
    for (let i = 0; i < 3 && v && typeof v === 'object' && v.result && typeof v.result === 'object' && !('scope' in v); i++) v = v.result;
    return v && typeof v === 'object' ? v : null;
}

/**
 * Accept only a scope that answers exactly what was asked: same node, repo, phase and
 * declaration, attested on a machine other than this one. Anything else is refused.
 */
export function validateRemoteOwnershipScope(raw: unknown, t: RemoteOwnershipTarget, localMachineId: string | undefined = getMachineId()): RemoteOwnershipProof {
    const body = unwrap(raw);
    if (!body) return { error: 'ownership_unproven: remote_attestation_unanswered' };
    if (body.success === false) {
        const detail = typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : 'refused';
        return { error: `ownership_unproven: remote_attestation_refused: ${detail}` };
    }
    const s = body.scope as PhysicalOwnershipScope | undefined;
    if (!s || typeof s !== 'object' || s.version !== 1) return { error: 'ownership_unproven: remote_attestation_malformed' };
    const ok = typeof s.machineId === 'string' && s.machineId.length > 0
        && (!localMachineId || s.machineId !== localMachineId)
        && meshNodeIdMatches({ id: s.nodeId }, t.nodeId)
        && s.repoIdentity === t.repoIdentity
        && s.phase === t.phase
        && typeof s.worktree === 'string' && s.worktree.length > 0
        && typeof s.worktreeIdentity === 'string' && typeof s.gitDir === 'string' && typeof s.commonGitDir === 'string'
        && !!s.gitResources && typeof s.gitResources === 'object'
        && Array.isArray(s.resources)
        && JSON.stringify(s.declaration) === JSON.stringify(t.paths.paths);
    return ok ? { scope: s } : { error: 'ownership_unproven: remote_attestation_mismatch' };
}

/** Ask the member that holds the checkout to attest it. Never throws. */
export async function requestRemoteOwnership(dispatch: Dispatch, t: RemoteOwnershipTarget, timeoutMs = REMOTE_ATTESTATION_TIMEOUT_MS): Promise<RemoteOwnershipProof> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const raw = await Promise.race([
            dispatch(t.daemonId, MESH_ATTEST_NODE_OWNERSHIP, {
                meshId: t.meshId,
                nodeId: t.nodeId,
                workspace: t.workspace,
                repoIdentity: t.repoIdentity,
                phase: t.phase,
                ownedPaths: t.paths,
                ...(t.sessionId ? { sessionId: t.sessionId } : {}),
            }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
        ]);
        return validateRemoteOwnershipScope(raw, t);
    } catch (e: any) {
        return { error: `ownership_unproven: remote_attestation_unreachable: ${e?.message ?? String(e)}` };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Same request, shared with any in-flight one for the same target, and remembered. */
export function fetchRemoteOwnership(dispatch: Dispatch, t: RemoteOwnershipTarget, now = Date.now()): Promise<RemoteOwnershipProof> {
    const key = keyOf(t);
    const known = entries.get(key);
    if (known?.pending) return known.pending;
    const pending = requestRemoteOwnership(dispatch, t).then(proof => {
        entries.set(key, { at: Date.now(), proof });
        if ('error' in proof) LOG.info('MeshQueue', `Remote ownership attestation for node ${t.nodeId} (mesh ${t.meshId}) refused: ${proof.error}`);
        return proof;
    });
    if (entries.size >= MAX_ENTRIES && !entries.has(key)) entries.delete(entries.keys().next().value!);
    entries.set(key, { at: now, ...(known?.proof ? { proof: known.proof } : {}), pending });
    return pending;
}

/**
 * The claim's synchronous view: a remembered answer when one is fresh, otherwise start
 * (or keep) the request and report it pending. `onAnswer` lets the caller re-drive.
 */
export function remoteOwnershipProofSync(dispatch: Dispatch | undefined, t: RemoteOwnershipTarget, onAnswer?: () => void, now = Date.now()): RemoteOwnershipProof {
    if (!dispatch) return { error: 'ownership_unproven: remote_attestation_unavailable (no mesh transport)' };
    if (!t.daemonId || !t.workspace || !t.repoIdentity) return { error: 'ownership_unproven: remote_attestation_unavailable (node identity incomplete)' };
    const key = keyOf(t);
    const known = entries.get(key);
    if (known?.proof && !known.pending) {
        const ttl = 'scope' in known.proof ? ANSWER_TTL_MS : FAILURE_RETRY_MS;
        if (now - known.at < ttl) return known.proof;
    }
    if (!known?.pending) void fetchRemoteOwnership(dispatch, t, now).then(() => { try { onAnswer?.(); } catch { /* best-effort */ } });
    return { error: 'ownership_unproven: remote_attestation_pending' };
}

/** A node is remote when its daemon is a different daemon from this one. */
export function isRemoteOwnershipNode(nodeDaemonId: string | undefined, selfDaemonId: string | undefined): boolean {
    return !!nodeDaemonId && !!selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
}

export function resetRemoteOwnershipForTest(): void { entries.clear(); }
