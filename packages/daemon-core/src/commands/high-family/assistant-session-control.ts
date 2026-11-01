/**
 * `assistant_session_control` — the verb behind the assistant's `session_control`
 * tool, and the owner-approval executor for staged `ctl-*` cards (design
 * docs/design/2026-11-01-assistant-session-handoff.md §4–§6).
 *
 * Authority is the owner-decision rule (`authorizeAssistantDecisionCaller`):
 * the bound assistant session's own MCP credential AND, for anything that acts,
 * an owner utterance in the current turn. The review-turn whitelist does not
 * include this verb (assistantToolGate → `review_turn_tool_denied`). All effects
 * are the daemon's EXISTING commands; the policy lives in assistant/session-control.ts.
 */

import { randomUUID } from 'node:crypto';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext } from './types.js';
import { ASSISTANT_TOOL_SOURCES } from './assistant-store.js';
import { assistantVerb, fail, resolveProject } from './assistant.js';
import { authorizeAssistantDecisionCaller } from './assistant-decisions.js';
import { LOG } from '../../logging/logger.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { pickCoordinator } from '../../assistant/coordinator-lifecycle.js';
import { liveAssistantQuotaPort } from '../../assistant/assistant-quota.js';
import { getStagedControlStore, type StagedControlProposal } from '../../assistant/staged-control.js';
import {
    executeApprovedControl, parseSessionControlArgs, runSessionControl,
    type PortOutcome, type ProviderSelection, type Quiescence, type SessionControlPorts, type SessionControlResult,
    type SessionControlRole, type SessionControlTarget, type TargetState,
} from '../../assistant/session-control.js';
import { switchCoordinator, type CoordinatorSwitchPorts } from '../../assistant/coordinator-switch.js';
import { buildCoordinatorHandoffBrief } from '../../assistant/coordinator-handoff-brief.js';
import { getSessionControlRuntime } from '../../assistant/session-control-runtime.js';
import { setCoordinatorDraining, getCoordinatorForSession, markCoordinatorSuccessor } from '../../mesh/coordinator-registry.js';
import { evaluateNewWorkHold } from '../../maintenance/new-work-hold.js';
import { createLaunchValidationPorts } from '../../launch-defaults/ports.js';
import { validateLaunchDefault } from '../../launch-defaults/validate.js';

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

const TERMINAL = new Set(['exited', 'stopped', 'terminated']);

export function instanceControlState(inst: { getState?: () => any; getDrainStatus?: () => string | null; isModalParked?: () => boolean } | undefined | null): TargetState {
    if (!inst) return 'stopped';
    const state = inst.getState?.();
    const status = str(state?.status).toLowerCase();
    if (TERMINAL.has(status)) return 'stopped';
    if (typeof inst.isModalParked === 'function' && inst.isModalParked()) return 'waiting';
    if (status === 'waiting_approval' || status === 'waiting_choice') return 'waiting';
    const drain = typeof inst.getDrainStatus === 'function' ? str(inst.getDrainStatus()).toLowerCase() : '';
    const effective = drain || status;
    if (effective === 'idle') return 'idle';
    if (effective === 'generating' || effective === 'long_generating' || effective === 'busy' || effective === 'starting') return 'busy';
    return 'unknown';
}

/** What the port builders need from a host: the router context for verbs, `DaemonComponents` for the runtime tick. */
export interface ControlHost {
    deps: Pick<HighFamilyContext['deps'], 'instanceManager' | 'cliManager' | 'providerLoader'>;
    components: () => any;
    exec(cmd: string, args: Record<string, unknown>): Promise<any>;
}

export function controlHostOf(ctx: HighFamilyContext): ControlHost {
    return { deps: ctx.deps, components: ctx.components, exec: (cmd, a) => ctx.execute(cmd, a, 'ipc', { inProcess: true }) as Promise<any> };
}

function instancesOf(host: ControlHost) {
    return host.deps.instanceManager;
}

