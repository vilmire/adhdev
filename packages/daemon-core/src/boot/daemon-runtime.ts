/**
 * bootDaemonRuntime — the staged daemon boot (wiring-unification B4, plan §4).
 *
 *   S1 bootPlatform → S2 bootProviders → S3 bootSessionCore → S4 bootSeqscribeNode
 *   → S5 bootCommandPlane → S6 armSeqscribeProjections → S7 bootMeshRuntime → S8 startLoops
 *
 * Each stage's typed result is the next stage's input, so the ~15 ordering
 * comments of the old `initDaemonComponents` are enforced by construction.
 * Where each old constraint lives now:
 *
 * | Old constraint (daemon-lifecycle.ts)                    | Enforced by |
 * |---------------------------------------------------------|-------------|
 * | hardening / shim / log interceptor before providers     | S1 is first; nothing builds without PlatformStage |
 * | env overrides before any flag read; migrate → re-read   | S1 internal |
 * | first-sync → daemon-update sync never concurrent        | S2 `channelBootSync` is one chain |
 * | setDefaultProviderLoader before version-chip reads      | S2 (retained process slot, one consumer) |
 * | version detection off the boot path                     | S2 `setTimeout(…, 0)` |
 * | claim liveness after the registry                       | S3 bus subscriber (live-session set) |
 * | termination/signal observers before any spawn           | S7 < S8 (restore); commands need the returned runtime |
 * | "poller declared first so onIdeConnected captures it"   | poller built in S3, passed to the router as a value |
 * | seqscribe node after router → holder                    | S4 opens the node before S5 builds the router |
 * | collector = single drain owner                          | `SeqscribeRuntime.collector` exposes only `snapshot()` |
 * | componentsRef for the host-armed beacon                 | `SeqscribeRuntime.beacon` (BeaconSlot) |
 * | dual-write before parity / topic activation / prune / redrive | S6 fixed arm order; disarm is its exact reverse |
 * | JSONL inbox migration before the reconcile loop         | `setupMeshReconcileLoop(components, MigratedPendingInbox)` |
 * | quota hydration before boot refresh                     | S8 `scheduleQuotaBootRefresh` |
 * | event-loop monitor after the logger                     | S1 < S8 |
 * | shutdown: producers stopped before the node closes      | shutdown below: S8→S6 disposers, S4 quiesce, S3, then S4 close |
 * | observers uninstalled before sessions are torn down     | `registry.beginShutdown()` first → `daemon_shutdown` cause filter |
 */

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import type { DaemonBootConfig, DaemonRuntime, Disposer } from './daemon-components.js';
import { bootPlatform } from './stages/platform.js';
import { bootProviders } from './stages/providers.js';
import { bootSessionCore } from './stages/session-core.js';
import { bootSeqscribeNode } from './stages/seqscribe-node.js';
import { bootCommandPlane } from './stages/command-plane.js';
import { armSeqscribeProjections } from './stages/seqscribe-projections.js';
import { bootMeshRuntime } from './stages/mesh-runtime.js';
import { startLoops } from './stages/loops.js';
import type {
    CommandPlaneStage,
    MeshRuntimeStage,
    PlatformStage,
    ProjectionsStage,
    ProvidersStage,
    SeqscribeNodeStage,
    SessionCoreStage,
} from './stages/types.js';

/** The eight stages. Injectable so the composition (order, shutdown) is testable without a real daemon. */
export interface DaemonBootStages {
    bootPlatform(cfg: DaemonBootConfig): Promise<PlatformStage>;
    bootProviders(s1: PlatformStage): Promise<ProvidersStage>;
    bootSessionCore(s2: ProvidersStage): Promise<SessionCoreStage>;
    bootSeqscribeNode(s3: SessionCoreStage): SeqscribeNodeStage;
    bootCommandPlane(s4: SeqscribeNodeStage): CommandPlaneStage;
    armSeqscribeProjections(s5: CommandPlaneStage): ProjectionsStage;
    bootMeshRuntime(s6: ProjectionsStage): MeshRuntimeStage;
    startLoops(s7: MeshRuntimeStage): Promise<Disposer>;
    /** Final step after the bus closes. Default: VACUUM the mesh runtime DB. */
    vacuum(): void;
}

export const DEFAULT_DAEMON_BOOT_STAGES: DaemonBootStages = {
    bootPlatform,
    bootProviders,
    bootSessionCore,
    bootSeqscribeNode,
    bootCommandPlane,
    armSeqscribeProjections: (s5) => armSeqscribeProjections(s5),
    bootMeshRuntime,
    startLoops,
    vacuum: () => {
        // Retention prunes with DELETE (frees pages, never shrinks the file); the
        // mesh-runtime.db grew to hundreds of MB because it was never compacted.
        // Last, after every writer stopped, so nothing contends for the lock.
        try { MeshRuntimeStore.getInstance().vacuum(); } catch { /* store unavailable — nothing to vacuum */ }
    },
};

function runDisposer(name: string, dispose: Disposer): void {
    try {
        dispose();
    } catch (e: any) {
        LOG.warn('Shutdown', `${name} teardown failed (continuing): ${e?.message || e}`);
    }
}

export async function bootDaemonRuntime(
    cfg: DaemonBootConfig,
    stages: DaemonBootStages = DEFAULT_DAEMON_BOOT_STAGES,
): Promise<DaemonRuntime> {
    const s1 = await stages.bootPlatform(cfg);
    const s2 = await stages.bootProviders(s1);
    const s3 = await stages.bootSessionCore(s2);
    const s4 = stages.bootSeqscribeNode(s3);
    const s5 = stages.bootCommandPlane(s4);
    const s6 = stages.armSeqscribeProjections(s5);
    const s7 = stages.bootMeshRuntime(s6);
    const disposeLoops = await stages.startLoops(s7);

    let shutdownPromise: Promise<void> | null = null;
    const shutdown = (): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            // Every termination from here on carries `daemon_shutdown`, so no
            // subscriber that is still attached records a daemon teardown as a death.
            s3.sessionRegistry.beginShutdown();
            // 1. Stop producers, reverse stage order (all synchronous).
            runDisposer('loops', disposeLoops);
            runDisposer('mesh runtime', s7.disposeMeshRuntime);
            runDisposer('seqscribe projections', s6.disarmProjections);
            runDisposer('seqscribe producers', () => s4.seqscribe?.quiesce());
            runDisposer('provider staleness probe', s2.stalenessProbe.stop);
            runDisposer('session liveness', s3.disposeLiveness);
            // 2. Session core: agent streams, submit drain, CLI detach, instances, CDP.
            try {
                await s3.disposeSessionCore();
            } catch (e: any) {
                LOG.warn('Shutdown', `session core teardown failed (continuing): ${e?.message || e}`);
            }
            // 3. Release the seqscribe node (and its DB owner lock) after its
            //    transports stopped producing work.
            await s4.seqscribe?.close();
            // 4. No emits after this point; then compact the mesh DB last.
            s3.bus.close();
            stages.vacuum();
        })();
        return shutdownPromise;
    };

    return { components: s7.components, bus: s3.bus, seqscribe: s4.seqscribe, shutdown };
}
