import { describe, expect, it } from 'vitest';
import { renderTurnNotify } from '../../src/mesh/turn-ledger/format.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { classifyOwnQuotaFailureOnlyReply } from '../../src/providers/spec/provider-output-attribution.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold } from './fixtures.js';

// Sanitized seq141 quota body; the provider error id is intentionally omitted.
const QUOTA_REPLY = '… 69 more actions (44 reads, 3 edits, 21 commands, 1 tool: 4 failed) …\n⚠ Individual quota reached. Please upgrade your subscription to increase your\nlimits. Resets in 29h11m3s.';
const step = (attempt: ReturnType<typeof makeAttempt>, holds: ReturnType<typeof makeHold>[], evidence: ReturnType<typeof ev>) =>
    reduce({ attempt, holds, evidence, nowMs: NOW, policy: POLICY });

describe('7aa0a33b quota/no-report provenance', () => {
    it('recognizes only the measured own-provider whole quota screen', () => {
        expect(classifyOwnQuotaFailureOnlyReply('antigravity-cli', QUOTA_REPLY)).toBe('usage_limit_exceeded');
        for (const text of [`Investigated the error.\n${QUOTA_REPLY}`, `> ${QUOTA_REPLY}`, `\`\`\`\n${QUOTA_REPLY}\n\`\`\``, `${QUOTA_REPLY}\nDone.`]) {
            expect(classifyOwnQuotaFailureOnlyReply('antigravity-cli', text)).toBeNull();
        }
        expect(classifyOwnQuotaFailureOnlyReply('codex-cli', QUOTA_REPLY)).toBeNull();
    });
    for (const liveness of ['alive', 'unknown'] as const) {
        it(`keeps the report-owning queue attempt incomplete with ${liveness} liveness`, () => {
            const end = step(makeAttempt('generating'), [], ev('turn_end', { strength: 'genuine', reportExpected: true, summary: REF }));
            expect(end.rule).toBe('R9r');
            const attempt = { ...end.attempt!, lastLiveness: liveness,
                data: { ...end.attempt!.data, livenessObservation: { generation: 1, sessionId: 's1', at: NOW, probeStartedAt: NOW } } };
            const result = step(attempt, [makeHold('await_report')], expired('await_report'));
            expect(result.rule).toBe('R13q');
            expect(result.attempt?.terminal).toBeNull();
            expect(result.attempt?.sessionId).toBe('s1');
            expect(result.effects.some(e => ['commit', 'task_terminal', 'queue_status', 'cancel_dispatch', 'reclaim'].includes(e.kind))).toBe(false);
            const accepted = step(result.attempt!, result.holds, ev('worker_report', { outcome: 'completed', hasHandoffNotes: false }, { source: 'worker_tool' }));
            expect(accepted.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
        });
    }
    it('a replacement-session probe cannot substitute for the queue report', () => {
        const attempt = makeAttempt('finalizing');
        const rebound = step(attempt, [makeHold('await_report')], ev('session_rebound', { toSessionId: 's2', reason: 'restart' }));
        expect(rebound.rule).toBe('R26');
        const stale = step(rebound.attempt!, rebound.holds, ev('liveness', { result: 'alive', probeStartedAtMs: NOW }, { sessionId: 's1' }));
        expect(stale.verdict).toBe('rejected');
        const fresh = step(rebound.attempt!, rebound.holds, ev('liveness', { result: 'alive', probeStartedAtMs: NOW }, { sessionId: 's2' }));
        const waiting = step(fresh.attempt!, fresh.holds, { ...expired('await_report'), sessionId: 's2' });
        expect(waiting.rule).toBe('R13q');
        expect(waiting.attempt?.terminal).toBeNull();
        expect(waiting.attempt?.sessionId).toBe('s2');
    });

    it('an accepted tool report remains authoritative over a later quota-shaped idle edge', () => {
        const reported = step(makeAttempt('generating'), [], ev('worker_report', { outcome: 'completed', hasHandoffNotes: false }, { source: 'worker_tool' }));
        const end = step(reported.attempt!, reported.holds, ev('turn_end', { strength: 'genuine', reportExpected: true, providerFailure: 'usage_limit_exceeded' }));
        expect(end.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
    });

    it('renders a sanitized quota reason without promising retry or a success verdict', () => {
        const rendered = renderTurnNotify({ notify: 'failed', scalars: { nodeLabel: 'worker', stopReason: 'usage_limit_exceeded' }, refs: {}, resolveRef: () => null });
        expect(rendered.text).toContain('usage quota limit');
        expect(rendered.text).toContain('no successful completion verdict');
        expect(rendered.text).not.toContain('Error ID');
    });

    it('does not adopt a stale-generation report after report wait expiry', () => {
        const result = step(makeAttempt('finalizing'), [makeHold('await_report')], expired('await_report'));
        const stale = step(result.attempt!, result.holds, ev('worker_report', { outcome: 'completed', hasHandoffNotes: false },
            { source: 'worker_tool', attemptRef: { attemptId: 'a1', generation: 0 } }));
        expect(stale.attempt?.terminal).toBeNull();
    });
});
