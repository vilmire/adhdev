/**
 * Session control — the planning/decision core behind the assistant's
 * `session_control` tool (design 2026-11-01-assistant-session-handoff.md §4).
 *
 * Pure policy over injected ports; the verb layer
 * (commands/high-family/assistant-session-control.ts) binds the ports to the
 * daemon's EXISTING commands (`stop_cli`, `restart_session`, the strict worker
 * stop, `launch_mesh_coordinator`, `launch_assistant`). Nothing here stops a
 * process or duplicates stop/launch logic.
 *
 * Policy (owner decisions H4/H5):
 *   - `status` reads.
 *   - `stop` / `restart` of an IDLE target (no modal) run at once on the owner's
 *     utterance; a busy / waiting / unknown target is only PROPOSED (staged card).
 *   - `switch_provider` is ALWAYS proposed; execution happens on owner approval.
 *   - The assistant's own session is never cut mid-turn: its request is deferred
 *     to the end of the current turn.
 *   - A stop whose quiescence is not `confirmed` is reported as such; no caller
 *     re-assigns or re-queues on that basis (§4.3, §6.4).
 */

import { detectCredential } from './store-guards.js';
import type { StagedControlProposal, StagedControlTrigger } from './staged-control.js';

export const SESSION_CONTROL_ROLES = ['coordinator', 'worker', 'assistant'] as const;
export type SessionControlRole = typeof SESSION_CONTROL_ROLES[number];
export const SESSION_CONTROL_ACTIONS = ['status', 'stop', 'restart', 'switch_provider'] as const;
export type SessionControlAction = typeof SESSION_CONTROL_ACTIONS[number];

export const SESSION_CONTROL_REASON_MAX = 200;
export const SESSION_CONTROL_UTTERANCE_MAX = 1000;

export type Quiescence = 'confirmed' | 'pending' | 'unknown';
export type TargetState = 'idle' | 'busy' | 'waiting' | 'stopped' | 'unknown';

export interface SessionControlRequest {
    role: SessionControlRole;
    action: SessionControlAction;
    sessionId?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    reason?: string;
    interpretedFrom?: string;
}

export interface SessionControlTarget {
    role: SessionControlRole;
    sessionId: string;
    meshId: string;
    cliType: string;
    state: TargetState;
    /** False when another daemon hosts the session (remote worker nodes). */
    local: boolean;
    nodeId?: string;
    providerType?: string;
    quotaRemainingPct?: number;
}

export interface ProviderSelection { provider: string; model?: string; thinkingLevel?: string }

export type PortOutcome = { success: boolean; code?: string; error?: string; [k: string]: unknown };

export interface SessionControlPorts {
    resolveTarget(role: SessionControlRole, meshId: string, sessionId?: string): Promise<SessionControlTarget | null>;
    /** `new_work_held` etc.: a mesh-scope hold blocks launches (no bypass). */
    meshHeld(meshId: string): boolean;
    /** Eligibility check for the explicit override (resolveRoleLaunch semantics). */
    validateProvider(role: SessionControlRole, selection: ProviderSelection): { ok: true; selection: ProviderSelection } | { ok: false; code: string; error?: string };
    stop(target: SessionControlTarget): Promise<PortOutcome & { quiescence: Quiescence }>;
    restart(target: SessionControlTarget): Promise<PortOutcome & { newSessionId?: string }>;
    /** Coordinator switch sequence (assistant/coordinator-switch.ts). */
    switchCoordinator(target: SessionControlTarget, selection: ProviderSelection, opts: { reason?: string }): Promise<PortOutcome & { newSessionId?: string; previousSessionId?: string; quiescence?: Quiescence }>;
    /** Deferred execution of the assistant's own stop / restart / switch. */
    deferAssistant(job: DeferredAssistantJob): Promise<PortOutcome & { queued?: boolean }>;
    /** Release the target's queued work for reassignment. Called ONLY after a stop with `quiescence: 'confirmed'`. */
    releaseWork?(target: SessionControlTarget): Promise<void>;
    stage(proposal: StagedControlProposal): { id: string; expiresAt: number };
    /** Existing open card for the same target+action (no stacking). */
    findOpenProposal?(match: { meshId: string; role: SessionControlRole; action: string; sessionId?: string; provider?: string }): { id: string } | undefined;
    log?(line: string): void;
}

export interface DeferredAssistantJob {
    action: 'stop' | 'restart' | 'switch_provider';
    sessionId: string;
    selection?: ProviderSelection;
    reason?: string;
    requestedAt: number;
}

