/**
 * Quota failover (design 2026-11-01 §6): when the assistant's or a followed
 * project's coordinator provider has run out of quota, offer (or, opted in,
 * perform) a switch to the next eligible provider of the role's fallback order.
 *
 * `decideFailover` is a pure judgement; `QuotaFailoverTicker` owns the
 * per-role policy (notify | auto | off), the auto caps (2 per rolling day,
 * 6 h cooldown per role+project) and de-duplication of cards/notices.
 * Everything crosses injected ports — local daemon/dashboard only; nothing
 * here touches the cloud status path (CLAUDE.md content boundary).
 */

import type { ProviderSelection, SessionControlRole, TargetState } from './session-control.js';
import type { QuotaFailoverMode } from './assistant-registry.js';
import type { StagedControlProposal } from './staged-control.js';

/** A fallback must have at least this much quota left (same floor the review turn uses). */
export const FAILOVER_MIN_REMAINING_PCT = 20;
/** A window that resets sooner than this is waited out, not switched away from. */
export const FAILOVER_MIN_WAIT_MS = 30 * 60_000;
/** A `generating` session counts as stalled after this long without finishing. */
export const FAILOVER_STALL_MS = 10 * 60_000;
export const FAILOVER_AUTO_PER_DAY = 2;
export const FAILOVER_AUTO_COOLDOWN_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface FailoverSubject {
    role: Extract<SessionControlRole, 'assistant' | 'coordinator'>;
    project: string;
    meshId: string;
    sessionId: string;
    cliType: string;
    state: TargetState;
    /** ms the session has been in its current `generating` turn (when busy). */
    busyForMs?: number;
    /** Remaining % of the subject's own provider quota (0 = exhausted, null = unknown). */
    remainingPct: number | null;
    /** Epoch ms the exhausted window resets, when known. */
    resetsAt?: number;
}

export interface FailoverProviderQuota { remainingPct: number | null; resetsAt?: number }

export interface FailoverDecisionInput {
    subject: FailoverSubject;
    fallback: readonly ProviderSelection[];
    quotaOf(provider: string): FailoverProviderQuota;
    isEligible(selection: ProviderSelection): boolean;
    now: number;
}

export type FailoverDecision =
    | { kind: 'none'; reason: 'not_exhausted' | 'busy' | 'resets_soon' | 'no_fallback_configured' }
    | { kind: 'no_fallback'; reason: 'none_eligible' }
    | { kind: 'switch'; to: ProviderSelection; toRemainingPct: number; toResetsAt?: number };

export function decideFailover(input: FailoverDecisionInput): FailoverDecision {
    const { subject, now } = input;
    if (subject.remainingPct === null || subject.remainingPct > 0) return { kind: 'none', reason: 'not_exhausted' };
    const idle = subject.state === 'idle';
    const stalled = subject.state === 'busy' && (subject.busyForMs ?? 0) >= FAILOVER_STALL_MS;
    if (!idle && !stalled) return { kind: 'none', reason: 'busy' };
    // A window about to reset is waited out; an unknown reset cannot be promised.
    if (subject.resetsAt !== undefined && subject.resetsAt - now < FAILOVER_MIN_WAIT_MS) return { kind: 'none', reason: 'resets_soon' };
    if (input.fallback.length === 0) return { kind: 'none', reason: 'no_fallback_configured' };
    for (const candidate of input.fallback) {
        if (candidate.provider === subject.cliType) continue;
        if (!input.isEligible(candidate)) continue;
        const q = input.quotaOf(candidate.provider);
        if (q.remainingPct === null || q.remainingPct < FAILOVER_MIN_REMAINING_PCT) continue;
        return { kind: 'switch', to: candidate, toRemainingPct: q.remainingPct, ...(q.resetsAt !== undefined ? { toResetsAt: q.resetsAt } : {}) };
    }
    return { kind: 'no_fallback', reason: 'none_eligible' };
}

export interface FailoverHistory {
    /** Auto failovers of (role, meshId) at or after `since`. */
    autoCountSince(role: string, meshId: string, since: number): number;
    /** Time of the latest recorded failover (auto or accepted) of (role, meshId). */
    lastAt(role: string, meshId: string): number | null;
    record(entry: { at: number; role: string; meshId: string; sessionId: string; mode: 'auto' | 'accepted'; from: string; to: string }): void;
}

export interface QuotaFailoverPorts {
    now(): number;
    subjects(): Promise<FailoverSubject[]>;
    /** Per-role policy; unset = notify. */
    mode(role: 'assistant' | 'coordinator'): QuotaFailoverMode;
    /** The role's configured alternatives (launch-defaults `fallback`). */
    fallbackOrder(role: 'assistant' | 'coordinator'): ProviderSelection[];
    quotaOf(provider: string): FailoverProviderQuota;
    isEligible(role: 'assistant' | 'coordinator', selection: ProviderSelection): boolean;
    /** An unexpired card for this session already exists. */
    hasOpenCard(meshId: string, role: string, sessionId: string): boolean;
    stage(proposal: StagedControlProposal): { id: string };
    /** `[ADHDev notice]` to the assistant (local). */
    notify(text: string, messageId: string): void;
    /** Run the switch without a card (auto mode only). */
    autoSwitch(subject: FailoverSubject, to: ProviderSelection): Promise<{ success: boolean; code?: string }>;
    history: FailoverHistory;
    metric(column: 'quota_failovers_proposed' | 'quota_failovers_auto', meshId: string): void;
    log(line: string): void;
}

