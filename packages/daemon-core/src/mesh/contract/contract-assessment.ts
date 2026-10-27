/**
 * Contract versioning — evidence join at completion and the CENTRAL result
 * eligibility facade (design §8 last ¶s, §10, §15; F2; AC07, AC19, AC26, AC31; RN-01).
 *
 * Execution status ("did the runtime accept the task?") and version
 * eligibility ("may THIS exact result be used for THIS purpose under the
 * CURRENT authority?") are separate questions. Every normative consumer asks
 * the second one through `assessResultEligibility` / `assessTaskForPurpose`;
 * a warning wrapped around stale instructions is never a substitute.
 *
 *   - At a valid completion the daemon joins E1/E2/C1 of the exact
 *     (result, attempt, generation, binding) into an immutable evidence
 *     snapshot keyed by the result reference. The six-key report payload,
 *     deliveryId and prepared tuple are untouched (Cut A).
 *   - A strict result with no evidence row is HELD (missing rows mean held,
 *     never legacy) — this is what makes a crash between completion and the
 *     join safe: the join is replayed idempotently and nothing consumed it.
 *   - The facade reads the authenticated current vector itself; a caller
 *     vector is only an expected-value precondition. There is no decision
 *     cache, so a head/policy/revocation change is observed by the very next
 *     consumer call.
 *   - Quarantine origin, revoked pinned revisions and failed authentication
 *     are never eligible; no waiver promotes them.
 */

import { ContractRefusal, type ContractEligibility, type ContractHeadVector, type ContractResultRef, type ContractUsePurpose } from './contract-types.js';
import { assertIssued, inTxn, newId, type ContractCtx, type ContractPrincipal } from './contract-context.js';
import { domainDigest, resultKeyOf } from './contract-identity.js';
import { authorityReadable, currentHeadVector, getAuthority, recheckPrincipal } from './contract-authority.js';
import { getPinSet, getTaskScope, listBindingsForTask } from './contract-pins.js';
import { isDigestPurged, isRevisionRevoked } from './contract-proposals.js';
import { rangesCoverAll, servedRanges } from './contract-reads.js';
import { insertUseGuard, type ContractUseGuard } from './contract-use-guards.js';

export interface ContractEvidenceSnapshot {
    bindingId: string | null;
    pinSetId: string | null;
    e1: { blockDigest: string; stage: string } | null;
    units: Array<{ unitId: string; unitDigest: string; e2Full: boolean; e2ReadIds: string[]; c1ClaimIds: string[] }>;
}

interface EvidenceRow {
    result_key: string; mesh_id: string; task_id: string; attempt_id: string; generation: number; output_version: number;
    payload_digest: string; namespace_id: string; binding_id: string | null; pin_set_id: string | null; evidence_json: string;
    snapshot_digest: string; provenance: string;
}

export function getResultEvidence(ctx: ContractCtx, resultKey: string): (EvidenceRow & { evidence: ContractEvidenceSnapshot }) | null {
    const r = ctx.db.prepare('SELECT * FROM contract_result_evidence WHERE result_key = ?').get(resultKey) as EvidenceRow | undefined;
    if (!r) return null;
    return { ...r, evidence: JSON.parse(r.evidence_json) as ContractEvidenceSnapshot };
}