/** Build the ports over the daemon's existing commands. */
export function buildSessionControlPorts(ctx: ControlHost, projectPorts: { coordinators(meshId: string): Array<{ sessionId: string; idle: boolean; modalParked: boolean; managedByAssistant: boolean; startedAt?: number; draining?: boolean }> }): SessionControlPorts {
    const exec = ctx.exec;
    const now = Date.now();
    const quotaPct = (cliType: string): number | undefined => {
        try { const v = liveAssistantQuotaPort.remainingPct(cliType, now, null); return v === null ? undefined : v; } catch { return undefined; }
    };
    const stopCli = async (sessionId: string, cliType: string): Promise<PortOutcome> => {
        const out = await exec('stop_cli', { cliType, targetSessionId: sessionId, mode: 'hard', reason: 'owner_session_control' });
        return { success: out?.success !== false, ...(out?.code ? { code: str(out.code) } : {}), ...(out?.error ? { error: str(out.error) } : {}) };
    };
    const quiescenceOf = (sessionId: string, meshId: string, nodeId?: string): Quiescence => {
        if (instancesOf(ctx).getInstance(sessionId)) return 'unknown';
        try {
            if (nodeId && MeshRuntimeStore.getInstance().hasActiveAssignment(meshId, sessionId, nodeId)) return 'pending';
        } catch { /* unreadable ledger: stay conservative below */ }
        return 'confirmed';
    };
    return {
        async resolveTarget(role, meshId, sessionId) {
            if (role === 'assistant') {
                const sid = str(getAssistantRegistry().read()?.sessionId);
                if (!sid || (sessionId && sessionId !== sid)) return null;
                const inst = instancesOf(ctx).getInstance(sid);
                if (!inst) return null;
                const cliType = str(getAssistantRegistry().read()?.cliType) || str(inst.getState?.()?.type);
                const q = quotaPct(cliType);
                return { role, sessionId: sid, meshId, cliType, state: instanceControlState(inst as any), local: true, ...(q !== undefined ? { quotaRemainingPct: q } : {}) };
            }
            if (role === 'coordinator') {
                const views = projectPorts.coordinators(meshId);
                const view = sessionId ? views.find(v => v.sessionId === sessionId) : pickCoordinator(views);
                if (!view) return null;
                const inst = instancesOf(ctx).getInstance(view.sessionId);
                const cliType = getCoordinatorForSession(view.sessionId)?.cliType || str(inst?.getState?.()?.type);
                const state: TargetState = view.modalParked ? 'waiting' : view.idle ? 'idle' : inst ? instanceControlState(inst as any) : 'unknown';
                const q = quotaPct(cliType);
                return { role, sessionId: view.sessionId, meshId, cliType, state: state === 'unknown' && view.idle ? 'idle' : state, local: true, ...(q !== undefined ? { quotaRemainingPct: q } : {}) };
            }
            // worker: a local session of this project (workers on other machines are not driven from here)
            if (!sessionId) return null;
            const inst = instancesOf(ctx).getInstance(sessionId);
            const st = inst?.getState?.();
            const settings = (st?.settings && typeof st.settings === 'object') ? st.settings as Record<string, unknown> : {};
            if (!inst || str(settings.meshNodeFor) !== meshId || str(settings.meshCoordinatorFor) || settings.assistant === true) return null;
            const cliType = str(st?.type) || str(settings.providerType);
            const q = quotaPct(cliType);
            return { role, sessionId, meshId, cliType, state: instanceControlState(inst as any), local: true,
                ...(str(settings.meshNodeId) ? { nodeId: str(settings.meshNodeId) } : {}), ...(q !== undefined ? { quotaRemainingPct: q } : {}) };
        },
        meshHeld: (meshId) => evaluateNewWorkHold({ meshId }).held,
        validateProvider(role, selection) {
            if (role === 'worker') return { ok: false, code: 'unsupported_for_worker' };
            try {
                const checked = validateLaunchDefault(role, selection, createLaunchValidationPorts({ deps: ctx.deps }));
                if (!checked.ok) return { ok: false, code: `provider_${checked.issue.reason}`, error: `${checked.issue.field} '${(selection as any)[checked.issue.field] ?? ''}': ${checked.issue.reason}` };
                return { ok: true, selection: checked.selection };
            } catch (e) {
                return { ok: false, code: 'catalog_unavailable', error: (e as Error)?.message ?? 'catalog unavailable' };
            }
        },
        async stop(target) {
            if (target.role === 'worker') {
                const { stopStaleMeshWorker } = await import('../../mesh/mesh-event-forwarding.js');
                const out: any = await stopStaleMeshWorker(ctx.components(), {
                    meshId: target.meshId, sessionId: target.sessionId, providerType: target.cliType,
                    ...(target.nodeId ? { nodeId: target.nodeId } : {}), reason: 'owner_session_control',
                });
                if (out?.code === 'writer_checkpoint_pending') return { success: true, code: 'writer_checkpoint_pending', quiescence: 'pending' };
                if (out?.success === false) return { success: false, code: str(out.code) || 'stop_failed', error: str(out.error), quiescence: 'unknown' };
                return { success: true, quiescence: quiescenceOf(target.sessionId, target.meshId, target.nodeId) };
            }
            if (target.role === 'coordinator') setCoordinatorDraining(target.sessionId, true);
            const out = await stopCli(target.sessionId, target.cliType);
            if (!out.success && target.role === 'coordinator') setCoordinatorDraining(target.sessionId, false);
            return { ...out, quiescence: out.success ? quiescenceOf(target.sessionId, target.meshId, target.nodeId) : 'unknown' };
        },
        async restart(target) {
            const out = await exec('restart_session', { cliType: target.cliType, targetSessionId: target.sessionId });
            if (out?.success === false) return { success: false, code: str(out.code) || 'restart_failed', error: str(out.error) };
            return { success: true, newSessionId: target.sessionId };
        },
        async switchCoordinator(target, selection, opts) {
            const out = await switchCoordinator({
                meshId: target.meshId, oldSessionId: target.sessionId, fromProvider: target.cliType, selection,
            }, buildCoordinatorSwitchPorts(ctx, exec));
            if (!out.success) return { success: false, code: out.code, error: out.error };
            void opts;
            return { success: true, newSessionId: out.newSessionId, previousSessionId: out.previousSessionId, quiescence: out.quiescence };
        },
        deferAssistant: async (job) => getSessionControlRuntime().pending.request(job),
        stage: (proposal) => {
            const rec = getStagedControlStore().write(proposal);
            return { id: rec.id, expiresAt: rec.expiresAt };
        },
        findOpenProposal: (m) => getStagedControlStore().findOpen(r => r.kind === 'session_control' && r.meshId === m.meshId
            && r.role === m.role && r.action === m.action && r.sessionId === m.sessionId && r.provider === m.provider),
        log: (line) => LOG.info('Assistant', line),
    };
}

