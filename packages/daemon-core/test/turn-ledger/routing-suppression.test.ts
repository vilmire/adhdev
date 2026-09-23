import { describe, expect, it } from 'vitest';
import { routeNotice, type CoordinatorSessionView } from '../../src/mesh/turn-ledger/routing.js';
import { evaluateNotifySuppression } from '../../src/mesh/turn-ledger/suppression.js';

// turn-ledger/routing + suppression — the pure halves of the turn.deliver
// consumer (C2): which local coordinator takes a notice now, which edge to
// wait for, and which notices the attempt has since outgrown.

const idle = (sessionId: string): CoordinatorSessionView => ({ sessionId, idle: true, modalParked: false });
const busy = (sessionId: string): CoordinatorSessionView => ({ sessionId, idle: false, modalParked: false });
const modal = (sessionId: string): CoordinatorSessionView => ({ sessionId, idle: false, modalParked: true });

describe('routeNotice', () => {
    const cases: Array<[string, Parameters<typeof routeNotice>[0], ReturnType<typeof routeNotice>]> = [
        ['no coordinator here → none (cursor passes)', { coordinators: [], pastCeiling: false }, { kind: 'none' }],
        ['addressed session, none here at all → none (MCP-only coordinator)', { targetSessionId: 'c1', coordinators: [], pastCeiling: false }, { kind: 'none' }],
        ['any coordinator, one idle → deliver', { coordinators: [busy('a'), idle('b')], pastCeiling: false }, { kind: 'deliver', sessionId: 'b', escalated: false }],
        ['any coordinator, all busy → wait input_ready', { coordinators: [busy('a')], pastCeiling: false }, { kind: 'wait', sessionId: null, waitFor: 'input_ready' }],
        ['any coordinator, all modal → wait modal_cleared', { coordinators: [modal('a')], pastCeiling: false }, { kind: 'wait', sessionId: null, waitFor: 'modal_cleared' }],
        ['any coordinator, all busy, past ceiling → escalate (queue into FIFO)', { coordinators: [busy('a')], pastCeiling: true }, { kind: 'deliver', sessionId: 'a', escalated: true }],
        ['addressed + idle → deliver to it', { targetSessionId: 'c1', coordinators: [idle('c0'), idle('c1')], pastCeiling: false }, { kind: 'deliver', sessionId: 'c1', escalated: false }],
        ['addressed + busy → wait input_ready on it (an idle sibling does NOT take it before the ceiling)', { targetSessionId: 'c1', coordinators: [idle('c0'), busy('c1')], pastCeiling: false }, { kind: 'wait', sessionId: 'c1', waitFor: 'input_ready' }],
        ['addressed + modal → wait modal_cleared', { targetSessionId: 'c1', coordinators: [modal('c1')], pastCeiling: false }, { kind: 'wait', sessionId: 'c1', waitFor: 'modal_cleared' }],
        ['addressed + busy past ceiling → idle sibling', { targetSessionId: 'c1', coordinators: [idle('c0'), busy('c1')], pastCeiling: true }, { kind: 'deliver', sessionId: 'c0', escalated: true }],
        ['addressed + modal past ceiling, no sibling → its own FIFO', { targetSessionId: 'c1', coordinators: [modal('c1')], pastCeiling: true }, { kind: 'deliver', sessionId: 'c1', escalated: true }],
        ['addressed not registered, sibling exists → wait registered', { targetSessionId: 'c1', coordinators: [idle('c0')], pastCeiling: false }, { kind: 'wait', sessionId: 'c1', waitFor: 'registered' }],
        ['addressed not registered, past ceiling → escalate to sibling', { targetSessionId: 'c1', coordinators: [busy('c0'), idle('c2')], pastCeiling: true }, { kind: 'deliver', sessionId: 'c2', escalated: true }],
    ];
    for (const [name, input, expected] of cases) {
        it(name, () => expect(routeNotice(input)).toEqual(expected));
    }
});

describe('evaluateNotifySuppression', () => {
    const attempt = (state: any, suspension: 'approval' | 'choice' | null = null, generation = 0) => ({ state, generation, suspension });
    const cases: Array<[string, Parameters<typeof evaluateNotifySuppression>[0], ReturnType<typeof evaluateNotifySuppression>]> = [
        ['unknown attempt → deliver', { notify: 'approval', attempt: null }, null],
        ['approval while suspended → deliver', { notify: 'approval', attempt: attempt('suspended', 'approval'), generation: 0 }, null],
        ['approval after resolution → stale', { notify: 'approval', attempt: attempt('generating') }, 'stale_suspension'],
        ['approval after terminal → stale (STALE-APPROVAL-AFTER-TERMINAL)', { notify: 'approval', attempt: attempt('completed') }, 'stale_suspension'],
        ['choice for an older generation → stale', { notify: 'choice', attempt: attempt('suspended', 'choice', 2), generation: 1 }, 'stale_suspension'],
        ['candidate while finalizing → deliver', { notify: 'candidate', attempt: attempt('finalizing') }, null],
        ['candidate after the commit → superseded', { notify: 'candidate', attempt: attempt('completed') }, 'candidate_superseded'],
        ['no_progress on an open attempt → deliver', { notify: 'no_progress', attempt: attempt('generating') }, null],
        ['no_progress after terminal → suppressed', { notify: 'no_progress', attempt: attempt('failed') }, 'attempt_terminal'],
        ['progress after terminal → suppressed', { notify: 'progress', attempt: attempt('completed') }, 'attempt_terminal'],
        ['completed always delivers', { notify: 'completed', attempt: attempt('completed') }, null],
        ['late_completion always delivers', { notify: 'late_completion', attempt: attempt('generating', null, 1), generation: 0 }, null],
        ['mesh_event always delivers', { notify: 'mesh_event', attempt: null }, null],
    ];
    for (const [name, input, expected] of cases) {
        it(name, () => expect(evaluateNotifySuppression(input)).toBe(expected));
    }
});
