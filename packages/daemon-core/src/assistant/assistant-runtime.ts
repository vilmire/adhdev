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
 */

import { SESSION_STATUS_CLASS } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { getMeshQueueStats } from '../mesh/mesh-work-queue.js';
import { getMeshMissions } from '../mesh/mesh-missions.js';
import { buildMeshStatusLineForNotification } from '../mesh/mesh-notification-status-line.js';
import { getAssistantRegistry, subscribeAssistantRegistry, type AssistantRegistry } from './assistant-registry.js';
import { InMemoryAssistantRelayStore, type AssistantRelayStore } from './assistant-relay-store.js';
import { AssistantMetricsStore, SqliteAssistantRelayStore } from './assistant-relay-sqlite-store.js';
import { ASSISTANT_RELAY_BUS_KINDS, AssistantRelay, type AssistantPulledEvent, type AssistantRelayPorts, type MeshWorkCounts } from './assistant-relay.js';
import { getAssistantServices } from './assistant-services.js';
import { setAssistantRelayHooks } from './assistant-project-ports.js';
import { projectSlugs } from './assistant-projects.js';
import { compactTranscriptTail } from './project-views.js';
import { AssistantCurator, startAssistantCuratorTimer } from './skills/skill-curator.js';
import { liveAssistantQuotaPort, type AssistantQuotaPort } from './assistant-quota.js';
import { AssistantReviewScheduler } from './assistant-review-scheduler.js';
import { setAssistantHumanInputSink } from './assistant-human-input.js';

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
}

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
    },
): AssistantRelayPorts {
    const { registry, store, metrics } = deps;
    const svc = getAssistantServices();
    return {
        subscribe: (handler) => components.bus.on(ASSISTANT_RELAY_BUS_KINDS, handler, { name: 'assistant.relay' }),
        coordinatorMeshOf: (sessionId) => str(instanceOf(components, sessionId)?.getState?.()?.settings?.meshCoordinatorFor) || null,
        projectSlug: (meshId) => projectSlugs(svc.listMeshes()).get(meshId) ?? null,
        readCoordinatorTail: async (sessionId) => {
            const chat = await components.router.execute('read_chat', { targetSessionId: sessionId, limit: 40 }, 'ipc', { inProcess: true });
            if (!chat?.success) return null;
            const messages = (compactTranscriptTail(chat, 20).messages as Array<{ role: string; text: string }>) ?? [];
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
    };
}

/**
 * S7: build the runtime. Installs the project hooks immediately; the bus
 * subscribers and timers start on `activate()` (now, when `assistant.json`
 * already has an entry).
 */
export function wireAssistantRuntime(
    components: Pick<DaemonComponents, 'instanceManager' | 'router' | 'cliManager' | 'bus'>,
    opts: AssistantRuntimeOptions = {},
): AssistantRuntime {
    const registry = opts.registry ?? getAssistantRegistry();
    const opened = opts.store ? { store: opts.store, metrics: opts.metrics ?? null } : openStores();
    const { store, metrics } = opened;
    let sawCaller = false;
    let review: AssistantReviewScheduler | null = null;
    const relay = new AssistantRelay(buildAssistantRelayPorts(components, {
        registry, store, metrics, sawCaller: () => sawCaller,
        onReviewDelivered: (sid, messageId, at) => review?.onDelivered(sid, messageId, at),
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
            const r = reviewScheduler.evaluate(now);
            if (r.fired) LOG.info('Assistant', `idle review turn queued (${r.messageId})`);
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
        relay.start();
        offs.push(() => relay.stop());
        tickTimer = setInterval(tick, opts.tickMs ?? ASSISTANT_RELAY_TICK_MS);
        (tickTimer as { unref?: () => void }).unref?.();
        offs.push(() => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; });
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

    // Dashboard chat into the assistant session → input log (human), at delivery.
    setAssistantHumanInputSink((r) => relay.recordHumanSubmit(r.sessionIds, r.messageId, r.outcome));

    setAssistantRelayHooks({
        openThread: (meshId) => {
            activate('project_send');
            relay.openThread(meshId);
            metrics?.bump('assistant_sends', meshId, Date.now());
        },
        isThreadOpen: (meshId) => store.isThreadOpen(meshId),
        lastRelayAt: (meshId) => relay.lastRelayAtFor(meshId),
        recordSkillAttaches: (meshId, count) => metrics?.bump('skill_attaches', meshId, Date.now(), count),
    });

    const runtime: AssistantRuntime = {
        registry,
        relay,
        store,
        metrics,
        review: reviewScheduler,
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
