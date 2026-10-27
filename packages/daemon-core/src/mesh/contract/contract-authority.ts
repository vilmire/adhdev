/**
 * Contract versioning — enrollment, fenced authority tenure, coordinator
 * capabilities (design §4, F1; owner decisions O2/O12; AC01–AC03).
 *
 *   - Enrollment, policy changes, recovery and transfer are OWNER-RESERVED and
 *     need an owner principal issued after the router's trusted-owner-ingress
 *     proof. A source label (ws/p2p/ipc/standalone) is never a principal.
 *   - A coordinator capability (`csb_` + 256 random bits) is minted by this
 *     daemon, bound to namespace + coordinator session instance + authority
 *     daemon + epoch + process incarnation + grant generation + ops + max
 *     impact + expiry. Only SHA-256(capability) is stored; the bearer secret is
 *     returned once over the authenticated owner channel and never logged.
 *   - Daemon restart (new process incarnation) invalidates every volatile grant
 *     before any mutation is accepted; history is preserved.
 *   - Transfer increments the epoch only when the old writer is fenced;
 *     otherwise strict acceptance PAUSES (no split-brain availability promise).
 *   - Fencing evidence lives outside the DB (`ContractAuthorityFencePort`):
 *     a restored stale backup (DB epoch < fenced epoch) requires owner
 *     recovery to a NEW epoch, which rejects every prior grant.
 *
 * Limitation (stated, not hidden): a same-UID process able to read another
 * process's secrets can impersonate its capability. Minimal scope, private
 * delivery and revocation reduce exposure; this is not OS isolation.
 */

import { createHash } from 'node:crypto';
import {
    CONTRACT_CAPABILITY_PREFIX,
    CONTRACT_GRANT_OPS,
    CONTRACT_PROTOCOL_VERSION,
    ContractRefusal,
    DEFAULT_CONTRACT_POLICY,
    type ContractGrantOp,
    type ContractHeadVector,
    type ContractImpact,
    type ContractPolicy,
} from './contract-types.js';
import {
    assertIssued,
    assertOwner,
    inTxn,
    issueCoordinatorPrincipal,
    newId,
    type ContractCtx,
    type ContractPrincipal,
    type CoordinatorPrincipal,
    type OwnerPrincipal,
} from './contract-context.js';
import { readContractStoreProtocolVersion } from './contract-schema.js';
import type { ContractRepoBindingRecord } from './contract-git-source.js';

export interface ContractAuthorityRow {
    namespaceId: string;
    meshId: string;
    ownerPrincipal: string;
    authorityDaemonId: string;
    authorityEpoch: number;
    processIncarnation: number;
    policyRevision: number;
    policy: ContractPolicy;
    revocationGeneration: number;
    status: 'active' | 'paused_transfer' | 'requires_owner_recovery' | 'transferred_away';
}

interface AuthorityDbRow {
    namespace_id: string; mesh_id: string; owner_principal: string; authority_daemon_id: string;
    authority_epoch: number; process_incarnation: number; policy_revision: number; policy_json: string;
    revocation_generation: number; status: string;
}

function toAuthority(r: AuthorityDbRow): ContractAuthorityRow {
    let policy: ContractPolicy = { ...DEFAULT_CONTRACT_POLICY };
    try { policy = { ...DEFAULT_CONTRACT_POLICY, ...JSON.parse(r.policy_json) }; } catch { /* default policy */ }
    return {
        namespaceId: r.namespace_id,
        meshId: r.mesh_id,
        ownerPrincipal: r.owner_principal,
        authorityDaemonId: r.authority_daemon_id,
        authorityEpoch: r.authority_epoch,
        processIncarnation: r.process_incarnation,
        policyRevision: r.policy_revision,
        policy,
        revocationGeneration: r.revocation_generation,
        status: r.status as ContractAuthorityRow['status'],
    };
}

export function getAuthority(ctx: ContractCtx, namespaceId: string): ContractAuthorityRow | null {
    const r = ctx.db.prepare('SELECT * FROM contract_authorities WHERE namespace_id = ?').get(namespaceId) as AuthorityDbRow | undefined;
    return r ? toAuthority(r) : null;
}

