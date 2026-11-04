/**
 * Owner override for a quota-held queue task (owner request 2026-11-01).
 *
 * A task held by the provider-quota RESERVE gate (`all_providers_quota_gated: …`) waits for the
 * window to reset. If it waits long the owner is asked, through the ordinary owner-decision inbox
 * (To do drawer + decision push), with three options (ids are positional, so the labels are the contract):
 *
 *   Wait for reset       — first option (id 'a'), recommended; keeps holding.
 *   Run anyway           — only when every blocking provider is overridable; sets `quotaGateOverride` on THIS queue row; the claim and auto-launch
 *                            quota gates then ignore the reserve for this one task.
 *   Use another provider — only offered when another usable, un-gated provider exists; drops the
 *                            task's `provider=` pin.
 *
 * ★Only the owner's answer can write `quotaGateOverride`: `applyQuotaOverrideAnswer` is called by the
 * answer state machine (mesh-mission-decisions.ts), whose ingress guard refuses coordinators, workers,
 * the assistant and the push relay for anything but option `a` (see `quotaOverrideAnswerGuard`).
 * Coordinators and assistants can only REQUEST the decision (`requestQuotaOverrideDecision`).
 *
 * ★A provider at its own hard limit is never overridden: a fresh `quota-exhausted` verdict, a
 * model-group exhaustion, or a reserve block with no headroom left stays gated (the provider itself
 * would refuse the run). `quotaBlockOverridable` is the single predicate; the decision then does not
 * offer "Run anyway" and the notice says the provider is at its limit.
 */
import {
    ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON,
    PROVIDER_QUOTA_MONTHLY_LOW_SKIP_REASON,
    PROVIDER_QUOTA_RESET_UNCONFIRMED_SKIP_REASON,
    PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
    PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON,
    type ProviderQuotaGateBlock,
} from './mesh-quota-routing.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { upsertStructuredMission } from './mesh-mission-structured.js';
import { meshRecord } from './mesh-record.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { LOG } from '../logging/logger.js';

export const QUOTA_OVERRIDE_KEY_PREFIX = 'quota-override:';
export const DEFAULT_QUOTA_HOLD_DECISION_AFTER_MS = 10 * 60_000;
/** Option labels are the contract (ids are positional and shift when an option is omitted); "Wait" is always first = id 'a'. */
export const QUOTA_OVERRIDE_LABELS = { wait: 'Wait for reset', runAnyway: 'Run anyway', otherProvider: 'Use another provider' } as const;
export const QUOTA_OVERRIDE_WAIT_OPTION_ID = 'a';
/** Below this remaining percent a provider is treated as fully used (matches the group-exhausted cut). */
export const QUOTA_HARD_LIMIT_PERCENT = 0.5;

/** `ADHDEV_QUOTA_HOLD_DECISION_AFTER_MS` overrides the 10 min default (tests, tuning). */
export function quotaHoldDecisionAfterMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.ADHDEV_QUOTA_HOLD_DECISION_AFTER_MS);
    return Number.isFinite(raw) && raw >= 0 && env.ADHDEV_QUOTA_HOLD_DECISION_AFTER_MS !== undefined && env.ADHDEV_QUOTA_HOLD_DECISION_AFTER_MS !== ''
        ? raw : DEFAULT_QUOTA_HOLD_DECISION_AFTER_MS;
}

export function isQuotaGateHoldReason(reason: string | undefined): boolean {
    return typeof reason === 'string'
        && (reason.startsWith(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON) || reason.startsWith('provider_quota_'));
}

/** Reserve blocks with headroom left are the only blocks a task's provider pin passes on its own (owner decision A, 2026-11-03). */
export function quotaBlockPinOverridable(block: Pick<ProviderQuotaGateBlock, 'reason' | 'remainingPercent'>): boolean {
    return (block.reason === PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON
        || block.reason === PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON
        || block.reason === PROVIDER_QUOTA_MONTHLY_LOW_SKIP_REASON)
        && block.remainingPercent >= QUOTA_HARD_LIMIT_PERCENT;
}

