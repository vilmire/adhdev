/**
 * S7 bootMeshRuntime — assemble `DaemonComponents`, attach the mesh bus
 * subscribers, cut the mesh event path over to the turn ledger (wiring-
 * unification C-W3), and start event forwarding + the quota loops.
 *
 * Turn-ledger cut-over, in order:
 *   1. the one-way C3 migration (`user_version` 0 → 1; its step 0 imports the
 *      legacy pending-events JSONL) — logged as one line;
 *   2. ONE ledger over mesh-runtime.db, passed by value on
 *      `components.turnLedger` (C-W4's scheduler takes it from there) with the
 *      host-owned post-commit ports (bus, cancel, attempt-ref release, the
 *      late-bound probe port the scheduler binds);
 *   3. the notice runtime (producer API + MCP inbox read) bound once;
 *   4. the three turn cursors per mesh (`turn.ingest` / `turn.deliver` /
 *      `mesh.index`, seqscribe/mesh-turn-consumer.ts), registered on every
 *      known mesh topic and on every topic defined later;
 *   5. republish every `pending` row (the crash window between the ledger txn
 *      and the append), after S6 activated the topics.
 *
 * The termination / signal subscribers can attach here because no session can
 * spawn before S8 (restore runs in `startLoops`).
 */

import { subscribeMeshTermination } from '../../mesh/mesh-termination-bridge.js';
import { subscribeMeshProviderSignals } from '../../mesh/mesh-signal-bridge.js';
import { subscribeCoordinatorRegistryRemoval } from '../../mesh/coordinator-registry.js';
import { subscribeWorkerBindRevocation } from '../../mesh/worker-mcp-isolation.js';
import {
    listLocalCoordinatorSessions,
    resolveCoordinatorDrainDaemonIds,
    resolveEvidenceOwner,
    setupMeshEventForwarding,
    stopStaleMeshWorker,
} from '../../mesh/mesh-event-forwarding.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { getLedgerDir } from '../../mesh/mesh-ledger-paths.js';
import { formatTurnLedgerMigrationLine, importLegacyPendingEventsJsonl } from '../../mesh/turn-ledger/migrate-v1.js';
import { formatTurnLedgerMigrationV2Line } from '../../mesh/turn-ledger/migrate-v2.js';
import { formatTurnLedgerMigrationV3Line } from '../../mesh/turn-ledger/migrate-v3.js';
import { createMeshRuntimeTurnLedger } from '../../mesh/turn-ledger/runtime-ledger.js';
import { createLateBoundProbePort } from '../../mesh/turn-ledger/scheduler.js';
import { setActiveTurnLedgerForIpc } from '../../commands/low-family/turn-ledger-ipc.js';
import { createTurnEvidencePort } from '../../providers/turn-evidence-port.js';
import type { TurnLedger } from '../../mesh/turn-ledger/ledger.js';
import type { TurnLedgerPorts } from '../../mesh/turn-ledger/effects.js';
import {
    bindMeshNoticeRuntime,
    createCoordinatorNotifier,
    createDeliverEdgeWaiter,
    createTurnDeliverCounters,
    createTurnDeliverHandler,
    createTurnIngestHandler,
    deliverNoticeBacklog,
    listControlNotices,
    listRecentDeliveredNotices,
    readCoordinatorNotices,
    retractCoordinatorNotices,
    type HandoffResolver,
    type MeshNoticeRuntime,
    type TurnDeliverDeps,
} from '../../mesh/turn-ledger/deliver.js';
import { MeshTopicIndex } from '../../mesh/mesh-topic-index.js';
import { buildMeshStatusLineForNotification } from '../../mesh/mesh-notification-status-line.js';
import { armMeshTurnConsumer, type MeshTurnConsumer } from '../../seqscribe/mesh-turn-consumer.js';
import { appendMeshHandoff } from '../../seqscribe/mesh-publisher.js';
import { meshEventsTopic } from '../../seqscribe/topics.js';
import type { SeqscribeRuntime } from '../../seqscribe/runtime.js';
import { setupQuotaEventRefresh, setupQuotaRefreshLoop } from '../../quota/refresh.js';
import { getMachineId } from '../../config/config.js';
import { LOG } from '../../logging/logger.js';
import { daemonIdsEquivalent, expandDaemonIdForms, type SummaryRef } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../daemon-components.js';
import type { MeshRuntimeStage, ProjectionsStage } from './types.js';

