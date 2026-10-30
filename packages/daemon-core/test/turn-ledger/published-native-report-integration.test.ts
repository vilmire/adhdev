import { describe, expect, it } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { captureCompletionIdentity, boundCompletionMarker } from '../../src/providers/completion/native-completion-binding.js';
import { emitGeneratingCompleted } from '../../src/providers/completion/completion-flush.js';
import { createTurnEvidencePort } from '../../src/providers/turn-evidence-port.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { NOW, POLICY, REF, ev, expired, makeAttempt, makeHold } from './fixtures.js';

// Exercise the published late-native binding with the pending report lifecycle.
// Native completion is neither a worker report nor a consume/application ACK.
function lateNativeEnd(failure = false) {
    const host: any = {
        instanceId: 's1', generatingStartedAt: NOW - 100,
        lastAcknowledgedUserInputAt: NOW - 200, lastAcknowledgedInputDigest: 'synthetic-digest',
        currentAttemptRef: () => ({ attemptId: 'a1', generation: 1 }), completingTurnTaskId: () => 't1',
        lastNativeTurnTerminalMarkers: [{ nativeSessionId: 'native', turnId: 'turn', startedAt: NOW - 150,
            inputAt: NOW - 200, inputDigest: 'synthetic-digest', receivedAt: NOW,
            outcome: failure ? 'failed' : 'completed', providerFailure: failure ? 'usage_limit_exceeded' : undefined,
            summary: 'Synthetic native final.' }],
    };
    const pending: any = { turnStartedAt: NOW - 100 };
    captureCompletionIdentity(host, pending);
    expect(boundCompletionMarker(host, pending)).toBeNull();
    host.providerSessionId = 'native';
    const marker = boundCompletionMarker(host, pending)!;
    expect(marker).not.toBeNull();
    const observed: TurnEvidence[] = [];
    emitGeneratingCompleted({ ...host, type: 'codex-cli', settings: {}, busyEpoch: 1,
        lastCompletionSummary: null, lastEmittedCompletion: null, pushEvent() {}, updateSettings() {},
        turnEvidencePort: createTurnEvidencePort({ observe: evidence => { observed.push(evidence); } }),
    }, { chatTitle: 'Synthetic', timestamp: NOW, taskId: 't1', attemptRef: pending.capturedAttemptRef,
        finalSummary: marker.summary, evidenceLevel: 'reported',
        completionDiagnostic: { nativeTurnOutcome: marker.outcome, nativeProviderFailure: marker.providerFailure } });
    expect(observed).toHaveLength(1);
    return { ...observed[0], summary: REF, reportExpected: true } as TurnEvidence;
}

describe('published native completion and pending report integration', () => {
    it.each(['alive', 'unknown'] as const)('late native success retains missing-report ownership with %s liveness', liveness => {
        const end = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: lateNativeEnd(), nowMs: NOW, policy: POLICY });
        expect(end.rule).toBe('R9r');
        const waiting = reduce({ attempt: { ...end.attempt!, lastLiveness: liveness }, holds: [makeHold('await_report')],
            evidence: expired('await_report'), nowMs: NOW, policy: POLICY });
        expect(waiting.rule).toBe('R13q');
        expect(waiting.attempt).toMatchObject({ sessionId: 's1', generation: 1, terminal: null });
        expect(waiting.effects.some(e => ['commit', 'task_terminal', 'queue_status', 'cancel_dispatch', 'reclaim'].includes(e.kind))).toBe(false);
        const report = ev('worker_report', { outcome: 'completed', hasHandoffNotes: false }, { source: 'worker_tool' });
        const stale = reduce({ attempt: waiting.attempt, holds: waiting.holds, evidence: { ...report, attemptRef: { attemptId: 'a1', generation: 0 } }, nowMs: NOW, policy: POLICY });
        expect(stale.attempt?.terminal).toBeNull();
        const accepted = reduce({ attempt: waiting.attempt, holds: waiting.holds, evidence: report, nowMs: NOW, policy: POLICY });
        expect(accepted.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' });
    });

    it('late native quota failure remains a failure without an accepted report', () => {
        const end = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: lateNativeEnd(true), nowMs: NOW, policy: POLICY });
        expect(end.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_usage_limit_exceeded' });
    });

    it('an accepted genuine report keeps authority over late native quota failure', () => {
        const reported = reduce({ attempt: makeAttempt('generating'), holds: [],
            evidence: ev('worker_report', { outcome: 'completed', hasHandoffNotes: false }, { source: 'worker_tool' }), nowMs: NOW, policy: POLICY });
        const end = reduce({ attempt: reported.attempt, holds: reported.holds, evidence: lateNativeEnd(true), nowMs: NOW, policy: POLICY });
        expect(end.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
    });
});
