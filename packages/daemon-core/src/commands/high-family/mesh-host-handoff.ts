/**
 * Host handoff commands (design docs/design/2026-11-01-assistant-session-handoff.md §7.6).
 *
 *   mesh_host_handoff {op: preflight|start|status|abort|retry|set_enabled|pair_host, meshId, ...}   owner verb (p2p / ws / standalone)
 *   mesh_host_handoff_{capability,chunk,ack,activate,status,discard,certificate}   peer verbs (mesh only, roster sender)
 *
 * Everything is behind `experimental.hostHandoff` (owner decision H2: off by
 * default). With the flag off the daemon answers the capability probe like an
 * older daemon, so no peer can start a handoff towards it; the owner verb refuses
 * with `host_handoff_disabled`. The assistant has no verb here: it can only stage
 * a `host_handoff` card, whose owner approval calls `startHostHandoff`.
 */

import { canonicalDaemonId, daemonIdsEquivalent, parseSessionLaunchRecord } from '@adhdev/mesh-shared';
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
import { classifyCoordinatorCensus, presentCoordinatorCensusRows } from '../../mesh/host-handoff/coordinator-observation.js';
import { withCoordinatorTransition } from '../../mesh/host-handoff/admission.js';
import { resolveRoleLaunch } from '../../launch-defaults/consumer.js';
import { resolveMeshCoordinatorSetup } from '../mesh-coordinator.js';
import { inspectTargetReadiness } from '../../mesh/host-handoff/target-readiness.js';
import { isTrustedOwnerIngress } from '../command-args.js';
import { updateConfig } from '../../config/config.js';
import { readAuthenticatedPeerOriginGrantPublicKey, readMeshHostRecord, transferMeshHostRecord, writeMeshHostRecord } from '../../mesh/mesh-host-memory.js';
import { putPeerSecret } from '../../mesh/transport/mesh-peer-secrets.js';
import type { MemberAdoptionPort } from '../../mesh/host-handoff/member-adopt.js';

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function hostHandoffEnabled(): boolean {
    try { return loadConfig().experimental?.hostHandoff === true; } catch { return false; }
}

const disabled = (): PeerResult => ({ success: false, code: 'host_handoff_disabled', error: 'Host handoff is an experimental feature; turn on experimental.hostHandoff in the daemon config.' });

const HANDOFF_PEER_VERBS = [
    HOST_HANDOFF_VERB.capability, HOST_HANDOFF_VERB.chunk, HOST_HANDOFF_VERB.ack, HOST_HANDOFF_VERB.activate,
    HOST_HANDOFF_VERB.status, HOST_HANDOFF_VERB.discard, HOST_HANDOFF_VERB.certificate, HOST_HANDOFF_VERB.memberProbe,
] as const;

/** A member follows a move whether or not it opted in to moves of its own. The flag
 * gates what this daemon may start or become; these two only report and follow. */