/** Build the components object hosts and mesh modules consume. */
export function assembleDaemonComponents(s6: ProjectionsStage): DaemonComponents {
    const { cfg, seqscribe } = s6;
    const components: DaemonComponents = {
        providerLoader: s6.providerLoader,
        instanceManager: s6.instanceManager,
        cliManager: s6.cliManager,
        commandHandler: s6.commandHandler,
        agentStreamManager: s6.agentStreamManager,
        router: s6.router,
        poller: s6.poller,
        cdpInitializer: s6.cdpInitializer,
        cdpManagers: s6.cdpManagers,
        sessionRegistry: s6.sessionRegistry,
        bus: s6.bus,
        seqscribe,
        detectedIdes: s6.detectedIdes,
        refreshProviderAvailability: s6.refreshProviderAvailability,
        dispatchMeshCommand: cfg.mesh?.dispatchMeshCommand,
        getMeshPeerConnectionStatus: cfg.mesh?.getMeshPeerConnectionStatus,
        outputFanout: s6.outputFanout,
        onMeshCoordinatorEventForwarded: cfg.mesh?.mirrorMeshWorkerEvent,
        statusInstanceId: cfg.statusInstanceId,
        providerStalenessProbe: { stop: s6.stalenessProbe.stop },
        ...(seqscribe ? { transcriptReplicaStore: seqscribe.transcriptReplica } : {}),
    };
    return components;
}

/** The late-bound probe port: the ledger is built here, the scheduler that services probes in S8. */
export interface TurnProbePort {
    bind(scheduler: { requestProbe(attemptId: string): void } | null): void;
}

/** What S7 wires beyond the legacy components (read by S8 / hosts / tests). */
export interface MeshTurnWiring {
    ledger: TurnLedger;
    probePort: TurnProbePort;
    consumer: MeshTurnConsumer | null;
    index: MeshTopicIndex;
    notices: MeshNoticeRuntime;
    /** Resolves once the boot republish of `pending` rows settled (never rejects). */
    republished: Promise<void>;
    /** Deliver notices the cursor passed while no coordinator existed (C-W4 tick may call it). */
    deliverBacklog(): Promise<number>;
    dispose(): void;
}

function selfDaemonIdFor(components: DaemonComponents): string {
    return components.statusInstanceId || getMachineId() || 'local';
}

function resolveHandoffOn(rt: SeqscribeRuntime | null): HandoffResolver {
    return (ref: SummaryRef) => {
        if (!rt) return null;
        try {
            const entry = rt.node.node.scanEntries(ref.topic, { writer: ref.writer, fromSeq: ref.seq, toSeq: ref.seq, limit: 1 }).entries[0];
            const payload = entry?.payload;
            return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
        } catch {
            return null; // topic not defined here / not replicated yet
        }
    };
}

/**
 * Turn-ledger cut-over (steps 1–5 of the file header). Exported for the boot
 * tests; `bootMeshRuntime` is the production caller.
 */