export type TickOutcome =
    | { subject: string; outcome: 'skipped'; why: string }
    | { subject: string; outcome: 'no_fallback' }
    | { subject: string; outcome: 'proposed'; stagedId: string }
    | { subject: string; outcome: 'auto_done' }
    | { subject: string; outcome: 'auto_blocked'; why: 'daily_cap' | 'cooldown' | 'switch_failed' };

const NOTICE_COOLDOWN_MS = 60 * 60_000;

export class QuotaFailoverTicker {
    private readonly noticed = new Map<string, number>();
    constructor(private readonly ports: QuotaFailoverPorts) {}

    async tick(): Promise<TickOutcome[]> {
        const out: TickOutcome[] = [];
        const now = this.ports.now();
        for (const subject of await this.ports.subjects()) {
            const key = `${subject.role}:${subject.meshId}:${subject.sessionId}`;
            const mode = this.ports.mode(subject.role);
            if (mode === 'off') { out.push({ subject: key, outcome: 'skipped', why: 'off' }); continue; }
            const decision = decideFailover({
                subject, now,
                fallback: this.ports.fallbackOrder(subject.role),
                quotaOf: (p) => this.ports.quotaOf(p),
                isEligible: (sel) => this.ports.isEligible(subject.role, sel),
            });
            if (decision.kind === 'none') { out.push({ subject: key, outcome: 'skipped', why: decision.reason }); continue; }
            if (decision.kind === 'no_fallback') {
                const last = this.noticed.get(`nf:${key}`) ?? 0;
                if (now - last >= NOTICE_COOLDOWN_MS) {
                    this.noticed.set(`nf:${key}`, now);
                    this.ports.notify(`[ADHDev notice] The ${subject.role} of ${subject.project} (${subject.cliType}) is out of quota and no eligible fallback provider has enough quota left (no_fallback). The owner can add or change fallbacks in the launch defaults.`, `qfo-nf:${key}:${Math.floor(now / NOTICE_COOLDOWN_MS)}`);
                }
                out.push({ subject: key, outcome: 'no_fallback' });
                continue;
            }
            if (this.ports.hasOpenCard(subject.meshId, subject.role, subject.sessionId)) { out.push({ subject: key, outcome: 'skipped', why: 'card_open' }); continue; }
            if (mode === 'auto') {
                const last = this.ports.history.lastAt(subject.role, subject.meshId);
                if (last !== null && now - last < FAILOVER_AUTO_COOLDOWN_MS) { out.push({ subject: key, outcome: 'auto_blocked', why: 'cooldown' }); continue; }
                if (this.ports.history.autoCountSince(subject.role, subject.meshId, now - DAY_MS) >= FAILOVER_AUTO_PER_DAY) { out.push({ subject: key, outcome: 'auto_blocked', why: 'daily_cap' }); continue; }
                const done = await this.ports.autoSwitch(subject, decision.to);
                if (!done.success) {
                    this.ports.log(`[session-control] quota failover auto role=${subject.role} outcome=${done.code ?? 'failed'}`);
                    out.push({ subject: key, outcome: 'auto_blocked', why: 'switch_failed' });
                    continue;
                }
                this.ports.history.record({ at: now, role: subject.role, meshId: subject.meshId, sessionId: subject.sessionId, mode: 'auto', from: subject.cliType, to: decision.to.provider });
                this.ports.metric('quota_failovers_auto', subject.meshId);
                this.ports.notify(`[ADHDev notice] The ${subject.role} of ${subject.project} ran out of ${subject.cliType} quota and was switched to ${decision.to.provider} automatically (opt-in).`, `qfo-auto:${key}:${now}`);
                out.push({ subject: key, outcome: 'auto_done' });
                continue;
            }
            const card = this.ports.stage({
                kind: 'session_control', project: subject.project, meshId: subject.meshId, trigger: 'quota_exhausted',
                role: subject.role, action: 'switch_provider', sessionId: subject.sessionId,
                provider: decision.to.provider,
                ...(decision.to.model ? { model: decision.to.model } : {}),
                ...(decision.to.thinkingLevel ? { thinkingLevel: decision.to.thinkingLevel } : {}),
                reason: 'quota_exhausted',
                quota: { fromProvider: subject.cliType, fromRemainingPct: subject.remainingPct ?? 0, toProvider: decision.to.provider, toRemainingPct: decision.toRemainingPct, ...(subject.resetsAt !== undefined ? { resetsAt: subject.resetsAt } : {}) },
            });
            this.ports.metric('quota_failovers_proposed', subject.meshId);
            this.ports.notify(`[ADHDev notice] The ${subject.role} of ${subject.project} is out of ${subject.cliType} quota. A switch to ${decision.to.provider} (${decision.toRemainingPct}% left) waits for the owner's approval (card ${card.id}); do nothing until the owner decides.`, `qfo:${key}:${card.id}`);
            out.push({ subject: key, outcome: 'proposed', stagedId: card.id });
        }
        return out;
    }
}