const MEMBER_VERBS_WITHOUT_FLAG: ReadonlySet<string> = new Set([HOST_HANDOFF_VERB.certificate, HOST_HANDOFF_VERB.memberProbe]);

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
        peerOnline: (daemonId) => {
            if (!ctx.deps.getMeshPeerConnectionStatus) return !!ctx.deps.dispatchMeshCommand;
            // No peer entry only means this daemon has not dialed yet: the probe that follows does.
            // A retained failure record is not "online" just because it exists.
            const peer = ctx.deps.getMeshPeerConnectionStatus(daemonId);
            return !peer || (peer.state !== 'failed' && peer.state !== 'disconnected' && peer.state !== 'closed');
        },
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
                const presented = presentCoordinatorCensusRows(records);
                const registeredIds = new Set(listCoordinatorsForMesh(meshId).map(r => r.sessionId));
                const census = classifyCoordinatorCensus(presented, meshId, registeredIds);
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
        restoreCoordinator: async (meshId) => {
            const out = await host.exec('launch_mesh_coordinator', { meshId, managedByAssistant: true });
            return { success: out?.success === true, ...(str(out?.sessionId) ? { sessionId: str(out.sessionId) } : {}), ...(str(out?.error) ? { error: str(out.error) } : {}) };
        },
        meshAuthorityChanged: (meshId) => {
            const inline = (ctx as { inlineMeshCache?: Map<string, unknown> }).inlineMeshCache;
            inline?.delete(meshId);
            try { (ctx as { invalidateAggregateMeshStatus?: (id: string) => void }).invalidateAggregateMeshStatus?.(meshId); } catch { /* a stale aggregate expires by itself */ }
        },
        readiness: async (meshId, plan, opts) => {
            // A worker daemon may hold no project record before it takes authority. Its own node
            // on the host's roster names the registration to inspect, and every check below still
            // runs against this machine. No other roster field affects the outcome.
            const mesh = readLiveHandoffMesh(meshId, selfDaemonId) ?? (opts?.offeredMesh as never);
            if (!mesh) return { ok: false, checks: [{ id: 'target_project', ok: false }] };
            return inspectTargetReadiness({ selfDaemonId, mesh: mesh as never, plan, ...(opts?.canaryMaxAgeMs ? { canaryMaxAgeMs: opts.canaryMaxAgeMs } : {}),
                validateSelection: selection => {
                    const { targetNodeId: _targetNodeId, ...override } = selection;
                    // This machine's defaults do not apply: the plan is what launches, so only its validity here is asked.
                    const resolved = resolveRoleLaunch(ctx, 'coordinator', override, undefined, ['model', 'thinkingLevel']);
                    // Still exact: a validated selection that came back different would launch something the plan did not name.
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
            liveHost(ctx).meshAuthorityChanged?.(meshId);
            const census = await liveHost(ctx).observeCoordinator(meshId, plan);
            if (!census.runtimeVerified) return { success: false, ready: false };
            if (census.liveCount) return { success: !!census.sessionId, sessionId: census.sessionId, ready: census.ready };
            const out = await host.exec('launch_mesh_coordinator', { meshId, managedByAssistant: true, coordinatorNodeId: plan.targetNodeId, cliType: plan.provider, initialModel: plan.model, initialThinkingLevel: plan.thinkingLevel, exactLaunchSelection: true });
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

/**
 * A provider probe plus a full export takes longer than a dashboard command may wait (30s),
 * and a start runs through the whole copy. The work continues here either way. A caller
 * that gets `pending` repeats the same call: it attaches to the same run, never a second one.
 */
const OWNER_JOB_ANSWER_WAIT_MS = 20_000;
const ownerJobs = new Map<string, { done?: PeerResult; run: Promise<void> }>();
async function ownerJob(key: string, work: () => Promise<PeerResult>): Promise<PeerResult> {
    let job = ownerJobs.get(key);
    if (!job) {
        const created: { done?: PeerResult; run: Promise<void> } = { run: Promise.resolve() };
        created.run = work().then(result => { created.done = result; }, e => { created.done = { success: false, code: 'verify_failed', error: (e as Error)?.message ?? String(e) }; });
        ownerJobs.set(key, job = created);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.run, new Promise<void>(resolve => { timer = setTimeout(resolve, OWNER_JOB_ANSWER_WAIT_MS); })]);
    if (timer) clearTimeout(timer);
    if (!job.done) return { success: true, pending: true };
    ownerJobs.delete(key);
    return job.done;
}

/** Owner-only, per machine, no restart: the flag is read on every use. Both machines of a move need it on. */
function setHostHandoffEnabled(enabled: boolean): PeerResult {
    updateConfig({ experimental: { ...(loadConfig().experimental ?? {}), hostHandoff: enabled } });
    return { success: true, enabled: hostHandoffEnabled() };
}

/**
 * Run on the TARGET, by the owner, with a one-time code the owner took from the host
 * over a separate authenticated connection. The host verifies that code, and only
 * then does this daemon pin the key the host answers with. That pin is what activation
 * verifies the stop certificate against; a key offered during a handoff never becomes one.
 */
async function pairTargetWithHost(ctx: HighFamilyContext, args: any): Promise<PeerResult> {
    const meshId = str(args?.meshId), token = str(args?.token), hostDaemonId = str(args?.hostDaemonId), nodeId = str(args?.targetNodeId), workspace = str(args?.workspace);
    const selfDaemonId = str(ctx.deps.statusInstanceId);
    if (!meshId || !token || !hostDaemonId || !nodeId || !workspace) return { success: false, code: 'invalid_args', error: 'meshId, token, hostDaemonId, targetNodeId and workspace are required' };
    if (!ctx.deps.dispatchMeshCommand) return { success: false, code: 'peer_capability_unconfirmed', error: 'mesh transport unavailable' };
    const answer = unwrapMeshRelayResult(await ctx.deps.dispatchMeshCommand(hostDaemonId, 'apply_mesh_host_join', {
        meshId, token, memberNode: { id: nodeId, workspace, daemonId: selfDaemonId, role: 'member' },
    }), { command: 'apply_mesh_host_join', peerDaemonId: hostDaemonId }) as Record<string, any>;
    if (answer.success !== true) return { success: false, code: str(answer.code) || 'mesh_host_join_rejected', error: str(answer.error) || 'The host refused the pairing.' };
    const key = str(answer.originGrantPublicKey) || str(answer.meshHost?.originGrantPublicKey);
    if (!key) return { success: false, code: 'host_key_unpinned', error: 'The host accepted the pairing but returned no key.' };
    // Stored the same way join_mesh_host_pairing stores them. Secret first: a member that
    // cannot keep its credential must not look paired.
    const secret = str(answer.peerSecret);
    if (secret) putPeerSecret({ meshId, peerDaemonId: canonicalDaemonId(hostDaemonId) || hostDaemonId, role: 'member', secret, originGrantPublicKey: key, createdAt: new Date().toISOString() });
    writeMeshHostRecord(meshId, hostDaemonId, 'pairing', key, { pairingVerified: true });
    return { success: true, pinned: true };
}

const ownerVerb: HighFamilyHandler = async (ctx, args) => {
    if (!isTrustedOwnerIngress(args)) return { success: false, code: 'owner_auth_required', error: 'Host handoff requires verified owner ingress.' };
    if (!hostHandoffEnabled()) {
        if (str(args?.op) === 'set_enabled') return setHostHandoffEnabled(args?.enabled === true);
        return str(args?.op) === 'status' && !str(args?.meshId) ? { success: true, enabled: false } : disabled() as never;
    }
    if (str(args?.op) === 'set_enabled') return setHostHandoffEnabled(args?.enabled === true);
    const e = enginesFor(ctx);
    const op = str(args?.op);
    const meshId = str(args?.meshId);
    const handoffId = str(args?.handoffId);
    if (op === 'pair_host') return pairTargetWithHost(ctx, args);
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
        const key = JSON.stringify([op, meshId, targetDaemonId, input.targetNodeId ?? '']);
        // A preflight that ran is an answer, whatever it found. `ok` carries the verdict; cloud P2P would reject `success:false`.
        if (op === 'preflight') return ownerJob(key, async () => { const pf = await e.source.preflight(input); return { success: true, ok: pf.ok, checks: pf.checks, ...(pf.estimateBytes !== undefined ? { estimateBytes: pf.estimateBytes } : {}) }; });
        return ownerJob(key, async () => startHostHandoff(ctx, input) as Promise<PeerResult>);
    }
    if (op === 'abort' || op === 'retry') {
        if (!handoffId) return { success: false, code: 'invalid_args', error: 'handoffId required' };
        return op === 'abort' ? e.source.abort(handoffId) : e.source.retry(handoffId);
    }
    return { success: false, code: 'invalid_args', error: 'op must be preflight, start, status, abort, retry, set_enabled or pair_host' };
};

function memberAdoption(ctx: HighFamilyContext, sender: string): MemberAdoptionPort {
    return {
        sender,
        readRecord: (meshId) => {
            const record = readMeshHostRecord(meshId);
            if (!record) return null;
            const pin = readAuthenticatedPeerOriginGrantPublicKey(meshId, record.hostDaemonId);
            return { hostDaemonId: record.hostDaemonId, ...(pin ? { originGrantPublicKey: pin } : {}) };
        },
        writeRecord: (meshId, next) => { transferMeshHostRecord(meshId, next); },
        reanchorSessions: (meshId, from, to) => {
            const instances = ctx.deps.instanceManager as unknown as { listInstanceIds?(): string[]; getInstance?(id: string): { getState?(): { settings?: Record<string, unknown> }; updateSettings?(s: Record<string, unknown>): void } | undefined };
            for (const id of instances?.listInstanceIds?.() ?? []) {
                const instance = instances.getInstance?.(id);
                const settings = instance?.getState?.()?.settings;
                if (settings?.meshNodeFor !== meshId || !daemonIdsEquivalent(str(settings.meshCoordinatorDaemonId), from)) continue;
                instance?.updateSettings?.({ meshCoordinatorDaemonId: to, meshCoordinatorSessionId: undefined });
            }
        },
    };
}

function peerVerb(verb: string): HighFamilyHandler {
    return async (ctx, args) => {
        // Flag off = indistinguishable from a daemon that does not know the feature, except that it can still follow a move.
        if (!hostHandoffEnabled() && !MEMBER_VERBS_WITHOUT_FLAG.has(verb)) return { success: false, code: 'peer_capability_unconfirmed' };
        const sender = str((args as Record<string, unknown>)?._meshSenderDaemonId) || (await import('../mesh-sender.js')).readMeshSender(args);
        const mesh = createLiveMeshPort(str(ctx.deps.statusInstanceId));
        const certificate = (a: { meshId: string; certificate: unknown }, from: string) => {
            const result = applyHostTransferToMember(mesh, str(ctx.deps.statusInstanceId), a.meshId, a.certificate, memberAdoption(ctx, from));
            if (result.success) liveHost(ctx).meshAuthorityChanged?.(a.meshId);
            return result;
        };
        if (MEMBER_VERBS_WITHOUT_FLAG.has(verb)) return handlePeerVerb({ certificate }, verb, (args ?? {}) as Record<string, unknown>, sender);
        const e = enginesFor(ctx);
        return handlePeerVerb({ source: e.source, target: e.target, certificate }, verb, (args ?? {}) as Record<string, unknown>, sender);
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

type HandoffTickerComponents = { router: { deps: unknown; execute(cmd: string, args: any, source: any, opts?: any): Promise<unknown> } };

/** The engines keep the first context they get, so the ticker's must be the router's own deps: components have no session host control. */
export function handoffTickerContext(components: HandoffTickerComponents): HighFamilyContext {
    return {
        // Read on use: the ticker starts during boot, before anything addresses the router.
        get deps() { return components.router.deps; }, components: () => components,
        execute: (cmd: string, args: any, source: any, opts?: any) => components.router.execute(cmd, args, source, opts),
    } as unknown as HighFamilyContext;
}

/**
 * Boot wiring: resume interrupted handoffs once, then tick every 30 s (freeze
 * re-check, ACK timeout, activation probes with backoff). A no-op while the
 * experimental flag is off; the timer is unref'd and stopped with the host.
 */
export function startHostHandoffTicker(components: HandoffTickerComponents): () => void {
    const ctx = handoffTickerContext(components);
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
