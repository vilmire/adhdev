/**
 * Contract versioning (Cut A) — daemon wiring: the process singleton over
 * `mesh-runtime.db`, and the ONE facade every normative consumer calls.
 *
 * Everything here is opt-in by construction (O1): a task is strict only when
 * it was enqueued into a mission an authorized coordinator/owner bound to an
 * enrolled namespace. Every other task returns `compat_open` and the consumer
 * behaves exactly as before — normal git work never waits on this feature.
 *
 * Consumers (design §10 inventory):
 *   (a) dependency gate      — taskDependenciesSatisfied / describe (registered gate)
 *   (b) Refinery admission + final landing guard (router-refine-contract-stage.ts)
 *   (c) handoff publication (RN-01: only after the completion assessment) + selection
 *   (d) upstream appendix / peer_context (hold metadata, never stale prose)
 *   (e) mission close candidate + explicit close
 * plus dispatch admission (pin block before native submission) and R25 rebind (RN-03).
 *
 * Old-binary barrier (AC22): strict tasks — and tasks depending on them — carry
 * the `contract=strict-v1` + `contract-ns=<ns>` required tags. Only this binary
 * advertises them, and only for nodes local to an ACTIVE authority, so an old
 * binary sharing the store can neither dispatch nor consume them, and a paused
 * or unrecoverable authority makes new strict work WAIT (O5) instead of failing.
 */

import * as path from 'node:path';
import { canonicalDaemonId, readText } from '@adhdev/mesh-shared';
import { getConfigDir, getMachineId, loadConfig } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { registerMeshNodeCapabilityTagProvider } from './mesh-node-capability-tags.js';
import { registerDependencyEligibilityGate } from './mesh-task-predicates.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';
import { createContractCtx, FileContractAuthorityFence } from './contract/contract-store.js';
import { CONTRACT_STRICT_CAPABILITY_TAG, ContractRefusal, isContractRefusal, type ContractEligibility, type ContractUsePurpose } from './contract/contract-types.js';
import type { ContractCtx } from './contract/contract-context.js';
import { authorityReadable, beginContractProcessIncarnation, revokeGrantsForSession } from './contract/contract-authority.js';
import { admitDispatch, bodyCarriesPinBlock, getTaskScope, rebindToHolder, stampTaskScopeFromMission, getMissionScope, type ContractTaskScope } from './contract/contract-pins.js';
import { assessTaskForPurpose, beginGuardedUse, recordResultEvidence } from './contract/contract-assessment.js';
import { processImpactOutbox, type ContractHintPort } from './contract/contract-notices.js';
import { runContractGc } from './contract/contract-retention.js';
import { finishUseGuard, listUseGuards, markUseGuardUnknown, reconcileUnknownUseGuard, recordGuardIntent } from './contract/contract-use-guards.js';

export const CONTRACT_NAMESPACE_TAG_PREFIX = 'contract-ns=';

let ctxCache: ContractCtx | null | undefined;
let ctxOverride: ContractCtx | null | undefined;
let failedForDb: unknown = null;

/**
 * The process contract context, or null when the runtime store is unavailable.
 * Rebuilt whenever the runtime store's DB handle changes (store reset/reopen),
 * so a closed handle is never reused.
 */
export function getContractCtx(): ContractCtx | null {
    if (ctxOverride !== undefined) return ctxOverride;
    let db: ReturnType<typeof MeshRuntimeStore.getInstance>['db'];
    try { db = MeshRuntimeStore.getInstance().db; } catch { return null; }
    if (ctxCache && ctxCache.db === db) return ctxCache;
    if (failedForDb === db) return null;
    try {
        const daemonId = canonicalDaemonId(readText(getMachineId())) || 'daemon_unknown';
        let budgets: Record<string, number> | null = null;
        try { budgets = (loadConfig().contractVersioning?.budgets ?? null) as Record<string, number> | null; } catch { budgets = null; }
        ctxCache = createContractCtx({
            db,
            localDaemonId: daemonId,
            fence: new FileContractAuthorityFence(path.join(getConfigDir(), 'contract-authority-fence.json')),
            budgets,
        });
    } catch (e: any) {
        LOG.warn('Contract', `contract runtime unavailable: ${e?.message || e}`);
        ctxCache = null;
        failedForDb = db;
    }
    return ctxCache;
}

