import { continueReport } from './report-continuation.js';
import { localAttemptReport } from '../commands/high-family/assistant.js';
import { TerminalWatchStore } from './terminal-watch.js';
import { TerminalWatchDelivery } from './terminal-watch-runtime.js';
/**
 * Boot wiring of the assistant layer (design docs/design/2026-10-07-assistant-layer.md
 * §4.3 "수신", §4.5, §4.8). Built by S7 (`boot/stages/mesh-runtime.ts`) next to
 * the other mesh bus subscribers; disposed in reverse order on shutdown.
 *
 * Inactive until an assistant exists: wiring only installs the project hooks.
 * `activate()` — at boot when `assistant.json` has an entry, on
 * `launch_assistant`, or on the first `project_send` / MCP-only pull — then
 * subscribes the registry and the relay to the bus and starts the 1-min relay
 * tick and the 24 h curator (both unref'd). A daemon whose owner never uses
 * the assistant carries no subscriber and no timer.
 *
 * Every port is an adapter over an existing function: the coordinator mark on
 * the live instance (`meshCoordinatorFor`), the read_chat projection (in-process
 * router call) for the relay body, `buildMeshStatusLineForNotification`, queue
 * stats + active missions, and the daemon's one send funnel
 * (`cliManager.input`, origin `assistant`, always `queue` for daemon inputs).
 * Nothing here judges turn completion — it only consumes `turn{committed}`.
 *
 * Remote-hosted projects (owner decision 2026-10-08): when the daemon has a
 * mesh transport, a second timer (`REMOTE_POLL_MS`) polls the host of every
 * open remote thread (assistant-remote-relay.ts) — the host's ledger commits
 * those coordinator turns, so they never reach this bus.
 */

import { SESSION_STATUS_CLASS } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { collectCoordinatorReplies } from './assistant-relay-audit.js';
import { verifiedNativeReportParts } from './attempt-report-recovery.js';
import { listCoordinatorsForMesh } from '../mesh/coordinator-registry.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { getMeshQueueStats } from '../mesh/mesh-work-queue.js';
import { getMeshMissions } from '../mesh/mesh-missions.js';
import { buildMeshStatusLineForNotification } from '../mesh/mesh-notification-status-line.js';
import { getAssistantRegistry, subscribeAssistantRegistry, type AssistantRegistry } from './assistant-registry.js';
import { InMemoryAssistantRelayStore, type AssistantRelayStore } from './assistant-relay-store.js';
import { AssistantMetricsStore, SqliteAssistantRelayStore } from './assistant-relay-sqlite-store.js';
import { ASSISTANT_RELAY_BUS_KINDS, AssistantRelay, type AssistantPulledEvent, type AssistantRelayPorts, type MeshWorkCounts } from './assistant-relay.js';
import { getAssistantServices } from './assistant-services.js';
import { projectSlugs } from './assistant-projects.js';
import { setAssistantMemberMeshSource } from './member-meshes.js';
import { compactTranscriptTail } from './project-views.js';
import { AssistantCurator, startAssistantCuratorTimer } from './skills/skill-curator.js';
import { liveAssistantQuotaPort, type AssistantQuotaPort } from './assistant-quota.js';
import { buildPreviousSessionNote, type PreviousSessionMessage } from './assistant-relay-format.js';
import { AssistantDigestScheduler } from './assistant-digest-scheduler.js';
import { AssistantReviewScheduler } from './assistant-review-scheduler.js';
import { setAssistantHumanInputSink } from './assistant-human-input.js';
import { getAssistantProjectPorts, setAssistantRelayHooks, type AssistantProjectPorts } from './assistant-project-ports.js';
import { AssistantRemoteRelayPoller, REMOTE_POLL_MS } from './assistant-remote-relay.js';

export const ASSISTANT_RELAY_TICK_MS = 60_000;
const METRICS_PRUNE_EVERY_MS = 60 * 60_000;