export function listAuthoritiesForMesh(ctx: ContractCtx, meshId: string): ContractAuthorityRow[] {
    return (ctx.db.prepare('SELECT * FROM contract_authorities WHERE mesh_id = ?').all(meshId) as AuthorityDbRow[]).map(toAuthority);
}

export function currentHeadVector(ctx: ContractCtx, namespaceId: string): ContractHeadVector | null {
    const auth = getAuthority(ctx, namespaceId);
    const head = ctx.db.prepare('SELECT * FROM contract_heads WHERE namespace_id = ?').get(namespaceId) as
        { authority_epoch: number; head_generation: number; revision_id: string | null; policy_revision: number } | undefined;
    if (!auth || !head) return null;
    return {
        namespaceId,
        authorityEpoch: head.authority_epoch,
        headGeneration: head.head_generation,
        revisionId: head.revision_id,
        policyRevision: head.policy_revision,
        revocationGeneration: auth.revocationGeneration,
    };
}

/** The store barrier plus "this daemon is the active fenced authority". Every strict mutation calls it. */
export function assertAuthorityWritable(ctx: ContractCtx, namespaceId: string): ContractAuthorityRow {
    if (readContractStoreProtocolVersion(ctx.db) > CONTRACT_PROTOCOL_VERSION) throw new ContractRefusal('store_version_unsupported');
    const auth = getAuthority(ctx, namespaceId);
    if (!auth) throw new ContractRefusal('not_enrolled');
    if (auth.status === 'requires_owner_recovery') throw new ContractRefusal('authority_requires_recovery');
    if (auth.status === 'paused_transfer') throw new ContractRefusal('authority_paused');
    if (auth.status !== 'active' || auth.authorityDaemonId !== ctx.localDaemonId) throw new ContractRefusal('not_authorized');
    return auth;
}

/** Read-side barrier: unknown/unsupported store or unavailable authority ⇒ consumers HOLD. */
export function authorityReadable(ctx: ContractCtx, namespaceId: string): ContractAuthorityRow | null {
    if (readContractStoreProtocolVersion(ctx.db) > CONTRACT_PROTOCOL_VERSION) return null;
    const auth = getAuthority(ctx, namespaceId);
    if (!auth || auth.status !== 'active' || auth.authorityDaemonId !== ctx.localDaemonId) return null;
    return auth;
}

function writeEpoch(ctx: ContractCtx, namespaceId: string, epoch: number, daemonId: string, reason: string): void {
    ctx.db.prepare(`INSERT OR REPLACE INTO contract_epochs (namespace_id, authority_epoch, authority_daemon_id, reason, started_at)
        VALUES (?, ?, ?, ?, ?)`).run(namespaceId, epoch, daemonId, reason, ctx.rt.nowMs());
}

export interface EnrollInput {
    meshId: string;
    policy?: Partial<ContractPolicy>;
    repositories: Array<{ repoBindingId?: string; repoPath: string }>;
}

