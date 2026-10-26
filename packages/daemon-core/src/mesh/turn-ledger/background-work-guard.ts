import {
  isPendingBackgroundWorkSummary,
  sanitizeProcessCommandName,
} from '../../process/session-process-tree.js';
import { notifyMeshCoordinator } from './deliver.js';
import { isTerminalTurnState, type TurnAttempt } from './types.js';

/** How long a held turn end waits before the coordinator is told (once) that the worker is still running background work. */
export const DEFAULT_BACKGROUND_WORK_TIMEOUT_MS = 120_000;

/**
 * Release rule (owner decision): the guard NEVER releases on a wall clock while
 * there is evidence of real activity. Activity = a live worker-started process
 * consuming CPU between two process-table snapshots, OR the session's output
 * advancing (raw PTY output / newest transcript bubble). It releases only when
 * the work is idle-but-alive: processes present, no CPU growth and no output
 * for this long CONTINUOUSLY (any activity restarts the clock). Unknown CPU is
 * unknown, not idle: it contributes nothing, and output alone decides.
 *
 * Example it exists for: a dev server the worker left running, which the
 * previous fixed 10-min cap handled but which also cut a 35-minute test run
 * short and re-created the premature weak completion.
 *
 * The 90-minute hard ceiling (turn policy `hardCeilingMs`) stays the outer
 * bound and is not touched here.
 */
export const DEFAULT_BACKGROUND_WORK_INACTIVITY_RELEASE_MS = 600_000;

/**
 * After the single nudge, how long the worker may stay INACTIVE (no output) before
 * the guard releases. Output after the nudge (the worker answering it) restarts it.
 */
export const DEFAULT_BACKGROUND_WORK_NUDGE_GRACE_MS = 180_000;

/**
 * Sent at most once per (attempt, generation). Worded to be true whether or not
 * the process inspection was able to see the command exit: it is never claimed
 * finished unless the worker confirms it.
 */
export const BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE =
  '[System] You ended your turn while background work was pending and have not called report_completion. If the command has finished, report its results with report_completion now; if it is still running, wait for it, then report.';

/**
 * Epoch ms before which a descendant process is baseline for this attempt: the
 * moment the task prompt reached the worker (falling back to acceptance). A
 * process older than that is a CLI helper or a leftover from an earlier task
 * in a reused session — not work this task started.
 */
export function backgroundWorkBaselineMs(attempt: Pick<TurnAttempt, 'deliveredAt' | 'acceptedAt'>): number {
  return attempt.deliveredAt ?? attempt.acceptedAt;
}

export type IncompleteTurnEndReason =
  | 'live_background_processes'
  | 'pending_background_work_text';

export interface TurnEndBackgroundWorkDecisionInput {
  readonly attempt: Pick<TurnAttempt, 'scope' | 'generation' | 'data'>;
  readonly finalSummary?: string | null;
  /** Live worker-started processes; undefined/empty = none seen OR unknown (never blocks, never completes). */
  readonly liveBackgroundProcesses?: readonly string[] | null;
  /** The monitor already released this attempt generation: the guard no longer holds it. */
  readonly released?: boolean;
}

export type TurnEndBackgroundWorkDecision =
  | {
      readonly complete: true;
    }
  | {
      readonly complete: false;
      readonly reason: IncompleteTurnEndReason;
      readonly liveProcessNames: readonly string[];
    };

/**
 * Authoritative turn-end completion decision for delegated mesh workers.
 *
 * A worker turn end is treated as NOT complete when:
 * (a) the worker session still has live descendant processes that the worker
 *     started (excluding the provider CLI's own long-lived helpers), OR
 * (b) there is no structured `report_completion` for the current generation
 *     and the inferred final text matches the small allow-list indicating
 *     pending background work (secondary signal to (a) + missing report).
 */
export function evaluateTurnEndBackgroundWork(
  input: TurnEndBackgroundWorkDecisionInput,
): TurnEndBackgroundWorkDecision {
  const { attempt, finalSummary, liveBackgroundProcesses } = input;
  if (attempt.scope === 'plain' || input.released === true) {
    return { complete: true };
  }

  const hasStructuredReport = attempt.data.report?.generation === attempt.generation;
  if (hasStructuredReport) {
    return { complete: true };
  }

  const sanitizedProcessNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of liveBackgroundProcesses ?? []) {
    const clean = sanitizeProcessCommandName(raw);
    if (clean && clean !== 'unknown' && !seen.has(clean)) {
      seen.add(clean);
      sanitizedProcessNames.push(clean);
    }
  }

  if (sanitizedProcessNames.length > 0) {
    return {
      complete: false,
      reason: 'live_background_processes',
      liveProcessNames: sanitizedProcessNames,
    };
  }

  if (isPendingBackgroundWorkSummary(finalSummary)) {
    return {
      complete: false,
      reason: 'pending_background_work_text',
      liveProcessNames: [],
    };
  }

  return { complete: true };
}