export function __setContractCtxForTests(ctx: ContractCtx | null | undefined): void {
    ctxOverride = ctx;
}

function hasAnyStrictState(ctx: ContractCtx): boolean {
    try {
        return !!ctx.db.prepare('SELECT 1 FROM contract_task_scopes LIMIT 1').get();
    } catch {
        return false;
    }
}

function scopeOf(meshId: string, taskId: string): { ctx: ContractCtx; scope: ContractTaskScope } | null {
    const ctx = getContractCtx();
    if (!ctx || !meshId || !taskId) return null;
    let scope: ContractTaskScope | null = null;
    try { scope = getTaskScope(ctx, meshId, taskId); } catch { return null; }
    return scope ? { ctx, scope } : null;
}

export function contractTaskIsStrict(meshId: string, taskId: string): boolean {
    return scopeOf(meshId, taskId)?.scope.mode === 'strict';
}

// ─── Enqueue / capability tags (old-binary barrier) ────────────────────

/**
 * Called at enqueue for a NEW task: inherit the mission's scope (never
 * retroactive) and return the required tags the row must carry. A task that
 * depends on a strict task is a strict CONSUMER and carries the same barrier.
 */
export function contractRequiredTagsForNewTask(meshId: string, taskId: string, missionId: string | undefined, dependsOn: readonly string[]): string[] {
    const ctx = getContractCtx();
    if (!ctx) return [];
    try {
        const tags = new Set<string>();
        const scope = stampTaskScopeFromMission(ctx, meshId, taskId, missionId);
        if (scope?.mode === 'strict') {
            tags.add(CONTRACT_STRICT_CAPABILITY_TAG);
            tags.add(`${CONTRACT_NAMESPACE_TAG_PREFIX}${scope.namespaceId}`);
        }
        for (const dep of dependsOn) {
            const depScope = getTaskScope(ctx, meshId, dep);
            if (depScope?.mode === 'strict') {
                tags.add(CONTRACT_STRICT_CAPABILITY_TAG);
                tags.add(`${CONTRACT_NAMESPACE_TAG_PREFIX}${depScope.namespaceId}`);
            }
        }
        return [...tags];
    } catch (e: any) {
        LOG.warn('Contract', `contract scope stamp failed for task ${taskId}: ${e?.message || e}`);
        return [];
    }
}

/**
 * Tags this binary advertises for a node: the strict protocol tag plus one
 * namespace tag per ACTIVE authority held by this daemon — only when the node is
 * served by this daemon (MVP: no cross-daemon strict participant). A namespace
 * is bound to one mesh at enrollment, so another mesh's tag is never required.
 */
export function contractCapabilityTagsForNode(nodeIsLocal: boolean): string[] {
    if (!nodeIsLocal) return [];
    const ctx = getContractCtx();
    if (!ctx) return [];
    try {
        const rows = ctx.db.prepare(`SELECT namespace_id FROM contract_authorities WHERE status = 'active'`).all() as Array<{ namespace_id: string }>;
        const active = rows.filter(r => authorityReadable(ctx, r.namespace_id));
        if (!active.length) return [];
        return [CONTRACT_STRICT_CAPABILITY_TAG, ...active.map(a => `${CONTRACT_NAMESPACE_TAG_PREFIX}${a.namespace_id}`)];
    } catch {
        return [];
    }
}

registerMeshNodeCapabilityTagProvider((node) => {
    const ctx = getContractCtx();
    if (!ctx || !hasAnyAuthority(ctx)) return [];
    let local = false;
    try { local = isLocalAutoLaunchNode(node); } catch { local = false; }
    return contractCapabilityTagsForNode(local);
});