/**
 * What the OWNER may waive for one task: a reserve block with headroom left, or a confirmed exhaustion
 * whose reset passed with no new measurement (the owner's run is the probe that produces it). A provider
 * still inside its exhausted window, or at a model group's hard limit, is never overridable.
 */
export function quotaBlockOverridable(block: Pick<ProviderQuotaGateBlock, 'reason' | 'remainingPercent'>): boolean {
    return quotaBlockPinOverridable(block) || block.reason === PROVIDER_QUOTA_RESET_UNCONFIRMED_SKIP_REASON;
}

export function hasQuotaOverride(task: Pick<MeshWorkQueueEntry, 'quotaGateOverride'> | null | undefined): boolean {
    return task?.quotaGateOverride?.by === 'owner';
}

// ─── in-memory gate evidence (observability only; never a source of truth) ───

export interface QuotaGateEvidence {
    providerType: string;
    reason: string;
    window: string;
    remainingPercent: number;
    thresholdPercent: number;
    resetsAt?: number;
    overridable: boolean;
}

const evidenceByTask = new Map<string, { at: number; gated: QuotaGateEvidence[] }>();
const EVIDENCE_MAX = 500;

function evidenceKey(meshId: string, taskId: string): string { return `${meshId}:${taskId}`; }

export function noteQuotaGateEvidence(meshId: string, taskId: string, gated: ReadonlyArray<{ providerType: string; block: ProviderQuotaGateBlock }>): void {
    if (evidenceByTask.size >= EVIDENCE_MAX) {
        const oldest = evidenceByTask.keys().next().value;
        if (oldest !== undefined) evidenceByTask.delete(oldest);
    }
    evidenceByTask.set(evidenceKey(meshId, taskId), {
        at: Date.now(),
        gated: gated.map(({ providerType, block }) => ({
            providerType, reason: block.reason, window: block.window,
            remainingPercent: block.remainingPercent, thresholdPercent: block.thresholdPercent,
            ...(block.resetsAt ? { resetsAt: block.resetsAt } : {}),
            overridable: quotaBlockOverridable(block),
        })),
    });
}

export function clearQuotaGateEvidence(meshId: string, taskId: string): void {
    evidenceByTask.delete(evidenceKey(meshId, taskId));
}

export function readQuotaGateEvidence(meshId: string, taskId: string): QuotaGateEvidence[] {
    return evidenceByTask.get(evidenceKey(meshId, taskId))?.gated ?? [];
}

export function resetQuotaGateEvidenceForTests(): void { evidenceByTask.clear(); }

/** Providers named by an `all_providers_quota_gated: a: provider_quota_x; b: …` reason, for the restart case. */
export function parseQuotaHoldReason(reason: string): Array<{ providerType: string; reason: string }> {
    const body = reason.startsWith(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON)
        ? reason.slice(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON.length).replace(/^:\s*/, '')
        : reason;
    return body.split(';').map(part => part.trim()).filter(Boolean).flatMap(part => {
        const m = /^([\w.-]+):\s*(provider_quota_[a-z_]+)$/.exec(part);
        return m ? [{ providerType: m[1], reason: m[2] }] : [];
    });
}

const WINDOW_WORDS: Record<string, string> = {
    [PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON]: '5-hour',
    [PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON]: 'weekly',
    [PROVIDER_QUOTA_MONTHLY_LOW_SKIP_REASON]: 'monthly',
};

function formatReset(resetsAt: number | undefined): string {
    return resetsAt ? new Date(resetsAt).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z').replace('T', ' ') : '';
}

