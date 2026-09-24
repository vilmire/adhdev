// Minimal fixtures for the pure turn-ledger reducer tests.
import type { TurnEvidence, TurnEvidenceBody, TurnEvidenceKind, HoldReason } from '@adhdev/mesh-shared';
import type { TurnAttempt, TurnHold, TurnState } from '../../src/mesh/turn-ledger/types.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';

export const POLICY = { ...DEFAULT_TURN_POLICY };
export const NOW = 1_000_000;
export const REF = { topic: 'mesh.m1.handoff', writer: 'w1', seq: 3 };

export function makeAttempt(state: TurnState, overrides: Partial<TurnAttempt> = {}): TurnAttempt {
    const terminal = state === 'completed' || state === 'failed' || state === 'cancelled'
        ? { outcome: state, reason: 'turn_end' as const, source: 'fsm_edge' as const, strength: 'genuine' as const, at: NOW - 10 }
        : null;
    return {
        attemptId: 'a1', scope: 'mesh_queue', meshId: 'm1', taskId: 't1', attemptNo: 0,
        sessionId: 's1', nodeId: 'n1', providerType: 'claude-cli', ownerDaemonId: 'dc',
        generation: 1, prevGeneration: { sessionId: 's0', consumed: false }, dispatchNonce: null, messageId: 'msg1',
        consumeProfile: 'default', maxTaskRetries: 1,
        state, suspension: state === 'suspended' ? 'approval' : null,
        redriveCount: 0, reclaimCount: 0, hollowCount: 0, livenessFailStreak: 0, lastLiveness: null,
        coordinator: { daemonId: 'dc', sessionId: 'coord' },
        acceptedAt: NOW - 1000, deliveredAt: null, consumedAt: state === 'accepted' || state === 'delivered' ? null : NOW - 500,
        lastActivityAt: null, weakSince: state === 'finalizing' ? NOW - 100 : null,
        candidateNotifiedGeneration: null, lastNoProgressNoticeAt: null, notifiedAt: null, terminal, data: {},
        ...overrides,
    };
}

type BodyOf<K extends TurnEvidenceKind> = Omit<Extract<TurnEvidenceBody, { kind: K }>, 'kind'>;

export function ev<K extends TurnEvidenceKind>(kind: K, body: BodyOf<K>, envelope: Partial<TurnEvidence> = {}): TurnEvidence {
    return {
        eventId: `ev-${kind}`, at: NOW, source: 'fsm_edge', sessionId: 's1', observedBy: 'dw',
        attemptRef: { attemptId: 'a1', generation: 1 },
        ...envelope, kind, ...body,
    } as TurnEvidence;
}

export function makeHold(reason: HoldReason, overrides: Partial<TurnHold> = {}): TurnHold {
    return {
        holdId: `a1:${reason}`, attemptId: 'a1', generation: reason === 'hard_ceiling' ? null : 1, reason,
        until: NOW, onExpire: 'release', data: reason === 'live_pending' ? { evidenceId: 'held-ev' } : {}, createdAt: NOW - 1000,
        ...overrides,
    };
}

export function expired(reason: HoldReason): TurnEvidence {
    return ev('hold_expired', { holdId: `a1:${reason}`, reason }, { source: 'scheduler' });
}

const LIVE_IDLE = { modal: false, adapterPending: false, trailingTool: false };

/**
 * Evidence variants per kind that together exercise every guard branch.
 * Each is paired with the holds it needs (hold_expired names a hold).
 */
