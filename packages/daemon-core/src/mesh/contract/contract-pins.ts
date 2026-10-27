/**
 * Contract versioning — task scopes, admission pins, dispatch bindings, the
 * compact pin block and session rebind (design §7, F5/F8; AC14–AC16, AC27; RN-03).
 *
 *   - O1: strict scope is opt-in for NEW assignments (mission/task binding);
 *     existing tasks stay compat-open.
 *   - Admission freezes a pin set from the CURRENT accepted head and a binding
 *     scoped to (meshId, taskId, attemptId, generation, recipient session),
 *     BEFORE any instruction is emitted. A new generation always gets a fresh
 *     binding even with unchanged content (R24); old receipts stay historical.
 *   - The PIN BLOCK is trusted framing over opaque references only — no
 *     capability, no path, no prose — measured in UTF-8 bytes independently of
 *     the 1200-char MissionBrief cap. Over budget or an unsupported strict
 *     participant refuses BEFORE native submission; nothing is truncated.
 *   - E1 records the admitted pin set and the exact composed block digest; it
 *     is not a claim that a native host delivered it to an attentive worker.
 *   - RN-03 / R25 rebind to an existing holder: if the holder's own trusted
 *     binding already carries the exact required pin set it is re-linked;
 *     otherwise the holder gets a NEW binding id and must read + claim afresh.
 *     Receipts are never relabelled from one session to another.
 */

import { createHash } from 'node:crypto';
import { ContractRefusal, CONTRACT_PROTOCOL_VERSION, type ContractHeadVector } from './contract-types.js';
import { assertIssued, inTxn, newId, type ContractCtx, type ContractPrincipal } from './contract-context.js';
import { computePinSetDigest, type PinEntry } from './contract-identity.js';
import { authorityReadable, currentHeadVector, getAuthority, recheckPrincipal } from './contract-authority.js';
import { getRevisionManifest } from './contract-proposals.js';

export type ContractScopeMode = 'strict' | 'advisory';

export interface ContractTaskScope {
    meshId: string;
    taskId: string;
    namespaceId: string;
    /** Empty = every unit of the accepted head. */
    units: string[];
    mode: ContractScopeMode;
}

const UNIT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function readUnits(v: unknown, max: number): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== 'string' || !UNIT_ID_RE.test(x))) throw new ContractRefusal('invalid_input');
    return [...new Set(v as string[])].sort();
}