export function enrollNamespace(ctx: ContractCtx, owner: OwnerPrincipal, input: EnrollInput): { namespaceId: string; vector: ContractHeadVector; repoBindingIds: string[] } {
    assertOwner(owner);
    if (!input || typeof input.meshId !== 'string' || !input.meshId.trim()) throw new ContractRefusal('invalid_input');
    if (!Array.isArray(input.repositories) || input.repositories.length === 0 || input.repositories.length > 8) throw new ContractRefusal('invalid_input');
    if (readContractStoreProtocolVersion(ctx.db) > CONTRACT_PROTOCOL_VERSION) throw new ContractRefusal('store_version_unsupported');
    const described = input.repositories.map((r) => ({ id: r.repoBindingId?.trim() || newId(ctx, 'repo'), path: r.repoPath, desc: ctx.sourceReader.describeRepository(r.repoPath) }));
    const namespaceId = newId(ctx, 'ns');
    const now = ctx.rt.nowMs();
    const policy: ContractPolicy = { ...DEFAULT_CONTRACT_POLICY, ...(input.policy ?? {}) };
    inTxn(ctx, () => {
        ctx.db.prepare(`INSERT INTO contract_authorities (namespace_id, mesh_id, owner_principal, authority_daemon_id, authority_epoch,
            process_incarnation, policy_revision, policy_json, revocation_generation, status, enrolled_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 1, 1, ?, 0, 'active', ?, ?)`)
            .run(namespaceId, input.meshId.trim(), owner.principalId, ctx.localDaemonId, JSON.stringify(policy), now, now);
        ctx.db.prepare(`INSERT INTO contract_heads (namespace_id, authority_epoch, head_generation, revision_id, policy_revision, updated_at)
            VALUES (?, 1, 0, NULL, 1, ?)`).run(namespaceId, now);
        writeEpoch(ctx, namespaceId, 1, ctx.localDaemonId, 'enrolled');
        for (const r of described) {
            ctx.db.prepare(`INSERT INTO contract_repo_bindings (repo_binding_id, namespace_id, repo_path, common_dir, hash_algorithm, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(r.id, namespaceId, r.path, r.desc.commonDir, r.desc.hashAlgorithm, now);
        }
    });
    ctx.fence.write(namespaceId, 1);
    return { namespaceId, vector: currentHeadVector(ctx, namespaceId)!, repoBindingIds: described.map(d => d.id) };
}

export function repoBindingsFor(ctx: ContractCtx, namespaceId: string): Map<string, ContractRepoBindingRecord> {
    const rows = ctx.db.prepare('SELECT * FROM contract_repo_bindings WHERE namespace_id = ?').all(namespaceId) as
        Array<{ repo_binding_id: string; repo_path: string; common_dir: string; hash_algorithm: string }>;
    return new Map(rows.map(r => [r.repo_binding_id, {
        repoBindingId: r.repo_binding_id, repoPath: r.repo_path, commonDir: r.common_dir,
        hashAlgorithm: r.hash_algorithm === 'sha256' ? 'sha256' : 'sha1',
    }]));
}

export function updatePolicy(ctx: ContractCtx, owner: OwnerPrincipal, namespaceId: string, patch: Partial<ContractPolicy>): ContractHeadVector {
    assertOwner(owner);
    return inTxn(ctx, () => {
        const auth = assertAuthorityWritable(ctx, namespaceId);
        const policy = { ...auth.policy, ...patch };
        const rev = auth.policyRevision + 1;
        ctx.db.prepare('UPDATE contract_authorities SET policy_json = ?, policy_revision = ?, updated_at = ? WHERE namespace_id = ?')
            .run(JSON.stringify(policy), rev, ctx.rt.nowMs(), namespaceId);
        ctx.db.prepare('UPDATE contract_heads SET policy_revision = ?, updated_at = ? WHERE namespace_id = ?').run(rev, ctx.rt.nowMs(), namespaceId);
        return currentHeadVector(ctx, namespaceId)!;
    });
}

// ─── Restart / fencing ─────────────────────────────────────────────────

/**
 * Daemon boot: bump the process incarnation of every authority this daemon
 * holds (rotating all volatile grants), and reconcile the external fence —
 * a DB whose epoch is behind the fenced epoch is a restored stale backup.
 */
export function beginContractProcessIncarnation(ctx: ContractCtx): { rotatedNamespaces: number; requiresRecovery: number } {
    let rotated = 0;
    let recovery = 0;
    inTxn(ctx, () => {
        const rows = ctx.db.prepare('SELECT * FROM contract_authorities WHERE authority_daemon_id = ?').all(ctx.localDaemonId) as AuthorityDbRow[];
        for (const r of rows) {
            const fenced = ctx.fence.read(r.namespace_id);
            if (fenced !== null && fenced > r.authority_epoch) {
                ctx.db.prepare(`UPDATE contract_authorities SET status = 'requires_owner_recovery', updated_at = ? WHERE namespace_id = ?`)
                    .run(ctx.rt.nowMs(), r.namespace_id);
                recovery += 1;
                continue;
            }
            ctx.db.prepare('UPDATE contract_authorities SET process_incarnation = process_incarnation + 1, updated_at = ? WHERE namespace_id = ?')
                .run(ctx.rt.nowMs(), r.namespace_id);
            ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = 'process_restart' WHERE namespace_id = ? AND revoked_at IS NULL`)
                .run(ctx.rt.nowMs(), r.namespace_id);
            rotated += 1;
        }
        // RN-02: a use guard still "active" from a previous incarnation has an UNKNOWN outcome.
        ctx.db.prepare(`UPDATE contract_use_guards SET state = 'unknown', updated_at = ? WHERE state = 'active' AND process_incarnation <
            COALESCE((SELECT process_incarnation FROM contract_authorities a WHERE a.namespace_id = contract_use_guards.namespace_id), 0)`)
            .run(ctx.rt.nowMs());
    });
    for (const r of ctx.db.prepare(`SELECT namespace_id, authority_epoch FROM contract_authorities WHERE authority_daemon_id = ? AND status = 'active'`)
        .all(ctx.localDaemonId) as Array<{ namespace_id: string; authority_epoch: number }>) {
        if (ctx.fence.read(r.namespace_id) === null) ctx.fence.write(r.namespace_id, r.authority_epoch);
    }
    return { rotatedNamespaces: rotated, requiresRecovery: recovery };
}