export function formatBackgroundWorkTimeoutNotice(params: {
  readonly sessionId: string;
  readonly taskId?: string | null;
  readonly liveProcessNames: readonly string[];
  /** `no_report_after_nudge`: the background work is gone but the nudged worker stayed silent. */
  readonly phase?: 'still_running' | 'no_report_after_nudge';
}): string {
  const taskLabel = params.taskId ?? 'unassigned';
  if (params.phase === 'no_report_after_nudge') {
    return `[System] Worker session ${params.sessionId} (task ${taskLabel}) was nudged after its background work finished and has gone quiet without reporting results.`;
  }
  const procs =
    params.liveProcessNames.length > 0
      ? params.liveProcessNames.map((name) => sanitizeProcessCommandName(name)).join(', ')
      : 'none';
  return `[System] Worker session ${params.sessionId} (task ${taskLabel}): background work still running (live processes: ${procs}), no results yet.`;
}

export interface TrackedBackgroundWorkEntry {
  readonly attemptId: string;
  readonly generation: number;
  readonly meshId: string | null;
  readonly nodeId: string | null;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly coordinator: { readonly daemonId: string | null; readonly sessionId: string | null };
  readonly firstObservedAt: number;
  readonly initialReason: IncompleteTurnEndReason;
  lastLiveProcessNames: readonly string[];
  nudgedAt?: number;
  timeoutNotifiedAt?: number;
  /** Newest evidence of real activity (CPU growth or advancing output); starts at `firstObservedAt`. */
  lastActivityAt: number;
  /** Newest output clock value seen, so only a LATER one counts as advancing. */
  lastOutputSeenAt?: number;
  /** Set when the hold expired: this attempt generation is never held again. */
  releasedAt?: number;
  resolution?: 'nudged_after_exit' | 'no_results' | 'released_unfinished';
}

export interface BackgroundWorkNudgeMeta {
  readonly attemptId: string;
  readonly generation: number;
  readonly taskId: string | null;
  readonly reason: IncompleteTurnEndReason;
  readonly messageId: string;
}

export interface BackgroundWorkTimeoutNoticeMeta {
  readonly attemptId: string;
  readonly generation: number;
  readonly meshId: string | null;
  readonly nodeId: string | null;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly coordinator: { readonly daemonId: string | null; readonly sessionId: string | null };
  readonly liveProcessNames: readonly string[];
  readonly at: number;
}

export interface BackgroundWorkMonitorDeps {
  readonly timeoutMs?: number;
  /** Continuous inactivity that releases; see `DEFAULT_BACKGROUND_WORK_INACTIVITY_RELEASE_MS`. */
  readonly inactivityReleaseMs?: number;
  readonly nudgeGraceMs?: number;
  readonly nudgeWorker?: (
    sessionId: string,
    text: string,
    meta: BackgroundWorkNudgeMeta,
  ) => Promise<boolean | void> | boolean | void;
  readonly notifyCoordinator?: (
    coordinatorSessionId: string | null,
    text: string,
    meta: BackgroundWorkTimeoutNoticeMeta,
  ) => Promise<boolean | void> | boolean | void;
}

export interface BackgroundWorkObserveInput {
  readonly attempt: TurnAttempt;
  readonly nowMs: number;
  readonly status?: string;
  readonly finalSummary?: string | null;
  readonly finalAssistantAt?: number;
  readonly liveBackgroundProcesses?: readonly string[] | null;
  /**
   * False = the process table could not be read this tick. A hold already in place on live
   * processes is then carried (never mistaken for "they exited"). Absent = known (legacy callers).
   */
  readonly processesKnown?: boolean;
  /** CPU activity of the live processes between two snapshots; absent/'unknown' = not measurable. */
  readonly cpuActivity?: 'active' | 'idle' | 'unknown';
  /** When the snapshot that showed `cpuActivity` was read (activity is credited to that instant). */
  readonly cpuObservedAtMs?: number;
  /** Newest output sign: raw PTY output clock / newest transcript bubble (epoch ms). */
  readonly outputAtMs?: number;
}