export function variantsFor(kind: TurnEvidenceKind): Array<{ label: string; evidence: TurnEvidence; holds: TurnHold[] }> {
    const v = (label: string, evidence: TurnEvidence, holds: TurnHold[] = []) => ({ label, evidence, holds });
    switch (kind) {
        case 'dispatch_accepted': return [v('mesh', ev(kind, { scope: 'mesh_queue', messageId: 'msg1', meshId: 'm1' }))];
        case 'delivered': return [v('delivered', ev(kind, { messageId: 'msg1', outcome: 'delivered', via: 'local' }))];
        case 'delivery_refused': return [
            v('exited', ev(kind, { messageId: 'msg1', reason: 'session_exited' })),
            v('busy', ev(kind, { messageId: 'msg1', reason: 'send_in_flight' })),
        ];
        case 'dispatch_failed': return [v('absent', ev(kind, { workerAbsent: true, reason: 'worker_absent' }))];
        case 'duplicate_dispatch_refusal': return [
            v('self', ev(kind, { holderSessionId: 's9', holderAttemptId: 'a1' })),
            v('foreign', ev(kind, { holderSessionId: 's9', holderAttemptId: 'a2' })),
        ];
        case 'session_rebound': return [v('restart', ev(kind, { toSessionId: 's2', reason: 'restart' }))];
        case 'turn_started': return [
            v('now', ev(kind, { retro: false })),
            v('old', ev(kind, { retro: true }, { at: NOW - 10_000 })),
            v('now-await-report', ev(kind, { retro: false }), [makeHold('await_report')]),
        ];
        case 'suspension': return [
            v('approval', ev(kind, { modal: 'approval' })),
            v('choice', ev(kind, { modal: 'choice' })),
        ];
        case 'suspension_resolved': return [v('approved', ev(kind, { resolution: 'approved', via: 'modal_button' }))];
        case 'turn_end': return [
            v('genuine', ev(kind, { strength: 'genuine', summary: REF })),
            v('weak', ev(kind, { strength: 'weak' })),
            v('weak-timeout', ev(kind, { strength: 'weak', afterFinalizationTimeout: true })),
            v('hollow', ev(kind, { strength: 'genuine', hollow: true })),
            v('live', ev(kind, { strength: 'genuine', live: { ...LIVE_IDLE, adapterPending: true } })),
            v('report-expected', ev(kind, { strength: 'genuine', summary: REF, reportExpected: true })),
            v('report-expected-held', ev(kind, { strength: 'genuine', summary: REF, reportExpected: true }), [makeHold('await_report')]),
        ];
        case 'transcript_final': return [
            v('marker', ev(kind, { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE })),
            v('shape', ev(kind, { selfAttributing: false, nativeRead: false, live: LIVE_IDLE, summary: REF })),
            v('growing', ev(kind, { selfAttributing: false, nativeRead: false, live: { ...LIVE_IDLE, newestActivityAt: NOW - 1000 }, summary: REF })),
            v('no-marker', ev(kind, { selfAttributing: false, nativeRead: true, live: LIVE_IDLE, summary: REF })),
            v('marker-await-report', ev(kind, { selfAttributing: false, nativeRead: true, nativeMarker: { outcome: 'completed' }, live: LIVE_IDLE }), [makeHold('await_report')]),
        ];
        case 'worker_report': return [
            v('completed', ev(kind, { outcome: 'completed', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' })),
            v('blocked', ev(kind, { outcome: 'blocked', summary: REF, hasHandoffNotes: false }, { source: 'worker_tool' })),
        ];
        case 'worker_progress': return [v('progress', ev(kind, { note: REF }, { source: 'worker_tool' }))];
        case 'transcript_activity': return [
            v('new', ev(kind, { newestActivityAt: NOW })),
            v('old', ev(kind, { newestActivityAt: NOW - 10_000 })),
            v('new-await-report', ev(kind, { newestActivityAt: NOW }), [makeHold('await_report')]),
        ];
        case 'no_progress': return [
            v('final', ev(kind, { stalledMs: 200_000, observedStatus: 'idle', finalAssistantPresent: true })),
            v('stuck', ev(kind, { stalledMs: 200_000, observedStatus: 'generating', finalAssistantPresent: false })),
        ];
        case 'liveness': return (['alive', 'unknown', 'read_failed', 'dead'] as const).map((result) => v(result, ev(kind, { result }, { source: 'coordinator_probe' })));
        case 'process_exit': return [
            v('exit', ev(kind, { exitCode: 1 })),
            v('auth', ev(kind, { exitCode: 1, providerFailure: 'auth_failed' })),
        ];
        case 'session_error': return [v('err', ev(kind, { reason: 'provider_error' }))];
        case 'git_side_effect': return [v('git', ev(kind, { dirty: true, commitsSinceDispatch: 2, attributable: true }))];
        case 'cancel': return [
            v('operator', ev(kind, { reason: 'operator_cancel' }, { source: 'operator' })),
            v('cleanup', ev(kind, { reason: 'intentional_cleanup' }, { source: 'intentional_cleanup' })),
        ];
        case 'operator_status': return [v('failed', ev(kind, { status: 'failed', reason: 'operator_update' }, { source: 'operator' }))];
        case 'coordinator_ack': return [v('ack', ev(kind, { notify: 'completed', outcome: 'delivered' }))];
        case 'hold_expired': return ([
            'await_delivery', 'await_consume', 'await_turn', 'liveness', 'hard_ceiling',
            'live_pending', 'transcript_quiet', 'weak_candidate', 'suspension_before_consumed', 'await_report', 'await_end',
        ] as const).map((reason) => v(reason, expired(reason), [makeHold(reason)])).concat([v('missing', expired('liveness'), [])]);
    }
}
