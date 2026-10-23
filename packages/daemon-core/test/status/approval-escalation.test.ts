/**
 * Worker permission policy — auto-approve OFF: a coordinator-delegated worker's
 * permission request reaches the coordinator first; the owner's server push is
 * an escalation sent once, only if the SAME episode is still unresolved after
 * the coordinator-first window. Resolved/replaced episodes are retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { createStatusEventEmitter } from '../../src/status/status-event.js';
import { currentApprovalEpisodeKey, isCoordinatorFirstSession, OWNER_APPROVAL_ESCALATION_MS } from '../../src/status/approval-escalation.js';

const workerSettings = { launchedByCoordinator: true, meshNodeFor: 'mesh-1', spawnedSessionVisibility: 'visible' };
const approval = (modalKey: string, extra: Record<string, unknown> = {}) => ({ type: 'tool_permission', lifecycle: 'pending', evidence: 'live', actionable: true, modalKey, resolvedAt: null, ...extra });

let state: any;
function world(opts: { settings?: Record<string, unknown> } = {}) {
    state = { status: 'waiting_approval', settings: opts.settings ?? workerSettings,
        activeChat: { status: 'waiting_approval', activeModal: { message: 'Run npm test?', buttons: ['Yes', 'No'] }, providerApproval: approval('modal:1') } };
    const bus = createSessionLifecycleBus();
    const dashboard: any[] = [];
    const server: any[] = [];
    const stop = createStatusEventEmitter(bus, {
        instanceManager: { getInstance: (id: string) => id === 'w1' ? { getState: () => state } : undefined },
        sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p),
    });
    const ask = () => bus.emit({ kind: 'provider_event', sessionId: 'w1', event: { event: 'agent:waiting_approval', targetSessionId: 'w1', providerType: 'codex-cli', modalMessage: 'Run npm test?', modalButtons: ['Yes', 'No'], timestamp: 1 } } as any);
    return { bus, dashboard, server, stop, ask };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('coordinator-first owner escalation', () => {
    it('holds the owner push but keeps the dashboard leg real time', () => {
        const w = world(); w.ask();
        expect(w.dashboard).toHaveLength(1);
        expect(w.server).toHaveLength(0);
        w.stop();
    });

    it('escalates exactly once when the same episode is still unresolved after the window', () => {
        const w = world(); w.ask();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS - 1);
        expect(w.server).toHaveLength(0);
        w.ask(); // repaint/stall nudge of the same episode must not restart or duplicate
        vi.advanceTimersByTime(1);
        expect(w.server).toHaveLength(1);
        expect(w.server[0]).toMatchObject({ event: 'agent:waiting_approval', targetSessionId: 'w1', modalMessage: 'Run npm test?' });
        w.ask();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS * 2);
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('retires the held push when the coordinator resolved the episode', () => {
        const w = world(); w.ask();
        state = { ...state, status: 'generating', activeChat: { ...state.activeChat, status: 'generating', providerApproval: approval('modal:1', { lifecycle: 'resolved', resolvedAt: 5 }) } };
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(0);
        w.stop();
    });

    it('a replaced episode keeps the original deadline instead of restarting the window', () => {
        const w = world(); w.ask();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS / 2);
        state = { ...state, activeChat: { ...state.activeChat, providerApproval: approval('modal:2') } };
        w.ask();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS / 2 - 1);
        expect(w.server).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('a modal that keeps minting new episode keys still reaches the owner once, on time', () => {
        const w = world(); w.ask();
        for (let i = 2; i <= 12; i++) {
            vi.advanceTimersByTime(5_000);
            state = { ...state, activeChat: { ...state.activeChat, providerApproval: approval(`modal:${i}`) } };
            w.ask();
        }
        vi.advanceTimersByTime(5_000);
        expect(w.server).toHaveLength(1);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS * 2);
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('re-checks a momentarily unreadable episode instead of dropping the escalation', () => {
        const w = world(); w.ask();
        const live = state;
        state = { ...state, activeChat: { ...state.activeChat, providerApproval: approval('modal:1', { evidence: 'unavailable' }) } };
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(0);
        state = live;
        vi.advanceTimersByTime(5_000);
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('drops the held push when the session terminates', () => {
        const w = world(); w.ask();
        w.bus.emit({ kind: 'terminated', sessionId: 'w1' } as any);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(0);
        w.stop();
    });

    it('keeps the hide/mute stamp on the escalated push (muted workers stay silent at the server gate)', () => {
        const w = world({ settings: { launchedByCoordinator: true, meshNodeFor: 'mesh-1', spawnedSessionVisibility: 'hidden' } });
        w.ask(); vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(1);
        expect(w.server[0]).toMatchObject({ surfaceHidden: true, muted: true });
        w.stop();
    });

    it('sends a non-delegated session immediately, as before', () => {
        const w = world({ settings: {} }); w.ask();
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('holds and deduplicates status_only waiting_external (signing_in) on a delegated worker so it never triggers an owner push storm', () => {
        const w = world();
        // signing_in (waiting_external) projects to status: 'waiting_approval', activeModal: null, providerApproval: undefined
        state = {
            status: 'waiting_approval',
            settings: workerSettings,
            activeChat: { status: 'waiting_approval', activeModal: null, providerApproval: undefined },
        };
        const askExternal = () => w.bus.emit({
            kind: 'provider_event',
            sessionId: 'w1',
            event: { event: 'agent:waiting_approval', targetSessionId: 'w1', providerType: 'claude-cli', timestamp: 1 },
        } as any);

        askExternal();
        expect(w.dashboard).toHaveLength(1);
        // Must hold during the coordinator-first window instead of failing open
        expect(w.server).toHaveLength(0);

        // Repeated waiting_approval emissions (e.g. stall nudge or re-entry) must not bypass the hold or storm the owner
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS / 2);
        askExternal();
        expect(w.server).toHaveLength(0);

        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS / 2);
        expect(w.server).toHaveLength(1);

        // Subsequent emissions for the same status_only episode are dropped
        askExternal();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS * 2);
        expect(w.server).toHaveLength(1);
        w.stop();
    });

    it('escalates a later modal-less wait again after the session resolves to idle (wait → push at 60 s → idle → new modal-less wait pushes again at 60 s)', () => {
        const w = world();
        state = {
            status: 'waiting_approval',
            settings: workerSettings,
            activeChat: { status: 'waiting_approval', activeModal: null, providerApproval: undefined },
        };
        const askExternal = (ts = 1) => w.bus.emit({
            kind: 'provider_event',
            sessionId: 'w1',
            event: { event: 'agent:waiting_approval', targetSessionId: 'w1', providerType: 'claude-cli', timestamp: ts },
        } as any);

        // 1. First modal-less wait -> pushes at 60s
        askExternal(1);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(1);

        // 2. Session resolves to idle
        state = {
            status: 'idle',
            settings: workerSettings,
            activeChat: { status: 'idle', activeModal: null, providerApproval: undefined },
        };
        vi.advanceTimersByTime(1_000);

        // 3. New modal-less wait -> must hold for 60s and then push again at 60s
        state = {
            status: 'waiting_approval',
            settings: workerSettings,
            activeChat: { status: 'waiting_approval', activeModal: null, providerApproval: undefined },
        };
        askExternal(2);
        expect(w.server).toHaveLength(1);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS - 1);
        expect(w.server).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(w.server).toHaveLength(2);
        w.stop();
    });
});

describe('episode identity helpers', () => {
    it('identifies only live, pending, unresolved episodes', () => {
        expect(currentApprovalEpisodeKey({ status: 'waiting_approval', activeChat: { providerApproval: approval('modal:x') } })).toBe('modal:modal:x');
        expect(currentApprovalEpisodeKey({ status: 'waiting_approval', activeChat: { providerApproval: approval('modal:x', { evidence: 'cached' }) } })).toBeNull();
        expect(currentApprovalEpisodeKey({ status: 'generating', activeChat: { providerApproval: approval('modal:x') } })).toBeNull();
        expect(isCoordinatorFirstSession({ launchedByCoordinator: true, meshNodeFor: 'm' })).toBe(true);
        expect(isCoordinatorFirstSession({ meshNodeFor: 'm' })).toBe(false);
    });
});