function buildSnapshot(ctx: ContractCtx, ref: ContractResultRef, sessionId: string | undefined): ContractEvidenceSnapshot {
    const bindings = listBindingsForTask(ctx, ref.meshId, ref.taskId)
        .filter(b => b.attemptId === ref.attemptId && b.generation === ref.generation && (!sessionId || b.recipientSessionId === sessionId));
    // The binding that was ACTIVE for this exact attempt/generation/session. A superseded one is historical, not current evidence.
    const binding = bindings.filter(b => b.state === 'active').pop() ?? null;
    if (!binding) return { bindingId: null, pinSetId: null, e1: null, units: [] };
    const row = ctx.db.prepare('SELECT block_digest, e1_stage FROM contract_bindings WHERE binding_id = ?').get(binding.bindingId) as { block_digest: string; e1_stage: string };
    const pinSet = getPinSet(ctx, binding.pinSetId);
    const claims = ctx.db.prepare('SELECT claim_id, units_json FROM contract_claims WHERE binding_id = ?').all(binding.bindingId) as Array<{ claim_id: string; units_json: string }>;
    const units = (pinSet?.pins ?? []).map((p) => {
        const ranges = servedRanges(ctx, binding.bindingId, p.unitId, p.unitDigest);
        const c1 = claims.filter(c => (JSON.parse(c.units_json) as Array<{ unitId: string; unitDigest: string }>)
            .some(u => u.unitId === p.unitId && u.unitDigest === p.unitDigest)).map(c => c.claim_id);
        return { unitId: p.unitId, unitDigest: p.unitDigest, e2Full: rangesCoverAll(ranges, p.byteLength), e2ReadIds: ranges.map(r => r.readId), c1ClaimIds: c1 };
    });
    return { bindingId: binding.bindingId, pinSetId: binding.pinSetId, e1: { blockDigest: row.block_digest, stage: row.e1_stage }, units };
}

/** Test seam: crash between the completion commit and the evidence join (AC07). */
let joinFault: (() => void) | null = null;
export function __setContractEvidenceJoinFaultForTests(f: typeof joinFault): void { joinFault = f; }

/**
 * Freeze the evidence snapshot for an exact result. Idempotent per result
 * reference (replay creates exactly one). Returns null for an unscoped task.
 */
