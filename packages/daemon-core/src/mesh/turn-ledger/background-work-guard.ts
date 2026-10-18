import {
  isPendingBackgroundWorkSummary,
  sanitizeProcessCommandName,
} from '../../process/session-process-tree.js';
import { notifyMeshCoordinator } from './deliver.js';
import { isTerminalTurnState, type TurnAttempt } from './types.js';

export const DEFAULT_BACKGROUND_WORK_TIMEOUT_MS = 120_000;

export const BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE =
  '[System] Your background command finished; report results with report_completion.';

export type IncompleteTurnEndReason =
  | 'live_background_processes'
  | 'pending_background_work_text';

export interface TurnEndBackgroundWorkDecisionInput {
  readonly attempt: Pick<TurnAttempt, 'scope' | 'generation' | 'data'>;
  readonly finalSummary?: string | null;
  readonly liveBackgroundProcesses?: readonly string[] | null;
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
  if (attempt.scope === 'plain') {
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
}): string {
  const taskLabel = params.taskId ?? 'unassigned';
  const procs =
    params.liveProcessNames.length > 0
      ? params.liveProcessNames.map((name) => sanitizeProcessCommandName(name)).join(', ')
      : 'none';
  return `[System] Worker session ${params.sessionId} (task ${taskLabel}) ended turn with background work running, no results (processes: ${procs}).`;
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
  resolution?: 'nudged_after_exit' | 'no_results';
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
}

export interface BackgroundWorkObserveResult {
  readonly holdTurnEnd: boolean;
  readonly nudgedWorker: boolean;
  readonly emittedCoordinatorNotice: boolean;
  readonly resolution?: 'nudged_after_exit' | 'no_results';
}

export interface BackgroundWorkMonitor {
  observe(input: BackgroundWorkObserveInput): Promise<BackgroundWorkObserveResult>;
  trackedAttemptIds(): string[];
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
  const notifyCoordinator = deps.notifyCoordinator ?? defaultNotifyCoordinator;
  const entries = new Map<string, TrackedBackgroundWorkEntry>();

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

      const decision = evaluateTurnEndBackgroundWork({
        attempt,
        finalSummary,
        liveBackgroundProcesses,
      });

      const currentEntry = entries.get(attempt.attemptId);
      const normStatus = (status ?? '').trim().toLowerCase();
      const isTurnEndedIdle = normStatus === 'idle' || normStatus === '';

      if (decision.complete && !currentEntry) {
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      if (!isTurnEndedIdle && !currentEntry) {
        return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
      }

      const liveNames = !decision.complete ? decision.liveProcessNames : [];
      let entry = currentEntry;
      if (!entry) {
        if (decision.complete) {
          return { holdTurnEnd: false, nudgedWorker: false, emittedCoordinatorNotice: false };
        }
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
          firstObservedAt: nowMs,
          initialReason: decision.reason,
          lastLiveProcessNames: liveNames,
        };
        entries.set(attempt.attemptId, entry);
      } else if (liveNames.length > 0) {
        entry.lastLiveProcessNames = liveNames;
      }

      // Case 1: Live background processes are STILL running.
      if (liveNames.length > 0) {
        const elapsed = nowMs - entry.firstObservedAt;
        if (elapsed >= timeoutMs && entry.timeoutNotifiedAt === undefined) {
          entry.timeoutNotifiedAt = nowMs;
          entry.resolution = 'no_results';
          const notice = formatBackgroundWorkTimeoutNotice({
            sessionId: entry.sessionId,
            taskId: entry.taskId,
            liveProcessNames: entry.lastLiveProcessNames,
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
          return {
            holdTurnEnd: true,
            nudgedWorker: false,
            emittedCoordinatorNotice: true,
            resolution: entry.resolution,
          };
        }
        return {
          holdTurnEnd: true,
          nudgedWorker: false,
          emittedCoordinatorNotice: false,
          resolution: entry.resolution,
        };
      }

      // Case 2: No live background processes remain (either child exited after (a),
      // or turn ended with waiting text (b) and child had already exited).
      if (entry.nudgedAt === undefined && entry.timeoutNotifiedAt === undefined) {
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

      return {
        holdTurnEnd: true,
        nudgedWorker: false,
        emittedCoordinatorNotice: false,
        resolution: entry.resolution,
      };
    },

    trackedAttemptIds(): string[] {
      return [...entries.keys()];
    },

    getEntry(attemptId: string): TrackedBackgroundWorkEntry | undefined {
      return entries.get(attemptId);
    },

    clear(attemptId: string): void {
      entries.delete(attemptId);
    },
  };
}