function hasAnyAuthority(ctx: ContractCtx): boolean {
    try { return !!ctx.db.prepare('SELECT 1 FROM contract_authorities LIMIT 1').get(); } catch { return false; }
}

// ─── Eligibility facade ────────────────────────────────────────────────

/** Eligibility of a task's exact latest terminal output for a purpose. Unscoped ⇒ compat_open. */
export function contractTaskEligibility(meshId: string, taskId: string, purpose: ContractUsePurpose): ContractEligibility {
    const s = scopeOf(meshId, taskId);
    if (!s) return { state: 'compat_open', usable: true, reasons: [] };
    try {
        const out = MeshRuntimeStore.getInstance().getLatestTaskOutput(taskId);
        const latest = out && out.meshId === meshId && out.status === 'completed' ? { version: out.version, digest: out.digest } : null;
        return assessTaskForPurpose(s.ctx, { meshId, taskId, purpose, latestOutput: latest });
    } catch (e: any) {
        // Fail closed for a strict task: unknown data in strict mode holds.
        return { state: 'unavailable', usable: false, reasons: [isContractRefusal(e) ? e.code : 'assessment_error'] };
    }
}

/**
 * (a) dependency gate: a completed STRICT prerequisite satisfies dependents
 * only when eligible. Unscoped prerequisites — and any lookup failure on one —
 * keep the pre-feature answer, so ordinary work never waits on this feature.
 */
export function contractDependencyUsable(meshId: string | undefined, depTaskId: string): boolean {
    const ctx = getContractCtx();
    if (!ctx || !hasAnyStrictState(ctx)) return true;
    let mesh = meshId;
    try {
        if (!mesh) mesh = (ctx.db.prepare('SELECT mesh_id FROM contract_task_scopes WHERE task_id = ? LIMIT 1').get(depTaskId) as { mesh_id?: string } | undefined)?.mesh_id;
    } catch { return true; }
    if (!mesh || !getTaskScopeSafe(ctx, mesh, depTaskId)) return true;
    return contractTaskEligibility(mesh, depTaskId, 'dependency').usable;
}

function getTaskScopeSafe(ctx: ContractCtx, meshId: string, taskId: string): ContractTaskScope | null {
    try { return getTaskScope(ctx, meshId, taskId); } catch { return null; }
}

registerDependencyEligibilityGate(contractDependencyUsable);

// ─── Dispatch admission ────────────────────────────────────────────────

export type ContractDispatchAdmission =
    | { kind: 'compat_open' }
    | { kind: 'admitted'; block: string; bindingId: string }
    | { kind: 'refused'; code: string };

export function contractAdmitDispatch(input: {
    meshId: string; taskId: string; attemptId?: string; generation?: number;
    sessionId: string; nodeId?: string; recipientDaemonId?: string; workerMcp: boolean | undefined;
}): ContractDispatchAdmission {
    const s = scopeOf(input.meshId, input.taskId);
    if (!s) return { kind: 'compat_open' };
    try {
        if (!input.attemptId || typeof input.generation !== 'number') throw new ContractRefusal('binding_missing');
        const adm = admitDispatch(s.ctx, {
            meshId: input.meshId, taskId: input.taskId, attemptId: input.attemptId, generation: input.generation,
            recipient: {
                sessionId: input.sessionId,
                ...(input.nodeId ? { nodeId: input.nodeId } : {}),
                daemonId: input.recipientDaemonId || s.ctx.localDaemonId,
            },
            // The negotiated strict bridge: the session must hold the worker MCP (contract_read/observe).
            recipientSupportsContractTools: input.workerMcp !== false,
        });
        if (!adm) return { kind: 'compat_open' };
        return { kind: 'admitted', block: adm.block, bindingId: adm.binding.bindingId };
    } catch (e: any) {
        return { kind: 'refused', code: isContractRefusal(e) ? e.code : 'admission_error' };
    }
}

