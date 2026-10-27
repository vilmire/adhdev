/**
 * Contract versioning — durable impact fan-out and change notices (design §11, F9; AC20, AC21, AC28).
 *
 *   - Acceptance writes ONE durable impact descriptor inside its transaction
 *     (contract-proposals.ts). Fan-out here is asynchronous and resumable: a
 *     bounded scan over active bindings with a persisted cursor, so a crash
 *     after acceptance loses neither the intent nor its progress.
 *   - Each notice has a SEMANTIC key over (namespace, epoch, head generation,
 *     target revision, task, attempt, generation, binding, class) — R1→R2→R1
 *     stays three distinct events; a retry of one event is INSERT-OR-IGNORE.
 *     The semantic key is separate from any native submit operation id.
 *   - A mailbox/PTY hint is content-free (no prose, path or secret), sent at
 *     most once per semantic notice and only through the injected port, which
 *     owns the existing lifecycle/uncertainty rules. A hint never marks a read.
 *   - Fan-out lag never authorizes stale use: admission and assessment compare
 *     the current head directly. A full per-binding backlog is compacted to the
 *     newest notice of the class (the pull path always returns the current
 *     head, so semantic coverage is retained) — never silently dropped.
 */

import { computeNoticeKey } from './contract-identity.js';
import { inTxn, type ContractCtx } from './contract-context.js';
import { getPinSet } from './contract-pins.js';

export interface ContractHintPort {
    /** Deliver a content-free hint for `bindingId`; return an operation id when accepted, null when not safely deliverable now. */
    deliver(input: { meshId: string; taskId: string; bindingId: string; noticeClass: string }): string | null;
}

interface OutboxRow {
    acceptance_id: string; namespace_id: string; authority_epoch: number; head_generation: number; revision_id: string | null;
    notice_class: string; scan_cursor: string; status: string;
}

interface BindingScanRow {
    binding_id: string; mesh_id: string; task_id: string; attempt_id: string; generation: number; pin_set_id: string;
}

/** Process pending impact descriptors, at most `limit` bindings per call. Returns notices created. */
export function processImpactOutbox(ctx: ContractCtx, opts: { limit?: number; hints?: ContractHintPort | null } = {}): number {
    const limit = Math.max(1, opts.limit ?? 200);
    let created = 0;
    let budget = limit;
    const pending = ctx.db.prepare(`SELECT * FROM contract_impact_outbox WHERE status = 'pending' ORDER BY created_at`).all() as OutboxRow[];
    for (const o of pending) {
        if (budget <= 0) break;
        const rows = ctx.db.prepare(`SELECT binding_id, mesh_id, task_id, attempt_id, generation, pin_set_id FROM contract_bindings
            WHERE namespace_id = ? AND state = 'active' AND binding_id > ? ORDER BY binding_id LIMIT ?`)
            .all(o.namespace_id, o.scan_cursor, budget) as BindingScanRow[];
        inTxn(ctx, () => {
            for (const b of rows) {
                const pin = getPinSet(ctx, b.pin_set_id);
                const affected = o.notice_class === 'revision_revoked'
                    ? pin?.vector.revisionId === o.revision_id
                    : !pin || pin.vector.authorityEpoch < o.authority_epoch || pin.vector.headGeneration < o.head_generation;
                if (affected) {
                    const key = computeNoticeKey({
                        namespaceId: o.namespace_id, authorityEpoch: o.authority_epoch, headGeneration: o.head_generation,
                        toRevisionId: o.revision_id, taskId: b.task_id, attemptId: b.attempt_id, generation: b.generation,
                        bindingId: b.binding_id, noticeClass: o.notice_class,
                    });
                    const r = ctx.db.prepare(`INSERT OR IGNORE INTO contract_notices (notice_key, namespace_id, binding_id, mesh_id, task_id, attempt_id, generation,
                        authority_epoch, head_generation, to_revision_id, notice_class, state, hint_operation_id, created_at, delivered_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`)
                        .run(key, o.namespace_id, b.binding_id, b.mesh_id, b.task_id, b.attempt_id, b.generation, o.authority_epoch, o.head_generation,
                            o.revision_id, o.notice_class, ctx.rt.nowMs());
                    created += r.changes;
                    compactBacklog(ctx, b.binding_id, o.notice_class);
                }
                ctx.db.prepare('UPDATE contract_impact_outbox SET scan_cursor = ? WHERE acceptance_id = ?').run(b.binding_id, o.acceptance_id);
            }
            if (rows.length < budget) ctx.db.prepare(`UPDATE contract_impact_outbox SET status = 'done' WHERE acceptance_id = ?`).run(o.acceptance_id);
        });
        budget -= rows.length;
    }
    if (opts.hints) deliverPendingHints(ctx, opts.hints);
    return created;
}

function compactBacklog(ctx: ContractCtx, bindingId: string, noticeClass: string): void {
    const pending = ctx.db.prepare(`SELECT notice_key FROM contract_notices WHERE binding_id = ? AND state = 'pending' AND notice_class = ?
        ORDER BY authority_epoch DESC, head_generation DESC`).all(bindingId, noticeClass) as Array<{ notice_key: string }>;
    if (pending.length <= ctx.budgets.maxPendingNoticesPerBinding) return;
    const stmt = ctx.db.prepare(`UPDATE contract_notices SET state = 'superseded' WHERE notice_key = ?`);
    for (const n of pending.slice(ctx.budgets.maxPendingNoticesPerBinding)) stmt.run(n.notice_key);
}

/** Content-free hint, at most once per semantic notice; never retried blindly on uncertainty. */
export function deliverPendingHints(ctx: ContractCtx, port: ContractHintPort): number {
    const rows = ctx.db.prepare(`SELECT notice_key, mesh_id, task_id, binding_id, notice_class FROM contract_notices
        WHERE state = 'pending' AND hint_operation_id IS NULL ORDER BY created_at LIMIT 100`).all() as Array<{
            notice_key: string; mesh_id: string; task_id: string; binding_id: string; notice_class: string;
        }>;
    let sent = 0;
    for (const n of rows) {
        let op: string | null = null;
        try { op = port.deliver({ meshId: n.mesh_id, taskId: n.task_id, bindingId: n.binding_id, noticeClass: n.notice_class }); } catch { op = null; }
        if (!op) continue;
        ctx.db.prepare(`UPDATE contract_notices SET hint_operation_id = ? WHERE notice_key = ? AND hint_operation_id IS NULL`).run(op, n.notice_key);
        sent += 1;
    }
    return sent;
}