/** Plain-words, content-free description of what blocks the task (provider labels, counts, a time). */
export function describeQuotaGate(reason: string, evidence: readonly QuotaGateEvidence[]): { text: string; resetsAt?: number; allOverridable: boolean; providers: string[] } {
    const items = evidence.length
        ? evidence
        : parseQuotaHoldReason(reason).map(p => ({ providerType: p.providerType, reason: p.reason, window: '', remainingPercent: NaN, thresholdPercent: NaN, overridable: WINDOW_WORDS[p.reason] !== undefined } as QuotaGateEvidence));
    const parts = items.map(e => {
        const word = WINDOW_WORDS[e.reason];
        if (!word) return `${e.providerType} has reached its own limit (${e.reason.replace('provider_quota_', '').replace(/_/g, ' ')})`;
        const left = Number.isFinite(e.remainingPercent) ? `${Math.round(e.remainingPercent)}% left` : 'low';
        const reserve = Number.isFinite(e.thresholdPercent) ? `, reserve ${Math.round(e.thresholdPercent)}%` : '';
        return `${e.providerType} ${word} quota is ${left}${reserve}`;
    });
    const resets = items.map(e => e.resetsAt).filter((v): v is number => typeof v === 'number');
    const resetsAt = resets.length ? Math.min(...resets) : undefined;
    return {
        text: parts.join('; ') || reason,
        ...(resetsAt ? { resetsAt } : {}),
        allOverridable: items.length > 0 && items.every(e => e.overridable),
        providers: [...new Set(items.map(e => e.providerType))],
    };
}

export function providerPinOf(task: Pick<MeshWorkQueueEntry, 'requiredTags'>): string | undefined {
    return (task.requiredTags ?? []).find(tag => tag.startsWith('provider='))?.slice('provider='.length) || undefined;
}

/** The coordinator-facing text of `mesh:queue_held` for a quota hold (#4): what blocks, and the next actions. */
export function quotaHoldCoordinatorMessage(task: MeshWorkQueueEntry, reason: string, ageMs: number, evidence: readonly QuotaGateEvidence[]): string {
    const d = describeQuotaGate(reason, evidence);
    const pin = providerPinOf(task);
    const reset = d.resetsAt ? ` The earliest reset is ${formatReset(d.resetsAt)} UTC.` : ' The reset time is not known yet.';
    const limit = d.allOverridable ? '' : ' At least one provider is at its own hard limit: an override cannot start it there.';
    return `[System] Queue task ${task.id} has been held for ${Math.floor(ageMs / 60_000)} min because its provider has no quota headroom: ${d.text}.${pin ? ` It is pinned to ${pin} by required_tags.` : ''}${reset} It stays pending and starts by itself after the reset.${limit} `
        + `Next actions: (1) wait until the reset; (2) if it need not use that provider, cancel it and enqueue it again without the provider pin; `
        + `(3) ask the owner for a one-task override with mesh_queue_revise {task_id, expected_revision, patch:{requestQuotaOverride:true}} — this raises an owner decision, only the owner can grant it, and you cannot.`;
}

// ─── the decision ────────────────────────────────────────────────────────────

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function quotaOverrideDecisionKey(taskId: string): string { return `${QUOTA_OVERRIDE_KEY_PREFIX}${taskId}`; }

/** Stored dedupe key `k:quota-override:<taskId>` → task id. */
export function taskIdFromQuotaOverrideKey(dedupeKey: string | undefined): string | null {
    const p = `k:${QUOTA_OVERRIDE_KEY_PREFIX}`;
    const key = dedupeKey ?? '';
    return key.startsWith(p) && key.length > p.length ? key.slice(p.length) : null;
}

export interface RaisedQuotaDecision { itemId: string; deduped: boolean; options: string[] }

/**
 * Raise (idempotently) the owner decision for a quota-held task. The question is push-safe: provider
 * labels and a percent only. `alternatives` = other usable, un-gated providers ("Use another provider"
 * is offered only when non-empty and the task is provider-pinned).
 */
