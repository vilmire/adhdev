/**
 * Worker permission policy — auto-approve OFF: a coordinator-delegated worker's
 * permission request reaches the coordinator first; the owner's server push is
 * an escalation sent once, only if the SAME episode is still unresolved after
 * the coordinator-first window. Resolved/replaced episodes are retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { createStatusEventEmitter } from '../../src/status/status-event.js';
import {
    createApprovalEscalationGate,
    currentApprovalEpisodeKey,
    isCoordinatorFirstSession,
    OWNER_APPROVAL_ESCALATION_MS,
    OWNER_APPROVAL_SESSION_COOLDOWN_MS,
} from '../../src/status/approval-escalation.js';

const EP_1 = 'modal:11111111-1111-4111-8111-111111111111';
const EP_2 = 'modal:22222222-2222-4222-8222-222222222222';
const EP_RECOVERED = 'modal:33333333-3333-4333-8333-333333333333';
const workerSettings = { launchedByCoordinator: true, meshNodeFor: 'mesh-1', spawnedSessionVisibility: 'visible' };
const approval = (modalKey: string, extra: Record<string, unknown> = {}) => ({ type: 'tool_permission', lifecycle: 'pending', evidence: 'live', actionable: true, modalKey, resolvedAt: null, ...extra });

let state: any;
function world(opts: { settings?: Record<string, unknown>; activeChat?: Record<string, unknown> } = {}) {
    state = { status: 'waiting_approval', settings: opts.settings ?? workerSettings,
        activeChat: opts.activeChat ?? { status: 'waiting_approval', activeModal: { message: 'Run npm test?', buttons: ['Yes', 'No'] }, providerApproval: approval(EP_1) } };
    const bus = createSessionLifecycleBus();
    const dashboard: any[] = [];
    const server: any[] = [];
    const stop = createStatusEventEmitter(bus, {
        instanceManager: { getInstance: (id: string) => id === 'w1' ? { getState: () => state } : undefined },
        sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p),
    });
    const ask = (extra: Record<string, unknown> = {}) => bus.emit({ kind: 'provider_event', sessionId: 'w1', event: { event: 'agent:waiting_approval', targetSessionId: 'w1', providerType: 'codex-cli', modalMessage: 'Run npm test?', modalButtons: ['Yes', 'No'], modalKey: EP_1, approvalEvidence: 'live', timestamp: 1, ...extra } } as any);
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

    it('fails closed (hold() === true) when a coordinator-first session is masked to generating or has unavailable evidence', () => {
        const escalated: any[] = [];
        let currentState: any = {
            status: 'generating',
            settings: workerSettings,
            activeChat: {
                status: 'waiting_approval',
                activeModal: { message: 'Run npm test?', buttons: ['Yes', 'No'] },
                providerApproval: approval('modal:masked'),
            },
        };
        const gate = createApprovalEscalationGate({
            readState: () => currentState,
            escalate: (_id, raw) => escalated.push(raw),
        });
        expect(gate.hold({ event: 'agent:waiting_approval', targetSessionId: 'w1' })).toBe(true);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS * 2);
        expect(escalated).toHaveLength(0);

        currentState = {
            status: 'waiting_approval',
            settings: workerSettings,
            activeChat: {
                status: 'waiting_approval',
                activeModal: { message: 'Run npm test?', buttons: ['Yes', 'No'] },
                providerApproval: approval('', { evidence: 'unavailable', modalKey: null }),
            },
        };
        expect(gate.hold({ event: 'agent:waiting_approval', targetSessionId: 'w1' })).toBe(true);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS * 2);
        expect(escalated).toHaveLength(0);
        gate.dispose();
    });

    it('enforces per-session cooldown so a worker cannot escalate twice within the cooldown window', () => {
        const w = world();
        w.ask();
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(1);

        // A new approval episode 10s later (still inside the 120s cooldown) must be held during the cooldown window
        // and then escalate automatically once the cooldown expires without needing a new provider event.
        vi.advanceTimersByTime(10_000);
        state = { ...state, activeChat: { ...state.activeChat, providerApproval: approval(EP_2) } };
        w.ask({ modalKey: EP_2 });
        expect(w.server).toHaveLength(1);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(1);

        // Once the remaining cooldown window elapses from the first escalation, the held second episode escalates automatically.
        vi.advanceTimersByTime(OWNER_APPROVAL_SESSION_COOLDOWN_MS - OWNER_APPROVAL_ESCALATION_MS - 10_000);
        expect(w.server).toHaveLength(2);
        expect(w.server[1]).toMatchObject({ modalKey: EP_2, approvalEvidence: 'live' });
        w.stop();
    });

    it('rebuilds the escalated event from the current validated episode (not stale entry.raw) when evidence starts unavailable and recovers late', () => {
        const w = world({
            activeChat: {
                status: 'waiting_approval',
                activeModal: { message: 'Initial transient frame', buttons: [] },
                providerApproval: approval('', { evidence: 'unavailable', modalKey: null }),
            },
        });
        // Initial raw event had unavailable evidence, no buttons, and no valid modalKey
        w.ask({
            modalMessage: 'Initial transient frame',
            modalButtons: [],
            modalKey: undefined,
            approvalEvidence: 'unavailable',
        });
        expect(w.server).toHaveLength(0);

        // Settles to live evidence 500ms later with no second provider_event
        vi.advanceTimersByTime(500);
        state = {
            ...state,
            activeChat: {
                status: 'waiting_approval',
                activeModal: { message: 'Run npm test?\n$ npm test', buttons: ['1. Yes, proceed', '2. No'] },
                providerApproval: approval(EP_RECOVERED, { evidence: 'live' }),
            },
        };
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(w.server).toHaveLength(1);
        // The escalated server payload carries the recovered live UUID modalKey, evidence, and buttons
        expect(w.server[0]).toMatchObject({
            event: 'agent:waiting_approval',
            targetSessionId: 'w1',
            modalKey: EP_RECOVERED,
            approvalEvidence: 'live',
            modalButtons: ['1. Yes, proceed', '2. No'],
        });
        expect(w.server[0].modalMessage).toContain('$ npm test');
        w.stop();
    });

    it('marks an episode as escalated ONLY after a successful delivery attempt and retries on transient failure', () => {
        const currentState: any = {
            status: 'waiting_approval',
            settings: workerSettings,
            activeChat: {
                status: 'waiting_approval',
                activeModal: { message: 'Run npm test?', buttons: ['Yes', 'No'] },
                providerApproval: approval(EP_1),
            },
        };
        let attempts = 0;
        const delivered: any[] = [];
        const gate = createApprovalEscalationGate({
            readState: () => currentState,
            escalate: (_id, raw) => {
                attempts += 1;
                if (attempts === 1) return false;
                delivered.push(raw);
                return true;
            },
        });
        expect(gate.hold({ event: 'agent:waiting_approval', targetSessionId: 'w1' })).toBe(true);
        vi.advanceTimersByTime(OWNER_APPROVAL_ESCALATION_MS);
        expect(attempts).toBe(1);
        expect(delivered).toHaveLength(0);

        // Retries after ESCALATION_RECHECK_MS (5s) because attempt 1 returned false
        vi.advanceTimersByTime(5_000);
        expect(attempts).toBe(2);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ modalKey: EP_1, approvalEvidence: 'live' });
        gate.dispose();
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
