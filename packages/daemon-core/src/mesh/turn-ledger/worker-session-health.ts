import type { TurnAttempt } from './types.js';
import type { TurnProbeRead } from './probe.js';
import { turnStartBoundary } from './probe.js';
import { notifyMeshCoordinator } from './deliver.js';

// Two complete generating/idle cycles in five minutes, spanning at least 30s:
// one idle edge or a quick repaint burst is not enough to page a coordinator.
// Idle pulses shorter than 5s are excluded when their resume edge arrives.
export const WORKER_FLAP_WINDOW_MS = 5 * 60_000;
export const WORKER_FLAP_MIN_SPAN_MS = 30_000;
export const WORKER_FLAP_TRANSITIONS = 4;
export const WORKER_FLAP_MIN_IDLE_MS = 5_000;
// Matches the watchdog's idle floor; generating watchdogs already require 360s.
export const WORKER_NO_PROGRESS_MIN_MS = 180_000;
export type WorkerSessionHealthSignal = 'stalled' | 'deteriorating' | 'flapping';
export type WorkerSessionHealthOwner = Pick<TurnAttempt, 'meshId' | 'taskId' | 'nodeId' | 'attemptId' | 'generation' | 'sessionId' | 'coordinator'>;
export interface WorkerSessionTransition { from: string; to: string; at: number }
export interface WorkerSessionHealthEvent {
    signal: WorkerSessionHealthSignal;
    attemptId: string;
    generation: number;
    sessionId: string;
    taskId?: string;
    nodeId?: string;
    at: number;
    quietMs: number;
    readFailureStreak: number;
    transitions: number;
    transitionHistory: WorkerSessionTransition[];
    source: 'probe' | 'status' | 'monitor:no_progress';
}

/** Advisory session signals; never change node health, task ownership or retry policy. */
export function createWorkerSessionHealthMonitor(
    emit: (owner: WorkerSessionHealthOwner, event: WorkerSessionHealthEvent) => void = notifyWorkerSessionHealth,
) {
    type State = { status: string; statusAt?: number; lastAt: number; edges: WorkerSessionTransition[]; failures: number; lastStallAt?: number; active: Set<WorkerSessionHealthSignal> };
    const states = new Map<string, State>();
    function stateFor(owner: WorkerSessionHealthOwner): State {
        const key = JSON.stringify([owner.meshId, owner.taskId, owner.sessionId, owner.attemptId, owner.generation]);
        let state = states.get(key);
        if (!state) {
            state = { status: '', lastAt: 0, edges: [], failures: 0, active: new Set() };
            states.set(key, state);
            if (states.size > 500) states.delete(states.keys().next().value!);
        }
        return state;
    }
    function statusEdge(state: State, status: string, at: number): boolean {
        if (!Number.isFinite(at) || at < state.lastAt) return false;
        state.edges = state.edges.filter((edge) => at - edge.at < WORKER_FLAP_WINDOW_MS);
        if (state.status === 'idle' && status === 'generating' && state.statusAt !== undefined && at - state.statusAt < WORKER_FLAP_MIN_IDLE_MS) {
            // A short idle and its resume are one normal pulse, not two flap
            // edges. Remove the provisional idle edge if we observed it.
            if (state.edges[state.edges.length - 1]?.at === state.statusAt) state.edges.pop();
        } else if ((state.status === 'generating' && status === 'idle') || (state.status === 'idle' && status === 'generating')) {
            state.edges.push({ from: state.status, to: status, at });
            state.edges = state.edges.slice(-64);
        } else if (status !== state.status && !['idle', 'generating'].includes(status)) {
            // Human waits / unknown presence are not generating-idle oscillation.
            state.edges = [];
        }
        if (state.status !== status) state.statusAt = at;
        state.status = status;
        state.lastAt = at;
        return true;
    }
    function publish(owner: WorkerSessionHealthOwner, state: State, signals: Set<WorkerSessionHealthSignal>, at: number, quietMs: number, source: WorkerSessionHealthEvent['source']): void {
        if (state.edges.length >= WORKER_FLAP_TRANSITIONS
            && state.edges[state.edges.length - 1].at - state.edges[0].at >= WORKER_FLAP_MIN_SPAN_MS) signals.add('flapping');
        for (const signal of signals) {
            if (!state.active.has(signal)) emit(owner, {
                signal, attemptId: owner.attemptId, generation: owner.generation, sessionId: owner.sessionId,
                ...(owner.taskId ? { taskId: owner.taskId } : {}), ...(owner.nodeId ? { nodeId: owner.nodeId } : {}),
                at, quietMs, readFailureStreak: state.failures, transitions: state.edges.length,
                transitionHistory: state.edges.map((edge) => ({ ...edge })), source,
            });
        }
        state.active = signals;
    }
    return {
        transition(owner: WorkerSessionHealthOwner, prev: string, next: string, at: number): void {
            if (!owner.meshId || !owner.taskId || prev === next) return;
            const state = stateFor(owner);
            if (!state.status) { state.status = prev; state.statusAt = at; }
            if (!statusEdge(state, next, at)) return;
            // A status change alone is not proof of renewed output/progress.
            const signals = new Set(state.active);
            signals.delete('flapping');
            publish(owner, state, signals, at, 0, 'status');
        },
        noProgress(owner: WorkerSessionHealthOwner, stalledMs: number, status: string, at: number): void {
            if (!owner.meshId || !owner.taskId || !Number.isFinite(stalledMs) || stalledMs < WORKER_NO_PROGRESS_MIN_MS
                || ['waiting_approval', 'waiting_choice'].includes(status)) return;
            const state = stateFor(owner);
            if (at < state.lastAt || !Number.isFinite(at)) return;
            state.edges = state.edges.filter((edge) => at - edge.at < WORKER_FLAP_WINDOW_MS);
            // The watchdog is output-based. Its observed status is context, not
            // an FSM transition, and must not manufacture generating/idle edges.
            const signals = new Set(state.active);
            // A later output anchor after the last alert proves the worker made
            // progress and then stalled again; ordinary refires stay deduped.
            if (state.lastStallAt !== undefined && at - stalledMs > state.lastStallAt) state.active.delete('stalled');
            if (!state.active.has('stalled')) state.lastStallAt = at;
            state.lastAt = at;
            signals.add('stalled');
            publish(owner, state, signals, at, stalledMs, 'monitor:no_progress');
        },
        observe(attempt: TurnAttempt, read: TurnProbeRead, now: number, stallMs: number): void {
            if (!attempt.meshId || attempt.scope === 'plain' || attempt.terminal) return;
            const state = stateFor(attempt);
            const status = read.presence === 'present'
                ? read.transcript === null ? 'read_failed' : (read.transcript?.providerObservedStatus || read.status || 'present').toLowerCase()
                : read.presence;
            if (!statusEdge(state, status, now)) return;
            state.failures = read.presence === 'present' && read.transcript === null ? state.failures + 1 : 0;
            const quietMs = Math.max(0, now - Math.max(turnStartBoundary(attempt), attempt.lastActivityAt ?? 0, read.transcript?.newestActivityAt ?? 0));
            const signals = new Set<WorkerSessionHealthSignal>();
            if (state.failures >= 2) signals.add('deteriorating');
            if (read.presence === 'present' && read.transcript !== null && !read.transcript?.activeModal
                && !['waiting_approval', 'waiting_choice', 'starting'].includes(status)
                && !read.transcript?.finalSummary && quietMs >= stallMs) signals.add('stalled');
            publish(attempt, state, signals, now, quietMs, 'probe');
        },
    };
}