export type AssistantActivationReason = 'registry' | 'launch' | 'project_send' | 'pull';

export interface AssistantRuntime {
    readonly registry: AssistantRegistry;
    readonly relay: AssistantRelay;
    readonly store: AssistantRelayStore;
    readonly metrics: AssistantMetricsStore | null;
    /** Idle review turn trigger (§4.10.7), evaluated on the relay tick. */
    readonly review: AssistantReviewScheduler;
    /** Remote-hosted project result path (polls hosts of open remote threads). */
    readonly remotePoller: AssistantRemoteRelayPoller;
    isActive(): boolean;
    activate(reason: AssistantActivationReason): void;
    /** MCP-only pull: activates, then claims queued relays/signals. */
    pull(callerSessionId: string | null): Promise<Array<AssistantPulledEvent & { project?: string }>>;
    /** The bound assistant session when its instance is live on this daemon. */
    liveSessionId(): string | null;
    /**
     * `ReviewTriggerInput.quotaRemainingPct` for the bound assistant's CLI
     * (null when there is no assistant or no usable quota reading).
     */
    reviewQuotaRemainingPct(now?: number): number | null;
    dispose(): void;
}

type InstanceLike = { getState?: () => any; isModalParked?: () => boolean };

/** Ready status class (the relay's delivery gate and the review's idle gate). */
function instanceReady(inst: InstanceLike | null): boolean {
    if (!inst) return false;
    if (typeof inst.isModalParked === 'function' && inst.isModalParked()) return false;
    const status = str(inst.getState?.()?.status).toLowerCase();
    return (SESSION_STATUS_CLASS as Record<string, string>)[status] === 'ready';
}

