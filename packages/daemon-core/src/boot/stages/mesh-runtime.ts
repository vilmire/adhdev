import {createNoticeSubmitInventory} from '../../mesh/turn-ledger/notice-submit-inventory.js';
import { maintenanceHeld, withMaintenanceAdmission } from '../../maintenance/cooperative-gate.js';
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
import { hasLiveWorkerSessionBind, setWorkerSessionBindPersistence, subscribeWorkerBindRevocation, subscribeWorkerMcpSharedConfigCleanup } from '../../mesh/worker-mcp-isolation.js';
import { SqliteWorkerSessionBindStore } from '../../mesh/worker-session-bind-store.js';
import { installLocalNodeProviderFallback } from '../../mesh/mesh-slot-provider-usability.js';
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
import { createMeshRuntimeTurnLedger, revokeCutSessionWorkerBind } from '../../mesh/turn-ledger/runtime-ledger.js';
import { resumePendingHolderReconciles } from '../../mesh/mesh-holder-reconcile.js';
import { contractBoot, subscribeContractGrantRevocation } from '../../mesh/contract-runtime.js';
import { probeRefineLanding } from '../../commands/router-refine-contract-stage.js';
import { createLateBoundProbePort } from '../../mesh/turn-ledger/scheduler.js';
import { closeInterruptedPlainAttempts, reconcileOrphanedPlainAttempts, type ReconcileOrphanedPlainAttemptsReport } from '../../mesh/turn-ledger/reconcile.js';
import { setActiveTurnLedgerForIpc } from '../../commands/low-family/turn-ledger-ipc.js';
import { createTurnEvidencePort } from '../../providers/turn-evidence-port.js';
import { extractSessionPtyPid } from '../../process/session-process-tree.js';
import { peekSessionBackgroundProcesses } from '../../process/process-table-snapshot.js';
import { createBackgroundWorkMonitor, type BackgroundWorkMonitor } from '../../mesh/turn-ledger/background-work-guard.js';
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
import { setupQuotaEventRefresh } from '../../quota/refresh-triggers.js';
import { setupQuotaRefreshLoop } from '../../quota/refresh-loop.js';
import { wireAssistantRuntime } from '../../assistant/assistant-runtime.js';
import { getMachineId } from '../../config/config.js';
import { LOG } from '../../logging/logger.js';
import { daemonIdsEquivalent, expandDaemonIdForms, type SummaryRef } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../daemon-components.js';
import type { MeshRuntimeStage, ProjectionsStage } from './types.js';
import { redeliverDispatch } from '../../mesh/mesh-dispatch-redelivery.js';
import { unwrapReadChatPayload, type TranscriptObservation } from '../../mesh/turn-ledger/probe.js';
import { readChatMessageTimestampMs } from '../../providers/chat-message-normalization.js';
import { flattenContent } from '../../providers/contracts.js';
import type { ChatMessage } from '../../types.js';

