/**
 * status/status-event.ts — the ONE status_event projection both hosts use
 * (wiring-unification B5). CLAUDE.md "Server content boundary": the server copy
 * is an ALLOW-LIST (approval-modal text is the only agent-authored text, the
 * push-actionability exception); the dashboard copy adds only the structured
 * AskUserQuestion fields; `provider:*` events are dropped whole.
 */
import { describe, expect, it } from 'vitest';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import {
    createStatusEventEmitter,
    projectP2PStatusEvent,
    projectServerStatusEvent,
    projectTurnStatusEvent,
} from '../../src/status/status-event.js';

const RAW = {
    event: 'agent:waiting_approval',
    timestamp: 42,
    targetSessionId: ' s1 ',
    providerType: 'claude-cli',
    providerSessionId: 'psid',
    workspaceName: 'repo',
    duration: 3,
    elapsedSec: 4,
    modalMessage: 'rm -rf build/',
    modalButtons: ['Yes', '', 7, 'No'],
    interactivePrompt: { promptId: 'p1', questions: [{ question: 'secret question text' }] },
    promptId: 'p1',
    multiSelect: true,
    // Content that must never reach the server (or the dashboard event):
    finalSummary: 'full assistant transcript',
    chatTitle: 'private chat title',
    messages: [{ role: 'user', content: 'hi' }],
    lastAgentMessage: 'agent text',
};

describe('projectServerStatusEvent (allow-list)', () => {
    it('keeps exactly the allow-listed fields, trimmed and type-checked', () => {
        const server = projectServerStatusEvent(RAW, () => ({ surfaceHidden: true, muted: false }));
        expect(server).toEqual({
            event: 'agent:waiting_approval',
            timestamp: 42,
            targetSessionId: 's1',
            providerType: 'claude-cli',
            providerSessionId: 'psid',
            workspaceName: 'repo',
            duration: 3,
            elapsedSec: 4,
            modalMessage: 'rm -rf build/',
            modalButtons: ['Yes', 'No'],
            surfaceHidden: true,
            muted: false,
        });
    });

    it('drops provider:* effects and unknown event names', () => {
        expect(projectServerStatusEvent({ event: 'provider:toast', message: 'x' })).toBeNull();
        expect(projectServerStatusEvent({ event: 'agent:ready' })).toBeNull();
        expect(projectServerStatusEvent({})).toBeNull();
    });
});

describe('projectP2PStatusEvent', () => {
    it('adds only the structured prompt fields to the server copy', () => {
        const server = projectServerStatusEvent(RAW)!;
        const dashboard = projectP2PStatusEvent(RAW, server);
        const { interactivePrompt, promptId, multiSelect, ...rest } = dashboard as any;
        expect(rest).toEqual(server);
        expect(interactivePrompt).toEqual(RAW.interactivePrompt);
        expect(promptId).toBe('p1');
        expect(multiSelect).toBe(true);
    });
});