function instanceModalOpen(inst: InstanceLike | null): boolean {
    if (!inst) return false;
    if (typeof inst.isModalParked === 'function' && inst.isModalParked()) return true;
    const state = inst.getState?.();
    const status = str(state?.status).toLowerCase();
    return (SESSION_STATUS_CLASS as Record<string, string>)[status] === 'blocked' || !!state?.activeChat?.activeModal;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export interface AssistantRuntimeOptions {
    registry?: AssistantRegistry;
    store?: AssistantRelayStore;
    metrics?: AssistantMetricsStore | null;
    tickMs?: number;
    /** Quota reading for the review-turn gate; defaults to the daemon's live quota cache. */
    quota?: AssistantQuotaPort;
    /** Remote-hosted project poll cadence (default `REMOTE_POLL_MS`). */
    remotePollMs?: number;
}

type RuntimeComponents = Pick<DaemonComponents, 'instanceManager' | 'router' | 'cliManager' | 'bus'>
    & Partial<Pick<DaemonComponents, 'dispatchMeshCommand' | 'getMeshPeerConnectionStatus' | 'statusInstanceId'>>;

let current: AssistantRuntime | null = null;

/** The wired runtime (null before S7 or after shutdown). */
export function getAssistantRuntime(): AssistantRuntime | null {
    return current;
}

function openStores(): { store: AssistantRelayStore; metrics: AssistantMetricsStore | null } {
    try {
        const db = MeshRuntimeStore.getInstance().db;
        return { store: new SqliteAssistantRelayStore(db), metrics: new AssistantMetricsStore(db) };
    } catch (e) {
        LOG.warn('Assistant', `relay store unavailable, using in-memory rows (no restart backlog): ${(e as Error)?.message ?? e}`);
        return { store: new InMemoryAssistantRelayStore(), metrics: null };
    }
}

/** Live instance lookup (best-effort). */
function instanceOf(components: Pick<DaemonComponents, 'instanceManager'>, sessionId: string): InstanceLike | null {
    try {
        return (components.instanceManager.getInstance(sessionId) as unknown as InstanceLike) ?? null;
    } catch {
        return null;
    }
}

export function buildAssistantRelayPorts(
    components: Pick<DaemonComponents, 'instanceManager' | 'router' | 'cliManager' | 'bus'>,
    deps: {
        registry: AssistantRegistry; store: AssistantRelayStore; metrics: AssistantMetricsStore | null; sawCaller: () => boolean;
        onReviewDelivered?: (sessionId: string, messageId: string, at: number) => void;
        onInputsSubmitted?: (sessionId: string, messageIds: readonly string[], at: number) => void;
    },
): AssistantRelayPorts {
    const { registry, store, metrics } = deps;
    const svc = getAssistantServices();
    const projectPorts = () => getAssistantProjectPorts({ components: () => components as DaemonComponents, selfDaemonId: str((components as any).statusInstanceId),
        execute: (cmd, args) => components.router.execute(cmd, args, 'ipc', { inProcess: true }),
        transport: { dispatch: (components as any).dispatchMeshCommand, peerStatus: (components as any).getMeshPeerConnectionStatus } });
    return {
        subscribe: (handler) => components.bus.on(ASSISTANT_RELAY_BUS_KINDS, handler, { name: 'assistant.relay' }),
        coordinatorMeshOf: (sessionId) => str(instanceOf(components, sessionId)?.getState?.()?.settings?.meshCoordinatorFor) || null,
        projectSlug: (meshId) => projectSlugs(svc.listMeshes()).get(meshId) ?? null,
        rehydrateAttemptReport: async (meshId, sessionId, attemptId) => {
            const ports = await projectPorts();
            const mesh = ports.listMeshes().find(m => m.id === meshId);
            if (!mesh) return null;
            if (ports.isHostedHere(mesh)) {
                const report = await localAttemptReport(ports, meshId, sessionId, attemptId);
                if (typeof report.body !== 'string' || !report.body) return null;
                return {
                    body: report.body,
                    completeness: report.completeness === 'final_native' ? 'final_native' as const : 'envelope_unverified' as const,
                    source: report.source,
                    ...(report.parts ? { parts: report.parts } : {}),
                };
            }
            const target = ports.remoteHost(mesh);
            if (!target.reachable) return null;
            const out = await ports.callHost(target, 'report', { coordinatorSessionId: sessionId, attemptId });
            if (!out.ok) return null;
            const result = out.result.result as { body?: unknown; completeness?: unknown; source?: unknown; parts?: unknown; provenance?: {
                version?: unknown; attemptId?: unknown; coordinatorSessionId?: unknown; generation?: unknown; evidenceRef?: unknown;
            } } | undefined;
            const proof = result?.provenance;
            // v1 rows are the rc16 truncated capture. A host that omits completeness
            // is unverified too. Neither is treated as an exact native window.
            const versionOk = proof?.version === 2 || proof?.version === 1;
            if (typeof result?.body !== 'string' || !versionOk || proof?.attemptId !== attemptId
                || proof?.coordinatorSessionId !== sessionId || !Number.isSafeInteger(proof?.generation) || Number(proof?.generation) < 0
                || typeof proof?.evidenceRef !== 'string' || proof.evidenceRef.length === 0 || proof.evidenceRef.length > 2048) return null;
            const nativeParts = proof?.version === 2 && result.completeness === 'final_native'
                ? verifiedNativeReportParts(result.body, result.parts, proof.evidenceRef, Number(proof.generation)) : null;
            const completeness = nativeParts ? 'final_native' as const : 'envelope_unverified' as const;
            const parts = nativeParts?.map(({ at, chars }) => ({ at, chars }));
            return { body: result.body, completeness, ...(typeof result.source === 'string' ? { source: result.source } : {}), ...(parts ? { parts } : {}) };
        },
        auditCoordinatorReplies: async (sinceMs) => {
            const ports = await projectPorts();
            const coordinatorSessions = ports.listMeshes().filter(mesh => ports.isHostedHere(mesh)).flatMap(mesh =>
                listCoordinatorsForMesh(mesh.id).filter(c => ports.coordinatorSessionAuthorized?.(mesh.id, c.sessionId) !== false));
            // The relay owns the failure fence. Converting rejection to [] here
            // would incorrectly advance its successful-audit watermark.
            return collectCoordinatorReplies({
                db: MeshRuntimeStore.getInstance().db, sinceMs, now: Date.now(), coordinatorSessions,
                execute: (cmd, args) => components.router.execute(cmd, args, 'ipc', { inProcess: true }),
            });
        },
        canReadCoordinatorReply: async (reply) => {
            if (!reply.messageId) return false;
            const ports = await projectPorts();
            if (!reply.meshId || ports.coordinatorSessionAuthorized?.(reply.meshId, reply.sessionId) === false
                || !ports.listMeshes().some(mesh => mesh.id === reply.meshId && ports.isHostedHere(mesh))) return false;
            const page = await continueReport(ports.execute, { coordinatorSessionId: reply.sessionId, messageId: reply.messageId, offset: 0 });
            return page.success === true && page.totalChars === reply.text.length
                && typeof page.text === 'string' && reply.text.startsWith(page.text);
        },
        onRelayGap: (_klass, at) => metrics?.bump('relay_gaps', '', at),
        readCoordinatorTail: async (sessionId) => {
            const chat = await components.router.execute('read_chat', { targetSessionId: sessionId, limit: 40 }, 'ipc', { inProcess: true });
            if (!chat?.success) return null;
            // Bypass compactTranscriptTail's 4,000 char limit by passing Infinity,
            // so compactRelayBody can properly apply its 4,096 char limit + explicit warning.
            const messages = (compactTranscriptTail(chat, 20, Infinity).messages as Array<{ role: string; text: string }>) ?? [];
            for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return messages[i]!.text;
            return null;
        },
        meshStatusLine: (meshId) => buildMeshStatusLineForNotification(meshId),
        meshWork: (meshId): MeshWorkCounts | null => {
            try {
                const q = getMeshQueueStats(meshId);
                return { activeMissions: getMeshMissions(meshId, ['active']).length, pending: q.pending, assigned: q.assigned };
            } catch {
                return null;
            }
        },
        hasAssistant: () => registry.read() !== null || deps.sawCaller(),
        assistantSessionId: () => registry.read()?.sessionId ?? null,
        isAssistantReady: (sessionId) => instanceReady(instanceOf(components, sessionId)),
        isParked: (sessionId, messageId) => components.cliManager.input.isParked(sessionId, messageId),
        submit: (sessionId, input) => components.cliManager.input.submit({
            messageId: input.messageId,
            sessionId,
            input: { parts: [{ type: 'text', text: input.text }], textFallback: input.text },
            origin: 'assistant',
            policy: input.policy,
            createdAt: Date.now(),
        }),
        inputLog: svc.inputLog,
        store,
        onRelayDelivered: (meshIds, at) => {
            registry.markFirstRelay(at);
            for (const m of meshIds) metrics?.bump('relays', m, at);
        },
        ...(deps.onReviewDelivered ? { onReviewDelivered: deps.onReviewDelivered } : {}),
        ...(deps.onInputsSubmitted ? { onInputsSubmitted: deps.onInputsSubmitted } : {}),
    };
}

/**
 * S7: build the runtime. Installs the project hooks immediately; the bus
 * subscribers and timers start on `activate()` (now, when `assistant.json`
 * already has an entry).
 */
export function wireAssistantRuntime(
    components: RuntimeComponents,
    opts: AssistantRuntimeOptions = {},
): AssistantRuntime {
    const registry = opts.registry ?? getAssistantRegistry();
    const opened = opts.store ? { store: opts.store, metrics: opts.metrics ?? null } : openStores();
    const { store, metrics } = opened;
    let sawCaller = false;
    let review: AssistantReviewScheduler | null = null;
    let terminalWatchStore: TerminalWatchStore | null = null;
    const relay = new AssistantRelay(buildAssistantRelayPorts(components, {
        registry, store, metrics, sawCaller: () => sawCaller,
        onReviewDelivered: (sid, messageId, at) => review?.onDelivered(sid, messageId, at),
        onInputsSubmitted: (sid, ids, at) => {
            for (const id of ids) {
                const match = /^assistant-terminal:([a-f0-9]{64}):(.+)$/.exec(id);
                if (!match) continue;
                const intent = terminalWatchStore?.intent(match[1]!, match[2]!);
                if (intent?.recipient_session_id === sid) terminalWatchStore?.acknowledge(match[1]!, match[2]!, at);
            }
        },
    }));
    const quota = opts.quota ?? liveAssistantQuotaPort;
    const liveSessionId = (): string | null => {
        const sid = registry.read()?.sessionId ?? null;
        return sid && instanceOf(components, sid) ? sid : null;
    };
    const reviewQuotaRemainingPct = (now: number): number | null => {
        const cliType = registry.read()?.cliType;
        return cliType ? quota.remainingPct(cliType, now) : null;
    };
    review = new AssistantReviewScheduler({
        liveSessionId,
        isReady: (sid) => instanceReady(instanceOf(components, sid)),
        modalOpen: (sid) => instanceModalOpen(instanceOf(components, sid)),
        idleSince: (sid) => {
            const t = registry.read()?.lastTurnState;
            return t && t.sessionId === sid && t.state === 'idle' ? t.at : null;
        },
        reviewTurnSetting: () => registry.read()?.reviewTurn ?? null,
        reviewAts: () => registry.read()?.reviewAts ?? [],
        quotaRemainingPct: reviewQuotaRemainingPct,
        inputLog: getAssistantServices().inputLog,
        relayBusy: () => relay.hasPendingInput(),
        isQueued: (messageId) => relay.isQueued(messageId),
        enqueue: (input) => relay.enqueueInput(input),
        recordDelivered: (at) => {
            registry.recordReview(at);
            metrics?.bump('review_turns', '', at);
        },
    });
    const reviewScheduler = review;
    const digestScheduler = new AssistantDigestScheduler({
        liveSessionId,
        isReady: (sid) => instanceReady(instanceOf(components, sid)),
        modalOpen: (sid) => instanceModalOpen(instanceOf(components, sid)),
        digestHour: () => registry.read()?.digestHour,
        lastDigestAt: () => registry.read()?.lastDigestAt ?? null,
        followsProjects: () => store.openThreads().length > 0,
        relayBusy: () => relay.hasPendingInput(),
        enqueue: (input) => relay.enqueueInput(input),
        recordDigest: (at) => registry.recordDigest(at),
    });

    // Meshes this daemon is a member of (no meshes.json record here): the
    // router's inline cache of the hosts' records joins the inventory.
    setAssistantMemberMeshSource({
        selfDaemonId: () => str(components.statusInstanceId),
        inlineMeshes: () => {
            const cache = (components.router as { inlineMeshCache?: Map<string, unknown> } | undefined)?.inlineMeshCache;
            return cache instanceof Map ? [...cache.values()] : [];
        },
    });

    // Remote-hosted projects: poll each open remote thread's host (the
    // project ports resolve host, reachability and the call; loaded once).
    let projectPorts: AssistantProjectPorts | null = null;
    const loadProjectPorts = async (): Promise<AssistantProjectPorts> => {
        projectPorts ??= await getAssistantProjectPorts({
            components: () => components as DaemonComponents,
            execute: (cmd, args) => components.router.execute(cmd, args, 'ipc', { inProcess: true }),
            selfDaemonId: str(components.statusInstanceId),
            transport: {
                ...(components.dispatchMeshCommand ? { dispatch: components.dispatchMeshCommand } : {}),
                ...(components.getMeshPeerConnectionStatus ? { peerStatus: components.getMeshPeerConnectionStatus } : {}),
            },
        });
        return projectPorts;
    };
    const remotePoller = new AssistantRemoteRelayPoller({
        openThreads: () => store.openThreads().map((t) => ({ meshId: t.meshId, lastSendAt: t.lastSendAt })),
        remoteTarget: (meshId) => {
            const ports = projectPorts;
            const mesh = ports?.listMeshes().find((m) => m.id === meshId);
            if (!ports || !mesh || ports.isHostedHere(mesh)) return null;
            return ports.remoteHost(mesh);
        },
        poll: async (target, args) => (await loadProjectPorts()).callHost(target, 'poll', args),
        relay,
    });
    let terminalDelivery: TerminalWatchDelivery | null = null;
    try {
        terminalWatchStore = new TerminalWatchStore(MeshRuntimeStore.getInstance().db);
        terminalDelivery = new TerminalWatchDelivery(terminalWatchStore, loadProjectPorts, liveSessionId,
            sid => instanceReady(instanceOf(components, sid)) && !relay.hasPendingInput(), async (sid, messageId, text) => {
                // Reuse relay batching, busy gates and delivery-time input attribution.
                if (!relay.isQueued(messageId)) relay.enqueueInput({ source: 'relay', text, messageId, forSessionId: sid });
                // Uncertainty metadata has no terminal receipt; dedupe its enqueue in memory.
                if (messageId.startsWith('assistant-terminal-uncertain:')) return true;
                return false; // durable intent stays pending until onInputsSubmitted or exact native evidence
            });
    } catch (e) { LOG.warn('Assistant', `terminal watch store unavailable: ${(e as Error).message}`); }
    const remoteTick = (): void => {
        void loadProjectPorts()
            .then(() => remotePoller.tick())
            .catch((e) => LOG.warn('Assistant', `remote relay poll failed: ${(e as Error)?.message ?? e}`));
    };

    let active = false;
    let disposed = false;
    const offs: Array<() => void> = [];
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let ticking = false;
    let lastMetricsPrune = 0;

    const tick = (): void => {
        if (ticking) return;
        ticking = true;
        try {
            const now = Date.now();
            relay.tick(now);
            void terminalDelivery?.tick().catch(e => LOG.warn('Assistant', `terminal watch delivery failed: ${(e as Error).message}`));
            const r = reviewScheduler.evaluate(now);
            if (r.fired) LOG.info('Assistant', `idle review turn queued (${r.messageId})`);
            const d = digestScheduler.evaluate(now);
            if (d.fired) LOG.info('Assistant', `daily digest queued (${d.messageId})`);
            if (metrics && now - lastMetricsPrune >= METRICS_PRUNE_EVERY_MS) {
                lastMetricsPrune = now;
                metrics.prune(now);
            }
        } catch (e) {
            LOG.warn('Assistant', `relay tick failed: ${(e as Error)?.message ?? e}`);
        } finally {
            ticking = false;
        }
    };

    const activate = (reason: AssistantActivationReason): void => {
        if (reason === 'project_send' || reason === 'pull') sawCaller = true;
        if (active || disposed) return;
        active = true;
        offs.push(subscribeAssistantRegistry(components.bus, registry));
        // After each finished assistant turn, keep its last exchanges for the
        // next session's [ADHDev previous session] note (read while alive: a
        // dead session's history is not readable for every CLI).
        let contextInFlight = false;
        offs.push(components.bus.on(['turn'], (event) => {
            if (event.kind !== 'turn' || event.phase !== 'committed' || contextInFlight) return;
            if (registry.read()?.sessionId !== event.sessionId) return;
            contextInFlight = true;
            void (async () => {
                try {
                    const chat = await components.router.execute('read_chat', { targetSessionId: event.sessionId, limit: 40 }, 'ipc', { inProcess: true });
                    if (!chat?.success) return;
                    const messages = (compactTranscriptTail(chat, 20, 2000).messages as PreviousSessionMessage[]) ?? [];
                    const text = buildPreviousSessionNote(messages);
                    if (text) registry.recordContext(event.sessionId, text, Date.now());
                } catch (e) {
                    LOG.debug('Assistant', `context snapshot failed: ${(e as Error)?.message ?? e}`);
                } finally {
                    contextInFlight = false;
                }
            })();
        }, { name: 'assistant.context' }));
        relay.start();
        offs.push(() => relay.stop());
        tickTimer = setInterval(tick, opts.tickMs ?? ASSISTANT_RELAY_TICK_MS);
        (tickTimer as { unref?: () => void }).unref?.();
        offs.push(() => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; });
        if (components.dispatchMeshCommand) {
            const remoteTimer = setInterval(remoteTick, opts.remotePollMs ?? REMOTE_POLL_MS);
            (remoteTimer as { unref?: () => void }).unref?.();
            offs.push(() => clearInterval(remoteTimer));
        }
        const svc = getAssistantServices();
        const curator = startAssistantCuratorTimer(new AssistantCurator(svc.skills, svc.memory), {
            onError: (e) => LOG.warn('Assistant', `curator pass failed: ${(e as Error)?.message ?? e}`),
        });
        offs.push(() => curator.stop());
        LOG.info('Assistant', `assistant layer active (${reason})`);
    };

    // M7 sink for the store verbs (applied / owner-approved review writes).
    const services = getAssistantServices();
    services.reviewMetrics = metrics ? { creditReviewWrite: (id, kind, at) => metrics.creditReviewWrite(id, kind, at) } : null;

    // Dashboard chat (at delivery) and dashboard terminal submit keys (at the
    // PTY write) into the assistant session → input log (human).
    setAssistantHumanInputSink({
        chat: (r) => relay.recordHumanSubmit(r.sessionIds, r.messageId, r.outcome),
        terminal: (r) => relay.recordHumanTerminalInput(r.sessionIds, r.data),
    });

    setAssistantRelayHooks({
        openThread: (meshId) => {
            activate('project_send');
            relay.openThread(meshId);
            metrics?.bump('assistant_sends', meshId, Date.now());
        },
        isThreadOpen: (meshId) => store.isThreadOpen(meshId),
        lastRelayAt: (meshId) => relay.lastRelayAtFor(meshId),
        recordProjectRead: (result) => relay.recordProjectRead(result),
        missedReports: (meshId) => relay.missedReportsFor(meshId),
        recordSkillAttaches: (meshId, count) => metrics?.bump('skill_attaches', meshId, Date.now(), count),
        remoteSent: (meshId, cursor) => remotePoller.noteSent(meshId, cursor),
    });

    const runtime: AssistantRuntime = {
        registry,
        relay,
        store,
        metrics,
        review: reviewScheduler,
        remotePoller,
        isActive: () => active,
        activate,
        async pull(callerSessionId) {
            activate('pull');
            const slugs = projectSlugs(getAssistantServices().listMeshes());
            const events = await relay.pullPending(callerSessionId);
            return events.map((e) => (e.meshId && slugs.get(e.meshId) ? { ...e, project: slugs.get(e.meshId) } : e));
        },
        liveSessionId,
        reviewQuotaRemainingPct(now = Date.now()) {
            return reviewQuotaRemainingPct(now);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            setAssistantRelayHooks(null);
            setAssistantHumanInputSink(null);
            setAssistantMemberMeshSource(null);
            if (services.reviewMetrics && getAssistantServices() === services) services.reviewMetrics = null;
            for (const off of offs.reverse()) {
                try { off(); } catch { /* noop */ }
            }
            if (current === runtime) current = null;
        },
    };

    if (registry.read() !== null) activate('registry');
    current = runtime;
    return runtime;
}