export function raiseQuotaOverrideDecision(
    meshId: string,
    task: MeshWorkQueueEntry,
    reason: string,
    opts: { alternatives?: readonly string[]; now?: number } = {},
): RaisedQuotaDecision | { error: string } {
    const evidence = readQuotaGateEvidence(meshId, task.id);
    const d = describeQuotaGate(reason, evidence);
    const alternatives = providerPinOf(task) ? [...(opts.alternatives ?? [])] : [];
    const shortId = task.id.slice(0, 8);
    const worst = evidence.length ? Math.min(...evidence.map(e => e.remainingPercent)) : NaN;
    const question = clip(`Task ${shortId} waits on ${d.providers.join('/') || 'provider'} quota${Number.isFinite(worst) ? ` (${Math.round(worst)}% left)` : ''}. Run it anyway?`, 120);
    const resetLine = d.resetsAt ? `Quota resets about ${formatReset(d.resetsAt)} UTC.` : 'The reset time is not known yet.';
    const options: Array<{ label: string; detail: string }> = [
        { label: QUOTA_OVERRIDE_LABELS.wait, detail: `${resetLine} The task keeps waiting and starts by itself.` },
    ];
    // A provider at its own hard limit would refuse the run, so "Run anyway" is not offered for it.
    if (d.allOverridable) options.push({ label: QUOTA_OVERRIDE_LABELS.runAnyway, detail: 'Ignores the quota reserve for this one task only. The provider may still refuse if it is truly out.' });
    if (!d.allOverridable && !alternatives.length) return { error: 'nothing_to_decide: the provider is at its own hard limit and no other provider can run this task' };
    if (alternatives.length) options.push({ label: QUOTA_OVERRIDE_LABELS.otherProvider, detail: `Drops the provider pin for this task so ${alternatives.slice(0, 3).join(', ')} can run it now.` });
    const context = clip([
        `Task ${task.id}: ${(task.message || '').trim().split('\n')[0].slice(0, 100)}`,
        `Blocked by: ${d.text}.`,
        resetLine,
        d.allOverridable ? 'Run anyway ignores the quota reserve for this one task only; a provider that is fully used still refuses to run it.' : 'A provider is at its own hard limit, so it cannot be overridden.',
    ].join(' '), 580);
    try {
        const { result } = upsertStructuredMission(meshId, {
            toCarryOver: true,
            itemsAdd: [{
                kind: 'decision', question, context, options,
                recommended: QUOTA_OVERRIDE_LABELS.wait, allowFreeText: false, urgency: 'normal', onDue: 'remind',
                dedupe_key: quotaOverrideDecisionKey(task.id),
            }],
        }, { actor: 'daemon' });
        const r = result.itemResults[0];
        if (!r || r.error || !r.id) return { error: r?.error ?? 'the decision was not recorded' };
        meshRecord(meshId, 'quota_gate_override', {
            taskId: task.id,
            payload: { phase: 'decision_raised', taskId: task.id, decisionId: r.id, deduped: !!r.deduped, options: options.length },
        }, { local: true });
        return { itemId: r.id, deduped: !!r.deduped, options: options.map(o => o.label) };
    } catch (e: any) {
        return { error: String(e?.message || e) };
    }
}

function persistTask(store: MeshRuntimeStore, task: MeshWorkQueueEntry): void {
    store.db.prepare("UPDATE mesh_queue SET payload = ? WHERE mesh_id = ? AND id = ? AND status = 'pending'").run(JSON.stringify(task), task.meshId, task.id);
}

/**
 * Called by the answer state machine after a decision answer/change/undo is recorded. Synchronises the
 * queue row with the CURRENT answer: option b grants the one-task override, option c drops the provider
 * pin, anything else (wait / undone / changed back) removes a previously granted override. A no-op for
 * every other decision.
 */