export type SessionControlResult =
    | { success: true; result: 'done'; code: string; role: SessionControlRole; action: SessionControlAction; sessionId?: string;
        newSessionId?: string; previousSessionId?: string; quiescence?: Quiescence; status?: Record<string, unknown>; deferred?: boolean }
    | { success: true; result: 'proposed'; code: string; stagedId: string; expiresAt: number; role: SessionControlRole; action: SessionControlAction; sessionId?: string }
    | { success: false; result: 'refused'; code: string; error: string; [k: string]: unknown };

function refuse(code: string, error: string, extra: Record<string, unknown> = {}): SessionControlResult {
    return { success: false, result: 'refused', code, error, ...extra };
}

function clean(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

/** Normalizes and validates the raw tool arguments. Returns an error string for invalid_args. */
export function parseSessionControlArgs(args: unknown): { ok: true; request: SessionControlRequest } | { ok: false; error: string } {
    const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args as Record<string, unknown> : {};
    const role = clean(a.role) as SessionControlRole;
    const action = clean(a.action) as SessionControlAction;
    if (!(SESSION_CONTROL_ROLES as readonly string[]).includes(role)) return { ok: false, error: 'role must be coordinator, worker or assistant' };
    if (!(SESSION_CONTROL_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: 'action must be status, stop, restart or switch_provider' };
    const sessionId = clean(a.sessionId);
    if (role === 'worker' && !sessionId) return { ok: false, error: 'sessionId is required for a worker' };
    const provider = clean(a.provider);
    if (action === 'switch_provider' && !provider) return { ok: false, error: 'provider is required for switch_provider' };
    if (action !== 'switch_provider' && (provider || clean(a.model) || clean(a.thinkingLevel))) {
        return { ok: false, error: 'provider / model / thinkingLevel apply to switch_provider only' };
    }
    const reason = clean(a.reason);
    if (reason.length > SESSION_CONTROL_REASON_MAX) return { ok: false, error: `reason is at most ${SESSION_CONTROL_REASON_MAX} characters` };
    const interpretedFrom = clean(a.interpretedFrom);
    if (interpretedFrom.length > SESSION_CONTROL_UTTERANCE_MAX) return { ok: false, error: `interpretedFrom is at most ${SESSION_CONTROL_UTTERANCE_MAX} characters` };
    if (action !== 'status' && !interpretedFrom) return { ok: false, error: 'interpretedFrom (the owner\'s words) is required' };
    for (const text of [reason, interpretedFrom, provider, clean(a.model), clean(a.thinkingLevel)]) {
        if (text && detectCredential(text)) return { ok: false, error: 'text looks like a credential; refused' };
    }
    return {
        ok: true,
        request: {
            role, action,
            ...(sessionId ? { sessionId } : {}),
            ...(provider ? { provider } : {}),
            ...(clean(a.model) ? { model: clean(a.model) } : {}),
            ...(clean(a.thinkingLevel) ? { thinkingLevel: clean(a.thinkingLevel) } : {}),
            ...(reason ? { reason } : {}),
            ...(interpretedFrom ? { interpretedFrom } : {}),
        },
    };
}

function isIdle(target: SessionControlTarget): boolean {
    return target.state === 'idle' || target.state === 'stopped';
}

function selectionOf(req: { provider?: string; model?: string; thinkingLevel?: string }): ProviderSelection | null {
    return req.provider ? { provider: req.provider, ...(req.model ? { model: req.model } : {}), ...(req.thinkingLevel ? { thinkingLevel: req.thinkingLevel } : {}) } : null;
}

function describeStatus(target: SessionControlTarget): Record<string, unknown> {
    return {
        sessionId: target.sessionId, role: target.role, cliType: target.cliType, state: target.state,
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        ...(target.quotaRemainingPct !== undefined ? { quotaRemainingPct: target.quotaRemainingPct } : {}),
        local: target.local,
    };
}

export interface RunContext {
    project: string;
    meshId: string;
    /** The mesh is hosted on another daemon (followed remote project). */
    remote: boolean;
    now: () => number;
}

/** Plan and (when policy allows) run one tool call. The caller authorized the owner utterance. */
export async function runSessionControl(req: SessionControlRequest, cx: RunContext, ports: SessionControlPorts): Promise<SessionControlResult> {
    const log = (line: string) => ports.log?.(line);
    if (cx.remote && req.action !== 'status') {
        return refuse('remote_project_unsupported', 'Session control of a project hosted on another machine is not available from here; use that machine.');
    }
    const target = await ports.resolveTarget(req.role, cx.meshId, req.sessionId);
    if (req.action === 'status') {
        if (!target) return refuse('target_not_found', `No ${req.role} session found for this project.`);
        return { success: true, result: 'done', code: 'status', role: req.role, action: 'status', sessionId: target.sessionId, status: describeStatus(target) };
    }
    if (!target) return refuse('target_not_found', `No ${req.role} session found for this project.`);
    if (req.role === 'worker' && req.action === 'switch_provider') {
        return refuse('unsupported_for_worker', 'A worker\'s provider follows node/slot routing; launch a new worker with mesh_launch_session instead.');
    }
    if (req.role === 'worker' && req.action === 'restart' && !isIdle(target)) {
        return propose(req, cx, ports, target, 'busy_target');
    }
    let selection: ProviderSelection | null = null;
    if (req.action === 'switch_provider') {
        const sel = selectionOf(req)!;
        const valid = ports.validateProvider(req.role, sel);
        if (!valid.ok) return refuse(valid.code, valid.error ?? valid.code, { field: 'provider' });
        selection = valid.selection;
        if (target.cliType === selection.provider && !selection.model && !selection.thinkingLevel) {
            return refuse('already_on_provider', `The ${req.role} already runs ${selection.provider}.`);
        }
        // Always an owner-approved card: cost and account change.
        return propose(req, cx, ports, target, 'switch_provider', selection);
    }
    if (req.role === 'assistant') {
        // The caller IS the assistant: end-of-turn execution, no card for an idle-free self request.
        const out = await ports.deferAssistant({ action: req.action as 'stop' | 'restart', sessionId: target.sessionId, ...(req.reason ? { reason: req.reason } : {}), requestedAt: cx.now() });
        if (!out.success) return refuse(out.code ?? 'defer_failed', out.error ?? 'could not queue the request');
        log(`[session-control] role=assistant action=${req.action} outcome=deferred`);
        return { success: true, result: 'done', code: 'deferred_to_turn_end', role: 'assistant', action: req.action, sessionId: target.sessionId, deferred: true };
    }
    if (!isIdle(target)) return propose(req, cx, ports, target, 'busy_target');
    return executeNow(req.role, req.action as 'stop' | 'restart', target, cx, ports, req.reason);
}

function propose(req: SessionControlRequest, cx: RunContext, ports: SessionControlPorts, target: SessionControlTarget,
    trigger: StagedControlTrigger, selection?: ProviderSelection): SessionControlResult {
    const existing = ports.findOpenProposal?.({ meshId: cx.meshId, role: req.role, action: req.action, sessionId: target.sessionId, provider: selection?.provider });
    const staged = existing
        ? { id: existing.id, expiresAt: 0 }
        : ports.stage({
            kind: 'session_control', project: cx.project, meshId: cx.meshId, trigger,
            role: req.role, action: req.action as 'stop' | 'restart' | 'switch_provider', sessionId: target.sessionId,
            ...(selection ? { provider: selection.provider, ...(selection.model ? { model: selection.model } : {}), ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}) } : {}),
            ...(req.reason ? { reason: req.reason } : {}),
            ...(req.interpretedFrom ? { interpretedFrom: req.interpretedFrom } : {}),
        });
    ports.log?.(`[session-control] role=${req.role} action=${req.action} outcome=proposed trigger=${trigger} staged=${staged.id}`);
    return { success: true, result: 'proposed', code: trigger === 'busy_target' ? 'target_busy_card' : 'owner_approval_required', stagedId: staged.id, expiresAt: staged.expiresAt, role: req.role, action: req.action, sessionId: target.sessionId };
}

