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
import { isShellWrapperCommand, resolveWrappedCliBinary } from '../../providers/provider-loader.js';
import { scheduleComposerResidueSweep } from '../composer-residue-sweep.js';
import { startEventLoopMonitor } from '../event-loop-monitor.js';
import type { Disposer } from '../daemon-components.js';
import type { MeshRuntimeStage } from './types.js';
import type { ChatMessage } from '../../types.js';
// Turn scheduler (wiring-unification C4). The transcript analysis lives in
// providers/** and mesh/** may not value-import it (check:boundaries), so the
// boot layer builds the analyzer and injects it into the probe.
import {
    countTrailingToolActivityAfterFinalAssistant,
    extractFinalAssistantSummaryEvidence,
    readChatMessageTimestampMs,
} from '../../providers/chat-message-normalization.js';
import { hasNonEmptyModalButtons } from '../../commands/read-chat-presentation.js';
import {
    providerHasNativeTurnSignal,
    selectTurnTerminalMarker,
    type NativeTurnTerminalMarker,
} from '../../chat/native-turn-signal.js';
import { extractJsonObjectFromSummary } from '../../mesh/mesh-ledger.js';
import { appendMeshHandoff } from '../../seqscribe/mesh-publisher.js';
import { getMeshWithCache } from '../../mesh/mesh-queue-assignment.js';
import { startContinuousAutoFastForwardScheduler } from '../../mesh/mesh-auto-fast-forward.js';
import { claimPendingQueues, startMeshHousekeeping } from '../../mesh/mesh-housekeeping-tick.js';
import { resolveTurnPolicy } from '../../mesh/turn-ledger/policy.js';
import { createComponentsProbeReader, type TranscriptAnalyzer, type TranscriptObservation } from '../../mesh/turn-ledger/probe.js';
import { resolveProbeLocation } from '../../mesh/turn-ledger/targets.js';
import { startTurnScheduler } from '../../mesh/turn-ledger/scheduler.js';
import { reconcileOrphanedPlainAttemptsOnBoot } from './mesh-runtime.js';

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
        // Background work: a throw here is uncaught inside setImmediate and would
        // take the whole daemon down (observed 2026-09-25 on a standalone boot).
        try {
        const targets = (components.providerLoader.getAvailableProviderInfos?.() || [])
            .filter((p: any) => p?.category === 'cli' && p?.modelDiscovery)
            .filter((p: any) => p.enabled !== false)
            .map((p: any) => ({
                type: p.type,
                modelDiscovery: p.modelDiscovery,
                // A shell-wrapped spawn (antigravity-cli: `bash -c "… exec agy"`)
                // must never hand the wrapper to discovery — that ran `bash models`
                // (2026-09-25). Detection now resolves the wrapped binary, so
                // detectedPath is the real CLI; this guard covers a stale
                // detection recorded before that fix.
                binary: resolveWrappedCliBinary(p.spawn?.command, p.binary) && isShellWrapperCommand(p.detectedPath)
                    ? p.binary
                    : (p.detectedPath || p.binary),
            }));
        void refreshDueModelDiscovery(targets).catch(() => { /* background; manifest lists stand */ });
        } catch (e: any) {
            LOG.warn('Models', `model discovery scheduling failed (manifest lists stand): ${e?.message || e}`);
        }
    });
}

// ─── turn scheduler wiring (C4) ─────────────────────────────────────────────

/** Handoff entry kind for a probe-read final summary (`mesh.<id>.handoff`, text lives only there). */
export const TURN_SUMMARY_HANDOFF_KIND = 'turn.summary';

/**
 * read_chat payload → the scalars the probe maps to evidence. Same extractors
 * the deleted PHASE-4 synth / assigned-row poll used (final assistant scoped to
 * the turn start, trailing tool count, newest bubble, parked modal, native
 * markers — present-even-as-[] means a native read happened).
 */
export const analyzeProbeTranscript: TranscriptAnalyzer = (payload, ctx) => {
    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    const turnStartedAtMs = ctx.turnStartedAtMs;
    const evidence = extractFinalAssistantSummaryEvidence(messages, undefined,
        typeof turnStartedAtMs === 'number' ? { turnStartedAtMs } : undefined);
    const finalAssistantAt = evidence.transcriptMessageAt ? Date.parse(evidence.transcriptMessageAt) : Number.NaN;
    let newestActivityAt: number | undefined;
    let newestAgentActivityAt: number | undefined;
    for (const msg of messages) {
        const ts = readChatMessageTimestampMs(msg);
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
        if (newestActivityAt === undefined || ts > newestActivityAt) newestActivityAt = ts;
        if (msg?.role === 'user' || msg?.role === 'system') continue;
        if (typeof turnStartedAtMs === 'number' && ts < turnStartedAtMs) continue;
        if (newestAgentActivityAt === undefined || ts > newestAgentActivityAt) newestAgentActivityAt = ts;
    }
    const markersPresent = 'turnTerminalMarkers' in payload && Array.isArray(payload.turnTerminalMarkers);
    const nativeRead = markersPresent && providerHasNativeTurnSignal({ type: ctx.providerType });
    const marker = nativeRead
        ? selectTurnTerminalMarker(payload.turnTerminalMarkers as readonly NativeTurnTerminalMarker[],
            typeof turnStartedAtMs === 'number' ? { turnStartedAt: turnStartedAtMs } : {})
        : null;
    const finalSummary = evidence.finalSummary || '';
    // Self-attributing = the summary parses as a worker-result JSON object (the
    // ledger's `final_summary_json` source) — the provider emitted it for THIS turn.
    const selfAttributing = !!finalSummary && !!extractJsonObjectFromSummary(finalSummary);
    const observed = typeof payload.providerObservedStatus === 'string' && payload.providerObservedStatus.trim()
        ? payload.providerObservedStatus
        : payload.status;
    const out: TranscriptObservation = {
        providerObservedStatus: typeof observed === 'string' ? observed.trim().toLowerCase() : '',
        activeModal: hasNonEmptyModalButtons(payload.activeModal),
        selfAttributing,
        trailingActivity: countTrailingToolActivityAfterFinalAssistant(messages),
        nativeRead,
        ...(Number.isFinite(finalAssistantAt) ? { finalAssistantAt } : {}),
        ...(finalSummary ? { finalSummary } : {}),
        ...(newestActivityAt !== undefined ? { newestActivityAt } : {}),
        ...(newestAgentActivityAt !== undefined ? { newestAgentActivityAt } : {}),
        ...(marker ? { nativeMarker: { outcome: marker.outcome, ...(marker.turnId ? { turnId: marker.turnId } : {}) } } : {}),
    };
    return out;
};