describe('projectTurnStatusEvent (wiring-unification C1/C5)', () => {
    it('projects a committed genuine turn to agent:generating_completed, allow-listed, content-free', () => {
        const payload = projectTurnStatusEvent(
            { kind: 'turn', phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 2, outcome: 'completed', strength: 'genuine' },
            123,
            () => ({ surfaceHidden: false, muted: true }),
        );
        expect(payload).toEqual({
            event: 'agent:generating_completed',
            timestamp: 123,
            targetSessionId: 's1',
            surfaceHidden: false,
            muted: true,
        });
    });

    it('projects a committed failed/cancelled turn to agent:stopped', () => {
        const failed = projectTurnStatusEvent(
            { kind: 'turn', phase: 'committed', sessionId: 's2', attemptId: 'a2', generation: 0, outcome: 'failed', strength: 'weak' },
            10,
        );
        expect(failed?.event).toBe('agent:stopped');
        const cancelled = projectTurnStatusEvent(
            { kind: 'turn', phase: 'committed', sessionId: 's3', attemptId: 'a3', generation: 0, outcome: 'cancelled', strength: 'weak' },
            10,
        );
        expect(cancelled?.event).toBe('agent:stopped');
    });

    it('returns null for every non-committed phase — those travel as their own bus kinds, not status_event', () => {
        for (const phase of ['started', 'suspended', 'resumed', 'progress'] as const) {
            expect(projectTurnStatusEvent({ kind: 'turn', phase, sessionId: 's1', attemptId: 'a1', generation: 0 }, 1)).toBeNull();
        }
    });

    it('carries no agent-authored text: only event/timestamp/targetSessionId/surfaceHidden/muted', () => {
        const payload = projectTurnStatusEvent(
            { kind: 'turn', phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' },
            1,
        )!;
        expect(Object.keys(payload).sort()).toEqual(['event', 'targetSessionId', 'timestamp']);
    });
});

describe('createStatusEventEmitter — turn bus subscription', () => {
    it('projects a committed turn bus event to both dashboard and server legs', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const server: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p) });
        bus.emit({ kind: 'turn', at: 55, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 1, outcome: 'completed', strength: 'genuine' } as any);
        expect(dashboard).toHaveLength(1);
        expect(server).toHaveLength(1);
        expect(dashboard[0]).toEqual({ event: 'agent:generating_completed', timestamp: 55, targetSessionId: 's1' });
        expect(server[0]).toEqual(dashboard[0]);
    });

    it('a non-committed turn phase (started/suspended/resumed/progress) sends nothing', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p) });
        bus.emit({ kind: 'turn', at: 1, phase: 'started', sessionId: 's1', attemptId: 'a1', generation: 0 } as any);
        expect(dashboard).toHaveLength(0);
    });

    it('★no double push: a producer that still puts the legacy name on provider_event (mesh-event-forwarding / quota refresh consumers) never causes a SECOND status_event for the same turn — projectServerStatusEvent drops it, the turn leg is the only source', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const server: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p) });
        // The legacy provider event and the ledger commit of the SAME turn.
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:generating_completed', targetSessionId: 's1' } as any });
        bus.emit({ kind: 'turn', at: 1, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(dashboard).toHaveLength(1);
        expect(server).toHaveLength(1);
    });

    it('turnCommits: false opts back into the pre-C-W5 behaviour (test-only escape hatch)', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p), turnCommits: false });
        bus.emit({ kind: 'turn', at: 1, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(dashboard).toHaveLength(0);
    });

    it('unsubscribe stops BOTH the provider_event and the turn subscriptions', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const off = createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p) });
        off();
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:waiting_approval' } as any });
        bus.emit({ kind: 'turn', at: 0, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(dashboard).toHaveLength(0);
    });
});

describe('createStatusEventEmitter', () => {
    it('sends the dashboard copy and the server copy per provider_event; the server copy never carries the prompt', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const server: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p) });
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: RAW as any });
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'provider:toast' } as any });
        expect(dashboard).toHaveLength(1);
        expect(server).toHaveLength(1);
        expect(dashboard[0].interactivePrompt).toBeDefined();
        expect(server[0]).not.toHaveProperty('interactivePrompt');
        expect(server[0]).not.toHaveProperty('promptId');
        for (const copy of [dashboard[0], server[0]]) {
            expect(copy).not.toHaveProperty('finalSummary');
            expect(copy).not.toHaveProperty('chatTitle');
            expect(copy).not.toHaveProperty('messages');
            expect(copy).not.toHaveProperty('lastAgentMessage');
        }
    });

    it('a failing dashboard leg never swallows the server leg, and unsubscribe stops delivery', () => {
        const bus = createSessionLifecycleBus();
        const server: any[] = [];
        const off = createStatusEventEmitter(bus, {
            sendDashboard: () => { throw new Error('peer gone'); },
            sendServer: (p) => server.push(p),
        });
        // agent:generating_completed/agent:stopped are turn-sourced only (see the
        // describe block above) — use a name that legitimately still travels on
        // provider_event to exercise this leg.
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:waiting_approval' } as any });
        expect(server).toHaveLength(1);
        off();
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:waiting_approval' } as any });
        expect(server).toHaveLength(1);
    });

    it('agent:generating_completed / agent:stopped on provider_event are dropped — turn-sourced only', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const server: any[] = [];
        createStatusEventEmitter(bus, { sendDashboard: (p) => dashboard.push(p), sendServer: (p) => server.push(p) });
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:generating_completed', targetSessionId: 's1' } as any });
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:stopped', targetSessionId: 's1' } as any });
        expect(dashboard).toHaveLength(0);
        expect(server).toHaveLength(0);
    });
});