async function executeNow(role: SessionControlRole, action: 'stop' | 'restart', target: SessionControlTarget,
    cx: RunContext, ports: SessionControlPorts, reason?: string): Promise<SessionControlResult> {
    const started = cx.now();
    if (action === 'restart' && ports.meshHeld(cx.meshId)) {
        return refuse('new_work_held', 'This project has a new-work hold; sessions cannot be restarted until it is released.');
    }
    if (action === 'stop') {
        const out = await ports.stop(target);
        ports.log?.(`[session-control] role=${role} action=stop outcome=${out.success ? 'done' : out.code ?? 'failed'} quiescence=${out.quiescence} ms=${cx.now() - started}`);
        if (!out.success) return refuse(out.code ?? 'stop_failed', out.error ?? 'stop failed', { quiescence: out.quiescence, sessionId: target.sessionId });
        // Only a confirmed-quiescent session may have its work released (§4.3, §6.4).
        if (out.quiescence === 'confirmed' && role === 'worker') await ports.releaseWork?.(target);
        return { success: true, result: 'done', code: out.quiescence === 'confirmed' ? 'stopped' : 'stop_not_quiescent', role, action, sessionId: target.sessionId, quiescence: out.quiescence };
    }
    const out = await ports.restart(target);
    ports.log?.(`[session-control] role=${role} action=restart outcome=${out.success ? 'done' : out.code ?? 'failed'} ms=${cx.now() - started}`);
    if (!out.success) return refuse(out.code ?? 'restart_failed', out.error ?? 'restart failed', { sessionId: target.sessionId });
    return { success: true, result: 'done', code: 'restarted', role, action, sessionId: target.sessionId, ...(out.newSessionId ? { newSessionId: out.newSessionId } : {}) };
}