export function recordResultEvidence(ctx: ContractCtx, ref: ContractResultRef, opts: { sessionId?: string; provenance?: 'execution' | 'quarantine' } = {}): { resultKey: string; created: boolean } | null {
    const scope = getTaskScope(ctx, ref.meshId, ref.taskId);
    if (!scope) return null;
    joinFault?.();
    const resultKey = resultKeyOf(ref);
    return inTxn(ctx, () => {
        if (ctx.db.prepare('SELECT 1 FROM contract_result_evidence WHERE result_key = ?').get(resultKey)) return { resultKey, created: false };
        const snapshot = opts.provenance === 'quarantine'
            ? { bindingId: null, pinSetId: null, e1: null, units: [] }
            : buildSnapshot(ctx, ref, opts.sessionId);
        const snapshotDigest = domainDigest('evidence', JSON.parse(JSON.stringify(snapshot)));
        ctx.db.prepare(`INSERT INTO contract_result_evidence (result_key, mesh_id, task_id, attempt_id, generation, output_version, payload_digest,
            namespace_id, binding_id, pin_set_id, evidence_json, snapshot_digest, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(resultKey, ref.meshId, ref.taskId, ref.attemptId, ref.generation, ref.outputVersion, ref.payloadDigest, scope.namespaceId,
                snapshot.bindingId, snapshot.pinSetId, JSON.stringify(snapshot), snapshotDigest, opts.provenance ?? 'execution', ctx.rt.nowMs());
        return { resultKey, created: true };
    });
}

function vectorsEqual(a: ContractHeadVector, b: ContractHeadVector): boolean {
    return a.namespaceId === b.namespaceId && a.authorityEpoch === b.authorityEpoch && a.headGeneration === b.headGeneration
        && a.revisionId === b.revisionId && a.policyRevision === b.policyRevision;
}

function matchingRevalidation(ctx: ContractCtx, resultKey: string, purpose: ContractUsePurpose, v: ContractHeadVector): { decision: string } | null {
    const rows = ctx.db.prepare(`SELECT decision, authority_epoch, head_generation, revision_id, policy_revision, revocation_generation, expires_at
        FROM contract_revalidations WHERE result_key = ? AND purpose = ? ORDER BY created_at DESC`).all(resultKey, purpose) as Array<{
            decision: string; authority_epoch: number; head_generation: number; revision_id: string | null; policy_revision: number;
            revocation_generation: number; expires_at: number | null;
        }>;
    const now = ctx.rt.nowMs();
    return rows.find(r => r.authority_epoch === v.authorityEpoch && r.head_generation === v.headGeneration && r.revision_id === v.revisionId
        && r.policy_revision === v.policyRevision && r.revocation_generation === v.revocationGeneration
        && (r.expires_at === null || r.expires_at > now)) ?? null;
}

const usable = (state: ContractEligibility['state']) => state === 'eligible' || state === 'waived' || state === 'compat_open';

export function assessResultEligibility(ctx: ContractCtx, resultKey: string, purpose: ContractUsePurpose): ContractEligibility {
    const ev = getResultEvidence(ctx, resultKey);
    const out = (state: ContractEligibility['state'], reasons: string[], extra: Partial<ContractEligibility> = {}): ContractEligibility =>
        ({ state, usable: usable(state), reasons, resultKey, ...extra });
    if (!ev) return out('held_missing_evidence', ['evidence_pending']);
    if (ev.provenance !== 'execution') return out('rejected_ineligible_origin', ['quarantine_origin'], { namespaceId: ev.namespace_id });
    const auth = authorityReadable(ctx, ev.namespace_id);
    if (!auth) return out('unavailable', ['authority_unavailable'], { namespaceId: ev.namespace_id });
    const vector = currentHeadVector(ctx, ev.namespace_id)!;
    const extra = { namespaceId: ev.namespace_id, vector };
    const pinSet = ev.pin_set_id ? getPinSet(ctx, ev.pin_set_id) : null;
    if (!pinSet) return out('held_missing_evidence', ['binding_missing'], extra);
    if (isRevisionRevoked(ctx, ev.namespace_id, pinSet.vector.revisionId)) return out('rejected_revoked', ['pinned_revision_revoked'], extra);
    if (pinSet.pins.some(p => isDigestPurged(ctx, p.unitDigest))) return out('unavailable', ['unit_purged'], extra);
    const reval = matchingRevalidation(ctx, resultKey, purpose, vector);
    if (reval?.decision === 'waiver') return out('waived', ['scoped_waiver'], extra);
    const missing: string[] = [];
    for (const u of ev.evidence.units) {
        if (!u.e2Full) missing.push(`missing_e2:${u.unitId}`);
        if (auth.policy.evidenceMode === 'E2+C1' && u.c1ClaimIds.length === 0) missing.push(`missing_c1:${u.unitId}`);
    }
    if (ev.evidence.units.length === 0) missing.push('no_pinned_units');
    if (missing.length) return out('held_missing_evidence', missing, extra);
    if (!vectorsEqual(pinSet.vector, vector)) {
        if (reval?.decision === 'compatible') return out('eligible', ['revalidated'], extra);
        return out('needs_revalidation', ['head_changed'], extra);
    }
    return out('eligible', auth.policy.evidenceMode === 'E2' ? ['served_bytes_only'] : [], extra);
}

/**
 * Facade for consumers that know a task, not a result: compat-open for an
 * unscoped task; otherwise assess the exact latest terminal output.
 */
export function assessTaskForPurpose(ctx: ContractCtx, input: {
    meshId: string; taskId: string; purpose: ContractUsePurpose;
    latestOutput: { version: number; digest: string } | null;
}): ContractEligibility {
    const scope = getTaskScope(ctx, input.meshId, input.taskId);
    if (!scope) return { state: 'compat_open', usable: true, reasons: [] };
    if (scope.mode === 'advisory') return { state: 'compat_open', usable: true, reasons: ['advisory_no_strict_guarantee'], namespaceId: scope.namespaceId };
    if (!input.latestOutput) return { state: 'held_missing_evidence', usable: false, reasons: ['no_output'], namespaceId: scope.namespaceId };
    const row = ctx.db.prepare(`SELECT result_key FROM contract_result_evidence WHERE mesh_id = ? AND task_id = ? AND output_version = ? AND payload_digest = ?
        ORDER BY created_at DESC LIMIT 1`).get(input.meshId, input.taskId, input.latestOutput.version, input.latestOutput.digest) as { result_key: string } | undefined;
    if (!row) return { state: 'held_missing_evidence', usable: false, reasons: ['evidence_pending'], namespaceId: scope.namespaceId };
    return assessResultEligibility(ctx, row.result_key, input.purpose);
}

/**
 * Revalidation by an authorized assessor (owner, or coordinator with `assess`)
 * over the EXACT result, purpose and current vector. Workers cannot self-assess.
 */
export function revalidateResult(ctx: ContractCtx, principal: ContractPrincipal, input: {
    resultKey: string; purpose: ContractUsePurpose; expectedVector: ContractHeadVector; decision: 'compatible' | 'waiver'; reason: string; expiresAt?: number;
}): { revalidationId: string; eligibility: ContractEligibility } {
    assertIssued(principal);
    if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
    const ev = getResultEvidence(ctx, input?.resultKey);
    if (!ev) throw new ContractRefusal('not_found');
    return inTxn(ctx, () => {
        const auth = recheckPrincipal(ctx, principal, ev.namespace_id, 'assess');
        if (ev.provenance !== 'execution') throw new ContractRefusal('ineligible_origin');
        const pinSet = ev.pin_set_id ? getPinSet(ctx, ev.pin_set_id) : null;
        if (pinSet && isRevisionRevoked(ctx, ev.namespace_id, pinSet.vector.revisionId)) throw new ContractRefusal('revoked');
        const vector = currentHeadVector(ctx, ev.namespace_id)!;
        const e = input.expectedVector;
        if (!e || !vectorsEqual(vector, e) || e.revocationGeneration !== vector.revocationGeneration) throw new ContractRefusal('vector_mismatch', { current: vector });
        if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 512) throw new ContractRefusal('invalid_input');
        let expiresAt: number | null = null;
        if (input.decision === 'waiver') {
            if (!auth.policy.allowWaivers) throw new ContractRefusal('waiver_not_allowed');
            const now = ctx.rt.nowMs();
            if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt! <= now || input.expiresAt! > now + auth.policy.maxWaiverTtlMs) throw new ContractRefusal('invalid_input');
            expiresAt = input.expiresAt!;
        } else if (input.decision !== 'compatible') {
            throw new ContractRefusal('invalid_input');
        }
        const revalidationId = newId(ctx, 'rvl');
        ctx.db.prepare(`INSERT INTO contract_revalidations (revalidation_id, result_key, purpose, namespace_id, authority_epoch, head_generation, revision_id,
            policy_revision, revocation_generation, decision, assessor_principal, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(revalidationId, input.resultKey, input.purpose, ev.namespace_id, vector.authorityEpoch, vector.headGeneration, vector.revisionId,
                vector.policyRevision, vector.revocationGeneration, input.decision, principal.principalId, input.reason.trim(), expiresAt, ctx.rt.nowMs());
        return { revalidationId, eligibility: assessResultEligibility(ctx, input.resultKey, input.purpose) };
    });
}

/**
 * RN-02 linearization point for a multi-stage consumer: assess every result
 * for the purpose and, only if ALL are usable at the current vector, open a
 * guard scoped to their namespace + pinned units — atomically.
 */
export function beginGuardedUse(ctx: ContractCtx, input: { namespaceId: string; resultKeys: readonly string[]; purpose: ContractUsePurpose }): {
    guard: ContractUseGuard | null; decisions: ContractEligibility[];
} {
    return inTxn(ctx, () => {
        const decisions = input.resultKeys.map(k => assessResultEligibility(ctx, k, input.purpose));
        if (decisions.some(d => !d.usable)) return { guard: null, decisions };
        const auth = getAuthority(ctx, input.namespaceId);
        const vector = currentHeadVector(ctx, input.namespaceId);
        if (!auth || !vector) return { guard: null, decisions };
        const units = new Set<string>();
        for (const k of input.resultKeys) {
            const ev = getResultEvidence(ctx, k);
            for (const u of ev?.evidence.units ?? []) units.add(u.unitId);
        }
        const guard = insertUseGuard(ctx, {
            namespaceId: input.namespaceId, units: [...units], resultKeys: input.resultKeys, purpose: input.purpose, vector,
            processIncarnation: auth.processIncarnation,
        });
        return { guard, decisions };
    });
}
