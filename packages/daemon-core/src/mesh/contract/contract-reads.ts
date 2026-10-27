/**
 * Contract versioning — Cut A read evidence (design §8, F3; AC06, AC16, AC21, AC28).
 *
 *   E2  `contract_read`: the daemon serves verified bytes of a PINNED unit to
 *       the authenticated worker of the ACTIVE binding and records exactly
 *       what it served (unit digest, byte range, length, time, binding,
 *       session). A served-byte receipt is NOT a semantic read — it says the
 *       daemon handed these bytes over the private command path, nothing more.
 *   C1  `contract_observe`: the worker's explicit claim that it read the named
 *       exact units. Accepted only over FULL served coverage of the SAME
 *       binding; it cannot create missing E2 and serving bytes never creates it.
 *   `contract_current`: authenticated pull of the authoritative head vector
 *       plus durable pending notices for the caller's binding. Marking a notice
 *       transport-delivered is a receipt, never a read claim.
 *
 * Cut A changes nothing in the six-key completion payload; evidence is joined
 * daemon-side by binding at completion (contract-assessment.ts).
 */

import { ContractRefusal, type ContractHeadVector } from './contract-types.js';
import { assertIssued, inTxn, newId, type ContractCtx, type WorkerPrincipal } from './contract-context.js';
import { authorityReadable, currentHeadVector } from './contract-authority.js';
import { getPinSet, requireActiveBinding, activeBindingForTask, type ContractBinding } from './contract-pins.js';
import { readSpoolBody } from './contract-proposals.js';

function assertWorker(p: unknown): asserts p is WorkerPrincipal {
    assertIssued(p);
    if ((p as WorkerPrincipal).kind !== 'worker') throw new ContractRefusal('not_authorized');
}

/** Union of served [start, end) ranges covers [0, length). */
export function rangesCoverAll(ranges: ReadonlyArray<{ start: number; end: number }>, length: number): boolean {
    if (length === 0) return ranges.length > 0;
    const sorted = [...ranges].filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
    let reach = 0;
    for (const r of sorted) {
        if (r.start > reach) return false;
        reach = Math.max(reach, r.end);
        if (reach >= length) return true;
    }
    return reach >= length;
}

export function servedRanges(ctx: ContractCtx, bindingId: string, unitId: string, unitDigest: string): Array<{ start: number; end: number; readId: string }> {
    return (ctx.db.prepare(`SELECT read_id, range_start, range_end FROM contract_reads WHERE binding_id = ? AND unit_id = ? AND unit_digest = ? AND outcome = 'served'`)
        .all(bindingId, unitId, unitDigest) as Array<{ read_id: string; range_start: number; range_end: number }>)
        .map(r => ({ start: r.range_start, end: r.range_end, readId: r.read_id }));
}

export interface ContractReadResult {
    readId: string;
    unitId: string;
    revisionId: string;
    unitDigest: string;
    unitLength: number;
    rangeStart: number;
    rangeEnd: number;
    encoding: 'utf8' | 'base64';
    content: string;
    /** This binding has now been served every byte of the unit (still not a semantic read). */
    fullCoverage: boolean;
}

/** Test seam: fail the serve after the binding check (interrupted read — AC06). */
let readFault: (() => void) | null = null;
export function __setContractReadFaultForTests(f: typeof readFault): void { readFault = f; }