/**
 * Apply an owner-approved proposal. The target is re-resolved: a session that
 * is gone is `target_gone`; the recorded session id must still be the one the
 * card named (a restarted coordinator is a different session — refused).
 */
export async function executeApprovedControl(p: StagedControlProposal, cx: Omit<RunContext, 'project'> & { project?: string }, ports: SessionControlPorts): Promise<SessionControlResult> {
    if (p.kind !== 'session_control' || !p.role || !p.action) return refuse('invalid_args', 'not a session control proposal');
    const role = p.role;
    const target = await ports.resolveTarget(role, cx.meshId, p.sessionId);
    if (!target || (p.sessionId && target.sessionId !== p.sessionId)) return refuse('target_gone', 'The session this card named is no longer running.');
    const run: RunContext = { project: p.project, meshId: cx.meshId, remote: false, now: cx.now };
    if (p.action === 'switch_provider') {
        const sel = selectionOf(p);
        if (!sel) return refuse('invalid_args', 'provider missing');
        const valid = ports.validateProvider(role, sel);
        if (!valid.ok) return refuse(valid.code, valid.error ?? valid.code);
        if (ports.meshHeld(cx.meshId)) return refuse('new_work_held', 'This project has a new-work hold.');
        if (role === 'assistant') {
            if (!isIdle(target)) {
                const out = await ports.deferAssistant({ action: 'switch_provider', sessionId: target.sessionId, selection: valid.selection, ...(p.reason ? { reason: p.reason } : {}), requestedAt: cx.now() });
                if (!out.success) return refuse(out.code ?? 'defer_failed', out.error ?? 'could not queue');
                return { success: true, result: 'done', code: 'deferred_to_turn_end', role, action: 'switch_provider', sessionId: target.sessionId, deferred: true };
            }
        }
        if (role === 'coordinator') {
            const out = await ports.switchCoordinator(target, valid.selection, { ...(p.reason ? { reason: p.reason } : {}) });
            ports.log?.(`[session-control] role=coordinator action=switch_provider outcome=${out.success ? 'done' : out.code ?? 'failed'}`);
            if (!out.success) return refuse(out.code ?? 'switch_failed', out.error ?? 'switch failed', { previousSessionId: target.sessionId });
            return { success: true, result: 'done', code: 'switched', role, action: 'switch_provider', sessionId: target.sessionId,
                ...(out.newSessionId ? { newSessionId: out.newSessionId } : {}), previousSessionId: target.sessionId,
                ...(out.quiescence ? { quiescence: out.quiescence } : {}) };
        }
        // assistant, idle: stop then launch with the explicit selection
        const out = await ports.deferAssistant({ action: 'switch_provider', sessionId: target.sessionId, selection: valid.selection, ...(p.reason ? { reason: p.reason } : {}), requestedAt: cx.now() });
        if (!out.success) return refuse(out.code ?? 'switch_failed', out.error ?? 'switch failed');
        return { success: true, result: 'done', code: 'switched', role, action: 'switch_provider', sessionId: target.sessionId };
    }
    // stop / restart approved by the owner: the busy guard was the card itself
    if (role === 'assistant') {
        const out = await ports.deferAssistant({ action: p.action, sessionId: target.sessionId, ...(p.reason ? { reason: p.reason } : {}), requestedAt: cx.now() });
        if (!out.success) return refuse(out.code ?? 'defer_failed', out.error ?? 'could not queue');
        return { success: true, result: 'done', code: 'deferred_to_turn_end', role, action: p.action, sessionId: target.sessionId, deferred: true };
    }
    return executeNow(role, p.action, target, run, ports, p.reason);
}