/** Ports for assistant/coordinator-switch.ts over launch_mesh_coordinator / stop_cli / send_chat. */
export function buildCoordinatorSwitchPorts(ctx: ControlHost, exec: (cmd: string, a: Record<string, unknown>) => Promise<any>): CoordinatorSwitchPorts {
    return {
        setDraining: setCoordinatorDraining,
        async launch(meshId, selection) {
            const out = await exec('launch_mesh_coordinator', {
                meshId, cliType: selection.provider,
                ...(selection.model ? { initialModel: selection.model } : {}),
                ...(selection.thinkingLevel ? { initialThinkingLevel: selection.thinkingLevel } : {}),
                managedByAssistant: true,
            });
            return { success: out?.success === true, sessionId: str(out?.sessionId), ...(out?.code ? { code: str(out.code) } : {}), ...(out?.error ? { error: str(out.error) } : {}) };
        },
        markSuccessor: markCoordinatorSuccessor,
        waitReady: async (sessionId, timeoutMs) => {
            const { localSessionReadyProbe } = await import('../coordinator-injection-cleanup.js');
            const probe = localSessionReadyProbe(ctx.deps.cliManager?.adapters as any, sessionId);
            if (!probe) return false;
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (probe() && instancesOf(ctx).getInstance(sessionId)) return true;
                await new Promise(r => setTimeout(r, 500));
            }
            return false;
        },
        async buildBrief(meshId, oldSessionId, c) {
            const data = await collectBriefData(ctx, exec, meshId, oldSessionId);
            const brief = buildCoordinatorHandoffBrief(data, { handoffId: c.handoffId, fromProvider: c.fromProvider, toProvider: c.toProvider });
            return { text: brief.text, messageId: brief.messageId };
        },
        async sendBrief(sessionId, text, messageId) {
            const out = await exec('send_chat', { targetSessionId: sessionId, text, origin: 'assistant', policy: { mode: 'queue' }, messageId });
            return { success: out?.success !== false, ...(out?.code || out?.reason ? { code: str(out.code) || str(out.reason) } : {}), ...(out?.error ? { error: str(out.error) } : {}) };
        },
        async stop(sessionId) {
            const cliType = getCoordinatorForSession(sessionId)?.cliType || str(instancesOf(ctx).getInstance(sessionId)?.getState?.()?.type);
            const out = await exec('stop_cli', { cliType, targetSessionId: sessionId, mode: 'hard', reason: 'coordinator_switch' });
            const gone = !instancesOf(ctx).getInstance(sessionId);
            return { success: out?.success !== false, quiescence: gone ? 'confirmed' : 'unknown', ...(out?.code ? { code: str(out.code) } : {}) };
        },
        async discardNew(sessionId) {
            const cliType = getCoordinatorForSession(sessionId)?.cliType || str(instancesOf(ctx).getInstance(sessionId)?.getState?.()?.type);
            await exec('stop_cli', { cliType, targetSessionId: sessionId, mode: 'hard', reason: 'coordinator_switch_rollback' });
        },
        log: (line) => LOG.info('Assistant', line),
    };
}

