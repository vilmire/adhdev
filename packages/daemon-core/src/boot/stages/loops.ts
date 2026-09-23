/**
 * S8 startLoops — start everything that ticks, now that every subscriber is
 * attached (wiring-unification B4). Returns the loop-stage disposer; the
 * runtime assembly lives in boot/daemon-runtime.ts.
 */

import { LOG } from '../../logging/logger.js';
import { DEFAULT_CDP_DISCOVERY_INTERVAL_MS, DEFAULT_CDP_SCAN_INTERVAL_MS } from '../../runtime-defaults.js';
import {
    hydrateQuotaCacheFromDisk,
    quotaProviderEnabledFromLoader,
    refreshQuotaCacheOnBoot,
} from '../../quota/refresh.js';
import { hydrateModelCache, refreshDueModelDiscovery } from '../../models/registry.js';
import { scheduleComposerResidueSweep } from '../composer-residue-sweep.js';
import { startEventLoopMonitor } from '../event-loop-monitor.js';
import type { Disposer } from '../daemon-components.js';
import type { MeshRuntimeStage } from './types.js';

/**
 * Quota: hydrate the last persisted snapshots, THEN the one-shot boot refresh.
 * Deferred past boot and never awaited — a ~900ms codex app-server spawn must
 * not add to startup latency. Hydration first so a restart shows its last
 * numbers immediately; the enable gate is the same authority cli-manager
 * launches on (a provider this machine cannot run is never probed).
 */
export function scheduleQuotaBootRefresh(components: MeshRuntimeStage['components']): void {
    setImmediate(() => {
        const isQuotaProviderEnabled = quotaProviderEnabledFromLoader(components.providerLoader);
        try { hydrateQuotaCacheFromDisk(process.env, isQuotaProviderEnabled); } catch { /* fail-soft: an unusable cache is just an empty one */ }
        refreshQuotaCacheOnBoot(isQuotaProviderEnabled);
    });
}

/**
 * Model discovery: same shape — hydrate, then refresh only TTL-expired entries.
 * Reads the public inventory, which carries the DETECTED path, so discovery
 * only ever runs a binary detection already resolved. Discovery can raise the
 * list above the signed manifest, never below it.
 */
export function scheduleModelDiscovery(components: MeshRuntimeStage['components']): void {
    setImmediate(() => {
        try { hydrateModelCache(process.env); } catch { /* fail-soft */ }
        const targets = (components.providerLoader.getAvailableProviderInfos?.() || [])
            .filter((p: any) => p?.category === 'cli' && p?.modelDiscovery)
            .filter((p: any) => p.enabled !== false)
            .map((p: any) => ({
                type: p.type,
                modelDiscovery: p.modelDiscovery,
                binary: p.detectedPath || p.binary,
            }));
        void refreshDueModelDiscovery(targets).catch(() => { /* background; manifest lists stand */ });
    });
}

export async function startLoops(s7: MeshRuntimeStage): Promise<Disposer> {
    const { cfg, components } = s7;

    s7.cdpInitializer.startPeriodicScan(cfg.cdpScanIntervalMs ?? DEFAULT_CDP_SCAN_INTERVAL_MS);
    s7.cdpInitializer.startDiscovery(DEFAULT_CDP_DISCOVERY_INTERVAL_MS);
    s7.poller.start();
    s7.instanceManager.startTicking(cfg.tickIntervalMs ?? 5_000);

    // Hosted-session restore (B5: moved here from both hosts). Every bus
    // subscriber is attached by now (S7), so each restored session's
    // `registered{origin:'restore'}` reaches the mesh / liveness consumers; the
    // composer-residue sweep is scheduled only after the restore batch settled.
    if (cfg.restoreHostedSessions) {
        try {
            await s7.cliManager.restoreHostedSessions();
        } catch (e: any) {
            LOG.warn('Init', `Hosted session restore failed: ${e?.message || e}`);
        }
    }

    scheduleQuotaBootRefresh(components);
    scheduleModelDiscovery(components);
    // Resume refine jobs interrupted by a previous daemon restart.
    setImmediate(() => void s7.router.resumePendingRefineJobsOnStartup());
    // Event-loop-lag heartbeat (logger installed in S1).
    components.eventLoopMonitor = startEventLoopMonitor();
    // Re-arm persisted restart_daemon_node whenIdle schedules.
    setImmediate(() => s7.router.resumeDeferredRestartsOnStartup());
    // ENTER-LOSS layer ③: one-shot composer-residue sweep.
    components.composerResidueSweep = scheduleComposerResidueSweep(components);

    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        s7.poller.stop();
        s7.cdpInitializer.stop();
        try { components.composerResidueSweep?.stop(); } catch { /* noop */ }
        try { components.eventLoopMonitor?.stop(); } catch { /* noop */ }
    };
}