/** `components` after S7: the ledger, its late-bound probe port and the notice wiring are typed fields. */
type TurnWiredComponents = MeshRuntimeStage['components'];

/** Start the one turn-lifecycle timer, the housekeeping timer and the auto-ff cadence (P-β, unchanged). */
export function startTurnLoops(components: TurnWiredComponents, env: NodeJS.ProcessEnv = process.env): void {
    const policy = resolveTurnPolicy(env);
    const ledger = components.turnLedger ?? null;
    if (ledger) {
        const selfDaemonId = ledger.selfDaemonId;
        const reader = createComponentsProbeReader(components, { analyzer: analyzeProbeTranscript });
        components.turnScheduler = startTurnScheduler({
            ledger,
            policy,
            bus: components.bus,
            probe: {
                reader,
                locate: (attempt) => resolveProbeLocation({
                    sessionRegistry: components.sessionRegistry,
                    instanceManager: components.instanceManager,
                    resolveMesh: (meshId) => getMeshWithCache(components, meshId),
                }, attempt, selfDaemonId),
                handoff: (attempt, observation) => appendMeshHandoff(attempt.meshId!, TURN_SUMMARY_HANDOFF_KIND, {
                    attemptId: attempt.attemptId,
                    generation: attempt.generation,
                    source: 'coordinator_probe',
                    text: observation.finalSummary ?? '',
                }),
            },
            claim: () => claimPendingQueues(components),
            deliverBacklog: () => components.meshTurn?.deliverBacklog(),
            log: {
                info: (m) => LOG.info('TurnScheduler', m),
                warn: (m) => LOG.warn('TurnScheduler', m),
                error: (m) => LOG.error('TurnScheduler', m),
            },
        });
        components.turnProbePort?.bind(components.turnScheduler);
        LOG.info('TurnScheduler', `Turn scheduler started (tick ${policy.tickMs}ms)`);
    } else {
        // Without a ledger nothing can reduce evidence: holds are never swept and
        // the claim net would be the only turn-side timer. Run the claim from the
        // housekeeping tick so queued work is still dispatched, and say so.
        LOG.warn('TurnScheduler', 'No turn ledger on components — turn scheduler NOT started (hold expiry, probes and republish are off); queue claim runs on the housekeeping tick');
    }
    components.meshHousekeeping = startMeshHousekeeping(components, policy.tickMs, { claim: !ledger });
    // P6 (2026-09-23 IPC-load audit): continuous auto fast-forward keeps its OWN
    // scheduler, never awaited by any tick.
    components.autoFastForwardScheduler = startContinuousAutoFastForwardScheduler(components);
}

export function stopTurnLoops(components: TurnWiredComponents): void {
    try { components.turnProbePort?.bind(null); } catch { /* noop */ }
    try { components.turnScheduler?.stop(); } catch { /* noop */ }
    try { components.meshHousekeeping?.stop(); } catch { /* noop */ }
    try { components.autoFastForwardScheduler?.stop(); } catch { /* noop */ }
}

export async function startLoops(s7: MeshRuntimeStage): Promise<Disposer> {
    const { cfg, components } = s7;

    s7.cdpInitializer.startPeriodicScan(cfg.cdpScanIntervalMs ?? DEFAULT_CDP_SCAN_INTERVAL_MS);
    s7.cdpInitializer.startDiscovery(DEFAULT_CDP_DISCOVERY_INTERVAL_MS);
    s7.poller.start();
    s7.instanceManager.startTicking(cfg.tickIntervalMs ?? 5_000);
    // Turn lifecycle timer + mesh housekeeping + auto-ff cadence (C4). Started
    // before hosted-session restore: a restored session's `registered` edge and
    // any hold that expired while the daemon was down are both just a tick.
    startTurnLoops(components as TurnWiredComponents);

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
    // Orphaned-plain-attempt closure (wiring-unification follow-up, design §5):
    // MUST run after restore resolves — restore is what tells this reconciliation
    // which sessions are legitimately still alive (an earlier check would see an
    // empty registry and misclassify every one of them as orphaned).
    try { reconcileOrphanedPlainAttemptsOnBoot(components as TurnWiredComponents); } catch (e: any) {
        LOG.warn('TurnLedger', `Orphaned-plain-attempt reconciliation failed: ${e?.message || e}`);
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
        stopTurnLoops(components as TurnWiredComponents);
        try { components.composerResidueSweep?.stop(); } catch { /* noop */ }
        try { components.eventLoopMonitor?.stop(); } catch { /* noop */ }
    };
}