/** Coordinator (op `assign`) or owner binds a mission: tasks enqueued INTO it from now on are strict/advisory. */
export function bindMissionScope(ctx: ContractCtx, principal: ContractPrincipal, input: {
    meshId: string; missionId: string; namespaceId: string; units?: string[]; mode?: ContractScopeMode;
}): void {
    assertIssued(principal);
    if (!input || typeof input.meshId !== 'string' || typeof input.missionId !== 'string' || !input.missionId) throw new ContractRefusal('invalid_input');
    const units = readUnits(input.units, ctx.budgets.maxDirectTaskPins);
    inTxn(ctx, () => {
        const auth = recheckPrincipal(ctx, principal, input.namespaceId, 'assign');
        if (principal.kind === 'worker') throw new ContractRefusal('not_authorized');
        if (auth.meshId !== input.meshId) throw new ContractRefusal('scope_mismatch');
        ctx.db.prepare(`INSERT OR REPLACE INTO contract_mission_scopes (mesh_id, mission_id, namespace_id, units_json, mode, bound_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(input.meshId, input.missionId, input.namespaceId, JSON.stringify(units), input.mode === 'advisory' ? 'advisory' : 'strict', ctx.rt.nowMs());
    });
}

export function getMissionScope(ctx: ContractCtx, meshId: string, missionId: string): Omit<ContractTaskScope, 'taskId'> | null {
    const r = ctx.db.prepare('SELECT * FROM contract_mission_scopes WHERE mesh_id = ? AND mission_id = ?').get(meshId, missionId) as
        { namespace_id: string; units_json: string; mode: string } | undefined;
    if (!r) return null;
    return { meshId, namespaceId: r.namespace_id, units: JSON.parse(r.units_json), mode: r.mode === 'advisory' ? 'advisory' : 'strict' };
}

/** Internal (enqueue path): a NEW task inherits its mission's scope. Never retroactive. */
export function stampTaskScopeFromMission(ctx: ContractCtx, meshId: string, taskId: string, missionId: string | undefined): ContractTaskScope | null {
    if (!missionId) return null;
    const ms = getMissionScope(ctx, meshId, missionId);
    if (!ms) return null;
    ctx.db.prepare(`INSERT OR IGNORE INTO contract_task_scopes (mesh_id, task_id, namespace_id, units_json, mode, bound_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(meshId, taskId, ms.namespaceId, JSON.stringify(ms.units), ms.mode, ctx.rt.nowMs());
    return getTaskScope(ctx, meshId, taskId);
}

export function getTaskScope(ctx: ContractCtx, meshId: string, taskId: string): ContractTaskScope | null {
    const r = ctx.db.prepare('SELECT * FROM contract_task_scopes WHERE mesh_id = ? AND task_id = ?').get(meshId, taskId) as
        { namespace_id: string; units_json: string; mode: string } | undefined;
    if (!r) return null;
    return { meshId, taskId, namespaceId: r.namespace_id, units: JSON.parse(r.units_json), mode: r.mode === 'advisory' ? 'advisory' : 'strict' };
}

// ─── Pin block ─────────────────────────────────────────────────────────

export const PIN_BLOCK_OPEN = '<<<ADHDEV-CONTRACT-PINS>>>';
export const PIN_BLOCK_CLOSE = '<<<END-ADHDEV-CONTRACT-PINS>>>';

export function renderPinBlock(input: {
    namespaceId: string; pinSetId: string; vector: Pick<ContractHeadVector, 'authorityEpoch' | 'headGeneration'>; bindingId: string; unitIds: readonly string[];
}): string {
    return [
        PIN_BLOCK_OPEN,
        `protocol=adhdev.contract/${CONTRACT_PROTOCOL_VERSION}`,
        `namespace=${input.namespaceId}`,
        `pinset=${input.pinSetId}`,
        `head=e${input.vector.authorityEpoch}.g${input.vector.headGeneration}`,
        `binding=${input.bindingId}`,
        `units=${input.unitIds.join(',')}`,
        'This task is pinned to exact contract units. Read each with contract_read (bindingId above), then record contract_observe for the units you read. These are opaque references, not file paths.',
        PIN_BLOCK_CLOSE,
    ].join('\n');
}

export function blockDigest(block: string): string {
    return createHash('sha256').update(block, 'utf8').digest('hex');
}

/** The block must appear EXACTLY once and byte-identical (an authored footer cannot bypass it). */
export function bodyCarriesPinBlock(body: string, block: string): boolean {
    const first = body.indexOf(block);
    return first >= 0 && body.indexOf(block, first + 1) < 0 && body.split(PIN_BLOCK_OPEN).length === 2;
}

// ─── Admission / bindings ──────────────────────────────────────────────

export interface ContractBinding {
    bindingId: string;
    meshId: string;
    taskId: string;
    attemptId: string;
    generation: number;
    namespaceId: string;
    recipientSessionId: string;
    pinSetId: string;
    blockDigest: string;
    state: 'active' | 'superseded' | 'revoked';
    linkedFromBindingId: string | null;
}

interface BindingRow {
    binding_id: string; mesh_id: string; task_id: string; attempt_id: string; generation: number; namespace_id: string;
    recipient_session_id: string; pin_set_id: string; block_digest: string; state: string; linked_from_binding_id: string | null;
}

function toBinding(r: BindingRow): ContractBinding {
    return {
        bindingId: r.binding_id, meshId: r.mesh_id, taskId: r.task_id, attemptId: r.attempt_id, generation: r.generation,
        namespaceId: r.namespace_id, recipientSessionId: r.recipient_session_id, pinSetId: r.pin_set_id,
        blockDigest: r.block_digest, state: r.state as ContractBinding['state'], linkedFromBindingId: r.linked_from_binding_id,
    };
}

export function getBinding(ctx: ContractCtx, bindingId: string): ContractBinding | null {
    const r = ctx.db.prepare('SELECT * FROM contract_bindings WHERE binding_id = ?').get(bindingId) as BindingRow | undefined;
    return r ? toBinding(r) : null;
}

export function activeBindingForTask(ctx: ContractCtx, meshId: string, taskId: string): ContractBinding | null {
    const r = ctx.db.prepare(`SELECT * FROM contract_bindings WHERE mesh_id = ? AND task_id = ? AND state = 'active' ORDER BY admitted_at DESC LIMIT 1`)
        .get(meshId, taskId) as BindingRow | undefined;
    return r ? toBinding(r) : null;
}

export function listBindingsForTask(ctx: ContractCtx, meshId: string, taskId: string): ContractBinding[] {
    return (ctx.db.prepare('SELECT * FROM contract_bindings WHERE mesh_id = ? AND task_id = ? ORDER BY admitted_at').all(meshId, taskId) as BindingRow[]).map(toBinding);
}

export interface PinSetRecord {
    pinSetId: string;
    namespaceId: string;
    vector: ContractHeadVector;
    pins: PinEntry[];
}

export function getPinSet(ctx: ContractCtx, pinSetId: string): PinSetRecord | null {
    const r = ctx.db.prepare('SELECT * FROM contract_pin_sets WHERE pin_set_id = ?').get(pinSetId) as {
        namespace_id: string; authority_epoch: number; head_generation: number; revision_id: string | null; policy_revision: number;
        revocation_generation: number; pins_json: string;
    } | undefined;
    if (!r) return null;
    return {
        pinSetId,
        namespaceId: r.namespace_id,
        vector: {
            namespaceId: r.namespace_id, authorityEpoch: r.authority_epoch, headGeneration: r.head_generation,
            revisionId: r.revision_id, policyRevision: r.policy_revision, revocationGeneration: r.revocation_generation,
        },
        pins: JSON.parse(r.pins_json),
    };
}

function freezePinSet(ctx: ContractCtx, scope: ContractTaskScope): PinSetRecord {
    const vector = currentHeadVector(ctx, scope.namespaceId);
    if (!vector?.revisionId) throw new ContractRefusal('unavailable');
    const manifest = getRevisionManifest(ctx, vector.revisionId);
    if (!manifest) throw new ContractRefusal('unavailable');
    const chosen = scope.units.length ? scope.units.map(id => manifest.units.find(u => u.unitId === id)) : manifest.units;
    if (chosen.some(u => !u)) throw new ContractRefusal('not_found');
    if (chosen.length === 0) throw new ContractRefusal('unavailable');
    if (chosen.length > ctx.budgets.maxDirectTaskPins) throw new ContractRefusal('budget_exceeded');
    const pins: PinEntry[] = chosen.map(u => ({ revisionId: vector.revisionId!, unitId: u!.unitId, unitDigest: u!.digest, byteLength: u!.byteLength }));
    const pinSetId = computePinSetDigest({
        namespaceId: scope.namespaceId, authorityEpoch: vector.authorityEpoch, headGeneration: vector.headGeneration,
        policyRevision: vector.policyRevision, pins,
    });
    ctx.db.prepare(`INSERT OR IGNORE INTO contract_pin_sets (pin_set_id, namespace_id, authority_epoch, head_generation, revision_id, policy_revision,
        revocation_generation, pins_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pinSetId, scope.namespaceId, vector.authorityEpoch, vector.headGeneration, vector.revisionId, vector.policyRevision,
            vector.revocationGeneration, JSON.stringify(pins), ctx.rt.nowMs());
    return getPinSet(ctx, pinSetId)!;
}

export interface DispatchAdmission {
    binding: ContractBinding;
    block: string;
    blockBytes: number;
    mode: ContractScopeMode;
    reused: boolean;
}

export interface AdmitDispatchInput {
    meshId: string;
    taskId: string;
    attemptId: string;
    generation: number;
    recipient: { sessionId: string; nodeId?: string; daemonId?: string };
    /** The receiving session holds the worker MCP (contract_read/contract_observe) — the negotiated strict bridge. */
    recipientSupportsContractTools: boolean;
}

/**
 * Admit one dispatch. Returns null for a compat-open (unscoped) task — the
 * dispatch is then byte-identical to the pre-feature behaviour. Throws a
 * ContractRefusal when a strict dispatch must not reach native submission.
 */
export function admitDispatch(ctx: ContractCtx, input: AdmitDispatchInput): DispatchAdmission | null {
    const scope = getTaskScope(ctx, input.meshId, input.taskId);
    if (!scope) return null;
    if (!input.attemptId || !Number.isSafeInteger(input.generation) || !input.recipient?.sessionId) throw new ContractRefusal('invalid_input');
    return inTxn(ctx, () => {
        const auth = authorityReadable(ctx, scope.namespaceId);
        if (!auth) {
            const raw = getAuthority(ctx, scope.namespaceId);
            throw new ContractRefusal(raw?.status === 'requires_owner_recovery' ? 'authority_requires_recovery'
                : raw?.status === 'paused_transfer' ? 'authority_paused' : 'unavailable');
        }
        if (scope.mode === 'strict') {
            if (input.recipient.daemonId && input.recipient.daemonId !== auth.authorityDaemonId) throw new ContractRefusal('strict_participant_unsupported');
            if (!input.recipientSupportsContractTools) throw new ContractRefusal('strict_participant_unsupported');
        }
        const pinSet = freezePinSet(ctx, scope);
        const existing = activeBindingForTask(ctx, input.meshId, input.taskId);
        if (existing && existing.attemptId === input.attemptId && existing.generation === input.generation
            && existing.recipientSessionId === input.recipient.sessionId && existing.pinSetId === pinSet.pinSetId) {
            const block = renderPinBlock({ namespaceId: scope.namespaceId, pinSetId: pinSet.pinSetId, vector: pinSet.vector, bindingId: existing.bindingId, unitIds: pinSet.pins.map(p => p.unitId) });
            return { binding: existing, block, blockBytes: Buffer.byteLength(block, 'utf8'), mode: scope.mode, reused: true };
        }
        const bindingId = newId(ctx, 'bnd');
        const block = renderPinBlock({ namespaceId: scope.namespaceId, pinSetId: pinSet.pinSetId, vector: pinSet.vector, bindingId, unitIds: pinSet.pins.map(p => p.unitId) });
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (blockBytes > ctx.budgets.maxPinBlockBytes) throw new ContractRefusal('pin_block_over_budget');
        const now = ctx.rt.nowMs();
        ctx.db.prepare(`UPDATE contract_bindings SET state = 'superseded', ended_at = ? WHERE mesh_id = ? AND task_id = ? AND state = 'active'`)
            .run(now, input.meshId, input.taskId);
        ctx.db.prepare(`INSERT INTO contract_bindings (binding_id, mesh_id, task_id, attempt_id, generation, namespace_id, recipient_session_id,
            recipient_node_id, recipient_daemon_id, pin_set_id, block_digest, block_bytes, e1_stage, state, linked_from_binding_id, admitted_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'composed', 'active', NULL, ?, NULL)`)
            .run(bindingId, input.meshId, input.taskId, input.attemptId, input.generation, scope.namespaceId, input.recipient.sessionId,
                input.recipient.nodeId ?? null, input.recipient.daemonId ?? null, pinSet.pinSetId, blockDigest(block), blockBytes, now);
        return { binding: getBinding(ctx, bindingId)!, block, blockBytes, mode: scope.mode, reused: false };
    });
}

/**
 * The binding a worker action may use right now: active, same task, same
 * attempt, same CURRENT generation, same recipient session. Anything else is
 * historical at most (AC16).
 */
export function requireActiveBinding(ctx: ContractCtx, worker: { meshId: string; taskId: string; attemptId: string; generation: number; sessionId: string }, bindingId: string): ContractBinding {
    const b = getBinding(ctx, bindingId);
    if (!b) throw new ContractRefusal('binding_missing');
    if (b.meshId !== worker.meshId || b.taskId !== worker.taskId) throw new ContractRefusal('binding_missing');
    if (b.state !== 'active' || b.attemptId !== worker.attemptId || b.generation !== worker.generation || b.recipientSessionId !== worker.sessionId) {
        throw new ContractRefusal('binding_not_active');
    }
    return b;
}

export interface RebindResult {
    mode: 'linked' | 'fresh_binding' | 'unscoped';
    bindingId?: string;
    /** Present for a fresh binding: the amendment block the holder must receive (it has NOT seen it). */
    block?: string;
}

/**
 * RN-03 / R25: the coordinator rebinds a duplicate dispatch (to `losingSessionId`)
 * onto the session that already holds the task. Runs inside the caller's
 * owner CAS transaction when there is one (nested savepoint).
 */
export function rebindToHolder(ctx: ContractCtx, input: {
    meshId: string; taskId: string; attemptId: string; generation: number; losingSessionId: string; holderSessionId: string;
}): RebindResult {
    const scope = getTaskScope(ctx, input.meshId, input.taskId);
    if (!scope) return { mode: 'unscoped' };
    return inTxn(ctx, () => {
        const now = ctx.rt.nowMs();
        const bindings = listBindingsForTask(ctx, input.meshId, input.taskId);
        const losing = bindings.filter(b => b.recipientSessionId === input.losingSessionId && b.state === 'active');
        const required = losing[0]?.pinSetId ?? null;
        // Trusted holder evidence: the holder's OWN admitted binding for this exact attempt + generation.
        const holder = bindings.filter(b => b.recipientSessionId === input.holderSessionId && b.attemptId === input.attemptId
            && b.generation === input.generation && b.state !== 'revoked').pop();
        for (const b of losing) {
            ctx.db.prepare(`UPDATE contract_bindings SET state = 'revoked', ended_at = ? WHERE binding_id = ?`).run(now, b.bindingId);
        }
        const currentPin = required ?? (holder ? holder.pinSetId : null);
        if (holder && currentPin && holder.pinSetId === currentPin) {
            ctx.db.prepare(`UPDATE contract_bindings SET state = 'superseded', ended_at = ? WHERE mesh_id = ? AND task_id = ? AND state = 'active' AND binding_id <> ?`)
                .run(now, input.meshId, input.taskId, holder.bindingId);
            ctx.db.prepare(`UPDATE contract_bindings SET state = 'active', ended_at = NULL, linked_from_binding_id = ? WHERE binding_id = ?`)
                .run(losing[0]?.bindingId ?? null, holder.bindingId);
            return { mode: 'linked', bindingId: holder.bindingId };
        }
        // Different (or no) prior pin set on the holder: NEW binding id, fresh read + claim required.
        const pinSet = freezePinSet(ctx, scope);
        const bindingId = newId(ctx, 'bnd');
        const block = renderPinBlock({ namespaceId: scope.namespaceId, pinSetId: pinSet.pinSetId, vector: pinSet.vector, bindingId, unitIds: pinSet.pins.map(p => p.unitId) });
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (blockBytes > ctx.budgets.maxPinBlockBytes) throw new ContractRefusal('pin_block_over_budget');
        ctx.db.prepare(`UPDATE contract_bindings SET state = 'superseded', ended_at = ? WHERE mesh_id = ? AND task_id = ? AND state = 'active'`)
            .run(now, input.meshId, input.taskId);
        ctx.db.prepare(`INSERT INTO contract_bindings (binding_id, mesh_id, task_id, attempt_id, generation, namespace_id, recipient_session_id,
            recipient_node_id, recipient_daemon_id, pin_set_id, block_digest, block_bytes, e1_stage, state, linked_from_binding_id, admitted_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'amendment_pending', 'active', NULL, ?, NULL)`)
            .run(bindingId, input.meshId, input.taskId, input.attemptId, input.generation, scope.namespaceId, input.holderSessionId,
                pinSet.pinSetId, blockDigest(block), blockBytes, now);
        ctx.db.prepare(`INSERT OR IGNORE INTO contract_notices (notice_key, namespace_id, binding_id, mesh_id, task_id, attempt_id, generation,
            authority_epoch, head_generation, to_revision_id, notice_class, state, hint_operation_id, created_at, delivered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'binding_amended', 'pending', NULL, ?, NULL)`)
            .run(`ntc_amend_${bindingId}`, scope.namespaceId, bindingId, input.meshId, input.taskId, input.attemptId, input.generation,
                pinSet.vector.authorityEpoch, pinSet.vector.headGeneration, pinSet.vector.revisionId, now);
        return { mode: 'fresh_binding', bindingId, block };
    });
}
