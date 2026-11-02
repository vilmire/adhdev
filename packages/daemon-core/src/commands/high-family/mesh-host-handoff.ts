/**
 * Host handoff commands (design docs/design/2026-11-01-assistant-session-handoff.md §7.6).
 *
 *   mesh_host_handoff {op: preflight|start|status|abort|retry, meshId, ...}   owner verb (p2p / ws / standalone)
 *   mesh_host_handoff_{capability,chunk,ack,activate,status,discard,certificate}   peer verbs (mesh only, roster sender)
 *
 * Everything is behind `experimental.hostHandoff` (owner decision H2: off by
 * default). With the flag off the daemon answers the capability probe like an
 * older daemon, so no peer can start a handoff towards it; the owner verb refuses
 * with `host_handoff_disabled`. The assistant has no verb here: it can only stage
 * a `host_handoff` card, whose owner approval calls `startHostHandoff`.
 */

import { daemonIdsEquivalent, parseSessionLaunchRecord } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { loadConfig } from '../../config/config.js';
import { LOG } from '../../logging/logger.js';
import { listLocalCoordinatorSessions } from '../../mesh/mesh-event-forwarding.js';
import { applyHostTransferToMember } from '../../mesh/host-handoff/member-adopt.js';
import { createLiveHandoffEngines, createLiveMeshPort, readLiveHandoffMesh, type LiveHandoffEngines, type LiveHandoffHost } from '../../mesh/host-handoff/live-env.js';
import { handlePeerVerb } from '../../mesh/host-handoff/peer-protocol.js';
import { HOST_HANDOFF_VERB, type PeerResult } from '../../mesh/host-handoff/types.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { buildCoordinatorHandoffBrief } from '../../assistant/coordinator-handoff-brief.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { collectBriefData, controlHostOf } from './assistant-session-control.js';
import { stopProjectCoordinators } from '../../mesh/host-handoff/coordinator-stop.js';
import { listCoordinatorsForMesh } from '../../mesh/coordinator-registry.js';
import { classifyCoordinatorCensus } from '../../mesh/host-handoff/coordinator-observation.js';
import { withCoordinatorTransition } from '../../mesh/host-handoff/admission.js';
import { resolveRoleLaunch } from '../../launch-defaults/consumer.js';
import { resolveMeshCoordinatorSetup } from '../mesh-coordinator.js';
import { inspectTargetReadiness } from '../../mesh/host-handoff/target-readiness.js';
import { isTrustedOwnerIngress } from '../command-args.js';

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function hostHandoffEnabled(): boolean {
    try { return loadConfig().experimental?.hostHandoff === true; } catch { return false; }
}

const disabled = (): PeerResult => ({ success: false, code: 'host_handoff_disabled', error: 'Host handoff is an experimental feature; turn on experimental.hostHandoff in the daemon config.' });

const HANDOFF_PEER_VERBS = [
    HOST_HANDOFF_VERB.capability, HOST_HANDOFF_VERB.chunk, HOST_HANDOFF_VERB.ack, HOST_HANDOFF_VERB.activate,
    HOST_HANDOFF_VERB.status, HOST_HANDOFF_VERB.discard, HOST_HANDOFF_VERB.certificate,
] as const;

