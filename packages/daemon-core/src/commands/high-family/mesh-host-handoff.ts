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

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { loadConfig } from '../../config/config.js';
import { LOG } from '../../logging/logger.js';
import { listLocalCoordinatorSessions } from '../../mesh/mesh-event-forwarding.js';
import { applyHostTransferToMember } from '../../mesh/host-handoff/member-adopt.js';
import { createLiveHandoffEngines, createLiveMeshPort, type LiveHandoffEngines, type LiveHandoffHost } from '../../mesh/host-handoff/live-env.js';
import { handlePeerVerb } from '../../mesh/host-handoff/peer-protocol.js';
import { HOST_HANDOFF_VERB, type PeerResult } from '../../mesh/host-handoff/types.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { buildCoordinatorHandoffBrief } from '../../assistant/coordinator-handoff-brief.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { collectBriefData, controlHostOf } from './assistant-session-control.js';

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
            for (const c of listLocalCoordinatorSessions(ctx.deps as never, meshId)) {
                const cliType = getCoordinatorForSession(c.sessionId)?.cliType ?? str(ctx.deps.instanceManager.getInstance(c.sessionId)?.getState?.()?.type);
                await host.exec('stop_cli', { cliType, targetSessionId: c.sessionId, mode: 'hard', reason: 'host_handoff' });
            }
        },
        canLaunchCoordinator: (meshId) => {
            const mesh = createLiveMeshPort().read(meshId);
            return !!mesh && (mesh.role === 'member' || mesh.role === 'host');
        },
        launchCoordinator: async (meshId, handoffId) => {
            const out = await host.exec('launch_mesh_coordinator', { meshId, managedByAssistant: true });
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
            return { success: true, sessionId, ready };
        },
        selfNodeId: (meshId) => {
            const mesh = createLiveMeshPort().read(meshId);
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
        return { success: true, enabled: true, source, target };
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
        const mesh = createLiveMeshPort();
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