export async function collectBriefData(ctx: ControlHost, exec: (cmd: string, a: Record<string, unknown>) => Promise<any>, meshId: string, oldSessionId: string) {
    const [{ getMeshQueueStats }, { getMeshMissions }, { buildOwnerDecisions }, { compactTranscriptTail }] = await Promise.all([
        import('../../mesh/mesh-work-queue.js'),
        import('../../mesh/mesh-missions.js'),
        import('../../mesh/mesh-mission-decisions.js'),
        import('../../assistant/project-views.js'),
    ]);
    void ctx;
    const stats = getMeshQueueStats(meshId);
    let tail: Array<{ role: string; text: string }> = [];
    if (oldSessionId) try {
        const chat = await exec('read_chat', { targetSessionId: oldSessionId, limit: 40 });
        if (chat?.success) tail = ((compactTranscriptTail(chat, 20, 2000).messages as Array<{ role: string; text: string }>) ?? []).slice(-20);
    } catch { /* the brief is still useful without the tail */ }
    return {
        missions: getMeshMissions(meshId, ['active', 'paused']).map(m => ({ id: m.id, title: m.title, status: m.status, openItems: 0 })),
        queue: { pending: stats.pending, assigned: stats.assigned, failed: stats.failed, ids: stats.activeAssignments.map(a => a.id) },
        decisions: buildOwnerDecisions(meshId).map(d => ({ id: d.itemId, question: d.question })),
        attempts: stats.activeAssignments.filter(a => a.sessionId).map(a => ({ sessionId: a.sessionId!, nodeId: a.nodeId, status: 'assigned' })),
        tail,
    };
}

/** Recognise `no_owner_utterance` under the design's code name. */
function translateAuthRefusal(denied: CommandRouterResult): CommandRouterResult {
    return denied.code === 'no_owner_utterance' ? { ...denied, code: 'owner_utterance_required' } : denied;
}

export const sessionControlVerb = assistantVerb(ASSISTANT_VERB.sessionControl, async (projectPorts, args, ctx) => {
    const parsed = parseSessionControlArgs(args);
    if (!parsed.ok) return fail('invalid_args', parsed.error);
    const denied = authorizeAssistantDecisionCaller(args, { requireOwnerUtterance: parsed.request.action !== 'status' });
    if (denied) return translateAuthRefusal(denied);
    const p = await resolveProject(projectPorts, args.project);
    if (!p.ok) return p.result;
    const result = await runSessionControl(parsed.request, { project: p.slug, meshId: p.mesh.id, remote: !!p.remote, now: Date.now },
        buildSessionControlPorts(controlHostOf(ctx), projectPorts));
    if (result.result !== 'refused') bumpSessionControlMetric(p.mesh.id);
    return { ...result, project: p.slug, meshId: p.mesh.id } as CommandRouterResult;
});

function bumpSessionControlMetric(meshId: string): void {
    try { getSessionControlRuntime().bumpMetric('session_controls', meshId); } catch { /* metrics never fail a control call */ }
}

/** Owner approval of a staged `ctl-*` card (called from assistant_staged_resolve). */
export async function resolveStagedControl(ctx: HighFamilyContext, id: string, decision: 'apply' | 'discard'): Promise<CommandRouterResult> {
    const store = getStagedControlStore();
    const out = await store.resolve(id, decision, async (record) => {
        if (record.kind === 'host_handoff') {
            // The owner approved this exact card; start the handoff engine directly (no assistant-reachable verb exists).
            const { startHostHandoff } = await import('./mesh-host-handoff.js');
            if (!record.targetDaemonId) return { success: false, code: 'invalid_args', error: 'card has no target daemon' };
            const res = await startHostHandoff(ctx, { meshId: record.meshId, targetDaemonId: record.targetDaemonId, ...(record.targetNodeId ? { targetNodeId: record.targetNodeId } : {}) }) as Record<string, unknown>;
            return { ...res, success: res.success === true };
        }
        const { getAssistantProjectPorts } = await import('../../assistant/assistant-project-ports.js');
        const projectPorts = await getAssistantProjectPorts({
            components: ctx.components,
            execute: (cmd, a) => ctx.execute(cmd, a, 'ipc', { inProcess: true }),
            selfDaemonId: str(ctx.deps?.statusInstanceId),
        });
        const res: SessionControlResult = await executeApprovedControl(record as StagedControlProposal, { meshId: record.meshId, remote: false, now: Date.now }, buildSessionControlPorts(controlHostOf(ctx), projectPorts));
        if (res.result === 'refused') return { success: false, code: res.code, error: res.error };
        if (record.trigger === 'quota_exhausted') getSessionControlRuntime().bumpMetric('quota_failovers_accepted', record.meshId);
        return { ...res, success: true };
    });
    return out as unknown as CommandRouterResult;
}