export function wireTurnLedger(components: DaemonComponents, opts: { runMigration?: boolean } = {}): MeshTurnWiring {
    const rt = components.seqscribe ?? null;
    const store = MeshRuntimeStore.getInstance();
    const selfDaemonId = selfDaemonIdFor(components);
    const selfDaemonIds = (): string[] => {
        // Self first, then every equivalent machine-id form (one de-duplicated list).
        return expandDaemonIdForms([selfDaemonId, ...resolveCoordinatorDrainDaemonIds(components)]);
    };

    // 1. One-way migrations (v1: no-op once user_version ≥ 1).
    if (opts.runMigration !== false) {
        try {
            const report = store.runTurnLedgerMigrationV1({
                ownerDaemonId: selfDaemonId,
                beforeFold: () => {
                    const jsonl = importLegacyPendingEventsJsonl(store.db, getLedgerDir());
                    if (jsonl.filesScanned > 0) {
                        LOG.info('TurnLedger', `legacy pending-events JSONL: imported ${jsonl.eventsImported} event(s) from ${jsonl.filesScanned} file(s) (removed ${jsonl.filesRemoved}, retained ${jsonl.filesRetained}, skipped ${jsonl.linesSkipped} line(s))`);
                    }
                },
            });
            LOG.info('TurnLedger', formatTurnLedgerMigrationLine(report));
        } catch (error) {
            // The failed mesh's txn rolled back; the next boot resumes it.
            LOG.error('TurnLedger', `turn-ledger migration v1 failed: ${error instanceof Error ? error.message : String(error)} — the next boot resumes it`);
        }
        // 1b. v1 → v2 (C-W8): drop the legacy tables whose last writer is gone,
        // fold post-v1 operating notes out of the event ledger. No-op once ≥ 2;
        // refuses until v1 succeeded (the next boot retries both).
        try {
            LOG.info('TurnLedger', formatTurnLedgerMigrationV2Line(store.runTurnLedgerMigrationV2({})));
        } catch (error) {
            LOG.error('TurnLedger', `turn-ledger migration v2 failed: ${error instanceof Error ? error.message : String(error)} — the next boot resumes it`);
        }
        // 1c. v2 → v3 (C-W9a): fold the recent event-ledger rows + active per-mesh
        // JSONL mirrors into `mesh_local_records`, drop the event ledger.
        try {
            LOG.info('TurnLedger', formatTurnLedgerMigrationV3Line(store.runTurnLedgerMigrationV3({})));
        } catch (error) {
            LOG.error('TurnLedger', `turn-ledger migration v3 failed: ${error instanceof Error ? error.message : String(error)} — the next boot resumes it`);
        }
    }

    // 2. The ledger, with the host-owned post-commit ports. The probe port is
    // late-bound (the S8 scheduler binds it) and REMEMBERS a request made
    // before the bind (a boot-time republish / hold sweep can ask for one).
    const lateProbe = createLateBoundProbePort();
    const probePort: TurnProbePort = { bind: (scheduler) => lateProbe.bind(scheduler) };
    const ports: TurnLedgerPorts = {
        bus: (event, at) => { components.bus.emit({ ...event, at }); },
        cancelDispatch: (request) => {
            if (!request.meshId) return;
            stopStaleMeshWorker(components, {
                meshId: request.meshId,
                sessionId: request.sessionId,
                ...(request.nodeId ? { nodeId: request.nodeId } : {}),
                reason: 'turn_ledger_cancel_dispatch',
            });
        },
        releaseAttemptRef: ({ attemptId }) => releaseLocalAttemptRef(components, attemptId),
        probe: (e) => lateProbe.port(e),
    };
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, ports });

    // The handoff publisher (`mesh.<id>.handoff`) is built here — before 2b —
    // because both the evidence port (a remote-owned worker's text) and the
    // notice runtime (a coordinator notice's remote-authored text) need it.
    const appendHandoff = rt ? (meshId: string, kind: string, payload: Record<string, unknown>) => appendMeshHandoff(meshId, kind, payload as never) : undefined;

    // 2b. Provider-side evidence (C5/C-W5c): every instance holds this port,
    // which is now the SOLE producer of a mesh session's turn evidence (the
    // forwarder's `buildProviderEvidence` duplicate is deleted).
    const offEvidencePort = wireTurnEvidencePort(components, ledger, { appendHandoff });

    // 3. Notices: producer API, deliver, MCP inbox read.
    const counters = createTurnDeliverCounters();
    const waiter = createDeliverEdgeWaiter({ now: () => Date.now() });
    const resolveHandoff = resolveHandoffOn(rt);
    // D2 (applied in C-W8): notices go through the daemon's ONE send funnel —
    // `cliManager.input` — so they share the single messageId dedupe with every
    // other origin and get the same runtime ack bubble. Notices are always
    // `queue` mode (deliver.ts builds them), so a busy coordinator parks them.
    const inputPort = components.cliManager.input;
    const deliverLog = { info: (m: string) => LOG.info('MeshNotice', m), warn: (m: string) => LOG.warn('MeshNotice', m) };
    const deliverDeps: TurnDeliverDeps = {
        ledger,
        selfDaemonIds,
        port: inputPort,
        coordinators: (meshId) => listLocalCoordinatorSessions(components, meshId),
        waiter,
        resolveHandoff,
        statusLine: (meshId) => buildMeshStatusLineForNotification(meshId),
        isControlEvent: (event) => event === 'coordinator_catchup',
        counters,
        log: deliverLog,
    };
    const notifier = createCoordinatorNotifier({ ledger, selfDaemonIds, ...(appendHandoff ? { appendHandoff } : {}), log: deliverLog });
    const notices: MeshNoticeRuntime = {
        notify: (notice) => notifier.notify(notice),
        readNotices: (meshId, readOpts) => readCoordinatorNotices({ ...deliverDeps, waiter }, meshId, readOpts),
        controlNotices: (meshId, event) => listControlNotices({ ledger, selfDaemonIds, resolveHandoff }, meshId, event),
        retract: (meshId, match) => retractCoordinatorNotices({ ledger, selfDaemonIds }, meshId, match),
        hasUndelivered: (meshId) => ledger.store.listUndeliveredNotifies(meshId, { sinceMs: Date.now() - 24 * 60 * 60 * 1000, limit: 1 }).length > 0,
        hasLiveCliCoordinator: (meshId) => listLocalCoordinatorSessions(components, meshId).length > 0,
        recentDeliveredNotices: (sinceMs) => listRecentDeliveredNotices({ ledger, resolveHandoff }, sinceMs),
        releaseDelivery: (claimEventId) => {
            const released = ledger.store.releaseDeliveryClaim(claimEventId);
            if (released) scheduleBacklog();
            return released;
        },
        isSelfDaemon: (daemonId) => selfDaemonIds().some((id) => daemonIdsEquivalent(id, daemonId)),
        replicationPending: (meshId) => {
            if (!rt) return false;
            try {
                const behind = rt.node.node.staleness(meshEventsTopic(meshId)).behind;
                return Object.values(behind).some((n) => n > 0);
            } catch {
                return false;
            }
        },
        evidence: ledger,
        ...(appendHandoff ? { appendHandoff } : {}),
        // Deliver outcomes + the cursors' own counters (the consumer arms below).
        counters: () => ({ ...counters, ...(consumer?.counters() ?? {}) }),
    };
    bindMeshNoticeRuntime(notices);

    // 4. The turn cursors.
    const index = new MeshTopicIndex(store.db);
    // The MCP turn IPC (turn_observe / turn_query / mesh_index_query …) reads
    // the same ledger + index this daemon writes.
    setActiveTurnLedgerForIpc(ledger, {
        index,
        ownWriter: () => rt?.node.writerId ?? null,
        replicationPending: (meshId) => notices.replicationPending(meshId),
    });
    const abort = new AbortController();
    const ingest = createTurnIngestHandler({ ledger, selfDaemonIds, releaseAttemptRef: ({ attemptId }) => releaseLocalAttemptRef(components, attemptId), counters, log: deliverLog });
    const deliver = createTurnDeliverHandler(deliverDeps);
    let consumer: MeshTurnConsumer | null = null;
    if (rt) {
        try {
            consumer = armMeshTurnConsumer(rt.node, {
                ingest: (entry) => ingest(entry),
                deliver: async (entry, signal) => { await deliver(entry, signal); },
                index: (entry) => { index.ingest(entry); },
            }, { skipRetiredPrune: true });
            const registered = consumer.ensureKnownMeshes();
            LOG.info('MeshTurnConsumer', `turn cursors (turn.ingest / turn.deliver / mesh.index) armed on ${registered} mesh topic(s)`);
        } catch (error) {
            LOG.error('MeshTurnConsumer', `turn cursors failed to arm: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        LOG.warn('MeshTurnConsumer', 'no seqscribe node — turn notices stay in turn_events (the MCP inbox reads them); no cross-machine delivery');
    }

    // Wake deferred deliveries on the edges they wait for, and deliver the
    // backlog when a coordinator session appears / goes idle.
    let backlogTimer: ReturnType<typeof setTimeout> | null = null;
    const deliverBacklog = async (): Promise<number> => {
        let delivered = 0;
        const meshIds = consumer?.meshIds() ?? [];
        for (const meshId of meshIds) {
            if (!notices.hasUndelivered(meshId) || listLocalCoordinatorSessions(components, meshId).length === 0) continue;
            try {
                delivered += await deliverNoticeBacklog(deliverDeps, meshId, abort.signal);
            } catch (error) {
                LOG.warn('MeshNotice', `backlog delivery failed (mesh ${meshId}): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return delivered;
    };
    const scheduleBacklog = () => {
        if (backlogTimer) return;
        backlogTimer = setTimeout(() => { backlogTimer = null; void deliverBacklog(); }, 1_000);
        (backlogTimer as { unref?: () => void }).unref?.();
    };
    const offEdges = components.bus.on(['status', 'modal', 'registered', 'terminated', 'turn'], (event) => {
        waiter.wake();
        if (event.kind === 'registered' || event.kind === 'status') scheduleBacklog();
    }, { name: 'mesh.turn-deliver-edges' });

    // 5. Republish rows committed but not appended before the last shutdown.
    const republished = ledger.republishPending().then(
        (report) => {
            if (report.published + report.failed + report.pending > 0) {
                LOG.info('TurnLedger', `boot republish: ${report.published} published, ${report.failed} failed, ${report.pending} still pending`);
            }
        },
        (error: unknown) => { LOG.error('TurnLedger', `boot republish failed: ${error instanceof Error ? error.message : String(error)}`); },
    );

    let disposed = false;
    return {
        ledger,
        probePort,
        consumer,
        index,
        notices,
        republished,
        deliverBacklog,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (backlogTimer) clearTimeout(backlogTimer);
            abort.abort(new Error('mesh runtime disposed'));
            try { offEdges(); } catch { /* noop */ }
            try { consumer?.dispose(); } catch { /* noop */ }
            try { offEvidencePort(); } catch { /* noop */ }
            setActiveTurnLedgerForIpc(null);
            bindMeshNoticeRuntime(null);
        },
    };
}

