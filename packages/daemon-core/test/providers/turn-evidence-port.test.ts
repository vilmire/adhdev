/**
 * Wiring-unification C5 — TurnEvidencePort.
 *
 * Pins: guarded/never-throwing emit helpers, envelope field construction
 * (eventId/at/sessionId/attemptRef), isTurnEvidence validation with drop on
 * invalid, and attemptRefFor resolution replacing the meshActiveTaskId scalar
 * read for evidence submitted via the raw port (not through an emit* helper).
 */
import { describe, expect, it, vi } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { isTurnEvidence } from '@adhdev/mesh-shared';
import {
    createTurnEvidencePort,
    emitLiveness,
    emitNoProgress,
    emitProcessExit,
    emitSessionError,
    emitSessionRebound,
    emitSuspension,
    emitSuspensionResolved,
    emitTranscriptActivity,
    emitTranscriptFinal,
    emitTurnEnd,
    emitTurnStarted,
    type TurnEvidencePort,
} from '../../src/providers/turn-evidence-port.js';

const LIVE: TurnEvidence extends { kind: 'transcript_final' } ? never : { modal: boolean; adapterPending: boolean; trailingTool: boolean } = {
    modal: false, adapterPending: false, trailingTool: false,
};

function makePort() {
    const observed: TurnEvidence[] = [];
    const port: TurnEvidencePort = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
    return { port, observed };
}

describe('createTurnEvidencePort', () => {
    it('accepts a valid evidence envelope and forwards it to observe', () => {
        const { port, observed } = makePort();
        port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
        });
        expect(observed).toHaveLength(1);
        expect(observed[0].kind).toBe('turn_started');
    });

    it('drops an invalid evidence object (fails isTurnEvidence) without throwing and without forwarding', () => {
        const { port, observed } = makePort();
        expect(() => port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started',
            retro: 'not-a-boolean', // invalid field type
        } as unknown as TurnEvidence)).not.toThrow();
        expect(observed).toHaveLength(0);
    });

    it('drops evidence with an undeclared extra field (free-text smuggling attempt)', () => {
        const { port, observed } = makePort();
        port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
            userMessage: 'this should never be a field',
        } as unknown as TurnEvidence);
        expect(observed).toHaveLength(0);
    });

    it('a sink that throws does not propagate — observe() swallows it', () => {
        const observe = vi.fn(() => { throw new Error('ledger write failed'); });
        const port = createTurnEvidencePort({ observe });
        expect(() => port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
        })).not.toThrow();
        expect(observe).toHaveBeenCalledTimes(1);
    });

    it('an async sink rejecting does not throw synchronously either', () => {
        const port = createTurnEvidencePort({ observe: async () => { throw new Error('async ledger failure'); } });
        expect(() => port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
        })).not.toThrow();
    });

    it('resolves attemptRef via attemptRefFor when the evidence lacks one and a session id is present', () => {
        const observed: TurnEvidence[] = [];
        const attemptRefFor = vi.fn((sessionId: string) => (sessionId === 'sess_1' ? { attemptId: 'att_1', generation: 2 } : null));
        const port = createTurnEvidencePort({ observe: (e) => observed.push(e), attemptRefFor });
        port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
        });
        expect(attemptRefFor).toHaveBeenCalledWith('sess_1');
        expect(observed[0].attemptRef).toEqual({ attemptId: 'att_1', generation: 2 });
    });

    it('does not overwrite an attemptRef the call site already supplied', () => {
        const observed: TurnEvidence[] = [];
        const attemptRefFor = vi.fn(() => ({ attemptId: 'wrong', generation: 0 }));
        const port = createTurnEvidencePort({ observe: (e) => observed.push(e), attemptRefFor });
        port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
            attemptRef: { attemptId: 'already-resolved', generation: 5 },
        });
        expect(attemptRefFor).not.toHaveBeenCalled();
        expect(observed[0].attemptRef).toEqual({ attemptId: 'already-resolved', generation: 5 });
    });

    it('submits without attemptRef/taskId when attemptRefFor returns null (cold PTY-exit path)', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => observed.push(e), attemptRefFor: () => null });
        port.observe({
            eventId: 'e1', at: 1000, sessionId: 'sess_1', observedBy: 'daemon_a',
            source: 'fsm_edge', kind: 'turn_started', retro: false,
        });
        expect(observed).toHaveLength(1);
        expect(observed[0].attemptRef).toBeUndefined();
    });
});

