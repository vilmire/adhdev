/**
 * Contract versioning — private spool, proposals, reviews and the atomic CAS
 * acceptance (design §6; AC20, AC24 quota).
 *
 *   - Source bytes are read from immutable git objects and STAGED durably in
 *     the private spool before a proposal can reference them; no head can
 *     point at an unavailable body.
 *   - Concurrent drafts need no head lock. Acceptance is ONE transaction:
 *     principal recheck, policy/impact authority, review quorum bound to the
 *     exact candidate/base/policy, RN-02 use-guard conflict, CAS on the
 *     expected head, acceptance log, head advance, durable impact-outbox
 *     intent and the idempotency result. A failure anywhere moves nothing.
 *   - The idempotency key is bound to the exact request digest: a retry with
 *     the same key and bytes returns the recorded result exactly once; the
 *     same key with different bytes is refused.
 *   - Stale base or stale review ⇒ conflict carrying authorized current-head
 *     metadata. No last-writer-wins, no automatic rebase (an author re-proposes
 *     as a new proposalVersion and obtains review again).
 */

import {
    ContractRefusal,
    type ContractExpectedHead,
    type ContractHeadVector,
    type ContractImpact,
    type ContractRevisionManifest,
    type ContractUnitManifestEntry,
} from './contract-types.js';
import { assertIssued, inTxn, newId, type ContractCtx, type ContractPrincipal } from './contract-context.js';
import { computeRevisionId, digestOfRequest, normalizeManifest, sha256Bytes } from './contract-identity.js';
import { currentHeadVector, recheckPrincipal, repoBindingsFor } from './contract-authority.js';
import type { ContractSourceRequest } from './contract-git-source.js';
import { overlappingOpenGuards } from './contract-use-guards.js';

const UNIT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The actor identity used for review independence (a grant rotation does not make a coordinator a new reviewer). */
export function principalActor(p: ContractPrincipal): string {
    if (p.kind === 'owner') return 'owner';
    return `${p.kind}:${p.sessionId}`;
}

export function currentGcGeneration(ctx: ContractCtx): number {
    const row = ctx.db.prepare(`SELECT value FROM contract_store_meta WHERE key = 'gc_generation'`).get() as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
}

/** Stage bytes in the private bounded spool (content-addressed). Quota excess is a bounded refusal. */
export function stageSpoolBody(ctx: ContractCtx, bytes: Buffer): string {
    const digest = sha256Bytes(bytes);
    const existing = ctx.db.prepare('SELECT body IS NOT NULL AS live FROM contract_spool WHERE digest = ?').get(digest) as { live: number } | undefined;
    if (existing?.live) {
        // A new reference to an existing body: refresh its generation so an in-flight GC sweep cannot reclaim it.
        ctx.db.prepare('UPDATE contract_spool SET gc_generation = ? WHERE digest = ?').run(currentGcGeneration(ctx), digest);
        return digest;
    }
    if (ctx.db.prepare('SELECT 1 FROM contract_tombstones WHERE digest = ?').get(digest)) throw new ContractRefusal('unavailable');
    const used = (ctx.db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS n FROM contract_spool WHERE body IS NOT NULL').get() as { n: number }).n;
    if (used + bytes.length > ctx.budgets.maxSpoolBytes) throw new ContractRefusal('quota_exceeded');
    ctx.db.prepare(`INSERT OR REPLACE INTO contract_spool (digest, byte_length, body, gc_generation, created_at, purged_at, purge_reason)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)`).run(digest, bytes.length, bytes, currentGcGeneration(ctx), ctx.rt.nowMs());
    return digest;
}

export function isDigestPurged(ctx: ContractCtx, digest: string): boolean {
    return !!ctx.db.prepare('SELECT 1 FROM contract_tombstones WHERE digest = ?').get(digest);
}

export function readSpoolBody(ctx: ContractCtx, digest: string): Buffer | null {
    const row = ctx.db.prepare('SELECT body FROM contract_spool WHERE digest = ?').get(digest) as { body: Buffer | null } | undefined;
    if (!row?.body) return null;
    const bytes = Buffer.from(row.body);
    return sha256Bytes(bytes) === digest ? bytes : null;
}

export function getRevisionManifest(ctx: ContractCtx, revisionId: string): ContractRevisionManifest | null {
    const row = ctx.db.prepare('SELECT manifest_json FROM contract_revisions WHERE revision_id = ?').get(revisionId) as { manifest_json: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.manifest_json) as ContractRevisionManifest; } catch { return null; }
}