/**
 * The provider-side evidence port (C5), wired into every provider instance.
 *
 * SOLE PRODUCER (C-W5c): the port is now the only place a mesh-bound
 * session's turn evidence is built — `mesh-event-forwarding.ts`'s
 * `buildProviderEvidence` (which used to build the same evidence a second
 * time from the legacy `agent:*` wire names on `provider_event`, for the
 * owner routing and local render envelope the port could not carry) is
 * deleted. `ownerFor` closes that gap: it resolves the attempt's owner via
 * `resolveEvidenceOwner` (the same `resolveWorkerDelegateRouting` authority
 * the deleted evidence builder routed through), and the port's `observe`
 * (`turn-evidence-port.ts`) publishes text to `mesh.<id>.handoff` for a
 * remote owner or passes it straight through as a local envelope otherwise —
 * every producer site's `emit*` call (unchanged) already supplies that
 * envelope via its `notice`/`finalSummary` opt. A plain (non-mesh) session
 * resolves no owner (`ownerFor` returns `null`) and behaves exactly as
 * before this change.
 */
export function wireTurnEvidencePort(components: DaemonComponents, ledger: TurnLedger, deps: { appendHandoff?: (meshId: string, kind: string, payload: Record<string, unknown>) => Promise<SummaryRef> } = {}): () => void {
    const port = createTurnEvidencePort({
        observe: (evidence, opts) => { ledger.observe(evidence, opts); },
        ownerFor: (sessionId) => resolveEvidenceOwner(components, sessionId),
        selfDaemonId: ledger.selfDaemonId,
        ...(deps.appendHandoff ? { appendHandoff: deps.appendHandoff } : {}),
        attemptRefFor: (sessionId) => {
            const attempt = ledger.openAttemptForSession(sessionId);
            return attempt ? { attemptId: attempt.attemptId, generation: attempt.generation } : null;
        },
        log: {
            warn: (scope, msg) => LOG.warn(scope, msg),
            debug: (scope, msg) => LOG.debug(scope, msg),
        },
    });
    components.instanceManager.setTurnEvidencePort(port);
    return () => components.instanceManager.setTurnEvidencePort(null);
}