export function applyQuotaOverrideAnswer(meshId: string, itemId: string): { applied: 'granted' | 'revoked' | 'pin_dropped' | 'none'; taskId?: string } {
    const store = MeshRuntimeStore.getInstance();
    const item = store.missionItems().getItem(meshId, itemId);
    const taskId = taskIdFromQuotaOverrideKey(item?.dedupeKey);
    if (!item || !taskId || !item.decision) return { applied: 'none' };
    const decision = item.decision;
    const pickedId = item.state === 'answered' && item.decision.answer?.by === 'owner' ? item.decision.answer.optionId : undefined;
    const choice = item.decision.options.find(o => o.id === pickedId)?.label;
    return store.transaction(() => {
        const task = store.findQueueEntryById(meshId, taskId);
        if (!task || task.status !== 'pending') return { applied: 'none' as const, taskId };
        const had = hasQuotaOverride(task);
        if (choice === QUOTA_OVERRIDE_LABELS.runAnyway) {
            if (had && task.quotaGateOverride?.decisionId === itemId) return { applied: 'none' as const, taskId };
            task.quotaGateOverride = { by: 'owner', at: new Date().toISOString(), decisionId: itemId };
            persistTask(store, task);
            meshRecord(meshId, 'quota_gate_override', { taskId, payload: { phase: 'granted', taskId, decisionId: itemId, via: decision.answer?.via } }, { local: true });
            return { applied: 'granted' as const, taskId };
        }
        if (choice === QUOTA_OVERRIDE_LABELS.otherProvider) {
            const kept = (task.requiredTags ?? []).filter(tag => !tag.startsWith('provider='));
            if (kept.length === (task.requiredTags ?? []).length && !had) return { applied: 'none' as const, taskId };
            if (kept.length) task.requiredTags = kept; else delete task.requiredTags;
            delete task.quotaGateOverride; delete task.hold; delete task.holdNoticeId; delete task.autoLaunch;
            persistTask(store, task);
            meshRecord(meshId, 'quota_gate_override', { taskId, payload: { phase: 'pin_dropped', taskId, decisionId: itemId, via: decision.answer?.via } }, { local: true });
            return { applied: 'pin_dropped' as const, taskId };
        }
        if (had && task.quotaGateOverride?.decisionId === itemId) {
            delete task.quotaGateOverride;
            persistTask(store, task);
            meshRecord(meshId, 'quota_gate_override', { taskId, payload: { phase: 'revoked', taskId, decisionId: itemId } }, { local: true });
            return { applied: 'revoked' as const, taskId };
        }
        return { applied: 'none' as const, taskId };
    });
}

/**
 * Ingress guard for the answer state machine. Granting (b) or re-routing (c) is the owner's call from
 * the dashboard/CLI; the assistant and the push relay may only choose "Wait for reset".
 */
export function quotaOverrideAnswerGuard(dedupeKey: string | undefined, via: string, optionId: string | undefined): { code: string; error: string } | null {
    if (!taskIdFromQuotaOverrideKey(dedupeKey)) return null;
    if ((via === 'assistant' || via === 'push') && optionId !== QUOTA_OVERRIDE_WAIT_OPTION_ID) {
        return { code: 'quota_override_owner_only', error: 'a quota override can only be granted by the owner from the dashboard — the assistant and notifications may only choose "Wait for reset"' };
    }
    return null;
}

/** Close the open decision when its task is gone or no longer quota-held. */
export function withdrawQuotaOverrideDecision(meshId: string, itemId: string, reason: string): void {
    try {
        const items = MeshRuntimeStore.getInstance().missionItems();
        const found = items.getItem(meshId, itemId);
        if (!found || found.state !== 'open') return;
        items.updateItem(meshId, itemId, { state: 'withdrawn' });
        items.appendEvent(meshId, found.missionId, 'item_state_changed', 'daemon', { itemId, from: 'open', to: 'withdrawn', reason });
    } catch (e: any) { LOG.debug('MeshQueue', `withdraw quota-override decision failed: ${e?.message || e}`); }
}
