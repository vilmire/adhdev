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

import { resolveSessionTurnPresentation, isTerminalTurnStage } from '../../mesh/mesh-turn-presentation.js';
import { traceMeshEventDrop, traceMeshEventStage } from '../../shared/mesh-event-trace.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';
import { emitNoProgress } from '../turn-evidence-port.js';
import type { TurnEvidencePort } from '../turn-evidence-port.js';
import { SESSION_STATUSES, type TurnAttemptRef, type NoProgressObservedStatus } from '@adhdev/mesh-shared';

/** Narrow a raw adapter status string to the closed no_progress vocabulary. */
function toNoProgressObservedStatus(raw: string): NoProgressObservedStatus {
    return (SESSION_STATUSES as readonly string[]).includes(raw) ? (raw as NoProgressObservedStatus) : 'unknown';
}

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
        getLastApprovalResolvedAt?: () => number;
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
    /** Turn-evidence port (wiring-unification C5/C-W5). Null until boot wires it. */
    turnEvidencePort?: TurnEvidencePort | null;
    /** Live attempt ref for this session, if the mesh assignment attached one. */
    currentAttemptRef?(): TurnAttemptRef | null;
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

    // A successfully-dispatched approval decision after the last PTY output is
    // independent proof that a still-reported waiting_approval is a stale latch.
    // A genuinely new approval necessarily renders new PTY output after that
    // decision, so its lastOutputAt moves past resolvedAt and remains protected.
    let staleResolvedApprovalLatch = false;
    try {
        const resolvedAt = host.adapter.getLastApprovalResolvedAt?.() ?? 0;
        staleResolvedApprovalLatch = observedStatus === 'waiting_approval'
            && Number.isFinite(resolvedAt)
            && resolvedAt > 0
            && resolvedAt > lastOutputAt;
    } catch { /* missing/failed evidence stays fail-closed: protect the wait */ }

    // (APPROVAL-WAIT-BLINDSPOT fix ④, live defect 2026-09-22) A worker PARKED AT
    // A PROMPT IS NOT STALLED — it is waiting for a human, and reporting it as
    // no-progress kills work nobody had any reason to abandon.
    //
    // Why the existing Stage-6 branch below cannot cover this: it only engages
    // when `authority === 'turn_reducer'`, i.e. when a `turn_attempts` row
    // already says `waiting_approval`. That row is written from the ledger event
    // the DAEMON emits on entering the approval state — so in exactly the
    // situation this watchdog needs protection from (the approval was never
    // detected, or was detected minutes late) there is no row, no authority, and
    // therefore no veto. The watchdog was structurally blind to the failure mode
    // it most needed to survive. Measured: a `waiting_approval` that arrived 4
    // minutes late landed on a task the watchdog had already reaped, and was
    // discarded as `stale`.
    //
    // `observedStatus` closes that loop because it is read LIVE from the adapter
    // at the top of this tick (`getStatus({allowParse:false})`) — it does not
    // depend on any event having been successfully emitted, forwarded, or
    // recorded. It is the one liveness fact available even when the whole event
    // path is broken. This also covers `waiting_external` (a browser login/2FA
    // wait), which the adapter projects to `waiting_approval` for exactly this
    // "a human must act" reason.
    //
    // Scope: re-arm, never suppress permanently. A session that leaves the
    // prompt goes back to the normal clock on the very next tick, and a genuinely
    // wedged GENERATING session is untouched — this branch requires the adapter
    // to be actively reporting a prompt, which a wedged worker is not.
    if ((observedStatus === 'waiting_approval' && !staleResolvedApprovalLatch) || observedStatus === 'waiting_choice') {
        traceMeshEventDrop('mesh_worker_stall_waiting_on_human', host.meshTraceCtx('monitor:no_progress'),
            `PTY quiet ${Math.round(stalledMs / 1000)}s but the adapter reports '${observedStatus}' — `
            + 'the session is parked at a prompt awaiting a human decision, not stalled');
        host.meshStallAnchorAt = now;
        host.meshStallEmittedForAnchor = false;
        return;
    }

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
        if ((stage === 'waiting_approval' && !staleResolvedApprovalLatch)
            || stage === 'waiting_choice' || stage === 'finalizing' || isTerminalTurnStage(stage)) {
            host.meshStallAnchorAt = now;
            host.meshStallEmittedForAnchor = false;
            return;
        }
        // GENERATING-LIVE-TURN (2026-09-20): a reducer-authoritative `generating`
        // whose ADAPTER TURN IS STILL OPEN is affirmative proof the turn is running.
        // It must veto the stall outright — NOT via a clock comparison.
        //
        // The incident: a codex-cli worker reasoned silently for ~6 minutes (PTY and
        // transcript both quiet — long model thinking between tool calls emits
        // nothing). monitor:no_progress fired, the reconcile committed a terminal
        // FAILED (`source=stall_reconcile, stage was generating`), and the worker
        // then went busy→idle 74s later having completed the work. The result was
        // discarded: totalMessages=1, assistant output 0.
        //
        // Why the `updatedAt` comparison below could never have saved it — this is
        // the actual defect, and it is structural, not a tuning miss:
        // `turn_attempts.updated_at` is a STAGE-TRANSITION timestamp, not a
        // liveness timestamp. `generating` is written exactly once, edge-triggered
        // from agent:generating_started (mesh-event-forwarding.ts:1107); nothing
        // re-asserts it while the agent works, and there is no heartbeat column on
        // the row. So `now - updatedAt` is just the TURN'S OWN AGE, and
        // `now - updatedAt < threshold` holds only while the turn is YOUNGER than
        // the threshold — exactly the window in which the stall cannot fire anyway
        // (`stalledMs < threshold` already returned above). The moment the turn gets
        // old enough for the watchdog to act, the guard meant to protect it inverts
        // into no protection at all. The premise stated at
        // mesh-turn-presentation.ts:162-163 ("a reducer-authoritative turn refreshes
        // updated_at on every stage write, so a live turn is not silently quiet for
        // this long") is false for a single long `generating` stage with no
        // intervening suspension.
        //
        // Why `turnActive` is the right evidence and not merely a longer timeout:
        // it is sampled from the ADAPTER (hasAdapterPendingResponse — a request is
        // outstanding to the provider process), so it tracks whether THIS turn is
        // still open rather than how long it has been running. Raising the timeout
        // would only move the cliff (a 6-minute reasoning turn becomes a 10-minute
        // one); this asks the question the watchdog actually means to ask.
        //
        // Scope is deliberately narrow — this does NOT disable stall detection:
        //   - `consumed` keeps the old clock-based treatment (no turn is open yet,
        //     so there is no adapter liveness to appeal to).
        //   - A `generating` row whose adapter turn has CLOSED (turnActive false) is
        //     a genuinely wedged session — it falls through and still fires. That is
        //     the real stall this watchdog exists for.
        //   - The attempt-row staleness gate still applies upstream: a stranded row
        //     is demoted out of `turn_reducer` authority before we get here, so a
        //     dead row cannot claim liveness through this branch.
        if (stage === 'generating' && turnActive) {
            traceMeshEventDrop('mesh_worker_stall_generating_live_turn', host.meshTraceCtx('monitor:no_progress'),
                `PTY quiet ${Math.round(stalledMs / 1000)}s but the attempt is 'generating' with an open adapter turn `
                + `(updatedAt=${turnPresentation.updatedAt ?? 'none'} is the turn-start stamp, not a liveness clock)`);
            host.meshStallAnchorAt = now;
            host.meshStallEmittedForAnchor = false;
            return;
        }
        // CLOCK-LOWER-BOUND (2026-09-21): the freshness exemption below requires a
        // NON-NEGATIVE age. `updatedAt` is a foreign timestamp — an ISO string written
        // into `turn_attempts` by whichever process/machine owned the turn — so it
        // is not guaranteed to precede this daemon's `now` (clock skew between nodes, an
        // NTP step, a hand-edited/replicated row). Without a lower bound, a FUTURE
        // `updatedAt` makes `now - causalEvidenceMs` negative, the `< threshold`
        // comparison unconditionally true, and the stall suppressed FOREVER: every tick
        // re-takes this branch, so a genuinely wedged worker is never reported.
        //
        // ★The lower bound must REJECT, not clamp. `Math.max(0, age)` would read a
        // future stamp as age 0 — i.e. "evidence created this very instant", the
        // freshest possible — which is the strongest possible pass of the exemption and
        // leaves the defect exactly where it was. A negative age is not fresh evidence;
        // it is an UNTRUSTWORTHY CLOCK SIGNAL, and the safe reading of untrustworthy
        // liveness evidence is to decline the exemption and let the remaining axes
        // (transcript-advancing, completion-rescue) or the stall itself decide. Note the
        // `generating && turnActive` veto above already protects the live-turn case on
        // adapter evidence, which needs no clock at all.
        //
        // This mirrors the house shape already used for untrusted completion evidence:
        // mesh-completion-live-gate.ts rejects `observedAt > nowMs + 2_000` outright as
        // `stale_evidence_timestamp` rather than clamping it into range.
        const causalEvidenceMs = Date.parse(turnPresentation.updatedAt || '');
        const causalEvidenceAgeMs = now - causalEvidenceMs;
        if ((stage === 'consumed' || stage === 'generating')
            && Number.isFinite(causalEvidenceMs)
            && causalEvidenceAgeMs >= 0
            && causalEvidenceAgeMs < threshold) {
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
    // Turn-evidence (C5/C-W5): a pure observation, mirroring the provider event
    // above — this watchdog does not decide "stalled" is terminal, the ledger's
    // admission/reducer does. `finalAssistantPresent` is false here: had a final
    // assistant already been observed, tryReconcileTranscriptCompletionForStall
    // above would have reconciled to a completion and returned before this point.
    if (host.turnEvidencePort) {
        emitNoProgress(host.turnEvidencePort, {
            sessionId: host.instanceId,
            observedBy: 'mesh_stall_watchdog',
            source: 'mesh_stall_watchdog',
            attemptRef: host.currentAttemptRef?.() ?? undefined,
            stalledMs,
            observedStatus: toNoProgressObservedStatus(observedStatus),
            finalAssistantPresent: false,
        });
    }
}