/** Owner recovery to a NEW epoch above both the DB and the fence; every prior grant is revoked. */
export function recoverAuthority(ctx: ContractCtx, owner: OwnerPrincipal, namespaceId: string): ContractHeadVector {
    assertOwner(owner);
    const auth = getAuthority(ctx, namespaceId);
    if (!auth) throw new ContractRefusal('not_enrolled');
    const epoch = Math.max(auth.authorityEpoch, ctx.fence.read(namespaceId) ?? 0) + 1;
    inTxn(ctx, () => {
        const now = ctx.rt.nowMs();
        ctx.db.prepare(`UPDATE contract_authorities SET authority_epoch = ?, authority_daemon_id = ?, status = 'active',
            process_incarnation = process_incarnation + 1, updated_at = ? WHERE namespace_id = ?`).run(epoch, ctx.localDaemonId, now, namespaceId);
        ctx.db.prepare('UPDATE contract_heads SET authority_epoch = ?, updated_at = ? WHERE namespace_id = ?').run(epoch, now, namespaceId);
        ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = 'owner_recovery' WHERE namespace_id = ? AND revoked_at IS NULL`).run(now, namespaceId);
        writeEpoch(ctx, namespaceId, epoch, ctx.localDaemonId, 'owner_recovery');
    });
    ctx.fence.write(namespaceId, epoch);
    return currentHeadVector(ctx, namespaceId)!;
}

/**
 * Authority transfer (O12). `oldWriterFenced` is the owner's explicit
 * statement that the old writer is stopped/fenced; without it strict
 * acceptance pauses instead of risking two writers.
 */
export function transferAuthority(ctx: ContractCtx, owner: OwnerPrincipal, input: { namespaceId: string; newDaemonId: string; oldWriterFenced: boolean }): ContractAuthorityRow {
    assertOwner(owner);
    const auth = getAuthority(ctx, input.namespaceId);
    if (!auth) throw new ContractRefusal('not_enrolled');
    if (typeof input.newDaemonId !== 'string' || !input.newDaemonId.trim()) throw new ContractRefusal('invalid_input');
    const now = ctx.rt.nowMs();
    if (!input.oldWriterFenced) {
        ctx.db.prepare(`UPDATE contract_authorities SET status = 'paused_transfer', updated_at = ? WHERE namespace_id = ?`).run(now, input.namespaceId);
        return getAuthority(ctx, input.namespaceId)!;
    }
    const epoch = Math.max(auth.authorityEpoch, ctx.fence.read(input.namespaceId) ?? 0) + 1;
    inTxn(ctx, () => {
        const status = input.newDaemonId === ctx.localDaemonId ? 'active' : 'transferred_away';
        ctx.db.prepare(`UPDATE contract_authorities SET authority_epoch = ?, authority_daemon_id = ?, status = ?, updated_at = ? WHERE namespace_id = ?`)
            .run(epoch, input.newDaemonId, status, now, input.namespaceId);
        ctx.db.prepare('UPDATE contract_heads SET authority_epoch = ?, updated_at = ? WHERE namespace_id = ?').run(epoch, now, input.namespaceId);
        ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = 'authority_transfer' WHERE namespace_id = ? AND revoked_at IS NULL`).run(now, input.namespaceId);
        writeEpoch(ctx, input.namespaceId, epoch, input.newDaemonId, 'transfer');
    });
    ctx.fence.write(input.namespaceId, epoch);
    return getAuthority(ctx, input.namespaceId)!;
}