export type WorkerSessionHealthMonitor = ReturnType<typeof createWorkerSessionHealthMonitor>;
// One daemon-owned instance shared by raw events and scheduler samples.
const monitors = new WeakMap<object, WorkerSessionHealthMonitor>();
export function workerSessionHealthFor(components: object): WorkerSessionHealthMonitor {
    let monitor = monitors.get(components);
    if (!monitor) { monitor = createWorkerSessionHealthMonitor(); monitors.set(components, monitor); }
    return monitor;
}

function notifyWorkerSessionHealth(owner: WorkerSessionHealthOwner, event: WorkerSessionHealthEvent): void {
    const trail = event.transitionHistory.map((edge) => `${edge.from}→${edge.to}@${new Date(edge.at).toISOString()}`).join(', ');
    const coordinatorMessage = `[System] Worker session ${event.sessionId} on node ${owner.nodeId || 'unknown'} is ${event.signal} while holding task ${owner.taskId || owner.attemptId} at ${new Date(event.at).toISOString()}. `
        + (event.signal === 'stalled' ? `No observed progress for ${Math.round(event.quietMs / 1000)}s. ` : '')
        + `Consecutive transcript read failures: ${event.readFailureStreak}; generating/idle transitions in 5m: ${event.transitions}. `
        + (trail ? `Observed transitions: ${trail}. ` : '')
        + 'This is an advisory session signal; inspect the worker transcript and task history. It does not establish a failure or its cause.';
    notifyMeshCoordinator({
        event: 'mesh:dispatch_blocked', meshId: owner.meshId!, nodeLabel: owner.nodeId || event.sessionId,
        ...(owner.nodeId ? { nodeId: owner.nodeId } : {}),
        eventId: `worker_session_health:${owner.meshId}:${owner.taskId}:${event.sessionId}:${event.attemptId}:g${event.generation}:${event.signal}:${event.at}`,
        metadataEvent: { ...event, source: 'worker_session_health', observationSource: event.source, coordinatorMessage },
        coordinatorMessage, queuedAt: event.at,
        ...(owner.coordinator?.daemonId ? { targetCoordinatorDaemonId: owner.coordinator.daemonId } : {}),
        ...(owner.coordinator?.sessionId ? { targetCoordinatorSessionId: owner.coordinator.sessionId } : {}),
    });
}