function sameHead(v: ContractHeadVector, e: ContractExpectedHead): boolean {
    return v.authorityEpoch === e.authorityEpoch && v.headGeneration === e.headGeneration
        && v.revisionId === e.revisionId && v.policyRevision === e.policyRevision;
}

function readExpected(e: unknown): ContractExpectedHead {
    const o = e as Partial<ContractExpectedHead> | null;
    if (!o || !Number.isSafeInteger(o.authorityEpoch) || !Number.isSafeInteger(o.headGeneration) || !Number.isSafeInteger(o.policyRevision)
        || !(o.revisionId === null || typeof o.revisionId === 'string')) throw new ContractRefusal('invalid_input');
    return { authorityEpoch: o.authorityEpoch!, headGeneration: o.headGeneration!, revisionId: o.revisionId as string | null, policyRevision: o.policyRevision! };
}

export type ProposedUnit =
    | {
        unitId: string;
        source: ContractSourceRequest;
        mediaType?: string;
        normativeType?: ContractUnitManifestEntry['normativeType'];
        applicationApiVersion?: string;
        dependsOn?: string[];
        roles?: string[];
    }
    | { unitId: string; carryForward: true };

export interface ProposeInput {
    namespaceId: string;
    proposalId?: string;
    baseHead: ContractExpectedHead;
    impact: ContractImpact;
    units: ProposedUnit[];
}

export interface ProposeResult {
    proposalId: string;
    proposalVersion: number;
    candidateRevisionId: string;
    base: ContractExpectedHead;
}

function strList(v: unknown, max: number): string[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== 'string' || !UNIT_ID_RE.test(x))) throw new ContractRefusal('invalid_input');
    return [...new Set(v as string[])];
}