describe('guarded emit* helpers', () => {
    it('a null port makes every emit* a silent no-op (never throws)', () => {
        expect(() => {
            emitTurnStarted(null, { sessionId: 's', observedBy: 'd', retro: false, source: 'fsm_edge' });
            emitTurnEnd(null, { sessionId: 's', observedBy: 'd', source: 'completion_flush_genuine', strength: 'genuine' });
            emitTranscriptFinal(null, { sessionId: 's', observedBy: 'd', source: 'stall_transcript', selfAttributing: false, nativeRead: false, live: LIVE });
            emitTranscriptActivity(null, { sessionId: 's', observedBy: 'd', source: 'stall_transcript', newestActivityAt: 1 });
            emitNoProgress(null, { sessionId: 's', observedBy: 'd', source: 'status_monitor', stalledMs: 1, observedStatus: 'idle', finalAssistantPresent: false });
            emitLiveness(null, { sessionId: 's', observedBy: 'd', source: 'coordinator_probe', result: 'alive' });
            emitProcessExit(null, { sessionId: 's', observedBy: 'd', source: 'pty_exit', exitCode: 0 });
            emitSessionError(null, { sessionId: 's', observedBy: 'd', source: 'provider_error', reason: 'unknown' });
            emitSuspension(null, { sessionId: 's', observedBy: 'd', source: 'approval_gate', modal: 'approval' });
            emitSuspensionResolved(null, { sessionId: 's', observedBy: 'd', source: 'modal_button', resolution: 'approved', via: 'modal_button' });
            emitSessionRebound(null, { sessionId: 's', observedBy: 'd', source: 'session_registry', toSessionId: 's2', reason: 'restart' });
        }).not.toThrow();
    });

    it('emitTurnStarted builds a valid turn_started envelope with retro/source/eventId/at', () => {
        const { port, observed } = makePort();
        emitTurnStarted(port, { sessionId: 'sess_1', observedBy: 'daemon_a', retro: true, source: 'short_gen_inline', at: 500 });
        expect(observed).toHaveLength(1);
        const ev = observed[0];
        expect(ev.kind).toBe('turn_started');
        expect(ev.sessionId).toBe('sess_1');
        expect(ev.observedBy).toBe('daemon_a');
        expect(ev.at).toBe(500);
        expect(typeof ev.eventId).toBe('string');
        expect(ev.eventId.length).toBeGreaterThan(0);
        if (ev.kind === 'turn_started') expect(ev.retro).toBe(true);
        expect(isTurnEvidence(ev)).toBe(true);
    });

    it('emitTurnEnd never computes a verdict — it only carries strength/blockReason as observed', () => {
        const { port, observed } = makePort();
        emitTurnEnd(port, {
            sessionId: 'sess_1', observedBy: 'daemon_a', source: 'completion_flush_weak',
            strength: 'weak', blockReason: 'finalization_timeout', afterFinalizationTimeout: true,
        });
        const ev = observed[0];
        expect(ev.kind).toBe('turn_end');
        if (ev.kind === 'turn_end') {
            expect(ev.strength).toBe('weak');
            expect(ev.blockReason).toBe('finalization_timeout');
            expect(ev.afterFinalizationTimeout).toBe(true);
            expect('done' in ev).toBe(false);
        }
    });

    it('emitTranscriptFinal carries nativeRead/selfAttributing/live/summary without deciding admission', () => {
        const { port, observed } = makePort();
        emitTranscriptFinal(port, {
            sessionId: 'sess_1', observedBy: 'daemon_a', source: 'stall_transcript',
            selfAttributing: true, nativeRead: true,
            nativeMarker: { outcome: 'completed', turnId: 't1' },
            live: LIVE,
            summary: { topic: 'mesh.m1.handoff', writer: 'w1', seq: 3 },
        });
        const ev = observed[0];
        expect(ev.kind).toBe('transcript_final');
        if (ev.kind === 'transcript_final') {
            expect(ev.selfAttributing).toBe(true);
            expect(ev.nativeRead).toBe(true);
            expect(ev.nativeMarker).toEqual({ outcome: 'completed', turnId: 't1' });
            expect(ev.summary).toEqual({ topic: 'mesh.m1.handoff', writer: 'w1', seq: 3 });
        }
    });

    it('emitNoProgress requires a closed observedStatus value (invalid value is dropped by the port guard)', () => {
        const { port, observed } = makePort();
        emitNoProgress(port, {
            sessionId: 'sess_1', observedBy: 'daemon_a', source: 'mesh_stall_watchdog',
            stalledMs: 5000, observedStatus: 'unknown', finalAssistantPresent: false,
        });
        expect(observed).toHaveLength(1);
        // Now an invalid value at the type level, forced through as unknown input.
        emitNoProgress(port, {
            sessionId: 'sess_1', observedBy: 'daemon_a', source: 'mesh_stall_watchdog',
            stalledMs: 5000, observedStatus: 'not-a-real-status' as unknown as 'unknown', finalAssistantPresent: false,
        });
        expect(observed).toHaveLength(1); // second call dropped, not forwarded
    });

    it('emitProcessExit passes exitCode:null through untouched (never collapsed to 0)', () => {
        const { port, observed } = makePort();
        emitProcessExit(port, { sessionId: 'sess_1', observedBy: 'daemon_a', source: 'pty_exit', exitCode: null });
        const ev = observed[0];
        if (ev.kind === 'process_exit') expect(ev.exitCode).toBeNull();
    });

    it('emitSuspension/emitSuspensionResolved round-trip modal/modalKey and resolution/via', () => {
        const { port, observed } = makePort();
        emitSuspension(port, { sessionId: 's', observedBy: 'd', source: 'approval_gate', modal: 'approval', modalKey: 'fp_1' });
        emitSuspensionResolved(port, { sessionId: 's', observedBy: 'd', source: 'modal_button', resolution: 'approved', via: 'modal_button' });
        expect(observed).toHaveLength(2);
        expect(observed[0].kind).toBe('suspension');
        expect(observed[1].kind).toBe('suspension_resolved');
    });

    it('each emit* call produces a distinct eventId even for the same sessionId/kind/at (seq tiebreak)', () => {
        const { port, observed } = makePort();
        emitTurnStarted(port, { sessionId: 's', observedBy: 'd', retro: false, source: 'fsm_edge', at: 42 });
        emitTurnStarted(port, { sessionId: 's', observedBy: 'd', retro: false, source: 'fsm_edge', at: 42 });
        expect(observed).toHaveLength(2);
        expect(observed[0].eventId).not.toBe(observed[1].eventId);
    });

    it('break-once: a helper emitting an out-of-vocabulary source is dropped, not forwarded', () => {
        const { port, observed } = makePort();
        emitLiveness(port, { sessionId: 's', observedBy: 'd', source: 'made_up_source' as unknown as 'coordinator_probe', result: 'alive' });
        expect(observed).toHaveLength(0);
    });
});
