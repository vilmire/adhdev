/**
 * Contract versioning — GC with a generation barrier, privileged legal purge,
 * and authenticated audit-only quarantine of late historical reports
 * (design §9, §12; F6/F7; AC18, AC19, AC24).
 *
 * GC: mark every body reachable from a retention root (current/past heads,
 * pin sets, result evidence, open proposals and closed ones inside the O8
 * window, quarantine records, open/unknown use guards), then sweep only
 * bodies staged BEFORE the barrier. A reference added between mark and sweep
 * re-stamps its body with the new generation and survives. Git reachability
 * is never consulted: a deleted branch does not free a pinned body.
 *
 * Legal purge is an explicit owner operation: the body is removed, a
 * content-free tombstone stays, and every dependent read/assessment reports
 * `unavailable` — never a silent fallback to current file bytes.
 *
 * Quarantine (O5 approved default: prepared-provenance-only): a historical
 * report with verified prepared provenance is stored privately as AUDIT-ONLY
 * evidence and is permanently ineligible as a normative completion. Without
 * provenance (or under the refusal_local_only policy) the answer is a
 * content-free refusal and the caller keeps its local body. A receipt is only
 * returned after the body is durable; quota/storage failure returns PENDING so
 * the caller retains the bytes. No existing outbox wire code is changed here.
 */

import { ContractRefusal } from './contract-types.js';
import { assertOwner, inTxn, newId, type ContractCtx, type OwnerPrincipal } from './contract-context.js';
import { currentGcGeneration, stageSpoolBody } from './contract-proposals.js';
export { isDigestPurged } from './contract-proposals.js';
import { sha256Bytes } from './contract-identity.js';
import { getAuthority } from './contract-authority.js';
import { getTaskScope } from './contract-pins.js';
import { recordResultEvidence } from './contract-assessment.js';

export interface ContractGcPlan { generation: number; marked: Set<string> }

function rootedRevisionIds(ctx: ContractCtx): Set<string> {
    const cutoff = ctx.rt.nowMs() - ctx.budgets.closedProposalRetentionMs;
    const ids = new Set<string>();
    const add = (rows: Array<{ id: string | null }>) => { for (const r of rows) if (r.id) ids.add(r.id); };
    add(ctx.db.prepare('SELECT revision_id AS id FROM contract_heads').all() as Array<{ id: string | null }>);
    add(ctx.db.prepare('SELECT revision_id AS id FROM contract_head_log').all() as Array<{ id: string | null }>);
    add(ctx.db.prepare('SELECT revision_id AS id FROM contract_pin_sets').all() as Array<{ id: string | null }>);
    add(ctx.db.prepare(`SELECT candidate_revision_id AS id FROM contract_proposals WHERE status = 'open' OR status = 'accepted' OR closed_at > ?`).all(cutoff) as Array<{ id: string | null }>);
    add(ctx.db.prepare(`SELECT base_revision_id AS id FROM contract_proposals WHERE status = 'open'`).all() as Array<{ id: string | null }>);
    return ids;
}

/** Phase 1: raise the barrier and mark. */
export function beginContractGc(ctx: ContractCtx): ContractGcPlan {
    const generation = currentGcGeneration(ctx) + 1;
    ctx.db.prepare(`INSERT OR REPLACE INTO contract_store_meta (key, value) VALUES ('gc_generation', ?)`).run(String(generation));
    const marked = new Set<string>();
    for (const revId of rootedRevisionIds(ctx)) {
        for (const u of ctx.db.prepare('SELECT unit_digest FROM contract_units WHERE revision_id = ?').all(revId) as Array<{ unit_digest: string }>) marked.add(u.unit_digest);
    }
    for (const p of ctx.db.prepare('SELECT pins_json FROM contract_pin_sets').all() as Array<{ pins_json: string }>) {
        for (const pin of JSON.parse(p.pins_json) as Array<{ unitDigest: string }>) marked.add(pin.unitDigest);
    }
    for (const q of ctx.db.prepare('SELECT body_digest FROM contract_audit_quarantine').all() as Array<{ body_digest: string }>) marked.add(q.body_digest);
    return { generation, marked };
}

/** Phase 2: sweep unmarked bodies staged before the barrier. */
export function sweepContractGc(ctx: ContractCtx, plan: ContractGcPlan): { reclaimed: number } {
    return inTxn(ctx, () => {
        const rows = ctx.db.prepare('SELECT digest FROM contract_spool WHERE body IS NOT NULL AND gc_generation < ?').all(plan.generation) as Array<{ digest: string }>;
        let reclaimed = 0;
        for (const r of rows) {
            if (plan.marked.has(r.digest)) continue;
            ctx.db.prepare('DELETE FROM contract_spool WHERE digest = ? AND gc_generation < ?').run(r.digest, plan.generation);
            reclaimed += 1;
        }
        const tombCutoff = ctx.rt.nowMs() - ctx.budgets.tombstoneRetentionMs;
        ctx.db.prepare(`DELETE FROM contract_idempotency WHERE created_at < ? AND namespace_id NOT IN (SELECT namespace_id FROM contract_authorities)`).run(tombCutoff);
        return { reclaimed };
    });
}