export function proposeRevision(ctx: ContractCtx, principal: ContractPrincipal, input: ProposeInput): ProposeResult {
    assertIssued(principal);
    if (!input || typeof input.namespaceId !== 'string') throw new ContractRefusal('invalid_input');
    recheckPrincipal(ctx, principal, input.namespaceId, 'propose');
    const base = readExpected(input.baseHead);
    const current = currentHeadVector(ctx, input.namespaceId)!;
    if (!sameHead(current, base)) throw new ContractRefusal('head_conflict', { current });
    if (input.impact !== 'nonbreaking' && input.impact !== 'breaking') throw new ContractRefusal('invalid_input');
    if (!Array.isArray(input.units) || input.units.length === 0) throw new ContractRefusal('invalid_input');
    if (input.units.length > ctx.budgets.maxUnitsPerRevision) throw new ContractRefusal('budget_exceeded');

    const baseManifest = base.revisionId ? getRevisionManifest(ctx, base.revisionId) : null;
    const bindings = repoBindingsFor(ctx, input.namespaceId);
    const seen = new Set<string>();
    const units: ContractUnitManifestEntry[] = [];
    const bodies: Buffer[] = [];
    let total = 0;
    for (const u of input.units) {
        if (!u || typeof u.unitId !== 'string' || !UNIT_ID_RE.test(u.unitId) || seen.has(u.unitId)) throw new ContractRefusal('invalid_input');
        seen.add(u.unitId);
        if ('carryForward' in u) {
            const prior = baseManifest?.units.find(x => x.unitId === u.unitId);
            if (!prior || !readSpoolBody(ctx, prior.digest)) throw new ContractRefusal('source_unavailable');
            units.push(prior);
            total += prior.byteLength;
            continue;
        }
        const { entry, bytes } = ctx.sourceReader.resolveBlob(bindings, u.source, ctx.budgets.maxUnitBytes);
        total += bytes.length;
        if (total > ctx.budgets.maxRevisionBytes) throw new ContractRefusal('budget_exceeded');
        bodies.push(bytes);
        units.push({
            unitId: u.unitId,
            digest: entry.sha256,
            byteLength: bytes.length,
            mediaType: typeof u.mediaType === 'string' && u.mediaType.length <= 128 ? u.mediaType : 'text/markdown',
            normativeType: u.normativeType === 'api_schema' || u.normativeType === 'guide' ? u.normativeType : 'contract',
            ...(typeof u.applicationApiVersion === 'string' && u.applicationApiVersion.length <= 64 ? { applicationApiVersion: u.applicationApiVersion } : {}),
            dependsOn: strList(u.dependsOn, 32),
            roles: strList(u.roles, 16),
            sources: [entry],
        });
    }
    if (total > ctx.budgets.maxRevisionBytes) throw new ContractRefusal('budget_exceeded');
    for (const u of units) for (const d of u.dependsOn) if (!seen.has(d)) throw new ContractRefusal('invalid_input');

    const manifest = normalizeManifest({
        schema: 'adhdev.contract.revision/1',
        namespaceId: input.namespaceId,
        predecessorRevisionId: base.revisionId,
        impact: input.impact,
        units,
    });
    const revisionId = computeRevisionId(manifest);
    return inTxn(ctx, () => {
        recheckPrincipal(ctx, principal, input.namespaceId, 'propose');
        for (const b of bodies) stageSpoolBody(ctx, b);
        const now = ctx.rt.nowMs();
        ctx.db.prepare(`INSERT OR IGNORE INTO contract_revisions (revision_id, namespace_id, predecessor_revision_id, impact, manifest_json, total_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(revisionId, input.namespaceId, base.revisionId, input.impact, JSON.stringify(manifest), total, now);
        for (const u of manifest.units) {
            ctx.db.prepare(`INSERT OR IGNORE INTO contract_units (revision_id, unit_id, unit_digest, byte_length, roles_json) VALUES (?, ?, ?, ?, ?)`)
                .run(revisionId, u.unitId, u.digest, u.byteLength, JSON.stringify(u.roles));
        }
        const proposalId = typeof input.proposalId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.proposalId) ? input.proposalId : newId(ctx, 'prop');
        const prev = ctx.db.prepare('SELECT MAX(proposal_version) AS v, MIN(namespace_id) AS ns FROM contract_proposals WHERE proposal_id = ?').get(proposalId) as { v: number | null; ns: string | null };
        if (prev.ns && prev.ns !== input.namespaceId) throw new ContractRefusal('scope_mismatch');
        const proposalVersion = (prev.v ?? 0) + 1;
        // A newer version supersedes the open older ones of the same proposal (history preserved).
        ctx.db.prepare(`UPDATE contract_proposals SET status = 'superseded', closed_at = ? WHERE proposal_id = ? AND status = 'open'`).run(now, proposalId);
        ctx.db.prepare(`INSERT INTO contract_proposals (proposal_id, proposal_version, namespace_id, base_epoch, base_head_generation, base_revision_id,
            base_policy_revision, candidate_revision_id, impact, author_principal, status, created_at, closed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`)
            .run(proposalId, proposalVersion, input.namespaceId, base.authorityEpoch, base.headGeneration, base.revisionId, base.policyRevision,
                revisionId, input.impact, principalActor(principal), now);
        return { proposalId, proposalVersion, candidateRevisionId: revisionId, base };
    });
}

interface ProposalRow {
    proposal_id: string; proposal_version: number; namespace_id: string; base_epoch: number; base_head_generation: number;
    base_revision_id: string | null; base_policy_revision: number; candidate_revision_id: string; impact: string;
    author_principal: string; status: string;
}

function getProposal(ctx: ContractCtx, proposalId: string, proposalVersion: number): ProposalRow | null {
    return (ctx.db.prepare('SELECT * FROM contract_proposals WHERE proposal_id = ? AND proposal_version = ?').get(proposalId, proposalVersion) as ProposalRow | undefined) ?? null;
}

export function reviewProposal(ctx: ContractCtx, principal: ContractPrincipal, input: {
    proposalId: string; proposalVersion: number; candidateRevisionId: string; verdict: 'approve' | 'reject'; rationale?: string;
}): { reviewId: string } {
    assertIssued(principal);
    const p = getProposal(ctx, input?.proposalId, input?.proposalVersion);
    if (!p) throw new ContractRefusal('proposal_not_found');
    return inTxn(ctx, () => {
        const auth = recheckPrincipal(ctx, principal, p.namespace_id, 'review');
        if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
        if (p.status !== 'open') throw new ContractRefusal('proposal_not_open');
        // A review attaches only to these exact bytes; it cannot approve a later candidate implicitly.
        if (input.candidateRevisionId !== p.candidate_revision_id) throw new ContractRefusal('review_stale');
        if (auth.policy.requireIndependentReviewer && principalActor(principal) === p.author_principal) throw new ContractRefusal('review_not_independent');
        if (input.verdict !== 'approve' && input.verdict !== 'reject') throw new ContractRefusal('invalid_input');
        const reviewId = newId(ctx, 'rvw');
        const rationale = typeof input.rationale === 'string' ? input.rationale.slice(0, 4096) : null;
        ctx.db.prepare(`INSERT INTO contract_reviews (review_id, proposal_id, proposal_version, candidate_revision_id, base_head_generation, base_revision_id,
            policy_revision, reviewer_principal, verdict, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(reviewId, p.proposal_id, p.proposal_version, p.candidate_revision_id, p.base_head_generation, p.base_revision_id,
                auth.policyRevision, principalActor(principal), input.verdict, rationale, ctx.rt.nowMs());
        return { reviewId };
    });
}

export interface AcceptInput {
    proposalId: string;
    proposalVersion: number;
    expectedHead: ContractExpectedHead;
    idempotencyKey: string;
}

export interface AcceptResult {
    acceptanceId: string;
    vector: ContractHeadVector;
    duplicate: boolean;
}

/** Test seam: inject a crash at a named point inside the acceptance transaction (AC20 failure injection). */
let acceptFault: ((point: 'after_head_update' | 'after_outbox') => void) | null = null;
export function __setContractAcceptFaultForTests(f: typeof acceptFault): void { acceptFault = f; }

function changedUnits(ctx: ContractCtx, baseRevisionId: string | null, candidateRevisionId: string): string[] {
    const cand = getRevisionManifest(ctx, candidateRevisionId);
    const base = baseRevisionId ? getRevisionManifest(ctx, baseRevisionId) : null;
    const baseDigest = new Map((base?.units ?? []).map(u => [u.unitId, u.digest]));
    const out = new Set<string>();
    for (const u of cand?.units ?? []) if (baseDigest.get(u.unitId) !== u.digest) out.add(u.unitId);
    for (const id of baseDigest.keys()) if (!cand?.units.some(u => u.unitId === id)) out.add(id);
    return [...out].sort();
}

export function acceptProposal(ctx: ContractCtx, principal: ContractPrincipal, input: AcceptInput): AcceptResult {
    assertIssued(principal);
    if (!input || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey)) throw new ContractRefusal('invalid_input');
    const expected = readExpected(input.expectedHead);
    const p = getProposal(ctx, input.proposalId, input.proposalVersion);
    if (!p) throw new ContractRefusal('proposal_not_found');
    const requestDigest = digestOfRequest('accept', {
        proposalId: p.proposal_id, proposalVersion: p.proposal_version, candidate: p.candidate_revision_id,
        expected: { e: expected.authorityEpoch, g: expected.headGeneration, r: expected.revisionId, p: expected.policyRevision },
    });
    return inTxn(ctx, () => {
        const prior = ctx.db.prepare('SELECT request_digest, result_json FROM contract_idempotency WHERE namespace_id = ? AND idem_key = ?')
            .get(p.namespace_id, input.idempotencyKey) as { request_digest: string; result_json: string } | undefined;
        if (prior) {
            if (prior.request_digest !== requestDigest) throw new ContractRefusal('idempotency_conflict');
            return { ...(JSON.parse(prior.result_json) as Omit<AcceptResult, 'duplicate'>), duplicate: true };
        }
        const auth = recheckPrincipal(ctx, principal, p.namespace_id, 'accept');
        if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
        if (p.status !== 'open') throw new ContractRefusal('proposal_not_open');
        if (principal.kind === 'coordinator') {
            const impact = p.impact as ContractImpact;
            if (impact === 'breaking' && !(auth.policy.delegateBreaking && principal.maxImpact === 'breaking')) throw new ContractRefusal('impact_requires_owner');
            if (impact === 'nonbreaking' && !auth.policy.delegateNonbreaking) throw new ContractRefusal('impact_requires_owner');
        }
        const current = currentHeadVector(ctx, p.namespace_id)!;
        if (!sameHead(current, expected)) throw new ContractRefusal('head_conflict', { current });
        const base: ContractExpectedHead = { authorityEpoch: p.base_epoch, headGeneration: p.base_head_generation, revisionId: p.base_revision_id, policyRevision: p.base_policy_revision };
        if (!sameHead(current, base)) throw new ContractRefusal('head_conflict', { current });
        const reviews = ctx.db.prepare(`SELECT reviewer_principal, verdict, candidate_revision_id, base_head_generation, base_revision_id, policy_revision
            FROM contract_reviews WHERE proposal_id = ? AND proposal_version = ?`).all(p.proposal_id, p.proposal_version) as Array<{
                reviewer_principal: string; verdict: string; candidate_revision_id: string; base_head_generation: number; base_revision_id: string | null; policy_revision: number;
            }>;
        const valid = reviews.filter(r => r.candidate_revision_id === p.candidate_revision_id && r.base_head_generation === current.headGeneration
            && r.base_revision_id === current.revisionId && r.policy_revision === current.policyRevision
            && (!auth.policy.requireIndependentReviewer || r.reviewer_principal !== p.author_principal));
        if (valid.some(r => r.verdict === 'reject')) throw new ContractRefusal('review_missing');
        const approvers = new Set(valid.filter(r => r.verdict === 'approve').map(r => r.reviewer_principal));
        if (approvers.size < Math.max(0, auth.policy.reviewerQuorum)) throw new ContractRefusal(reviews.length > valid.length ? 'review_stale' : 'review_missing');
        // RN-02: an in-use guard (or one whose outcome is unknown) on an affected unit blocks acceptance; unrelated units do not.
        const affected = changedUnits(ctx, p.base_revision_id, p.candidate_revision_id);
        if (overlappingOpenGuards(ctx, p.namespace_id, affected).length > 0) throw new ContractRefusal('use_guard_conflict');

        const now = ctx.rt.nowMs();
        const acceptanceId = newId(ctx, 'acc');
        const nextGen = current.headGeneration + 1;
        ctx.db.prepare(`UPDATE contract_heads SET head_generation = ?, revision_id = ?, updated_at = ? WHERE namespace_id = ? AND head_generation = ?`)
            .run(nextGen, p.candidate_revision_id, now, p.namespace_id, current.headGeneration);
        ctx.db.prepare(`INSERT INTO contract_head_log (namespace_id, head_generation, authority_epoch, revision_id, prior_revision_id, policy_revision,
            acceptance_id, kind, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'accept', ?)`)
            .run(p.namespace_id, nextGen, current.authorityEpoch, p.candidate_revision_id, current.revisionId, current.policyRevision, acceptanceId, now);
        acceptFault?.('after_head_update');
        ctx.db.prepare(`UPDATE contract_proposals SET status = 'accepted', closed_at = ? WHERE proposal_id = ? AND proposal_version = ?`).run(now, p.proposal_id, p.proposal_version);
        ctx.db.prepare(`UPDATE contract_proposals SET status = 'superseded', closed_at = ? WHERE namespace_id = ? AND status = 'open'
            AND base_head_generation < ?`).run(now, p.namespace_id, nextGen);
        ctx.db.prepare(`INSERT INTO contract_impact_outbox (acceptance_id, namespace_id, authority_epoch, head_generation, revision_id, notice_class, scan_cursor, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'head_advanced', '', 'pending', ?)`).run(acceptanceId, p.namespace_id, current.authorityEpoch, nextGen, p.candidate_revision_id, now);
        acceptFault?.('after_outbox');
        const vector = currentHeadVector(ctx, p.namespace_id)!;
        const result = { acceptanceId, vector };
        ctx.db.prepare(`INSERT INTO contract_idempotency (namespace_id, idem_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(p.namespace_id, input.idempotencyKey, requestDigest, JSON.stringify(result), now);
        return { ...result, duplicate: false };
    });
}

export function closeProposal(ctx: ContractCtx, principal: ContractPrincipal, input: { proposalId: string; proposalVersion: number; status: 'rejected' | 'withdrawn' }): void {
    assertIssued(principal);
    const p = getProposal(ctx, input?.proposalId, input?.proposalVersion);
    if (!p) throw new ContractRefusal('proposal_not_found');
    inTxn(ctx, () => {
        if (input.status === 'withdrawn') {
            recheckPrincipal(ctx, principal, p.namespace_id, 'propose');
            if (principalActor(principal) !== p.author_principal && principal.kind !== 'owner') throw new ContractRefusal('not_authorized');
        } else if (input.status === 'rejected') {
            recheckPrincipal(ctx, principal, p.namespace_id, 'review');
            if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
        } else {
            throw new ContractRefusal('invalid_input');
        }
        if (p.status !== 'open') throw new ContractRefusal('proposal_not_open');
        ctx.db.prepare('UPDATE contract_proposals SET status = ?, closed_at = ? WHERE proposal_id = ? AND proposal_version = ?')
            .run(input.status, ctx.rt.nowMs(), p.proposal_id, p.proposal_version);
    });
}

/** Revoke an accepted revision: its own revocation generation + impact intent; results pinned to it are rejected. */
export function revokeRevision(ctx: ContractCtx, principal: ContractPrincipal, input: { namespaceId: string; revisionId: string }): ContractHeadVector {
    assertIssued(principal);
    return inTxn(ctx, () => {
        const auth = recheckPrincipal(ctx, principal, input.namespaceId, 'revoke');
        if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
        const known = ctx.db.prepare('SELECT 1 FROM contract_revisions WHERE revision_id = ? AND namespace_id = ?').get(input.revisionId, input.namespaceId);
        if (!known) throw new ContractRefusal('not_found');
        const gen = auth.revocationGeneration + 1;
        const now = ctx.rt.nowMs();
        ctx.db.prepare('UPDATE contract_authorities SET revocation_generation = ?, updated_at = ? WHERE namespace_id = ?').run(gen, now, input.namespaceId);
        ctx.db.prepare(`INSERT OR IGNORE INTO contract_revoked_revisions (namespace_id, revision_id, revocation_generation, revoked_at) VALUES (?, ?, ?, ?)`)
            .run(input.namespaceId, input.revisionId, gen, now);
        const head = currentHeadVector(ctx, input.namespaceId)!;
        ctx.db.prepare(`INSERT INTO contract_impact_outbox (acceptance_id, namespace_id, authority_epoch, head_generation, revision_id, notice_class, scan_cursor, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'revision_revoked', '', 'pending', ?)`).run(newId(ctx, 'rvk'), input.namespaceId, head.authorityEpoch, head.headGeneration, input.revisionId, now);
        return head;
    });
}

export function isRevisionRevoked(ctx: ContractCtx, namespaceId: string, revisionId: string | null): boolean {
    if (!revisionId) return false;
    return !!ctx.db.prepare('SELECT 1 FROM contract_revoked_revisions WHERE namespace_id = ? AND revision_id = ?').get(namespaceId, revisionId);
}