/** Exact-once insertion of the trusted pin block right after the authored message (outside upstream/handoff prose). */
export function insertPinBlock(body: string, block: string): string {
    if (bodyCarriesPinBlock(body, block)) return body;
    return `${block}\n\n${body}`;
}

export { bodyCarriesPinBlock };

// ─── Completion (RN-01) ────────────────────────────────────────────────

/**
 * RN-01: a strict task's handoff note is held privately at report time and
 * published to the active projection only after the completion assessment
 * says it is usable for `handoff`. Returns true when the note was held.
 */
export function contractHoldHandoffNote(input: {
    meshId: string; taskId: string; attemptId?: string; sessionId?: string; nodeId?: string; notesJson: string; nowMs: number;
}): boolean {
    const s = scopeOf(input.meshId, input.taskId);
    if (!s || s.scope.mode !== 'strict') return false;
    s.ctx.db.prepare(`INSERT OR REPLACE INTO contract_held_handoffs (mesh_id, task_id, result_key, notes_json, attempt_id, session_id, node_id, recorded_at, published_at)
        VALUES (?, ?, '', ?, ?, ?, ?, ?, NULL)`).run(input.meshId, input.taskId, input.notesJson, input.attemptId ?? '', input.sessionId ?? null, input.nodeId ?? null, input.nowMs);
    return true;
}

export interface HeldHandoffNote { meshId: string; taskId: string; attemptId: string; sessionId: string | null; nodeId: string | null; notesJson: string; recordedAt: number }

/**
 * After a strict completion committed: freeze the evidence snapshot for the
 * exact (attempt, generation, output version, digest) and assess it. Returns
 * the held handoff note to publish when (and only when) it is usable.
 */
