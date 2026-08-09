/**
 * MESH-STALL-WATCH — the status-agnostic mesh-worker stall watchdog (Phase 3
 * of the completion-engine rewrite: pure move out of CliProviderInstance).
 *
 * Fires at most ONE informational monitor:no_progress per stall episode when a
 * coordinator-spawned worker's raw PTY output clock (lastOutputAt) is static
 * past the threshold. Episode state lives ON THE HOST (the provider instance)
 * so restarts/tests construct it exactly as before; this module owns the
 * judgment and its provenance:
 *   - fix B: turn-end anchor re-arm (post-completion idle valley must not fire)
 *   - fix C: turn-scoped threshold raise (long thinking gaps absorbed; a real
 *     mid-turn wedge still fires late at the turn bound)
 *   - fix E: per-session refire cooldown (output dribble cannot page the
 *     coordinator on every re-arm)
 *   - TURN-PRESENTATION Stage 6: causal attempt stage/timestamps outrank the
 *     PTY quiet clock (parked approval/finalizing re-arms; fresh causal
 *     evidence advances the anchor)
 *   - TX-FSM Stage 1: transcript-advancing axis (a screen-quiet native-source
 *     worker whose transcript is growing is alive — re-arm, don't fire)
 *   - TRANSCRIPT-COMPLETION-STALL-RESCUE: a finished-but-quiet worker gets its
 *     missing completion emitted and the stall suppressed.
 */

import { resolveSessionTurnPresentation } from '../../mesh/mesh-turn-presentation.js';
import { isTerminalTurnStage } from '../../mesh/mesh-turn-ledger.js';
import { traceMeshEventDrop, traceMeshEventStage } from '../../mesh/mesh-event-trace.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';

export const MESH_WORKER_STALL_IDLE_THRESHOLD_MS = 180_000;
export const MESH_WORKER_STALL_TURN_THRESHOLD_MS = 360_000;
export const MESH_WORKER_STALL_REFIRE_COOLDOWN_MS = 600_000;

/**
 * The narrow surface of CliProviderInstance the watchdog reads/writes.
 * meshStall* fields remain instance-owned (tests seed them directly).
 */