export function contractRead(ctx: ContractCtx, worker: WorkerPrincipal, input: {
    bindingId: string; unitId: string; rangeStart?: number; rangeEnd?: number; requestId?: string;
}): ContractReadResult {
    assertWorker(worker);
    const binding = requireActiveBinding(ctx, worker, input?.bindingId);
    if (!authorityReadable(ctx, binding.namespaceId)) throw new ContractRefusal('unavailable');
    return inTxn(ctx, () => {
        const b = requireActiveBinding(ctx, worker, input.bindingId);
        const pinSet = getPinSet(ctx, b.pinSetId);
        const pin = pinSet?.pins.find(p => p.unitId === input.unitId);
        if (!pin) throw new ContractRefusal('unit_not_pinned');
        const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM contract_reads WHERE binding_id = ?').get(b.bindingId) as { n: number }).n;
        if (count >= ctx.budgets.maxReadsPerBinding) throw new ContractRefusal('quota_exceeded');
        const start = input.rangeStart ?? 0;
        const end = input.rangeEnd ?? Math.min(pin.byteLength, start + ctx.budgets.maxReadBytesPerRequest);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > pin.byteLength
            || end - start > ctx.budgets.maxReadBytesPerRequest) throw new ContractRefusal('invalid_input');
        const now = ctx.rt.nowMs();
        const readId = newId(ctx, 'read');
        const body = readSpoolBody(ctx, pin.unitDigest);
        const insert = (outcome: 'served' | 'failed') => ctx.db.prepare(`INSERT INTO contract_reads (read_id, binding_id, session_id, revision_id, unit_id, unit_digest,
            range_start, range_end, unit_length, outcome, request_id, served_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(readId, b.bindingId, worker.sessionId, pin.revisionId, pin.unitId, pin.unitDigest, start, end, pin.byteLength, outcome,
                typeof input.requestId === 'string' ? input.requestId.slice(0, 128) : null, now);
        if (!body) {
            insert('failed');
            return null;
        }
        readFault?.();
        insert('served');
        const slice = body.subarray(start, end);
        // Valid UTF-8 round-trips byte-identically; anything else (incl. a range that
        // splits a multibyte character) is served as base64, never lossily decoded.
        const decoded = slice.toString('utf8');
        const text: string | null = !slice.includes(0) && Buffer.from(decoded, 'utf8').equals(slice) ? decoded : null;
        const isText = text !== null;
        return {
            readId,
            unitId: pin.unitId,
            revisionId: pin.revisionId,
            unitDigest: pin.unitDigest,
            unitLength: pin.byteLength,
            rangeStart: start,
            rangeEnd: end,
            encoding: isText ? 'utf8' : 'base64',
            content: isText ? text! : slice.toString('base64'),
            fullCoverage: rangesCoverAll(servedRanges(ctx, b.bindingId, pin.unitId, pin.unitDigest), pin.byteLength),
        } as ContractReadResult;
    }) ?? (() => { throw new ContractRefusal('unavailable'); })();
}

export interface ContractObserveResult {
    claimId: string;
    units: Array<{ unitId: string; unitDigest: string; readIds: string[] }>;
}

export function contractObserve(ctx: ContractCtx, worker: WorkerPrincipal, input: {
    bindingId: string; units: Array<{ unitId: string; unitDigest: string }>;
}): ContractObserveResult {
    assertWorker(worker);
    if (!input || !Array.isArray(input.units) || input.units.length === 0 || input.units.length > ctx.budgets.maxDirectTaskPins) throw new ContractRefusal('invalid_input');
    return inTxn(ctx, () => {
        const b = requireActiveBinding(ctx, worker, input.bindingId);
        const pinSet = getPinSet(ctx, b.pinSetId);
        const claimed: ContractObserveResult['units'] = [];
        for (const u of input.units) {
            const pin = pinSet?.pins.find(p => p.unitId === u?.unitId);
            if (!pin || pin.unitDigest !== u.unitDigest) throw new ContractRefusal('unit_not_pinned');
            const ranges = servedRanges(ctx, b.bindingId, pin.unitId, pin.unitDigest);
            if (!rangesCoverAll(ranges, pin.byteLength)) throw new ContractRefusal('no_full_receipt');
            claimed.push({ unitId: pin.unitId, unitDigest: pin.unitDigest, readIds: ranges.map(r => r.readId) });
        }
        const claimId = newId(ctx, 'clm');
        ctx.db.prepare(`INSERT INTO contract_claims (claim_id, binding_id, session_id, units_json, claimed_at) VALUES (?, ?, ?, ?, ?)`)
            .run(claimId, b.bindingId, worker.sessionId, JSON.stringify(claimed), ctx.rt.nowMs());
        return { claimId, units: claimed };
    });
}

export interface ContractCurrentView {
    scoped: boolean;
    binding?: { bindingId: string; pinSetId: string; units: Array<{ unitId: string; unitDigest: string; byteLength: number; revisionId: string }> };
    /** The caller's binding is no longer the active one (superseded/rebound/revoked). */
    bindingActive?: boolean;
    pinnedVector?: ContractHeadVector;
    currentVector?: ContractHeadVector | null;
    notices: Array<{ noticeKey: string; noticeClass: string; headGeneration: number; authorityEpoch: number; toRevisionId: string | null }>;
}

export function contractCurrent(ctx: ContractCtx, worker: WorkerPrincipal, opts: { acknowledgeTransport?: boolean } = {}): ContractCurrentView {
    assertWorker(worker);
    const all = ctx.db.prepare(`SELECT * FROM contract_bindings WHERE mesh_id = ? AND task_id = ? AND recipient_session_id = ? AND attempt_id = ? AND generation = ?
        ORDER BY admitted_at DESC`).all(worker.meshId, worker.taskId, worker.sessionId, worker.attemptId, worker.generation) as Array<{ binding_id: string; state: string; pin_set_id: string }>;
    const active = activeBindingForTask(ctx, worker.meshId, worker.taskId);
    const mine: ContractBinding | null = active && active.recipientSessionId === worker.sessionId && active.attemptId === worker.attemptId
        && active.generation === worker.generation ? active : null;
    const ref = mine ? { binding_id: mine.bindingId, pin_set_id: mine.pinSetId } : all[0];
    if (!ref) return { scoped: false, notices: [] };
    const pinSet = getPinSet(ctx, ref.pin_set_id);
    const notices = ctx.db.prepare(`SELECT notice_key, notice_class, head_generation, authority_epoch, to_revision_id FROM contract_notices
        WHERE binding_id = ? AND state = 'pending' ORDER BY authority_epoch, head_generation`).all(ref.binding_id) as Array<{
            notice_key: string; notice_class: string; head_generation: number; authority_epoch: number; to_revision_id: string | null;
        }>;
    if (opts.acknowledgeTransport !== false && notices.length) {
        const stmt = ctx.db.prepare(`UPDATE contract_notices SET state = 'delivered_transport', delivered_at = ? WHERE notice_key = ? AND state = 'pending'`);
        inTxn(ctx, () => { for (const n of notices) stmt.run(ctx.rt.nowMs(), n.notice_key); });
    }
    return {
        scoped: true,
        bindingActive: !!mine,
        binding: {
            bindingId: ref.binding_id,
            pinSetId: ref.pin_set_id,
            units: (pinSet?.pins ?? []).map(p => ({ unitId: p.unitId, unitDigest: p.unitDigest, byteLength: p.byteLength, revisionId: p.revisionId })),
        },
        ...(pinSet ? { pinnedVector: pinSet.vector } : {}),
        currentVector: pinSet ? currentHeadVector(ctx, pinSet.namespaceId) : null,
        notices: notices.map(n => ({ noticeKey: n.notice_key, noticeClass: n.notice_class, headGeneration: n.head_generation, authorityEpoch: n.authority_epoch, toRevisionId: n.to_revision_id })),
    };
}