// ─── Coordinator capabilities ──────────────────────────────────────────

export function hashCapability(secret: string): string {
    return createHash('sha256').update(`adhdev.contract/capability/v1\u0000${secret}`).digest('hex');
}

export interface MintGrantInput {
    namespaceId: string;
    coordinatorSessionId: string;
    ops: readonly ContractGrantOp[];
    maxImpact?: ContractImpact;
    ttlMs?: number;
    /** Keep the previous generation usable for the policy's bounded overlap window (never for a revoked/compromised grant). */
    overlapPrevious?: boolean;
}

export function mintCoordinatorGrant(ctx: ContractCtx, owner: OwnerPrincipal, input: MintGrantInput): {
    grantId: string; capability: string; grantGeneration: number; expiresAt: number;
} {
    assertOwner(owner);
    const ops = Array.isArray(input.ops) ? [...new Set(input.ops)] : [];
    if (!ops.length || ops.some(op => !(CONTRACT_GRANT_OPS as readonly string[]).includes(op))) throw new ContractRefusal('invalid_input');
    if (typeof input.coordinatorSessionId !== 'string' || !input.coordinatorSessionId.trim()) throw new ContractRefusal('invalid_input');
    const maxImpact: ContractImpact = input.maxImpact === 'breaking' ? 'breaking' : 'nonbreaking';
    return inTxn(ctx, () => {
        const auth = assertAuthorityWritable(ctx, input.namespaceId);
        if (maxImpact === 'breaking' && !auth.policy.delegateBreaking) throw new ContractRefusal('impact_requires_owner');
        const now = ctx.rt.nowMs();
        const ttl = Math.min(input.ttlMs && input.ttlMs > 0 ? input.ttlMs : ctx.budgets.capabilityTtlMs, ctx.budgets.capabilityTtlMs);
        const prev = ctx.db.prepare(`SELECT MAX(grant_generation) AS g FROM contract_grants WHERE namespace_id = ? AND coordinator_session_id = ?`)
            .get(input.namespaceId, input.coordinatorSessionId) as { g: number | null };
        const generation = (prev.g ?? 0) + 1;
        const overlapUntil = input.overlapPrevious && auth.policy.rotationOverlapMs > 0 ? now + auth.policy.rotationOverlapMs : null;
        ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = 'rotated', overlap_until = ?
            WHERE namespace_id = ? AND coordinator_session_id = ? AND revoked_at IS NULL`)
            .run(now, overlapUntil, input.namespaceId, input.coordinatorSessionId);
        const capability = `${CONTRACT_CAPABILITY_PREFIX}${ctx.rt.randomBytes(32).toString('base64url')}`;
        const grantId = newId(ctx, 'grant');
        ctx.db.prepare(`INSERT INTO contract_grants (grant_id, namespace_id, verifier, coordinator_session_id, authority_daemon_id, authority_epoch,
            process_incarnation, grant_generation, ops_json, max_impact, expires_at, overlap_until, revoked_at, revoke_reason, minted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
            .run(grantId, input.namespaceId, hashCapability(capability), input.coordinatorSessionId, ctx.localDaemonId, auth.authorityEpoch,
                auth.processIncarnation, generation, JSON.stringify(ops), maxImpact, now + ttl, now);
        return { grantId, capability, grantGeneration: generation, expiresAt: now + ttl };
    });
}

export function revokeGrant(ctx: ContractCtx, owner: OwnerPrincipal, grantId: string, reason = 'owner_revoked'): boolean {
    assertOwner(owner);
    return ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = ?, overlap_until = NULL WHERE grant_id = ? AND (revoked_at IS NULL OR overlap_until IS NOT NULL)`)
        .run(ctx.rt.nowMs(), reason, grantId).changes > 0;
}

/** Revocation is always safe: a coordinator session that ended loses every grant bound to its instance. */
export function revokeGrantsForSession(ctx: ContractCtx, coordinatorSessionId: string): number {
    return ctx.db.prepare(`UPDATE contract_grants SET revoked_at = ?, revoke_reason = 'session_ended', overlap_until = NULL
        WHERE coordinator_session_id = ? AND (revoked_at IS NULL OR overlap_until IS NOT NULL)`).run(ctx.rt.nowMs(), coordinatorSessionId).changes;
}

interface GrantDbRow {
    grant_id: string; namespace_id: string; coordinator_session_id: string; authority_daemon_id: string; authority_epoch: number;
    process_incarnation: number; ops_json: string; max_impact: string; expires_at: number; overlap_until: number | null;
    revoked_at: number | null; revoke_reason: string | null;
}

function grantUsable(ctx: ContractCtx, g: GrantDbRow, auth: ContractAuthorityRow): ContractRefusal | null {
    const now = ctx.rt.nowMs();
    if (g.revoked_at !== null) {
        const inOverlap = g.revoke_reason === 'rotated' && g.overlap_until !== null && g.overlap_until > now;
        if (!inOverlap) return new ContractRefusal('capability_revoked');
    }
    if (g.expires_at <= now) return new ContractRefusal('capability_expired');
    if (g.authority_daemon_id !== auth.authorityDaemonId || g.authority_epoch !== auth.authorityEpoch
        || g.process_incarnation !== auth.processIncarnation) return new ContractRefusal('capability_revoked');
    return null;
}

/**
 * Verify a presented capability for one operation in one namespace from one
 * coordinator session instance. Every refusal is content-free.
 */
export function verifyCoordinatorCapability(ctx: ContractCtx, secret: unknown, req: { namespaceId: string; sessionId: string; op: ContractGrantOp }): CoordinatorPrincipal {
    if (typeof secret !== 'string' || !secret.startsWith(CONTRACT_CAPABILITY_PREFIX) || secret.length < 20) throw new ContractRefusal('capability_invalid');
    const g = ctx.db.prepare('SELECT * FROM contract_grants WHERE verifier = ?').get(hashCapability(secret)) as GrantDbRow | undefined;
    if (!g) throw new ContractRefusal('capability_invalid');
    if (g.namespace_id !== req.namespaceId || g.coordinator_session_id !== req.sessionId) throw new ContractRefusal('scope_mismatch');
    const auth = assertAuthorityWritable(ctx, req.namespaceId);
    const refusal = grantUsable(ctx, g, auth);
    if (refusal) throw refusal;
    let ops: ContractGrantOp[] = [];
    try { ops = JSON.parse(g.ops_json); } catch { /* empty ops */ }
    if (!ops.includes(req.op)) throw new ContractRefusal('not_authorized');
    return issueCoordinatorPrincipal({
        grantId: g.grant_id,
        namespaceId: g.namespace_id,
        sessionId: g.coordinator_session_id,
        ops,
        maxImpact: g.max_impact === 'breaking' ? 'breaking' : 'nonbreaking',
    });
}

/**
 * Re-check a principal right before a commit (AC02: a deferred operation
 * rechecks revocation/expiry; a grant revoked meanwhile fails before any CAS).
 */
export function recheckPrincipal(ctx: ContractCtx, principal: ContractPrincipal, namespaceId: string, op: ContractGrantOp): ContractAuthorityRow {
    assertIssued(principal);
    const auth = assertAuthorityWritable(ctx, namespaceId);
    if (principal.kind === 'owner') return auth;
    if (principal.kind === 'worker') {
        if (op !== 'propose') throw new ContractRefusal('not_authorized');
        return auth;
    }
    if (principal.namespaceId !== namespaceId) throw new ContractRefusal('scope_mismatch');
    if (!principal.ops.includes(op)) throw new ContractRefusal('not_authorized');
    const g = ctx.db.prepare('SELECT * FROM contract_grants WHERE grant_id = ?').get(principal.grantId) as GrantDbRow | undefined;
    if (!g) throw new ContractRefusal('capability_invalid');
    const refusal = grantUsable(ctx, g, auth);
    if (refusal) throw refusal;
    return auth;
}