export interface MeshStallHost {
    instanceId: string;
    type: string;
    startedAt: number;
    adapter: {
        isAlive?: () => boolean;
        getStatus(opts: { allowParse: boolean }): unknown;
    };
    meshStallAnchorAt: number;
    meshStallEmittedForAnchor: boolean;
    meshStallTurnActiveLast: boolean | undefined;
    meshStallLastFiredAt: number;
    meshStallTranscriptSignalSampled: boolean;
    isMeshWorkerSession(): boolean;
    hasAdapterPendingResponse(): boolean;
    probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null;
    tryReconcileTranscriptCompletionForStall(
        observedStatus: string,
        transcriptSignals: { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null,
    ): boolean;
    meshTraceCtx(event?: string): Record<string, unknown>;
    completingTurnTaskId(): string | undefined;
    pushEvent(event: Record<string, unknown>): void;
}

/** Drop the entire stall episode (session no longer a mesh worker / PTY dead). */
export function resetMeshStallEpisode(host: MeshStallHost): void {
    host.meshStallAnchorAt = -1;
    host.meshStallEmittedForAnchor = false;
    host.meshStallTurnActiveLast = undefined;
    host.meshStallLastFiredAt = -1;
    host.meshStallTranscriptSignalSampled = false;
}

/** One watchdog tick. Semantics are a verbatim move from CliProviderInstance. */
export function runMeshStallTick(host: MeshStallHost, now: number): void {
    if (!host.isMeshWorkerSession()) {
        resetMeshStallEpisode(host);
        return;
    }
    // Defensive: not every CliAdapter exposes isAlive() (SpecCliAdapter historically
    // had none — an unguarded call disabled stall detection for those sessions).
    if (typeof host.adapter.isAlive === 'function' && !host.adapter.isAlive()) {
        resetMeshStallEpisode(host);
        return;
    }

    let lastOutputAt: number;
    let observedStatus = 'unknown';
    try {
        // allowParse:false — cheap status read; must not trigger parsing or bump lastOutputAt.
        const status = host.adapter.getStatus({ allowParse: false }) as { lastOutputAt?: unknown; status?: unknown };
        lastOutputAt = typeof status?.lastOutputAt === 'number' && Number.isFinite(status.lastOutputAt)
            ? status.lastOutputAt
            : 0;
        if (typeof status?.status === 'string' && status.status) observedStatus = status.status;
    } catch {
        return; // defensive: a failed status read just skips this tick
    }

    // (fix B + C) Real turn liveness — adapter scope/pending, NOT the sticky FSM status.
    let turnActive = false;
    try {
        turnActive = host.hasAdapterPendingResponse();
    } catch { /* defensive: missing adapter diagnostics → treat as no active turn */ }
    const turnEnded = host.meshStallTurnActiveLast === true && !turnActive;
    host.meshStallTurnActiveLast = turnActive;

    // Anchor: last raw output, or spawn time before any output (silent spawn is caught).
    const anchor = lastOutputAt > 0 ? lastOutputAt : host.startedAt;

    // (fix B) Turn just ended — start the idle valley on a fresh clock.
    if (turnEnded && host.meshStallAnchorAt !== -1) {
        host.meshStallAnchorAt = Math.max(anchor, now);
        host.meshStallEmittedForAnchor = false;
        return;
    }

    if (host.meshStallAnchorAt === -1) {
        host.meshStallAnchorAt = anchor;
        host.meshStallEmittedForAnchor = false;
        return;
    }

    if (anchor > host.meshStallAnchorAt) {
        host.meshStallAnchorAt = anchor;
        host.meshStallEmittedForAnchor = false;
        return;
    }

    if (host.meshStallEmittedForAnchor) return; // already fired for this stall

    // (fix C) Turn-scoped threshold raise.
    const threshold = turnActive
        ? MESH_WORKER_STALL_TURN_THRESHOLD_MS
        : MESH_WORKER_STALL_IDLE_THRESHOLD_MS;
    const stalledMs = now - host.meshStallAnchorAt;
    if (stalledMs < threshold) return;

    // (TURN-PRESENTATION Stage 6) Causal attempt evidence outranks the PTY quiet clock.
    const turnPresentation = resolveSessionTurnPresentation({
        sessionId: host.instanceId,
        legacyStatus: observedStatus,
        providerType: host.type,
        surface: 'stall_watchdog',
        nowMs: now,
    });
    if (turnPresentation.authority === 'turn_reducer' && turnPresentation.stage) {
        const stage = turnPresentation.stage;
        if (stage === 'waiting_approval' || stage === 'waiting_choice' || stage === 'finalizing' || isTerminalTurnStage(stage)) {
            host.meshStallAnchorAt = now;
            host.meshStallEmittedForAnchor = false;
            return;
        }
        const causalEvidenceMs = Date.parse(turnPresentation.updatedAt || '');
        if ((stage === 'consumed' || stage === 'generating')
            && Number.isFinite(causalEvidenceMs)
            && now - causalEvidenceMs < threshold) {
            host.meshStallAnchorAt = Math.max(host.meshStallAnchorAt, causalEvidenceMs);
            return;
        }
    }

    // (TX-FSM Stage 1) Transcript-advancing axis: screen-quiet but transcript-live → re-arm.
    const transcriptSignals = host.probeNativeTranscriptSignals();
    if (transcriptSignals?.snapshot?.available === true) {
        const firstSampleThisEpisode = !host.meshStallTranscriptSignalSampled;
        host.meshStallTranscriptSignalSampled = true;
        const signalDetail = transcriptSignals.snapshot.detail;
        if (firstSampleThisEpisode || transcriptSignals.snapshot.signals.in_turn_progress === true) {
            if (host.isMeshWorkerSession()) {
                traceMeshEventDrop('mesh_worker_stall_transcript_advancing', host.meshTraceCtx('monitor:no_progress'),
                    `msgCount=${signalDetail.msgCount} sourceMtime=${signalDetail.sourceMtimeMs} (PTY quiet ${Math.round(stalledMs / 1000)}s but transcript advancing)`);
            }
            host.meshStallAnchorAt = now;
            host.meshStallEmittedForAnchor = false;
            return;
        }
    }

    // (TRANSCRIPT-COMPLETION-STALL-RESCUE) Finished-but-quiet: emit the missing
    // completion and suppress the stall; a genuinely wedged worker falls through.
    if (host.tryReconcileTranscriptCompletionForStall(observedStatus, transcriptSignals)) {
        host.meshStallEmittedForAnchor = true;
        return;
    }

    // (fix E) Per-session refire cooldown: mark emitted regardless so a static
    // anchor stops re-checking every tick; suppress the notification when the
    // previous emission was too recent.
    host.meshStallEmittedForAnchor = true;
    if (host.meshStallLastFiredAt >= 0
        && now - host.meshStallLastFiredAt < MESH_WORKER_STALL_REFIRE_COOLDOWN_MS) {
        return;
    }
    host.meshStallLastFiredAt = now;

    // observedStatus is context only — deliberately NOT the reconciliation-triggering
    // `status` field (see mesh-events-stale.buildNoProgressCompletionReconciliation).
    if (host.isMeshWorkerSession()) {
        traceMeshEventStage('fired', host.meshTraceCtx('monitor:no_progress'), 'mesh_worker_stall_watchdog');
    }

    const stalledSec = Math.round(stalledMs / 1000);
    host.pushEvent({
        event: 'monitor:no_progress',
        agentKey: `${host.type}:cli`,
        elapsedSec: stalledSec,
        timestamp: now,
        // MESH-STALL-WATCH marker: buildMeshSystemMessage generalizes the coordinator
        // message when set, since this watchdog fires status-agnostically.
        meshWorkerStall: true,
        lastOutputAt: host.meshStallAnchorAt,
        stalledMs,
        observedStatus,
        taskId: host.completingTurnTaskId(),
    });
}