export function runContractGc(ctx: ContractCtx): { reclaimed: number } {
    return sweepContractGc(ctx, beginContractGc(ctx));
}

/** Owner-only legal purge: body removed, content-free tombstone kept, dependents become unavailable. */
export function legalPurgeBody(ctx: ContractCtx, owner: OwnerPrincipal, digest: string, reason: 'legal' | 'privacy' | 'owner_request'): boolean {
    assertOwner(owner);
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new ContractRefusal('invalid_input');
    return inTxn(ctx, () => {
        const now = ctx.rt.nowMs();
        const r = ctx.db.prepare(`UPDATE contract_spool SET body = NULL, purged_at = ?, purge_reason = ? WHERE digest = ?`).run(now, reason, digest);
        ctx.db.prepare(`INSERT OR REPLACE INTO contract_tombstones (digest, reason, purged_at) VALUES (?, ?, ?)`).run(digest, reason, now);
        return r.changes > 0;
    });
}

// ─── Audit-only quarantine ─────────────────────────────────────────────

export type ContractQuarantineDisposition =
    | { disposition: 'audit_only'; receipt: { quarantineId: string; deliveryId: string; payloadDigest: string; durable: true; duplicate: boolean } }
    | { disposition: 'refused_no_provenance' | 'refused_local_only' | 'digest_conflict' | 'unscoped' }
    | { disposition: 'pending'; reason: 'quota' | 'storage' };

export function quarantineHistoricalReport(ctx: ContractCtx, input: {
    deliveryId: string;
    meshId: string;
    taskId: string;
    attemptId?: string;
    generation?: number;
    body: Buffer;
    payloadDigest: string;
    /** Content-free prepared tuple identity (deliveryId, attempt, preparedAt …) — NOT proof of authorship time. */
    preparedTuple: Record<string, string | number>;
    /** The caller verified this is an authenticated historical prepared identity of verified origin. */
    provenanceVerified: boolean;
}): ContractQuarantineDisposition {
    const scope = getTaskScope(ctx, input.meshId, input.taskId);
    if (!scope) return { disposition: 'unscoped' };
    const auth = getAuthority(ctx, scope.namespaceId);
    if (auth?.policy.lateReportMode === 'refusal_local_only') return { disposition: 'refused_local_only' };
    if (!input.provenanceVerified) return { disposition: 'refused_no_provenance' };
    if (typeof input.deliveryId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.deliveryId)) throw new ContractRefusal('invalid_input');
    if (!Buffer.isBuffer(input.body) || sha256Bytes(input.body) !== input.payloadDigest) throw new ContractRefusal('invalid_input');
    const prior = ctx.db.prepare('SELECT quarantine_id, payload_digest FROM contract_audit_quarantine WHERE delivery_id = ?').get(input.deliveryId) as
        { quarantine_id: string; payload_digest: string } | undefined;
    if (prior) {
        if (prior.payload_digest !== input.payloadDigest) return { disposition: 'digest_conflict' };
        return { disposition: 'audit_only', receipt: { quarantineId: prior.quarantine_id, deliveryId: input.deliveryId, payloadDigest: input.payloadDigest, durable: true, duplicate: true } };
    }
    if (input.body.length > ctx.budgets.maxQuarantineBodyBytes) return { disposition: 'pending', reason: 'quota' };
    const used = (ctx.db.prepare(`SELECT COALESCE(SUM(s.byte_length), 0) AS n FROM contract_audit_quarantine q JOIN contract_spool s ON s.digest = q.body_digest`).get() as { n: number }).n;
    if (used + input.body.length > ctx.budgets.maxQuarantineBytes) return { disposition: 'pending', reason: 'quota' };
    try {
        return inTxn(ctx, () => {
            const bodyDigest = stageSpoolBody(ctx, input.body);
            const quarantineId = newId(ctx, 'qtn');
            ctx.db.prepare(`INSERT INTO contract_audit_quarantine (quarantine_id, delivery_id, mesh_id, task_id, attempt_id, payload_digest, body_digest,
                prepared_tuple_json, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'historical_authenticated', ?)`)
                .run(quarantineId, input.deliveryId, input.meshId, input.taskId, input.attemptId ?? null, input.payloadDigest, bodyDigest,
                    JSON.stringify(input.preparedTuple ?? {}), ctx.rt.nowMs());
            // Immutable non-eligible origin, joinable by the same eligibility facade (always rejected).
            recordResultEvidence(ctx, {
                meshId: input.meshId, taskId: input.taskId, attemptId: input.attemptId ?? `quarantine:${input.deliveryId}`,
                generation: input.generation ?? -1, outputVersion: 0, payloadDigest: input.payloadDigest,
            }, { provenance: 'quarantine' });
            return { disposition: 'audit_only' as const, receipt: { quarantineId, deliveryId: input.deliveryId, payloadDigest: input.payloadDigest, durable: true as const, duplicate: false } };
        });
    } catch (e) {
        if (e instanceof ContractRefusal && e.code === 'quota_exceeded') return { disposition: 'pending', reason: 'quota' };
        return { disposition: 'pending', reason: 'storage' };
    }
}
