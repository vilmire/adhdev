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
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:generating_completed' } as any });
        expect(server).toHaveLength(1);
        off();
        bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:generating_completed' } as any });
        expect(server).toHaveLength(1);
    });
});