export interface BackgroundWorkObserveResult {
  readonly holdTurnEnd: boolean;
  readonly nudgedWorker: boolean;
  readonly emittedCoordinatorNotice: boolean;
  readonly resolution?: 'nudged_after_exit' | 'no_results' | 'released_unfinished';
}

export interface BackgroundWorkMonitor {
  observe(input: BackgroundWorkObserveInput): Promise<BackgroundWorkObserveResult>;
  /** Attempts still being HELD (released ones are not probed on the guard's behalf). */
  trackedAttemptIds(): string[];
  /** True once the hold expired for this attempt generation; the probe and ledger gates then stand down. */
  isReleased(attemptId: string, generation: number): boolean;
  getEntry(attemptId: string): TrackedBackgroundWorkEntry | undefined;
  clear(attemptId: string): void;
}

function defaultNotifyCoordinator(
  _coordinatorSessionId: string | null,
  text: string,
  meta: BackgroundWorkTimeoutNoticeMeta,
): void {
  if (!meta.meshId) return;
  notifyMeshCoordinator({
    event: 'mesh:background_work_no_results',
    meshId: meta.meshId,
    nodeLabel: meta.nodeId || meta.sessionId,
    ...(meta.nodeId ? { nodeId: meta.nodeId } : {}),
    eventId: `background_work_timeout:${meta.meshId}:${meta.taskId ?? 'none'}:${meta.sessionId}:${meta.attemptId}:g${meta.generation}`,
    metadataEvent: {
      source: 'background_work_guard',
      attemptId: meta.attemptId,
      generation: meta.generation,
      sessionId: meta.sessionId,
      taskId: meta.taskId,
      liveProcessNames: [...meta.liveProcessNames],
      resolution: 'no_results',
      coordinatorMessage: text,
      at: meta.at,
    },
    coordinatorMessage: text,
    queuedAt: meta.at,
    ...(meta.coordinator.daemonId ? { targetCoordinatorDaemonId: meta.coordinator.daemonId } : {}),
    ...(meta.coordinator.sessionId ? { targetCoordinatorSessionId: meta.coordinator.sessionId } : {}),
  });
}