export function newHandoffId(): string { return randomUUID(); }

/** Owner verb (dashboard only, never `ipc`): read / set the per-role quota failover policy (owner decision H3). */
export const ASSISTANT_QUOTA_FAILOVER_COMMAND = 'assistant_quota_failover' as const;

const quotaFailoverVerb = async (_ctx: HighFamilyContext, args: any): Promise<CommandRouterResult> => {
    const registry = getAssistantRegistry();
    const action = str(args?.action) || 'get';
    const view = () => {
        const q = registry.read()?.quotaFailover ?? {};
        return { success: true, assistant: q.assistant ?? 'notify', coordinator: q.coordinator ?? 'notify', limits: { autoPerDay: 2, cooldownHours: 6 } };
    };
    if (action === 'get') return view();
    if (action !== 'set') return fail('invalid_args', 'action must be get or set');
    const patch: Record<string, string> = {};
    for (const role of ['assistant', 'coordinator'] as const) {
        if (args?.[role] === undefined) continue;
        if (!['notify', 'auto', 'off'].includes(str(args[role]))) return fail('invalid_args', `${role} must be notify, auto or off`);
        patch[role] = str(args[role]);
    }
    if (!Object.keys(patch).length) return fail('invalid_args', 'assistant and/or coordinator required');
    try {
        if (!registry.updateSettings({ quotaFailover: patch })) return fail('assistant_not_configured', 'no assistant has been launched on this machine yet');
    } catch (e) { return fail('settings_unavailable', (e as Error)?.message ?? 'settings unavailable'); }
    return view();
};

/**
 * Owner verb (dashboard only): switch the assistant's own CLI. The owner acting directly needs no card; the switch
 * still waits for the end of the assistant's current turn (owner decision H5) and goes through the same validation.
 */
export const ASSISTANT_SWITCH_PROVIDER_COMMAND = 'assistant_switch_provider' as const;

const switchProviderVerb = async (ctx: HighFamilyContext, args: any): Promise<CommandRouterResult> => {
    const sessionId = str(getAssistantRegistry().read()?.sessionId);
    const provider = str(args?.provider);
    if (!provider) return fail('invalid_args', 'provider required');
    if (!sessionId) return fail('target_not_found', 'no assistant session is running');
    const ports = buildSessionControlPorts(controlHostOf(ctx), { coordinators: () => [] });
    const valid = ports.validateProvider('assistant', { provider, ...(str(args?.model) ? { model: str(args.model) } : {}), ...(str(args?.thinkingLevel) ? { thinkingLevel: str(args.thinkingLevel) } : {}) });
    if (!valid.ok) return fail(valid.code, valid.error ?? valid.code);
    const out = await getSessionControlRuntime().pending.request({ action: 'switch_provider', sessionId, selection: valid.selection, requestedAt: Date.now() });
    if (!out.success) return fail(out.code ?? 'switch_failed', out.error ?? 'switch failed');
    LOG.info('Assistant', `[session-control] role=assistant action=switch_provider outcome=${out.queued ? 'queued_until_turn_end' : 'done'} source=owner`);
    return { success: true, result: out.queued ? 'queued' : 'done', provider: valid.selection.provider };
};

export const assistantSessionControlHandlers = {
    [ASSISTANT_VERB.sessionControl]: sessionControlVerb,
    [ASSISTANT_QUOTA_FAILOVER_COMMAND]: quotaFailoverVerb as never,
    [ASSISTANT_SWITCH_PROVIDER_COMMAND]: switchProviderVerb as never,
};

export const assistantSessionControlSpecs = defineCommandSpecs('high', assistantSessionControlHandlers, {
    [ASSISTANT_VERB.sessionControl]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_QUOTA_FAILOVER_COMMAND]: { sources: ['p2p', 'ws', 'standalone'] },
    [ASSISTANT_SWITCH_PROVIDER_COMMAND]: { sources: ['p2p', 'ws', 'standalone'] },
});

export type { ProviderSelection, SessionControlRole, SessionControlTarget };