/** Build the components object hosts and mesh modules consume. */
export function assembleDaemonComponents(s6: ProjectionsStage): DaemonComponents {
    const { cfg, seqscribe } = s6;
    // Keyed chat resync (design 2026-09-28 §5.2): a replica whose commits keep
    // failing their digest asks the OWNER for one base frame over the same
    // peer command path every other mesh command uses (never the server).
    // Absent on standalone, which has no daemon-to-daemon dispatch.
    const dispatch = cfg.mesh?.dispatchMeshCommand;
    if (seqscribe && dispatch) {
        seqscribe.transcriptReplica.setBaseRequester((key) => {
            void dispatch(key.ownerDaemonId, 'request_transcript_base', { rawSessionId: key.rawSessionId }).catch(() => {});
        });
    }
    const components: DaemonComponents = {
        maintenanceLifecycleInventory:cfg.maintenanceLifecycleInventory,
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
    maintenanceInventory?(): {early:string[];bound:boolean};
    bind(scheduler: { requestProbe(attemptId: string): void } | null): void;
}

/** What S7 wires beyond the legacy components (read by S8 / hosts / tests). */
export interface MeshTurnWiring {
    noticeSubmitInventory():ReturnType<ReturnType<typeof createNoticeSubmitInventory>['inventory']>;
    ledger: TurnLedger;
    /**
     * The ONE worker background-work monitor, shared by the ledger's evidence
     * gate (which asks `isReleased`) and the turn scheduler (which feeds it
     * probe reads and owns the nudge / notice / release state).
     */
    backgroundWork: BackgroundWorkMonitor;
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

export function createRuntimeBackgroundWorkMonitor(
    components: Pick<DaemonComponents, 'cliManager' | 'commandHandler' | 'sessionRegistry'>,
): BackgroundWorkMonitor {
    return createBackgroundWorkMonitor({
        // `components.cliManager` is read at call time: the monitor is built here,
        // before every component exists, and only nudges once a worker has ended a turn.
        nudgeWorker: async (sessionId, text, meta) => {
            const target = components.sessionRegistry?.get(sessionId);
            const resolvedSessionId = target?.adapterKey || target?.instanceKey || sessionId;
            const inputPort = components.cliManager?.input;
            if (inputPort) {
                let out = await inputPort.submit({
                    messageId: meta.messageId,
                    sessionId: resolvedSessionId,
                    origin: 'mesh',
                    policy: { mode: 'queue' },
                    input: { parts: [{ type: 'text', text }], textFallback: text },
                    createdAt: Date.now(),
                });
                if (out.kind === 'refused' && out.reason === 'no_target' && resolvedSessionId !== sessionId) {
                    out = await inputPort.submit({
                        messageId: meta.messageId,
                        sessionId,
                        origin: 'mesh',
                        policy: { mode: 'queue' },
                        input: { parts: [{ type: 'text', text }], textFallback: text },
                        createdAt: Date.now(),
                    });
                }
                if (out.kind === 'delivered' || out.kind === 'queued' || out.kind === 'duplicate') {
                    return true;
                }
            }
            if (components.commandHandler) {
                await components.commandHandler.handle('send_chat', {
                    sessionId: resolvedSessionId,
                    messageId: meta.messageId,
                    text,
                    origin: 'mesh',
                });
                return true;
            }
            return false;
        },
    });
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
    const probePort: TurnProbePort = { maintenanceInventory:lateProbe.maintenanceInventory, bind: (scheduler) => lateProbe.bind(scheduler) };
    const ports: TurnLedgerPorts = {
        bus: (event, at) => { components.bus.emit({ ...event, at }); },
        cancelDispatch: (request) => {
            if (!request.meshId) return;
            if (!request.stopRequestId) return { success: false, code: 'writer_checkpoint_pending', reason: 'uncaptured_legacy_stop_identity' };
            return stopStaleMeshWorker(components, {
                meshId: request.meshId,
                sessionId: request.sessionId,
                ...(request.nodeId ? { nodeId: request.nodeId } : {}),
                ...(request.providerType ? { providerType: request.providerType } : {}),
                writerStop: request,
                reason: 'turn_ledger_cancel_dispatch',
            });
        },
        releaseAttemptRef: ({ attemptId }) => releaseLocalAttemptRef(components, attemptId),
        // WORKER-BIND-IDLE-DETACH: the default (bind/token revoke) plus the
        // local stamp detach withheld from the session's own idle edge — see
        // detachLocalMeshTaskStamp for why this composes rather than replaces.
        revokeWorkerBind: (request) => {
            revokeCutSessionWorkerBind(request);
            detachLocalMeshTaskStamp(components, request);
        },
        probe: (e) => lateProbe.port(e),
        // SUBMIT-UNCONFIRMED-RECLAIM ②: H2 lands here — probe now, never
        // re-send (mesh-dispatch-redelivery.ts explains why).
        redeliver: (e) => { redeliverDispatch(e, { probe: (attemptId) => lateProbe.port({ attemptId }) }); },
    };
    const backgroundWork = createRuntimeBackgroundWorkMonitor(components);
    const ledger = createMeshRuntimeTurnLedger({
        selfDaemonId,
        ports,
        // `observe` is synchronous, so this reads the shared process-table CACHE
        // (never spawns, never waits). Unknown (no snapshot yet / read failed or
        // stale / no PID) = undefined = the turn end proceeds as it always did.
        inspectBackgroundProcesses: (sessionId, { startedAfterMs }) => {
            try {
                const target = components.sessionRegistry.get(sessionId);
                const inst = components.instanceManager.getInstance(target?.instanceKey || sessionId);
                const pid = extractSessionPtyPid(inst);
                if (!pid) return undefined;
                const tree = peekSessionBackgroundProcesses(pid, { startedAfterMs });
                return tree && tree.liveProcessNames.length > 0 ? tree.liveProcessNames : undefined;
            } catch {
                return undefined;
            }
        },
        backgroundWorkReleased: (attemptId, generation) => backgroundWork.isReleased(attemptId, generation),
    });

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
    const noticeSubmitMetadata=createNoticeSubmitInventory(ledger);
    const deliverDeps: TurnDeliverDeps = {
        submitInventory:noticeSubmitMetadata,
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
        if (maintenanceHeld()) return 0;
        return withMaintenanceAdmission(async () => {
        let delivered = 0;
        const meshIds = consumer?.meshIds() ?? [];
        for (const meshId of meshIds) {
            if (listLocalCoordinatorSessions(components, meshId).length === 0 || !notices.hasUndelivered(meshId)) continue;
            try {
                delivered += await deliverNoticeBacklog(deliverDeps, meshId, abort.signal);
            } catch (error) {
                LOG.warn('MeshNotice', `backlog delivery failed (mesh ${meshId}): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return delivered;
        });
    };
    const scheduleBacklog = () => {
        if (maintenanceHeld() || backlogTimer) return;
        backlogTimer = setTimeout(() => { backlogTimer = null; void deliverBacklog(); }, 1_000);
        (backlogTimer as { unref?: () => void }).unref?.();
    };
    const offEdges = components.bus.on(['status', 'modal', 'registered', 'terminated', 'turn'], (event) => {
        waiter.wake();
        if (event.kind === 'registered' || event.kind === 'status') scheduleBacklog();
    }, { name: 'mesh.turn-deliver-edges' });

    // 5. Republish rows committed but not appended before the last shutdown.
    const republished = maintenanceHeld() ? Promise.resolve() : withMaintenanceAdmission(() => ledger.republishPending()).then(
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
        backgroundWork,
        probePort,
        consumer,
        index,
        notices,
        republished,
        noticeSubmitInventory:noticeSubmitMetadata.inventory,
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
        // R9r: a live worker-MCP bind ⇒ the worker can report, so its idle end
        // awaits the report instead of committing (stamped on THIS daemon).
        reportExpectedFor: (sessionId) => hasLiveWorkerSessionBind(sessionId),
        confirmConsumption: (sessionId, sinceMs, opts) => confirmLocalConsumption(components, sessionId, sinceMs, opts),
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

export interface DispatchAcknowledgementWatermark {
    readonly messageId: string;
    readonly nonce?: number;
    readonly watermarkSeq: number;
    readonly unacceptedConfirmed: boolean;
}

export interface ProviderConsumptionCapability {
    readonly providerType: string;
    readonly canProveNonConsumption: boolean;
    readonly supportsDispatchAcknowledgementWatermark: boolean;
    readonly requiresTurnTerminalMarkers: boolean;
    readonly reason: string;
}

/**
 * Per-provider authoritative non-consumption capability matrix (R10 / R11):
 * - Coordinator decision (R11): positive non-consumption is NOT provable from
 *   transcript inspection alone. Even when a provider's native store is fresh,
 *   complete, safely-mapped, and ends in a completed prior turn, current-turn
 *   persistence can lag behind input consumption, wall-clock timestamps can
 *   skew across processes, and native stores can normalize prompt bodies.
 * - Therefore `canProveNonConsumption` and `supportsDispatchAcknowledgementWatermark`
 *   are `false` for ALL providers today. `confirmLocalConsumption` returns
 *   `'consumed'` when there is positive evidence of agent activity for this
 *   dispatch (`newestAgentActivityAt >= sinceMs`), otherwise `'unknown'` —
 *   always, for every provider.
 * - Future `'not_consumed'` contract: gated behind a provider capability with
 *   `canProveNonConsumption: true` AND `supportsDispatchAcknowledgementWatermark: true`,
 *   plus a runtime `DispatchAcknowledgementWatermark` (`payload.dispatchAcknowledgement`
 *   or `messageSource.dispatchAcknowledgement`) bound to this dispatch's
 *   `messageId`/nonce and serialized with the provider's input acceptance queue.
 */
export const PROVIDER_CONSUMPTION_CAPABILITIES: Readonly<Record<string, ProviderConsumptionCapability>> = {
    'codex-cli': {
        providerType: 'codex-cli',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: true,
        reason: 'JSONL rollout persistence can lag behind PTY input acceptance and offers no dispatch-tied acknowledgement watermark serialized with input acceptance.',
    },
    'claude-cli': {
        providerType: 'claude-cli',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: false,
        reason: 'Per-session JSONL persistence can lag behind PTY input acceptance and offers no dispatch-tied acknowledgement watermark serialized with input acceptance.',
    },
    'antigravity-cli': {
        providerType: 'antigravity-cli',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: false,
        reason: 'Per-session SQLite step persistence can lag behind PTY input acceptance and offers no dispatch-tied acknowledgement watermark serialized with input acceptance.',
    },
    'kimi': {
        providerType: 'kimi',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: true,
        reason: 'wire.jsonl persistence can lag behind PTY input acceptance and offers no dispatch-tied acknowledgement watermark serialized with input acceptance.',
    },
    'grok-cli': {
        providerType: 'grok-cli',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: false,
        reason: 'chat_history.jsonl records carry no per-message timestamps; receivedAt is synthesized from created_at and file mtime.',
    },
    'cursor-cli': {
        providerType: 'cursor-cli',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: false,
        reason: 'agent-transcripts JSONL strips timestamps (no timestamp_ms in message_map); receivedAt is synthesized from file mtime.',
    },
    'opencode': {
        providerType: 'opencode',
        canProveNonConsumption: false,
        supportsDispatchAcknowledgementWatermark: false,
        requiresTurnTerminalMarkers: false,
        reason: 'SQLite part query only projects $.type=text parts and falls back to newest session when a session has no rows.',
    },
};

export function getProviderConsumptionCapability(providerType: string | undefined): ProviderConsumptionCapability | null {
    if (!providerType || typeof providerType !== 'string') return null;
    return PROVIDER_CONSUMPTION_CAPABILITIES[providerType.trim()] ?? null;
}

const DISPATCH_TIMESTAMP_CLOCK_SKEW_GUARD_MS = 5_000;

function normalizePromptWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function hasAuthoritativeNonConsumptionProof(
    payload: Record<string, unknown>,
    ms: Record<string, any> | null,
    observed: TranscriptObservation,
    providerType: string | undefined,
    sinceMs: number,
    opts?: { messageId?: string; expectedText?: string; capabilityOverride?: ProviderConsumptionCapability },
): boolean {
    const capability = opts?.capabilityOverride ?? getProviderConsumptionCapability(providerType);
    if (!capability || !capability.canProveNonConsumption || !capability.supportsDispatchAcknowledgementWatermark) return false;
    if (payload.stale === true || observed.stale === true) return false;
    if (typeof payload.unavailableReason === 'string' && payload.unavailableReason.trim().length > 0) return false;
    if (typeof observed.unavailableReason === 'string' && observed.unavailableReason.trim().length > 0) return false;
    if (observed.activeModal) return false;
    const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
    if (status !== 'idle' || (observed.providerObservedStatus && observed.providerObservedStatus !== 'idle')) return false;
    if (payload.transcriptAuthority !== 'provider' || payload.coverage !== 'full') return false;
    const providerSessionId = typeof payload.providerSessionId === 'string' ? payload.providerSessionId.trim() : '';
    if (!providerSessionId) return false;
    if (!ms || ms.selected !== 'native-history') return false;
    if (typeof ms.fallbackReason === 'string' && ms.fallbackReason.trim().length > 0) return false;
    if (typeof ms.unavailableReason === 'string' && ms.unavailableReason.trim().length > 0) return false;
    if (typeof ms.partialReason === 'string' && ms.partialReason.trim().length > 0) return false;
    // R11 P2: require affirmative provenance values everywhere consulted; missing -> unknown.
    if (ms.nativeSource !== 'provider-native') return false;
    if (ms.nativeHistoryCoverage !== 'full') return false;
    if (ms.identityStatus !== 'safe') return false;
    if (ms.coverage?.safeMapping !== true) return false;
    if (ms.staleness?.freshEnough !== true) return false;

    const expectedId = opts?.messageId?.trim() || '';
    if (!expectedId) return false;
    const rawAck = (payload.dispatchAcknowledgement ?? ms.dispatchAcknowledgement) as Partial<DispatchAcknowledgementWatermark> | undefined;
    if (
        !rawAck
        || typeof rawAck !== 'object'
        || typeof rawAck.messageId !== 'string'
        || rawAck.messageId.trim() !== expectedId
        || rawAck.unacceptedConfirmed !== true
        || typeof rawAck.watermarkSeq !== 'number'
        || !Number.isFinite(rawAck.watermarkSeq)
        || rawAck.watermarkSeq < sinceMs
    ) {
        return false;
    }

    const messages = payload.messages as ChatMessage[];
    if (messages.length === 0) return false;
    if (typeof payload.totalMessages === 'number' && payload.totalMessages > messages.length) return false;

    const expectedBody = opts?.expectedText?.trim() || '';
    const normalizedExpectedBody = expectedBody ? normalizePromptWhitespace(expectedBody) : '';
    const skewCeilingMs = sinceMs - DISPATCH_TIMESTAMP_CLOCK_SKEW_GUARD_MS;
    let hasCompletedPriorAssistant = false;
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') return false;
        const ts = readChatMessageTimestampMs(msg);
        if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0 || ts >= sinceMs || ts >= skewCeilingMs) return false;
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
        const msgId = typeof (msg as any).id === 'string' ? (msg as any).id.trim() : typeof (msg as any).messageId === 'string' ? (msg as any).messageId.trim() : '';
        if (expectedId && msgId && msgId === expectedId) return false;
        if (role === 'user' || role === 'human') {
            const text = flattenContent(msg.content).trim();
            const normalizedText = text ? normalizePromptWhitespace(text) : '';
            if (expectedBody && text && (text === expectedBody || text.includes(expectedBody))) return false;
            if (normalizedExpectedBody && normalizedText && (normalizedText === normalizedExpectedBody || normalizedText.includes(normalizedExpectedBody))) return false;
        } else if (role === 'assistant' || role === 'model') {
            if (flattenContent(msg.content).trim().length > 0) hasCompletedPriorAssistant = true;
        }
    }
    if (!hasCompletedPriorAssistant) return false;
    const lastMsg = messages[messages.length - 1];
    const lastRole = typeof lastMsg?.role === 'string' ? lastMsg.role.trim().toLowerCase() : '';
    if (lastRole === 'user' || lastRole === 'human') return false;

    if (capability.requiresTurnTerminalMarkers) {
        if (!Array.isArray(payload.turnTerminalMarkers) || payload.turnTerminalMarkers.length === 0) return false;
        for (const raw of payload.turnTerminalMarkers) {
            const m = raw as { receivedAt?: unknown; startedAt?: unknown; inputAt?: unknown } | null;
            const receivedAt = typeof m?.receivedAt === 'number' ? m.receivedAt : Number.NaN;
            if (!Number.isFinite(receivedAt) || receivedAt <= 0 || receivedAt >= sinceMs || receivedAt >= skewCeilingMs) return false;
            if (typeof m?.startedAt === 'number' && (m.startedAt >= sinceMs || m.startedAt >= skewCeilingMs)) return false;
            if (typeof m?.inputAt === 'number' && (m.inputAt >= sinceMs || m.inputAt >= skewCeilingMs)) return false;
        }
    }
    return true;
}

/**
 * SUBMIT-UNCONFIRMED-RECLAIM (review f8c79690 R4-1 / R10 / R11): fresh read of
 * a LOCAL session's transcript.
 * - `consumed`: positive evidence of agent activity for this dispatch at or
 *   after `sinceMs` (`observed.newestAgentActivityAt >= sinceMs`).
 * - `unknown`: returned for every other case across all providers today,
 *   because positive non-consumption is not provable from transcript inspection
 *   alone (persistence lag, clock skew, prompt normalization). Consequently,
 *   automatic clear+re-paste recovery is disabled and unconfirmed submits go to
 *   quarantine and the ledger's verified recovery (H2 probe -> H2r/H3 hard
 *   writer-stop -> queue recovery or coordinator notify).
 * - `not_consumed`: gated behind `hasAuthoritativeNonConsumptionProof`, which
 *   requires a future provider capability with `canProveNonConsumption: true`
 *   AND `supportsDispatchAcknowledgementWatermark: true` plus a dispatch-tied
 *   acknowledgement watermark bound to `messageId` and serialized with input
 *   acceptance, as well as affirmative provenance fields (`nativeSource ===
 *   'provider-native'`, `nativeHistoryCoverage === 'full'`, `identityStatus ===
 *   'safe'`, `coverage.safeMapping === true`, `staleness.freshEnough === true`).
 */
let cachedAnalyzeProbeTranscript: ((payload: Record<string, any>, ctx: { turnStartedAtMs?: number; providerType?: string }) => any) | null = null;

export function registerProbeTranscriptAnalyzer(
    fn: (payload: Record<string, any>, ctx: { turnStartedAtMs?: number; providerType?: string }) => any,
): void {
    cachedAnalyzeProbeTranscript = fn;
}

export async function confirmLocalConsumption(
    components: DaemonComponents,
    sessionId: string,
    sinceMs: number,
    opts?: { messageId?: string; expectedText?: string },
): Promise<'consumed' | 'not_consumed' | 'unknown'> {
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || sinceMs <= 0) return 'unknown';
    try {
        const instance = components.instanceManager?.getInstance?.(sessionId) as { type?: string } | undefined;
        const adapter = (components.cliManager as { adapters?: Map<string, { cliType?: string }> } | undefined)?.adapters?.get?.(sessionId);
        const regSession = (components as { sessionRegistry?: { get?: (id: string) => { providerType?: string } | undefined } }).sessionRegistry?.get?.(sessionId);
        const configuredProviderType = [instance?.type, adapter?.cliType, regSession?.providerType]
            .find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim();
        const result = await components.commandHandler.handle('read_chat', {
            sessionId,
            targetSessionId: sessionId,
            includeActivity: true,
            ...(configuredProviderType ? { agentType: configuredProviderType, providerType: configuredProviderType } : {}),
        });
        if (!result || typeof result !== 'object' || (result as { success?: unknown }).success === false) return 'unknown';
        const payload = unwrapReadChatPayload(result);
        if (!payload || (payload as { success?: unknown }).success === false || !Array.isArray(payload.messages)) return 'unknown';
        const ms = (payload.messageSource && typeof payload.messageSource === 'object' && !Array.isArray(payload.messageSource)
            ? payload.messageSource
            : payload.transcriptProvenance && typeof payload.transcriptProvenance === 'object' && !Array.isArray(payload.transcriptProvenance)
                ? payload.transcriptProvenance
                : null) as Record<string, any> | null;
        const providerType = configuredProviderType
            || (typeof (payload.debugReadChat as any)?.provider === 'string' && (payload.debugReadChat as any).provider.trim())
            || (typeof ms?.providerType === 'string' && ms.providerType.trim())
            || (typeof ms?.provider === 'string' && ms.provider.trim())
            || undefined;
        // Dynamic fallback: loops.ts imports this module (a static import would be a cycle).
        const analyzeProbeTranscript = cachedAnalyzeProbeTranscript ?? (await import('./loops.js')).analyzeProbeTranscript;
        cachedAnalyzeProbeTranscript = analyzeProbeTranscript;
        const observed = analyzeProbeTranscript(payload, { turnStartedAtMs: sinceMs, ...(providerType ? { providerType } : {}) });
        if (!observed) return 'unknown';
        const at = observed.newestAgentActivityAt;
        if (typeof at === 'number' && Number.isFinite(at) && at >= sinceMs) return 'consumed';
        return hasAuthoritativeNonConsumptionProof(payload, ms, observed, providerType, sinceMs, opts)
            ? 'not_consumed'
            : 'unknown';
    } catch {
        return 'unknown';
    }
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

/**
 * `revoke_worker_bind` executor's LOCAL half (WORKER-BIND-IDLE-DETACH,
 * 2026-09-24): the ledger's `cancel_dispatch` effect (a cut generation —
 * reclaim/redrive) is the one place a bound worker's mesh task stamp is
 * supposed to clear even though its own idle edge is deliberately withheld
 * from doing so (see `providers/cli-provider-events.ts` pushEvent). Runs
 * AFTER `revokeCutSessionWorkerBind` so the bind/token revoke that stops the
 * cut worker from calling `report_completion` lands first, then the local
 * instance (if this daemon is where that session lives) drops
 * `meshActiveTaskId`/attempt/nonce for the named task exactly the way its own
 * `generating_completed` would have, had it not been withheld.
 *
 * Scoped to the CUT (attemptId, sessionId): a session with no matching
 * instance (the cut session lives on another daemon, or already exited) is a
 * silent no-op — the bind/token revoke above is what actually mattered for a
 * remote session, and `terminated` already handles a locally-exited one via
 * `subscribeWorkerBindRevocation`.
 */
export function detachLocalMeshTaskStamp(components: DaemonComponents, request: { sessionId: string; taskId: string | null }): void {
    if (!request.taskId) return;
    const instance = components.instanceManager.getInstance(request.sessionId) as unknown as {
        getState?: () => { settings?: Record<string, unknown> };
        detachMeshAssignment?: () => void;
    } | undefined;
    if (!instance || typeof instance.detachMeshAssignment !== 'function') return;
    // Only detach the task this cancel actually names — a session that has
    // since moved on to a DIFFERENT task (attachMeshAssignment's taskChanged
    // handling already cleared the cut task's markers) must not have its
    // CURRENT, unrelated task torn down by a stale cancel arriving late.
    try {
        const settings = (instance.getState?.().settings as Record<string, unknown> | undefined) || {};
        if (settings.meshActiveTaskId !== request.taskId) return;
    } catch { /* best-effort: no readable state ⇒ fall through and detach anyway */ }
    try { instance.detachMeshAssignment(); } catch { /* best-effort */ }
}

/**
 * Persist worker session binds (hash-keyed) in mesh-runtime.db so a worker the
 * session host restores across a daemon restart can still report. A persisted
 * bind is honoured only for a session live on THIS daemon — the same two-source
 * liveness `reconcileOrphanedPlainAttemptsOnBoot` uses. Restore (S8) adopts the
 * rows of sessions that came back and prunes the rest. Returns the uninstaller.
 */
function installWorkerSessionBindPersistence(components: DaemonComponents): () => void {
    try {
        const store = new SqliteWorkerSessionBindStore(MeshRuntimeStore.getInstance().db);
        setWorkerSessionBindPersistence(store, (sessionId) => {
            if (components.sessionRegistry.has(sessionId)) return true;
            try { return !!components.instanceManager.getInstance(sessionId); } catch { return false; }
        });
    } catch (e: any) {
        LOG.warn('WorkerMcp', `worker session bind persistence unavailable (binds are in-memory only this run): ${e?.message || e}`);
    }
    return () => setWorkerSessionBindPersistence(null);
}

export function bootMeshRuntime(s6: ProjectionsStage): MeshRuntimeStage {
    const components = assembleDaemonComponents(s6);
    const { bus } = s6;
    const offBindPersistence = installWorkerSessionBindPersistence(components);
    // A hosted node with no providerPriority/slots defaults to this machine's enabled CLIs.
    const offLocalProviderFallback = installLocalNodeProviderFallback(components.providerLoader);

    // Session-death consumers. Registration order = delivery order on the sync
    // lane; the ledger writer runs on the async lane.
    const offSubscribers = [
        subscribeMeshTermination(bus),
        subscribeMeshProviderSignals(bus),
        subscribeCoordinatorRegistryRemoval(bus),
        // Takes a dead worker's entry back out of a SHARED workspace MCP config
        // (restoring what it shadowed) — see resolveWorkerMcpPlacement.
        subscribeWorkerMcpSharedConfigCleanup(bus),
        subscribeWorkerBindRevocation(bus),
        subscribeContractGrantRevocation(bus),
    ];

    // The turn ledger + notice path (C-W3), BEFORE forwarding so the first
    // provider event already has a ledger to observe into.
    const turn = wireTurnLedger(components);
    components.turnLedger = turn.ledger;
    // One read-only settlement pass recovers a reply lost across owner restart.
    // Normal stopping holds own the bounded destructive retry budget.
    void turn.ledger.resumeStoppingWriters();
    void resumePendingHolderReconciles(components);
    // CONTRACT-VERSIONING: new process incarnation rotates volatile grants; a use guard
    // left active by the previous process becomes UNKNOWN and is settled only by
    // checking the actual target branch (RN-02).
    contractBoot(probeRefineLanding);
    components.turnProbePort = turn.probePort;
    components.meshTurn = turn;
    // The command plane (built in S5, before these components existed) gets the
    // REAL components now — every command that calls a mesh function taking
    // `DaemonComponents` reads them via `ctx.components()`. Before this line a
    // command that needs them answers `daemon_components_not_ready` (never a
    // partial look-alike: the rc.39 ledger-less claim).
    components.router.attachComponents(components);

    // Provider events of mesh sessions → turn evidence / notices / queue edges.
    const offForwarding = setupMeshEventForwarding(components);
    // Periodic quota refresh (fills the cache buildLocalNodeFacts READS) and
    // its event-driven complement (refetch the provider that just finished a turn).
    components.quotaRefreshLoop = setupQuotaRefreshLoop(components);
    components.quotaEventRefresh = setupQuotaEventRefresh(components);
    // Assistant layer (design 2026-10-07 §4.3/§4.5): registry + relay bus
    // subscribers and timers — inert until an assistant exists. After the
    // router has its components (the relay reads read_chat in-process).
    const assistant = wireAssistantRuntime(components);

    let disposed = false;
    const disposeMeshRuntime = (): void => {
        if (disposed) return;
        disposed = true;
        try { assistant.dispose(); } catch { /* noop */ }
        try { components.quotaRefreshLoop?.stop(); } catch { /* noop */ }
        try { components.quotaEventRefresh?.stop(); } catch { /* noop */ }
        try { offForwarding(); } catch { /* noop */ }
        try { turn.dispose(); } catch { /* noop */ }
        for (const off of offSubscribers.reverse()) {
            try { off(); } catch { /* noop */ }
        }
        try { offBindPersistence(); } catch { /* noop */ }
        try { offLocalProviderFallback(); } catch { /* noop */ }
    };

    return { ...s6, components, disposeMeshRuntime };
}

/**
 * Boot-only closure of plain attempts a restart interrupted (assistant-layer
 * design 2026-10-07, appendix B item 2): every open plain attempt the
 * PREVIOUS daemon incarnation opened (acceptedAt < the ledger's
 * `incarnationStartedAt`) is closed `failed`/`daemon_restart` through the
 * reducer, live session or not. The caller (`startLoops`, S8) MUST invoke
 * this exactly once, BEFORE `cliManager.restoreHostedSessions()` — a session
 * restored live would otherwise have its next `turn_started` absorbed into
 * the stale attempt (R32), folding two turns into one.
 */
export function closeInterruptedPlainAttemptsOnBoot(components: DaemonComponents): ReconcileOrphanedPlainAttemptsReport | null {
    const ledger = components.turnLedger;
    if (!ledger) return null;
    return closeInterruptedPlainAttempts({
        ledger,
        log: {
            info: (m) => LOG.info('TurnLedger', m),
            warn: (m) => LOG.warn('TurnLedger', m),
        },
    });
}

/**
 * Boot-only orphan closure (wiring-unification follow-up, design §5): a plain
 * attempt orphaned by a daemon restart (R0a opens it with no hold, unlike a
 * mesh attempt's `hard_ceiling`) never closes on its own. The caller
 * (`startLoops`, S8) MUST invoke this exactly once, AFTER
 * `cliManager.restoreHostedSessions()` has resolved — restore is what
 * populates `SessionRegistry` for every session that legitimately survived
 * the restart, so calling this any earlier (e.g. from `wireTurnLedger`/S7,
 * before S8 even starts) would read an empty/partial registry and
 * misclassify live, restorable sessions as orphans. `instanceManager` is
 * checked too (same two-source liveness `resolveProbeLocation` already uses)
 * so a session tracked only there is never falsely closed.
 */
export function reconcileOrphanedPlainAttemptsOnBoot(components: DaemonComponents): ReconcileOrphanedPlainAttemptsReport | null {
    const ledger = components.turnLedger;
    if (!ledger) return null;
    return reconcileOrphanedPlainAttempts({
        ledger,
        isSessionLive: (sessionId) => {
            if (components.sessionRegistry.has(sessionId)) return true;
            try { return !!components.instanceManager.getInstance(sessionId); } catch { return false; }
        },
        log: {
            info: (m) => LOG.info('TurnLedger', m),
            warn: (m) => LOG.warn('TurnLedger', m),
        },
    });
}
