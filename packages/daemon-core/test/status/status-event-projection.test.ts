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
    createInstanceSessionMetaResolver,
    createTurnDurationTracker,
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

/**
 * REGRESSION (2026-09-26): after C-W5c moved `agent:generating_completed` /
 * `agent:stopped` onto the turn ledger, the wire event lost the session
 * identity and duration the legacy `provider_event` completion carried, so
 * webhooks fell back to the daemon kind for `providerType` and the completion
 * push lost its workspace and "Ns" wording. These pin the restored fields.
 */
describe('turn-sourced status_event — restored non-content fields', () => {
    const COMMITTED = { kind: 'turn', phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as const;

    function cliInstanceManager(overrides: Record<string, unknown> = {}) {
        const state = {
            type: 'claude-cli',
            category: 'cli',
            instanceId: 's1',
            providerSessionId: '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f',
            workspace: '/Users/someone/projects/my-app',
            status: 'idle',
            settings: {},
            activeChat: { title: 'private chat title', messages: [{ role: 'assistant', content: 'full assistant transcript' }] },
            ...overrides,
        };
        return { getInstance: (id: string) => (id === 's1' ? { getState: () => state as any } : undefined) };
    }

    it('projectTurnStatusEvent copies providerType / providerSessionId / workspaceName from the resolver, and duration on completion', () => {
        const payload = projectTurnStatusEvent(COMMITTED, 9_000, undefined, {
            resolveSessionMeta: () => ({ providerType: ' claude-cli ', providerSessionId: 'psid', workspaceName: '/w/repo' }),
            durationSec: 42,
        });
        expect(payload).toEqual({
            event: 'agent:generating_completed',
            timestamp: 9_000,
            targetSessionId: 's1',
            providerType: 'claude-cli',
            providerSessionId: 'psid',
            workspaceName: '/w/repo',
            duration: 42,
        });
    });

    it('agent:stopped never carries duration (the legacy stop never did)', () => {
        const payload = projectTurnStatusEvent({ ...COMMITTED, outcome: 'failed', strength: 'weak' }, 1, undefined, {
            resolveSessionMeta: () => ({ providerType: 'claude-cli' }),
            durationSec: 5,
        })!;
        expect(payload.event).toBe('agent:stopped');
        expect(payload.providerType).toBe('claude-cli');
        expect(payload).not.toHaveProperty('duration');
    });

    it('the resolver result is allow-listed field by field — an extra key it returns never reaches the wire', () => {
        const payload = projectTurnStatusEvent(COMMITTED, 1, undefined, {
            resolveSessionMeta: () => ({ providerType: 'claude-cli', chatTitle: 'private chat title', finalSummary: 'x' } as any),
        })!;
        expect(Object.keys(payload).sort()).toEqual(['event', 'providerType', 'targetSessionId', 'timestamp']);
    });

    it('createInstanceSessionMetaResolver reads type / providerSessionId / workspace off the live state (legacy pushEvent semantics)', () => {
        const resolve = createInstanceSessionMetaResolver(cliInstanceManager());
        expect(resolve('s1')).toEqual({
            providerType: 'claude-cli',
            providerSessionId: '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f',
            workspaceName: '/Users/someone/projects/my-app',
        });
        expect(resolve('remote-worker')).toBeUndefined();
    });

    it('an IDE extension session resolves through its parent IDE: its own type, the parent workspace', () => {
        const ide = {
            type: 'cursor', category: 'ide', instanceId: 'ide1', workspace: '/w/app', settings: {},
            extensions: [{ type: 'cline', category: 'extension', instanceId: 'ext1', providerSessionId: 'chat-9', settings: {} }],
        };
        const resolve = createInstanceSessionMetaResolver(
            { getInstance: (id: string) => (id === 'ide1' ? { getState: () => ide as any } : undefined) },
            { get: (id: string) => (id === 'ext1' ? { parentSessionId: 'ide1' } : undefined) },
        );
        expect(resolve('ext1')).toEqual({ providerType: 'cline', providerSessionId: 'chat-9', workspaceName: '/w/app' });
    });

    it('createTurnDurationTracker: whole seconds from started to committed, evicted at commit', () => {
        const t = createTurnDurationTracker();
        expect(t.observe({ ...COMMITTED, phase: 'started', at: 1_000 } as any)).toBeUndefined();
        expect(t.observe({ ...COMMITTED, phase: 'suspended', at: 5_000 } as any)).toBeUndefined();
        expect(t.observe({ ...COMMITTED, at: 43_600 })).toBe(43);
        expect(t.size).toBe(0);
        // A commit whose start was never seen (daemon restarted mid-turn) has no duration.
        expect(t.observe({ ...COMMITTED, at: 50_000 })).toBeUndefined();
    });

    it('createTurnDurationTracker is bounded and forgets a terminated session', () => {
        const t = createTurnDurationTracker(3);
        for (let i = 0; i < 10; i++) t.observe({ kind: 'turn', phase: 'started', sessionId: `s${i % 2}`, attemptId: `a${i}`, generation: 0, at: i } as any);
        expect(t.size).toBe(3);
        t.forgetSession('s1');
        expect(t.size).toBe(1);
    });

    it('createStatusEventEmitter stamps session identity + duration on the committed turn, both legs, and carries no content', () => {
        const bus = createSessionLifecycleBus();
        const dashboard: any[] = [];
        const server: any[] = [];
        createStatusEventEmitter(bus, {
            instanceManager: cliInstanceManager(),
            sendDashboard: (p) => dashboard.push(p),
            sendServer: (p) => server.push(p),
        });
        bus.emit({ kind: 'turn', at: 10_000, phase: 'started', sessionId: 's1', attemptId: 'a1', generation: 0 } as any);
        bus.emit({ kind: 'turn', at: 72_400, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(server).toHaveLength(1);
        expect(server[0]).toEqual({
            event: 'agent:generating_completed',
            timestamp: 72_400,
            targetSessionId: 's1',
            providerType: 'claude-cli',
            providerSessionId: '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f',
            workspaceName: '/Users/someone/projects/my-app',
            duration: 62,
            surfaceHidden: false,
            muted: false,
        });
        expect(dashboard[0]).toEqual(server[0]);
        const wire = JSON.stringify(server[0]);
        expect(wire).not.toContain('private chat title');
        expect(wire).not.toContain('full assistant transcript');
    });

    /**
     * REGRESSION (createInstanceHideMuteResolver): an IDE extension session is a
     * child of its IDE instance, not in the instance manager's own map. Before
     * this fix, `createInstanceHideMuteResolver` only looked sessions up in that
     * map directly, so an extension session's turn-sourced completion never
     * carried surfaceHidden/muted (silently omitted, forcing the server to fall
     * back to its snapshot join). It must resolve through the session registry's
     * `parentSessionId`, exactly as `createInstanceSessionMetaResolver` already
     * does for providerType/workspaceName, reading the flags off the
     * EXTENSION's own settings — not the parent IDE's.
     */
    it('createStatusEventEmitter stamps surfaceHidden+muted on an extension session\'s turn-sourced completion, via the parent IDE lookup', () => {
        const ide = {
            type: 'cursor',
            category: 'ide',
            instanceId: 'ide-1',
            workspace: '/w/app',
            settings: {},
            status: 'idle',
            extensions: [
                {
                    type: 'cline',
                    category: 'extension',
                    instanceId: 'ext-1',
                    providerSessionId: 'chat-9',
                    status: 'idle',
                    settings: { userHidden: true, userMuted: true },
                },
            ],
        };
        const instanceManager = { getInstance: (id: string) => (id === 'ide-1' ? { getState: () => ide as any } : undefined) };
        const sessionRegistry = { get: (id: string) => (id === 'ext-1' ? { parentSessionId: 'ide-1' } : undefined) };
        const bus = createSessionLifecycleBus();
        const server: any[] = [];
        createStatusEventEmitter(bus, {
            instanceManager,
            sessionRegistry,
            sendDashboard: () => {},
            sendServer: (p) => server.push(p),
        });
        bus.emit({ kind: 'turn', at: 10_000, phase: 'started', sessionId: 'ext-1', attemptId: 'a1', generation: 0 } as any);
        bus.emit({ kind: 'turn', at: 20_000, phase: 'committed', sessionId: 'ext-1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(server).toHaveLength(1);
        expect(server[0]).toMatchObject({
            event: 'agent:generating_completed',
            targetSessionId: 'ext-1',
            providerType: 'cline',
            surfaceHidden: true,
            muted: true,
        });
    });

    it('a terminated session drops its open turn start (no stale duration on a later commit with the same attempt id)', () => {
        const bus = createSessionLifecycleBus();
        const server: any[] = [];
        createStatusEventEmitter(bus, { instanceManager: cliInstanceManager(), sendDashboard: () => {}, sendServer: (p) => server.push(p) });
        bus.emit({ kind: 'turn', at: 0, phase: 'started', sessionId: 's1', attemptId: 'a1', generation: 0 } as any);
        bus.emit({ kind: 'terminated', sessionId: 's1', at: 1, cause: 'user', providerType: 'claude-cli', runtimeSettings: {} } as any);
        bus.emit({ kind: 'turn', at: 9_000, phase: 'committed', sessionId: 's1', attemptId: 'a1', generation: 0, outcome: 'completed', strength: 'genuine' } as any);
        expect(server[0]).not.toHaveProperty('duration');
    });
});