export function createBackgroundWorkMonitor(
  deps: BackgroundWorkMonitorDeps = {},
): BackgroundWorkMonitor {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BACKGROUND_WORK_TIMEOUT_MS;
  const inactivityReleaseMs = deps.inactivityReleaseMs ?? DEFAULT_BACKGROUND_WORK_INACTIVITY_RELEASE_MS;
  const nudgeGraceMs = deps.nudgeGraceMs ?? DEFAULT_BACKGROUND_WORK_NUDGE_GRACE_MS;
  const notifyCoordinator = deps.notifyCoordinator ?? defaultNotifyCoordinator;
  const entries = new Map<string, TrackedBackgroundWorkEntry>();

  // Attempts that went terminal between observations are never observed again;
  // bound the map so a long-lived daemon cannot accumulate them.
  const MAX_ENTRIES = 256;
  function boundEntries(): void {
    if (entries.size <= MAX_ENTRIES) return;
    const oldest = [...entries.values()].sort((a, b) => a.firstObservedAt - b.firstObservedAt);
    for (const entry of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(entry.attemptId);
  }

  const NOT_HELD: BackgroundWorkObserveResult = { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };

  /** Fold this observation's evidence of real activity into the entry's inactivity clock. */
  function noteActivity(entry: TrackedBackgroundWorkEntry, input: BackgroundWorkObserveInput): void {
    const { nowMs } = input;
    if (input.cpuActivity === 'active') {
      const at = Math.min(input.cpuObservedAtMs ?? nowMs, nowMs);
      entry.lastActivityAt = Math.max(entry.lastActivityAt, at);
    }
    if (typeof input.outputAtMs === 'number' && Number.isFinite(input.outputAtMs)) {
      if (entry.lastOutputSeenAt !== undefined && input.outputAtMs > entry.lastOutputSeenAt) {
        entry.lastActivityAt = Math.max(entry.lastActivityAt, Math.min(input.outputAtMs, nowMs));
      }
      entry.lastOutputSeenAt = Math.max(entry.lastOutputSeenAt ?? 0, input.outputAtMs);
    }
  }

  /** Expire the hold: from here the ordinary weak-completion path decides, and this generation is never held again. */
  function release(entry: TrackedBackgroundWorkEntry, nowMs: number): void {
    entry.releasedAt = nowMs;
    entry.resolution = 'released_unfinished';
  }

  async function sendNotice(
    entry: TrackedBackgroundWorkEntry,
    nowMs: number,
    phase: 'still_running' | 'no_report_after_nudge',
  ): Promise<void> {
    entry.timeoutNotifiedAt = nowMs;
    const notice = formatBackgroundWorkTimeoutNotice({
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      liveProcessNames: entry.lastLiveProcessNames,
      phase,
    });
    await notifyCoordinator(entry.coordinator.sessionId, notice, {
      attemptId: entry.attemptId,
      generation: entry.generation,
      meshId: entry.meshId,
      nodeId: entry.nodeId,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      coordinator: entry.coordinator,
      liveProcessNames: entry.lastLiveProcessNames,
      at: nowMs,
    });
  }

  return {
    async observe(input: BackgroundWorkObserveInput): Promise<BackgroundWorkObserveResult> {
      const { attempt, nowMs, status, finalSummary, finalAssistantAt, liveBackgroundProcesses } = input;
      if (attempt.scope === 'plain') {
        entries.delete(attempt.attemptId);
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      if (
        isTerminalTurnState(attempt.state) ||
        attempt.terminal !== null ||
        attempt.data.report?.generation === attempt.generation
      ) {
        entries.delete(attempt.attemptId);
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      const existing = entries.get(attempt.attemptId);
      if (existing && existing.generation !== attempt.generation) {
        entries.delete(attempt.attemptId);
      }
      // Latched: once released, this generation is never held again (no flapping).
      if (existing && existing.generation === attempt.generation && existing.releasedAt !== undefined) {
        return { ...NOT_HELD, resolution: 'released_unfinished' };
      }

      const decision = evaluateTurnEndBackgroundWork({
        attempt,
        finalSummary,
        liveBackgroundProcesses,
      });

      const currentEntry = entries.get(attempt.attemptId);
      const normStatus = (status ?? '').trim().toLowerCase();
      // Only a positive 'idle' (the scheduler passes it for native/pending-text turn
      // ends) starts the clock. An unknown/empty status once let a mid-turn read
      // seed firstObservedAt, and a short command started much later then tripped
      // the 120 s notice after a few seconds.
      const isTurnEndedIdle = normStatus === 'idle';

      if (decision.complete && !currentEntry) {
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      if (!isTurnEndedIdle && !currentEntry) {
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      // The worker is working again before anything was sent on this entry: the
      // earlier "turn ended" read was not the turn's end. Forget it, so the clock
      // restarts from the real end (re-created from the validated final timestamp,
      // which survives a flapping TUI) instead of from that stale observation.
      if (
        !isTurnEndedIdle &&
        currentEntry &&
        currentEntry.nudgedAt === undefined &&
        currentEntry.timeoutNotifiedAt === undefined
      ) {
        entries.delete(attempt.attemptId);
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      let liveNames = !decision.complete ? decision.liveProcessNames : [];
      // An unreadable process table is not "the processes exited": carry the last known live set
      // (before any nudge) so a transient ps failure cannot trigger a false nudge or release.
      if (
        input.processesKnown === false &&
        currentEntry &&
        currentEntry.nudgedAt === undefined &&
        liveNames.length === 0 &&
        currentEntry.lastLiveProcessNames.length > 0
      ) {
        liveNames = currentEntry.lastLiveProcessNames;
      }
      let entry = currentEntry;
      if (!entry) {
        if (decision.complete) {
          return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
        }
        // Probes can first discover the ended turn a minute later. Measure the
        // notice deadline from its validated final timestamp, not that delayed read.
        const baselineMs = backgroundWorkBaselineMs(attempt);
        const turnEndedAt =
          typeof finalAssistantAt === 'number' &&
          Number.isFinite(finalAssistantAt) &&
          finalAssistantAt >= baselineMs &&
          finalAssistantAt <= nowMs
            ? finalAssistantAt
            : nowMs;
        entry = {
          attemptId: attempt.attemptId,
          generation: attempt.generation,
          meshId: attempt.meshId,
          nodeId: attempt.nodeId,
          sessionId: attempt.sessionId,
          taskId: attempt.taskId,
          coordinator: {
            daemonId: attempt.coordinator.daemonId,
            sessionId: attempt.coordinator.sessionId,
          },
          firstObservedAt: turnEndedAt,
          lastActivityAt: nowMs,
          ...(typeof input.outputAtMs === 'number' && Number.isFinite(input.outputAtMs) ? { lastOutputSeenAt: input.outputAtMs } : {}),
          initialReason: decision.reason,
          lastLiveProcessNames: liveNames,
        };
        entries.set(attempt.attemptId, entry);
        boundEntries();
      } else {
        if (liveNames.length > 0) entry.lastLiveProcessNames = liveNames;
        noteActivity(entry, input);
      }

      // Case 1: Live background processes are STILL running.
      if (liveNames.length > 0) {
        const elapsed = nowMs - entry.firstObservedAt;
        let emittedNotice = false;
        if (elapsed >= timeoutMs && entry.timeoutNotifiedAt === undefined) {
          entry.resolution = 'no_results';
          await sendNotice(entry, nowMs, 'still_running');
          emittedNotice = true;
        }
        if (nowMs - entry.lastActivityAt >= inactivityReleaseMs) {
          // Idle-but-alive (no CPU growth and no output for the whole window): a
          // leftover dev server / watcher / stuck child must not pin the task.
          // Active work never reaches here, however long it runs.
          release(entry, nowMs);
          return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: emittedNotice, resolution: 'released_unfinished' };
        }
        return {
          holdTurnEnd: true,
          nudgedWorker: false,
          emittedCoordinatorNotice: emittedNotice,
          resolution: entry.resolution,
        };
      }

      // Case 2: No live background processes remain (either child exited after (a),
      // or turn ended with waiting text (b) and child had already exited).
      if (entry.nudgedAt === undefined) {
        entry.nudgedAt = nowMs;
        entry.resolution =
          entry.initialReason === 'pending_background_work_text'
            ? 'no_results'
            : 'nudged_after_exit';
        const messageId = `bg-nudge:${entry.attemptId}:g${entry.generation}`;
        await deps.nudgeWorker?.(entry.sessionId, BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE, {
          attemptId: entry.attemptId,
          generation: entry.generation,
          taskId: entry.taskId,
          reason: entry.initialReason,
          messageId,
        });
        return {
          holdTurnEnd: true,
          nudgedWorker: true,
          emittedCoordinatorNotice: false,
          resolution: entry.resolution,
        };
      }

      // If we already nudged and the worker subsequently wrote a NEW real final summary
      // (strictly after nudgedAt, not waiting text) and has no live background processes, release.
      if (
        decision.complete &&
        entry.nudgedAt !== undefined &&
        normStatus === 'idle' &&
        typeof finalAssistantAt === 'number' &&
        finalAssistantAt > entry.nudgedAt
      ) {
        const hasNewNonPendingFinal =
          typeof finalSummary === 'string' &&
          finalSummary.trim().length > 0 &&
          !isPendingBackgroundWorkSummary(finalSummary);
        if (hasNewNonPendingFinal) {
          entries.delete(attempt.attemptId);
          return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
        }
      }

      // Nudged (or notified) and still no report: the worker had its chance.
      // Tell the coordinator once and release instead of holding forever.
      if (entry.nudgedAt !== undefined && nowMs - Math.max(entry.nudgedAt, entry.lastActivityAt) >= nudgeGraceMs) {
        let emittedNotice = false;
        if (entry.timeoutNotifiedAt === undefined) {
          await sendNotice(entry, nowMs, 'no_report_after_nudge');
          emittedNotice = true;
        }
        release(entry, nowMs);
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: emittedNotice, resolution: 'released_unfinished' };
      }

      return {
        holdTurnEnd: true,
        nudgedWorker: false,
        emittedCoordinatorNotice: false,
        resolution: entry.resolution,
      };
    },

    trackedAttemptIds(): string[] {
      return [...entries.values()].filter((e) => e.releasedAt === undefined).map((e) => e.attemptId);
    },

    isReleased(attemptId: string, generation: number): boolean {
      const entry = entries.get(attemptId);
      return !!entry && entry.generation === generation && entry.releasedAt !== undefined;
    },

    getEntry(attemptId: string): TrackedBackgroundWorkEntry | undefined {
      return entries.get(attemptId);
    },

    clear(attemptId: string): void {
      entries.delete(attemptId);
    },
  };
}
