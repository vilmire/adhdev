import type { TurnAttempt } from './types.js';
import type { TurnProbeRead } from './probe.js';
import { turnStartBoundary } from './probe.js';
import { notifyMeshCoordinator } from './deliver.js';

export type WorkerSessionHealthSignal = 'stalled' | 'deteriorating' | 'flapping';
export interface WorkerSessionHealthEvent {
    signal: WorkerSessionHealthSignal;
    attemptId: string;
    generation: number;
    sessionId: string;
    at: number;
    quietMs: number;
    readFailureStreak: number;
    transitions: number;
}

/** Advisory session signals; never change node health, task ownership or retry policy. */
export function createWorkerSessionHealthMonitor(
    emit: (attempt: TurnAttempt, event: WorkerSessionHealthEvent) => void = notifyWorkerSessionHealth,
) {
    const states = new Map<string, { generation: number; sessionId: string; status: string; edges: number[]; failures: number; active: Set<WorkerSessionHealthSignal> }>();
    return {
        observe(attempt: TurnAttempt, read: TurnProbeRead, now: number, stallMs: number): void {
            if (!attempt.meshId || attempt.scope === 'plain' || attempt.terminal) return;
            let state = states.get(attempt.attemptId);
            if (!state || state.generation !== attempt.generation || state.sessionId !== attempt.sessionId) {
                state = { generation: attempt.generation, sessionId: attempt.sessionId, status: '', edges: [], failures: 0, active: new Set() };
                states.set(attempt.attemptId, state);
                // Bound memory independently of terminal pruning / attempt churn.
                if (states.size > 500) states.delete(states.keys().next().value!);
            }
            const status = read.presence === 'present'
                ? read.transcript === null ? 'read_failed' : (read.transcript?.providerObservedStatus || read.status || 'present').toLowerCase()
                : read.presence;
            state.edges = state.edges.filter((at) => now - at < 5 * 60_000);
            if (state.status && state.status !== status) state.edges.push(now);
            state.status = status;
            state.failures = read.presence === 'present' && read.transcript === null ? state.failures + 1 : 0;
            const quietMs = Math.max(0, now - Math.max(turnStartBoundary(attempt), attempt.lastActivityAt ?? 0, read.transcript?.newestActivityAt ?? 0));
            const signals = new Set<WorkerSessionHealthSignal>();
            if (state.failures >= 2) signals.add('deteriorating');
            if (state.edges.length >= 4) signals.add('flapping');
            // Busy probes can carry status alone; ledger activity still supplies
            // the progress clock. Failed reads and human waits do not diagnose stalls.
            if (read.presence === 'present' && read.transcript !== null && !read.transcript?.activeModal
                && !['waiting_approval', 'waiting_choice', 'starting'].includes(status)
                && !read.transcript?.finalSummary && quietMs >= stallMs) signals.add('stalled');
            for (const signal of signals) {
                if (!state.active.has(signal)) emit(attempt, {
                    signal, attemptId: attempt.attemptId, generation: attempt.generation,
                    sessionId: attempt.sessionId, at: now, quietMs,
                    readFailureStreak: state.failures, transitions: state.edges.length,
                });
            }
            state.active = signals;
        },
    };
}

function notifyWorkerSessionHealth(attempt: TurnAttempt, event: WorkerSessionHealthEvent): void {
    const coordinatorMessage = `[System] Worker session ${event.sessionId} is ${event.signal} while holding task ${attempt.taskId || attempt.attemptId}. `
        + `No observed progress for ${Math.round(event.quietMs / 1000)}s; consecutive transcript read failures: ${event.readFailureStreak}; status transitions in 5m: ${event.transitions}. `
        + 'This is an advisory session signal; inspect the worker transcript and task history.';
    notifyMeshCoordinator({
        event: 'mesh:dispatch_blocked', meshId: attempt.meshId!, nodeLabel: attempt.nodeId || event.sessionId,
        ...(attempt.nodeId ? { nodeId: attempt.nodeId } : {}),
        eventId: `worker_session_health:${event.attemptId}:g${event.generation}:${event.signal}:${event.at}`,
        metadataEvent: { source: 'worker_session_health', taskId: attempt.taskId, ...event, coordinatorMessage },
        coordinatorMessage, queuedAt: event.at,
        ...(attempt.coordinator?.daemonId ? { targetCoordinatorDaemonId: attempt.coordinator.daemonId } : {}),
        ...(attempt.coordinator?.sessionId ? { targetCoordinatorSessionId: attempt.coordinator.sessionId } : {}),
    });
}
