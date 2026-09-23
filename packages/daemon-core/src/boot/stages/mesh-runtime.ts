/**
 * S7 bootMeshRuntime — assemble `DaemonComponents`, attach the mesh bus
 * subscribers, start event forwarding and the reconcile / quota loops
 * (wiring-unification B4).
 *
 * The termination / signal subscribers used to be installed first thing in boot
 * ("must precede any provider spawn"). They can attach here because no session
 * can spawn before S8: restore runs in `startLoops`, and commands are only
 * reachable once `bootDaemonRuntime` has returned.
 */

import { subscribeMeshTermination } from '../../mesh/mesh-termination-bridge.js';
import { subscribeMeshProviderSignals } from '../../mesh/mesh-signal-bridge.js';
import { subscribeCoordinatorRegistryRemoval } from '../../mesh/coordinator-registry.js';
import { subscribeWorkerBindRevocation } from '../../mesh/worker-mcp-isolation.js';
import { setupMeshEventForwarding } from '../../mesh/mesh-events.js';
import { migratePendingInboxBeforeReconcile, setupMeshReconcileLoop } from '../../mesh/mesh-reconcile-loop.js';
import { setupQuotaEventRefresh, setupQuotaRefreshLoop } from '../../quota/refresh.js';
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

    // Queue persistence + coordinator idle fast-flush (a `provider_event` subscriber).
    const offForwarding = setupMeshEventForwarding(components);
    // Drain the legacy JSONL inbox BEFORE the loop that runs the retention sweep.
    const inbox = migratePendingInboxBeforeReconcile();
    components.meshReconcileLoop = setupMeshReconcileLoop(components, inbox);
    // Periodic quota refresh (fills the cache buildLocalNodeFacts READS) and
    // its event-driven complement (refetch the provider that just finished a turn).
    components.quotaRefreshLoop = setupQuotaRefreshLoop(components);
    components.quotaEventRefresh = setupQuotaEventRefresh(components);

    let disposed = false;
    const disposeMeshRuntime = (): void => {
        if (disposed) return;
        disposed = true;
        try { components.meshReconcileLoop?.stop(); } catch { /* noop */ }
        try { components.quotaRefreshLoop?.stop(); } catch { /* noop */ }
        try { components.quotaEventRefresh?.stop(); } catch { /* noop */ }
        try { offForwarding(); } catch { /* noop */ }
        // Sessions torn down after this point die because the daemon is going
        // away; the `daemon_shutdown` cause filter in each subscriber covers any
        // termination that still races in before this runs.
        for (const off of offSubscribers.reverse()) {
            try { off(); } catch { /* noop */ }
        }
    };

    return { ...s6, components, disposeMeshRuntime };
}