function liveHost(ctx: HighFamilyContext): LiveHandoffHost {
    const host = controlHostOf(ctx);
    const selfDaemonId = str(ctx.deps.statusInstanceId);
    return {
        selfDaemonId,
        dispatch: async (daemonId, verb, args) => {
            const dispatch = ctx.deps.dispatchMeshCommand;
            if (!dispatch) throw new Error('mesh transport unavailable');
            return unwrapMeshRelayResult(await dispatch(daemonId, verb, args), { command: verb, peerDaemonId: daemonId }) as PeerResult;
        },
        peerOnline: (daemonId) => (ctx.deps.getMeshPeerConnectionStatus ? !!ctx.deps.getMeshPeerConnectionStatus(daemonId) : !!ctx.deps.dispatchMeshCommand),
        coordinatorState: (meshId) => listLocalCoordinatorSessions(ctx.deps as never, meshId),
        stopCoordinators: async (meshId) => {
            if (!ctx.deps.sessionHostControl?.listSessions) throw new Error('trusted runtime census unavailable');
            return withCoordinatorTransition(meshId, () => stopProjectCoordinators(meshId, {
                list: () => ctx.deps.sessionHostControl!.listSessions(),
                registered: () => listCoordinatorsForMesh(meshId),
                stop: (targetSessionId, cliType) => host.exec('stop_cli', { cliType, targetSessionId, mode: 'hard', reason: 'host_handoff' }),
            }));
        },
        observeCoordinator: async (meshId, plan) => {
            const checkedAt = Date.now();
            if (!ctx.deps.sessionHostControl?.listSessions) return { ready: false, runtimeVerified: false, checkedAt };
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const records = await Promise.race([ctx.deps.sessionHostControl.listSessions(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runtime census timeout')), 3_000); })]);
                if (!Array.isArray(records) || records.some(r => !r || typeof r.sessionId !== 'string')) return { ready: false, runtimeVerified: false, checkedAt };
                const registeredIds = new Set(listCoordinatorsForMesh(meshId).map(r => r.sessionId));
                const census = classifyCoordinatorCensus(records, meshId, registeredIds);
                if (!census.verified) return { ready: false, runtimeVerified: false, checkedAt };
                const live = census.live;
                const sessionId = live.length === 1 ? live[0]!.sessionId : undefined;
                const registered = sessionId ? getCoordinatorForSession(sessionId) : undefined;
                if (sessionId && plan) {
                    const row = live[0]!;
                    const selectedNode = readLiveHandoffMesh(meshId, selfDaemonId)?.nodes?.find(n => n.id === plan.targetNodeId);
                    const launch = parseSessionLaunchRecord(row.meta?.launchRecord);
                    const selection = launch?.roleLaunch?.selection;
                    if (!selectedNode?.workspace || row.workspace !== selectedNode.workspace || registered?.workspace !== row.workspace
                        || row.providerType !== plan.provider || registered?.cliType !== plan.provider
                        || launch?.roleLaunch?.role !== 'coordinator' || selection?.provider !== plan.provider
                        || selection?.model !== plan.model || selection?.thinkingLevel !== plan.thinkingLevel) return { ready: false, runtimeVerified: false, checkedAt, liveCount: live.length };
                }
                const { localSessionReadyProbe } = await import('../coordinator-injection-cleanup.js');
                const probe = sessionId ? localSessionReadyProbe(ctx.deps.cliManager?.adapters as never, sessionId) : undefined;
                return { ready: !!sessionId && registered?.meshId === meshId && !!probe?.(), runtimeVerified: true, liveCount: live.length, checkedAt, ...(sessionId ? { sessionId } : {}) };
            } catch { return { ready: false, runtimeVerified: false, checkedAt }; }
            finally { if (timer) clearTimeout(timer); }
        },
        selectLaunch: (meshId, targetNodeId) => {
            const resolved = resolveRoleLaunch(ctx, 'coordinator', {}, meshId);
            if (!resolved.ok) throw new Error(`Coordinator selection unavailable: ${resolved.reason}`);
            if (!targetNodeId) throw new Error('An explicit target project workspace is required.');
            return { ...resolved.selection, targetNodeId };
        },
        readiness: async (meshId, plan) => {
            const mesh = readLiveHandoffMesh(meshId, selfDaemonId);
            if (!mesh) return { ok: false, checks: [{ id: 'target_project', ok: false }] };
            return inspectTargetReadiness({ selfDaemonId, mesh: mesh as never, plan,
                validateSelection: selection => {
                    const { targetNodeId: _targetNodeId, ...override } = selection;
                    const resolved = resolveRoleLaunch(ctx, 'coordinator', override);
                    return resolved.ok && JSON.stringify(resolved.selection) === JSON.stringify({ provider: selection.provider,
                        ...(selection.model !== undefined ? { model: selection.model } : {}),
                        ...(selection.thinkingLevel !== undefined ? { thinkingLevel: selection.thinkingLevel } : {}) });
                },
                provider: selection => {
                    const provider = ctx.deps.providerLoader.resolve?.(selection.provider) || ctx.deps.providerLoader.getMeta(selection.provider);
                    return provider?.spawn ? provider as never : undefined;
                },
                coordinatorCapable: (selection, workspace) => {
                    const provider = ctx.deps.providerLoader.resolve?.(selection.provider) || ctx.deps.providerLoader.getMeta(selection.provider);
                    const setup = resolveMeshCoordinatorSetup({ provider, cliType: selection.provider, meshId, workspace });
                    return setup.kind !== 'unsupported' && setup.kind !== 'manual';
                },
                census: () => {
                    if (!ctx.deps.sessionHostControl?.listSessions) throw new Error('trusted runtime census unavailable');
                    return ctx.deps.sessionHostControl.listSessions();
                },
            });
        },
        canLaunchCoordinator: (meshId) => {
            const mesh = createLiveMeshPort(selfDaemonId).read(meshId);
            return !!mesh && (mesh.role === 'member' || mesh.role === 'host');
        },
        launchCoordinator: async (meshId, handoffId, plan) => {
            if (!plan?.targetNodeId) return { success: false, ready: false };
            const census = await liveHost(ctx).observeCoordinator(meshId, plan);
            if (!census.runtimeVerified) return { success: false, ready: false };
            if (census.liveCount) return { success: !!census.sessionId, sessionId: census.sessionId, ready: census.ready };
            const out = await host.exec('launch_mesh_coordinator', { meshId, managedByAssistant: true, coordinatorNodeId: plan.targetNodeId, cliType: plan.provider, initialModel: plan.model, initialThinkingLevel: plan.thinkingLevel });
            const sessionId = str(out?.sessionId);
            if (out?.success !== true || !sessionId) return { success: false, ready: false };
            const { localSessionReadyProbe } = await import('../coordinator-injection-cleanup.js');
            const probe = localSessionReadyProbe(ctx.deps.cliManager?.adapters as never, sessionId);
            const deadline = Date.now() + 90_000;
            while (probe && Date.now() < deadline && !(probe() && ctx.deps.instanceManager.getInstance(sessionId))) await new Promise(r => setTimeout(r, 500));
            const ready = !!probe && probe() && !!ctx.deps.instanceManager.getInstance(sessionId);
            if (ready) {
                try {
                    const brief = buildCoordinatorHandoffBrief(await collectBriefData(host, host.exec, meshId, ''), { handoffId, toProvider: getCoordinatorForSession(sessionId)?.cliType ?? 'coordinator' });
                    await host.exec('send_chat', { targetSessionId: sessionId, text: brief.text, origin: 'assistant', policy: { mode: 'queue' }, messageId: brief.messageId });
                } catch (e) { LOG.warn('HostHandoff', `restart brief not delivered: ${(e as Error)?.message ?? e}`); }
            }
            const observed = await liveHost(ctx).observeCoordinator(meshId, plan);
            return { success: true, sessionId, ready: ready && observed.ready && observed.sessionId === sessionId };
        },
        selfNodeId: (meshId) => {
            const mesh = createLiveMeshPort(selfDaemonId).read(meshId);
            const node = (mesh?.config as { nodes?: Array<{ id?: string; daemonId?: string }> } | undefined)?.nodes?.find(n => !!n.daemonId && daemonIdsEquivalent(n.daemonId, selfDaemonId));
            return node?.id;
        },
        log: (line) => LOG.info('HostHandoff', line),
    };
}

let engines: LiveHandoffEngines | null = null;
function enginesFor(ctx: HighFamilyContext): LiveHandoffEngines {
    return engines ?? (engines = createLiveHandoffEngines(liveHost(ctx)));
}
export function __resetHostHandoffEnginesForTest(): void { engines = null; }

/** Called by the 30 s housekeeping and at boot (resume). Safe when the feature never ran. */
export async function tickHostHandoff(ctx: HighFamilyContext, opts: { resume?: boolean } = {}): Promise<void> {
    if (!hostHandoffEnabled()) return;
    const e = enginesFor(ctx);
    if (opts.resume) { await e.source.resume(); await e.target.resume(); }
    await e.source.tick();
    await e.target.tick();
}

/** The staged `host_handoff` card's approval. */
export async function startHostHandoff(ctx: HighFamilyContext, input: { meshId: string; targetDaemonId: string; targetNodeId?: string }) {
    if (!hostHandoffEnabled()) return disabled();
    return enginesFor(ctx).source.start(input);
}

const ownerVerb: HighFamilyHandler = async (ctx, args) => {
    if (!isTrustedOwnerIngress(args)) return { success: false, code: 'owner_auth_required', error: 'Host handoff requires verified owner ingress.' };
    if (!hostHandoffEnabled()) {
        return str(args?.op) === 'status' && !str(args?.meshId) ? { success: true, enabled: false } : disabled() as never;
    }
    const e = enginesFor(ctx);
    const op = str(args?.op);
    const meshId = str(args?.meshId);
    const handoffId = str(args?.handoffId);
    if (op === 'status') {
        if (!meshId && !handoffId) return { success: true, enabled: true };
        const source = e.source.status({ ...(handoffId ? { handoffId } : {}), ...(meshId ? { meshId } : {}) });
        const target = handoffId ? e.journal.get(handoffId, 'target') : meshId ? e.journal.list(meshId).filter(r => r.role === 'target').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null : null;
        return { success: true, enabled: true, source, target, ...(source ? { evidence: await e.source.evidence(source.handoffId) } : {}) };
    }
    if (!meshId && !handoffId) return { success: false, code: 'invalid_args', error: 'meshId or handoffId required' };
    if (op === 'preflight' || op === 'start') {
        const targetDaemonId = str(args?.targetDaemonId);
        if (!meshId || !targetDaemonId) return { success: false, code: 'invalid_args', error: 'meshId and targetDaemonId required' };
        const input = { meshId, targetDaemonId, ...(str(args?.targetNodeId) ? { targetNodeId: str(args.targetNodeId) } : {}), ...(handoffId ? { handoffId } : {}) };
        if (op === 'preflight') { const pf = await e.source.preflight(input); return { success: pf.ok, ok: pf.ok, checks: pf.checks, ...(pf.estimateBytes !== undefined ? { estimateBytes: pf.estimateBytes } : {}) }; }
        return startHostHandoff(ctx, input);
    }
    if (op === 'abort' || op === 'retry') {
        if (!handoffId) return { success: false, code: 'invalid_args', error: 'handoffId required' };
        return op === 'abort' ? e.source.abort(handoffId) : e.source.retry(handoffId);
    }
    return { success: false, code: 'invalid_args', error: 'op must be preflight, start, status, abort or retry' };
};

function peerVerb(verb: string): HighFamilyHandler {
    return async (ctx, args) => {
        // Flag off = indistinguishable from a daemon that does not know the feature.
        if (!hostHandoffEnabled()) return { success: false, code: 'peer_capability_unconfirmed' };
        const e = enginesFor(ctx);
        const sender = str((args as Record<string, unknown>)?._meshSenderDaemonId) || (await import('../mesh-sender.js')).readMeshSender(args);
        const mesh = createLiveMeshPort(str(ctx.deps.statusInstanceId));
        return handlePeerVerb({
            source: e.source, target: e.target,
            certificate: (a) => applyHostTransferToMember(mesh, str(ctx.deps.statusInstanceId), a.meshId, a.certificate),
        }, verb, (args ?? {}) as Record<string, unknown>, sender);
    };
}

export const meshHostHandoffHandlers: Record<string, HighFamilyHandler> = {
    [HOST_HANDOFF_VERB.owner]: ownerVerb,
    ...Object.fromEntries(HANDOFF_PEER_VERBS.map(v => [v, peerVerb(v)])),
};

export const meshHostHandoffSpecs = defineCommandSpecs('high', meshHostHandoffHandlers, {
    [HOST_HANDOFF_VERB.owner]: { sources: ['p2p', 'ws', 'standalone'] },
    ...Object.fromEntries(HANDOFF_PEER_VERBS.map(v => [v, { sources: ['mesh'] as const, meshSender: 'roster' as const }])),
});

/**
 * Boot wiring: resume interrupted handoffs once, then tick every 30 s (freeze
 * re-check, ACK timeout, activation probes with backoff). A no-op while the
 * experimental flag is off; the timer is unref'd and stopped with the host.
 */
export function startHostHandoffTicker(components: { router: { execute(cmd: string, args: any, source: any, opts?: any): Promise<unknown> } }): () => void {
    const ctx = {
        deps: components, components: () => components,
        execute: (cmd: string, args: any, source: any, opts?: any) => components.router.execute(cmd, args, source, opts),
    } as unknown as HighFamilyContext;
    let resumed = false;
    let running = false;
    const run = () => {
        if (running || !hostHandoffEnabled()) return;
        running = true;
        void tickHostHandoff(ctx, { resume: !resumed })
            .then(() => { resumed = true; })
            .catch(e => LOG.warn('HostHandoff', `tick failed: ${(e as Error)?.message ?? e}`))
            .finally(() => { running = false; });
    };
    const timer = setInterval(run, 30_000);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}