export function contractAfterAcceptedCompletion(input: {
    meshId: string; taskId: string; attemptId?: string; sessionId?: string;
}): { eligibility: ContractEligibility; publishHandoff: HeldHandoffNote | null } | null {
    const s = scopeOf(input.meshId, input.taskId);
    if (!s) return null;
    const store = MeshRuntimeStore.getInstance();
    try {
        const out = store.getLatestTaskOutput(input.taskId);
        const attempt = input.attemptId ? store.turnStore().getAttempt(input.attemptId) : undefined;
        if (out && attempt && input.attemptId) {
            recordResultEvidence(s.ctx, {
                meshId: input.meshId, taskId: input.taskId, attemptId: input.attemptId, generation: attempt.generation,
                outputVersion: out.version, payloadDigest: out.digest,
            }, { ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
        }
    } catch (e: any) {
        // A failed join leaves the strict result HELD (missing rows mean held) — recovered by the boot sweep.
        LOG.warn('Contract', `evidence join failed for task ${input.taskId}: ${e?.message || e}`);
    }
    const eligibility = contractTaskEligibility(input.meshId, input.taskId, 'handoff');
    return { eligibility, publishHandoff: eligibility.usable ? takeHeldHandoff(s.ctx, input.meshId, input.taskId, eligibility.resultKey) : null };
}

/**
 * RN-01: a held note publishes only with the exact result it was written for —
 * the assessed result's attempt must be the note's attempt. A note from a
 * superseded attempt stays private even when a later attempt is usable.
 */
function takeHeldHandoff(ctx: ContractCtx, meshId: string, taskId: string, resultKey: string | undefined): HeldHandoffNote | null {
    if (!resultKey) return null;
    const r = ctx.db.prepare('SELECT * FROM contract_held_handoffs WHERE mesh_id = ? AND task_id = ? AND published_at IS NULL').get(meshId, taskId) as {
        attempt_id: string; session_id: string | null; node_id: string | null; notes_json: string; recorded_at: number;
    } | undefined;
    if (!r) return null;
    const ev = ctx.db.prepare('SELECT attempt_id FROM contract_result_evidence WHERE result_key = ? AND mesh_id = ? AND task_id = ?').get(resultKey, meshId, taskId) as { attempt_id: string } | undefined;
    if (!ev || !r.attempt_id || ev.attempt_id !== r.attempt_id) return null;
    ctx.db.prepare('UPDATE contract_held_handoffs SET published_at = ?, result_key = ? WHERE mesh_id = ? AND task_id = ?').run(ctx.rt.nowMs(), resultKey, meshId, taskId);
    return { meshId, taskId, attemptId: r.attempt_id, sessionId: r.session_id, nodeId: r.node_id, notesJson: r.notes_json, recordedAt: r.recorded_at };
}

/** Selector-side gate: an active handoff projection never shows a strict note that is not CURRENTLY usable. */
export function contractHandoffVisible(meshId: string, taskId: string): boolean {
    const s = scopeOf(meshId, taskId);
    if (!s) return true;
    return contractTaskEligibility(meshId, taskId, 'handoff').usable;
}

/** Strict tasks whose held handoff note became usable later (revalidation) — published by the caller. */
export function contractPublishableHeldHandoffs(meshId: string): HeldHandoffNote[] {
    const ctx = getContractCtx();
    if (!ctx) return [];
    const rows = ctx.db.prepare('SELECT task_id FROM contract_held_handoffs WHERE mesh_id = ? AND published_at IS NULL').all(meshId) as Array<{ task_id: string }>;
    const out: HeldHandoffNote[] = [];
    for (const r of rows) {
        const e = contractTaskEligibility(meshId, r.task_id, 'handoff');
        if (!e.usable) continue;
        const note = takeHeldHandoff(ctx, meshId, r.task_id, e.resultKey);
        if (note) out.push(note);
    }
    return out;
}

// ─── Mission close ─────────────────────────────────────────────────────

/** Strict tasks of the mission whose completed result is NOT usable for mission satisfaction. */
export function contractMissionHeldTaskIds(meshId: string, missionId: string, completedTaskIds: readonly string[]): string[] {
    const ctx = getContractCtx();
    if (!ctx) return [];
    try {
        if (!getMissionScope(ctx, meshId, missionId)) return [];
    } catch {
        return [];
    }
    return completedTaskIds.filter(id => contractTaskIsStrict(meshId, id) && !contractTaskEligibility(meshId, id, 'mission_close').usable);
}

// ─── R25 rebind (RN-03) ────────────────────────────────────────────────

export function contractRebindHolder(input: {
    meshId: string; taskId: string; attemptId: string; generation: number; losingSessionId: string; holderSessionId: string;
}): { mode: 'linked' | 'fresh_binding' | 'unscoped'; bindingId?: string } {
    const s = scopeOf(input.meshId, input.taskId);
    if (!s) return { mode: 'unscoped' };
    const r = rebindToHolder(s.ctx, input);
    return { mode: r.mode, ...(r.bindingId ? { bindingId: r.bindingId } : {}) };
}

// ─── Refinery (b) ──────────────────────────────────────────────────────

export interface ContractRefineTaskRef { meshId: string; taskId: string }

/** Strict completed tasks whose result rides this node's branch. */
export function contractStrictTasksForNode(meshId: string, nodeMatches: (assignedNodeId: string | undefined) => boolean): ContractRefineTaskRef[] {
    const ctx = getContractCtx();
    if (!ctx || !hasAnyStrictState(ctx)) return [];
    const rows = ctx.db.prepare(`SELECT task_id FROM contract_task_scopes WHERE mesh_id = ? AND mode = 'strict'`).all(meshId) as Array<{ task_id: string }>;
    const store = MeshRuntimeStore.getInstance();
    const out: ContractRefineTaskRef[] = [];
    for (const r of rows) {
        const entry = store.findQueueEntryById(meshId, r.task_id);
        if (entry?.status === 'completed' && nodeMatches(entry.assignedNodeId ?? entry.targetNodeId)) out.push({ meshId, taskId: r.task_id });
    }
    return out;
}

/** Provisional admission: every strict result on the branch must be usable for integration_admission. */
export function contractRefineAdmission(tasks: readonly ContractRefineTaskRef[]): { held: Array<{ taskId: string; state: string }> } {
    const held: Array<{ taskId: string; state: string }> = [];
    for (const t of tasks) {
        const e = contractTaskEligibility(t.meshId, t.taskId, 'integration_admission');
        if (!e.usable) held.push({ taskId: t.taskId, state: e.state });
    }
    return { held };
}

/**
 * Final landing: open RN-02 guards (one per namespace) at the linearization
 * point. Returns the guard ids to finish, or the held tasks.
 */
export function contractBeginLanding(tasks: readonly ContractRefineTaskRef[], externalRef: Record<string, string>): { guards: string[]; held: Array<{ taskId: string; state: string }> } {
    const ctx = getContractCtx();
    if (!ctx || tasks.length === 0) return { guards: [], held: [] };
    const byNs = new Map<string, string[]>();
    const held: Array<{ taskId: string; state: string }> = [];
    for (const t of tasks) {
        const e = contractTaskEligibility(t.meshId, t.taskId, 'integration_landing');
        if (!e.usable || !e.resultKey || !e.namespaceId) { held.push({ taskId: t.taskId, state: e.state }); continue; }
        byNs.set(e.namespaceId, [...(byNs.get(e.namespaceId) ?? []), e.resultKey]);
    }
    if (held.length) return { guards: [], held };
    const guards: string[] = [];
    for (const [namespaceId, resultKeys] of byNs) {
        const { guard, decisions } = beginGuardedUse(ctx, { namespaceId, resultKeys, purpose: 'integration_landing' });
        if (!guard) {
            for (const g of guards) finishUseGuard(ctx, g, 'aborted');
            return { guards: [], held: decisions.filter(d => !d.usable).map(d => ({ taskId: d.resultKey ?? '', state: d.state })) };
        }
        recordGuardIntent(ctx, guard.guardId, externalRef);
        guards.push(guard.guardId);
    }
    return { guards, held: [] };
}

export function contractFinishLanding(guards: readonly string[], outcome: 'published' | 'aborted' | 'unknown', externalRef?: Record<string, string>): void {
    const ctx = getContractCtx();
    if (!ctx) return;
    for (const g of guards) {
        try {
            if (outcome === 'unknown') markUseGuardUnknown(ctx, g, externalRef);
            else finishUseGuard(ctx, g, outcome, externalRef);
        } catch (e: any) {
            LOG.warn('Contract', `use guard ${g} finish failed: ${e?.message || e}`);
        }
    }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

/** Boot: rotate volatile grants, mark stale guards unknown, reconcile them against the real target. */
export function contractBoot(probe?: (externalRef: Record<string, string> | null) => 'landed' | 'not_landed' | 'indeterminate'): void {
    const ctx = getContractCtx();
    if (!ctx) return;
    try {
        const r = beginContractProcessIncarnation(ctx);
        if (r.requiresRecovery) LOG.warn('Contract', `${r.requiresRecovery} contract authority namespace(s) need owner recovery (stale DB epoch behind the fence) — strict work is held`);
        if (probe) for (const g of listUseGuards(ctx, { states: ['unknown'] })) reconcileUnknownUseGuard(ctx, g.guardId, probe);
    } catch (e: any) {
        LOG.warn('Contract', `contract boot reconciliation failed: ${e?.message || e}`);
    }
}

/** Periodic: resumable notice fan-out (+ content-free hints) and GC. */
export function contractTick(hints: ContractHintPort | null, opts: { gc?: boolean } = {}): void {
    const ctx = getContractCtx();
    if (!ctx) return;
    try {
        processImpactOutbox(ctx, { limit: 200, hints });
        if (opts.gc) runContractGc(ctx);
    } catch (e: any) {
        LOG.warn('Contract', `contract tick failed: ${e?.message || e}`);
    }
}

export function contractOnCoordinatorSessionEnded(sessionId: string): void {
    const ctx = getContractCtx();
    if (!ctx || !sessionId) return;
    try { revokeGrantsForSession(ctx, sessionId); } catch { /* revocation retried on next end/boot rotation */ }
}

// ─── Housekeeping ──────────────────────────────────────────────────────

/** Content-free hint text: no prose, path, digest or secret (F10). */
export const CONTRACT_NOTICE_HINT_TEXT = '[adhdev-contract] A contract notice is pending for this task. Call contract_current before relying on your pinned contract units.';

/** Mailbox hint port: one deposit per semantic notice; mailbox full ⇒ not delivered now (no blind retry). */
export function mailboxContractHintPort(deposit: (input: { meshId: string; taskId: string; text: string }) => { ok: boolean; id?: string }): ContractHintPort {
    return {
        deliver: ({ meshId, taskId }) => {
            const r = deposit({ meshId, taskId, text: CONTRACT_NOTICE_HINT_TEXT });
            return r.ok && r.id ? r.id : null;
        },
    };
}

/**
 * AC07 recovery: a strict completed task whose latest output has no evidence
 * row (crash between the terminal commit and the join) is joined now. The
 * binding/E2/C1 rows are durable, so the replay snapshot is the same one.
 */
export function contractRecoverPendingEvidence(meshId: string): number {
    const ctx = getContractCtx();
    if (!ctx || !hasAnyStrictState(ctx)) return 0;
    const store = MeshRuntimeStore.getInstance();
    let joined = 0;
    const rows = ctx.db.prepare(`SELECT task_id FROM contract_task_scopes WHERE mesh_id = ? AND mode = 'strict'`).all(meshId) as Array<{ task_id: string }>;
    for (const r of rows) {
        try {
            const entry = store.findQueueEntryById(meshId, r.task_id);
            const out = store.getLatestTaskOutput(r.task_id);
            if (entry?.status !== 'completed' || !out || out.status !== 'completed' || !entry.attemptId) continue;
            const has = ctx.db.prepare('SELECT 1 FROM contract_result_evidence WHERE mesh_id = ? AND task_id = ? AND output_version = ? AND payload_digest = ?')
                .get(meshId, r.task_id, out.version, out.digest);
            if (has) continue;
            const attempt = store.turnStore().getAttempt(entry.attemptId);
            if (!attempt) continue;
            const res = recordResultEvidence(ctx, {
                meshId, taskId: r.task_id, attemptId: entry.attemptId, generation: attempt.generation, outputVersion: out.version, payloadDigest: out.digest,
            }, { sessionId: attempt.sessionId });
            if (res?.created) joined += 1;
        } catch (e: any) {
            LOG.warn('Contract', `evidence recovery for task ${r.task_id} failed: ${e?.message || e}`);
        }
    }
    return joined;
}

const CONTRACT_GC_INTERVAL_MS = 60 * 60 * 1000;
let lastContractGcAt = 0;

export function contractHousekeeping(meshIds: readonly string[], deps: {
    deposit: (input: { meshId: string; taskId: string; text: string }) => { ok: boolean; id?: string };
    publishHeld: (note: HeldHandoffNote) => void;
}, nowMs = Date.now()): void {
    const ctx = getContractCtx();
    if (!ctx || !hasAnyAuthority(ctx)) return;
    for (const meshId of meshIds) {
        contractRecoverPendingEvidence(meshId);
        for (const note of contractPublishableHeldHandoffs(meshId)) {
            try { deps.publishHeld(note); } catch (e: any) { LOG.warn('Contract', `held handoff publish failed for ${note.taskId}: ${e?.message || e}`); }
        }
    }
    const gc = nowMs - lastContractGcAt >= CONTRACT_GC_INTERVAL_MS;
    if (gc) lastContractGcAt = nowMs;
    contractTick(mailboxContractHintPort(deps.deposit), { gc });
}

/** A coordinator session instance that ended loses every contract grant bound to it (design §4). */
export function subscribeContractGrantRevocation(bus: SessionLifecycleBus): Unsubscribe {
    return bus.on('terminated', (event) => {
        contractOnCoordinatorSessionEnded(event.sessionId);
    }, { name: 'mesh.contract-grant-revocation' });
}
