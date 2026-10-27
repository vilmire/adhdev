import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { renderTurnNotify } from '../../src/mesh/turn-ledger/format.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold } from './fixtures.js';

const step = (input: Parameters<typeof reduce>[0]) => reduce({ ...input, policy: POLICY, nowMs: NOW });

describe('direct dispatch weak end requires an accepted report', () => {
    for (const reason of ['weak_candidate', 'await_report'] as const) {
        for (const liveness of ['alive', 'unknown'] as const) {
            it(`${reason} expiry with ${liveness} liveness keeps missing reports incomplete`, () => {
                const attempt = makeAttempt('finalizing', { scope: 'mesh_direct', lastLiveness: liveness,
                    data: { livenessObservation: { generation: 1, sessionId: 's1', at: NOW, probeStartedAt: NOW } } });
                const result = step({ attempt, holds: [makeHold(reason)], evidence: expired(reason), policy: POLICY, nowMs: NOW });
                expect(result.attempt?.terminal).toBeNull();
                expect(result.attempt?.state).toBe('finalizing');
                expect(result.effects.some(e => e.kind === 'commit' || e.kind === 'task_terminal' || e.kind === 'queue_status')).toBe(false);
                expect(result.holds.some(h => h.reason === reason)).toBe(false);
                // A report arriving after the wait window is still the authority.
                const report = ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' });
                const accepted = step({ attempt: result.attempt, holds: result.holds, evidence: report, policy: POLICY, nowMs: NOW });
                expect(accepted.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
                const duplicate = step({ attempt: accepted.attempt, holds: accepted.holds, evidence: report, policy: POLICY, nowMs: NOW });
                expect(duplicate.effects.some(e => e.kind === 'commit')).toBe(false);
            });
        }
    }

    it('does not promote a rejected report or adopt a wrong generation', () => {
        const attempt = makeAttempt('finalizing', { scope: 'mesh_direct', data: { reportCorrection: { generation: 1, until: NOW + 100 } } });
        const rejected = step({ attempt, holds: [makeHold('await_report')], evidence: expired('await_report'), policy: POLICY, nowMs: NOW });
        expect(rejected.attempt?.terminal).toBeNull();
        const stale = step({ attempt, holds: [], evidence: ev('worker_report', { outcome: 'completed', hasHandoffNotes: false },
            { source: 'worker_tool', attemptRef: { attemptId: 'a1', generation: 2 } }), policy: POLICY, nowMs: NOW });
        expect(stale.verdict).toBe('recorded');
        expect(stale.attempt?.terminal).toBeNull();
    });

    it('preserves the existing queue fallback and plain provider-turn semantics', () => {
        for (const scope of ['mesh_queue', 'plain'] as const) {
            const attempt = makeAttempt('finalizing', { scope, lastLiveness: 'alive',
                data: { livenessObservation: { generation: 1, sessionId: 's1', at: NOW, probeStartedAt: NOW } } });
            const result = step({ attempt, holds: [makeHold('weak_candidate')], evidence: expired('weak_candidate'), policy: POLICY, nowMs: NOW });
            expect(result.attempt?.terminal).toMatchObject({ strength: 'weak', reason: 'weak_end_confirmed' });
        }
    });

    it('gives the coordinator a supported report recovery step without claiming success', () => {
        const rendered = renderTurnNotify({ notify: 'candidate', scalars: { nodeLabel: 'worker', taskId: 't1', strength: 'weak' }, refs: {}, resolveRef: () => null });
        expect(JSON.stringify(rendered)).toContain('report_completion');
        expect(JSON.stringify(rendered)).toContain('awaiting confirmation');
    });
});