/**
 * `release_attempt_ref` executor: the local instance holding the attempt ref
 * drops it (C-W5 gives instances `releaseAttemptRef`; an instance without it
 * holds no ref to release).
 */
function releaseLocalAttemptRef(components: DaemonComponents, attemptId: string): void {
    for (const id of components.instanceManager.listInstanceIds()) {
        const instance = components.instanceManager.getInstance(id) as unknown as { releaseAttemptRef?: (attemptId: string) => void } | undefined;
        if (typeof instance?.releaseAttemptRef === 'function') {
            try { instance.releaseAttemptRef(attemptId); } catch { /* best-effort */ }
        }
    }
}

export function bootMeshRuntime(s6: ProjectionsStage): MeshRuntimeStage {
    const components = assembleDaemonComponents(s6);
    const { bus } = s6;

    // Session-death consumers. Registration order = delivery order on the sync
    // lane; the ledger writer runs on the async lane.
    const offSubscribers = [
        subscribeMeshTermination(bus),
        subscribeMeshProviderSignals(bus),
        subscribeCoordinatorRegistryRemoval(bus),
        subscribeWorkerBindRevocation(bus),
    ];

    // The turn ledger + notice path (C-W3), BEFORE forwarding so the first
    // provider event already has a ledger to observe into.
    const turn = wireTurnLedger(components);
    components.turnLedger = turn.ledger;
    components.turnProbePort = turn.probePort;
    components.meshTurn = turn;

    // Provider events of mesh sessions → turn evidence / notices / queue edges.
    const offForwarding = setupMeshEventForwarding(components);
    // Periodic quota refresh (fills the cache buildLocalNodeFacts READS) and
    // its event-driven complement (refetch the provider that just finished a turn).
    components.quotaRefreshLoop = setupQuotaRefreshLoop(components);
    components.quotaEventRefresh = setupQuotaEventRefresh(components);

    let disposed = false;
    const disposeMeshRuntime = (): void => {
        if (disposed) return;
        disposed = true;
        try { components.quotaRefreshLoop?.stop(); } catch { /* noop */ }
        try { components.quotaEventRefresh?.stop(); } catch { /* noop */ }
        try { offForwarding(); } catch { /* noop */ }
        try { turn.dispose(); } catch { /* noop */ }
        for (const off of offSubscribers.reverse()) {
            try { off(); } catch { /* noop */ }
        }
    };

    return { ...s6, components, disposeMeshRuntime };
}
