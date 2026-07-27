import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts) so this suite's turn tables stay free of sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-presentation-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    recordTurnStage,
    proposeTurnCompletion,
    __resetTurnLedgerMetricsForTests,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    resolveSessionTurnPresentation,
    resolveTurnAttemptRow,
    turnStageToSurfaceStatus,
    isRestartBlockingPresentation,
    classifyShadowDivergence,
    getTurnPresentationMetrics,
    __resetTurnPresentationMetricsForTests,
} from '../../src/mesh/mesh-turn-presentation.js';
import { normalizeManagedStatus } from '../../src/status/normalize.js';
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let nonceSeq = 0;

function openAttempt(args: { taskId: string; sessionId: string; providerType?: string; nowMs?: number }) {
    nonceSeq += 1;
    return openTurnAttempt({
        meshId: MESH,
        taskId: args.taskId,
        dispatchNonce: nonceSeq,
        sessionId: args.sessionId,
        providerType: args.providerType ?? 'kimi-cli',
        nowMs: args.nowMs,
    }).attempt;
}

function driveToGenerating(meshId: string, taskId: string, sessionId: string, nowMs?: number): void {
    recordTurnAck({ meshId, taskId, kind: 'delivered', sessionId, nowMs });
    recordTurnAck({ meshId, taskId, kind: 'consumed', sessionId, nowMs });
    recordTurnStage({ meshId, taskId, stage: 'generating', sessionId, occurredAtMs: nowMs });
}

beforeEach(() => {
    MeshRuntimeStore.resetForTests();
    __resetTurnLedgerMetricsForTests();
    __resetTurnPresentationMetricsForTests();
});

afterAll(() => {
    MeshRuntimeStore.resetForTests();
    rmSync(testTmpDir, { recursive: true, force: true });
});

describe('authority selector', () => {
    it('falls back to the persisted provider FSM when no attempt exists (any provider)', () => {
        for (const providerType of ['kimi-cli', 'codex-cli', 'claude-cli', 'hermes-cli']) {
            const p = resolveSessionTurnPresentation({
                sessionId: `sess-${providerType}`,
                legacyStatus: 'generating',
                providerType,
                surface: 'session_status',
            });
            expect(p.authority).toBe('provider_fsm_fallback');
            expect(p.status).toBe('generating');
            expect(p.stage).toBeNull();
            expect(p.attemptId).toBeNull();
        }
        const metrics = getTurnPresentationMetrics();
        expect(metrics.projectionSource.provider_fsm_fallback).toBe(4);
        expect(metrics.projectionSource.turn_reducer).toBe(0);
    });

    it('reducer projection is authoritative when an attempt exists; provider name plays no role', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'codex-cli' });
        const p = resolveSessionTurnPresentation({
            sessionId,
            legacyStatus: 'idle',
            providerType: 'codex-cli',
            surface: 'read_chat',
        });
        expect(p.authority).toBe('turn_reducer');
        expect(p.stage).toBe('accepted');
        expect(p.status).toBe('starting');
        expect(p.taskId).toBe(taskId);
        expect(p.meshId).toBe(MESH);
        expect(p.attemptId).toBeTruthy();
    });

    it('resolves the same projection by (meshId, taskId) and by sessionId (surface equivalence)', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const attempt = openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);

        const byTask = resolveSessionTurnPresentation({ meshId: MESH, taskId, legacyStatus: 'generating', surface: 'active_work' });
        const bySession = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'session_status' });
        const byReadChat = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'read_chat' });
        const byMeshStatus = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'mesh_status' });
        const byDashboard = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'dashboard' });

        for (const p of [byTask, bySession, byReadChat, byMeshStatus, byDashboard]) {
            expect(p.authority).toBe('turn_reducer');
            expect(p.stage).toBe('generating');
            expect(p.status).toBe('generating');
            expect(p.attemptId).toBe(attempt.attemptId);
            expect(p.terminalOutcome).toBeNull();
        }
    });
});

describe('stage → surface status mapping', () => {
    it('maps every causal stage deterministically', () => {
        expect(turnStageToSurfaceStatus('accepted')).toBe('starting');
        expect(turnStageToSurfaceStatus('delivered')).toBe('starting');
        expect(turnStageToSurfaceStatus('consumed')).toBe('generating');
        expect(turnStageToSurfaceStatus('generating')).toBe('generating');
        expect(turnStageToSurfaceStatus('waiting_approval')).toBe('waiting_approval');
        expect(turnStageToSurfaceStatus('waiting_choice')).toBe('waiting_choice');
        expect(turnStageToSurfaceStatus('finalizing')).toBe('finalizing');
        expect(turnStageToSurfaceStatus('completed')).toBe('idle');
        expect(turnStageToSurfaceStatus('failed')).toBe('error');
        expect(turnStageToSurfaceStatus('cancelled')).toBe('stopped');
    });

    it('normalizeManagedStatus passes finalizing through (never collapses to idle)', () => {
        expect(normalizeManagedStatus('finalizing')).toBe('finalizing');
        expect(normalizeManagedStatus('waiting_choice')).toBe('waiting_choice');
    });

    it('read_chat contract accepts finalizing and waiting_choice statuses', () => {
        const base = { messages: [] };
        expect(validateReadChatResultPayload({ ...base, status: 'finalizing' }).status).toBe('finalizing');
        expect(validateReadChatResultPayload({ ...base, status: 'waiting_choice' }).status).toBe('waiting_choice');
    });
});

describe('Kimi/Codex mid-turn point samples cannot override the projection', () => {
    it('PTy briefly idle / interim narration while generating: every surface stays generating', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'kimi-cli' });
        driveToGenerating(MESH, taskId, sessionId);

        // Fresh point-sample reads idle (Kimi native transcript growing / PTY quiet)
        // or a settled Codex prompt sample — the projection still says generating.
        for (const sample of ['idle', 'no_progress', 'long_generating'] as const) {
            const p = resolveSessionTurnPresentation({ sessionId, legacyStatus: sample, providerType: 'kimi-cli', surface: 'read_chat' });
            expect(p.status).toBe('generating');
            expect(p.stage).toBe('generating');
        }
        const metrics = getTurnPresentationMetrics();
        // normalizeManagedStatus collapses no_progress/long_generating to idle,
        // so all three point samples record the same deterministic divergence.
        expect(metrics.shadowDivergences['legacy_idle_turn_active|read_chat|kimi-cli']).toBe(3);
        expect(metrics.shadowAgreements).toBe(0);
    });
});

describe('provider idle while the reducer is finalizing', () => {
    it('all surfaces report finalizing; the restart gate blocks; no terminal is written', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);
        recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', sessionId });

        for (const surface of ['read_chat', 'session_status', 'mesh_status', 'dashboard', 'mcp_pending', 'restart_gate'] as const) {
            const p = resolveSessionTurnPresentation({ meshId: MESH, taskId, sessionId, legacyStatus: 'idle', surface });
            expect(p.status).toBe('finalizing');
            expect(p.stage).toBe('finalizing');
            expect(p.terminalOutcome).toBeNull();
            expect(p.finalizingAgeMs).not.toBeNull();
            expect(isRestartBlockingPresentation(p, false)).toBe(true);
        }
        // No terminal commit happened — the attempt is still nonterminal.
        const row = resolveTurnAttemptRow({ meshId: MESH, taskId });
        expect(row?.terminalOutcome).toBeNull();
    });
});

describe('waiting_approval vs waiting_choice stay distinct', () => {
    it('approval and choice are separate stages/surfaces and resume continues the same attempt', () => {
        const approvalTask = `task-${randomUUID().slice(0, 8)}`;
        const choiceTask = `task-${randomUUID().slice(0, 8)}`;
        const approvalSession = `sess-${randomUUID().slice(0, 8)}`;
        const choiceSession = `sess-${randomUUID().slice(0, 8)}`;
        const approvalAttempt = openAttempt({ taskId: approvalTask, sessionId: approvalSession });
        const choiceAttempt = openAttempt({ taskId: choiceTask, sessionId: choiceSession });
        driveToGenerating(MESH, approvalTask, approvalSession);
        driveToGenerating(MESH, choiceTask, choiceSession);

        recordTurnStage({ meshId: MESH, taskId: approvalTask, stage: 'waiting_approval', sessionId: approvalSession });
        recordTurnStage({ meshId: MESH, taskId: choiceTask, stage: 'waiting_choice', sessionId: choiceSession });

        const approval = resolveSessionTurnPresentation({ sessionId: approvalSession, legacyStatus: 'waiting_approval', surface: 'read_chat' });
        const choice = resolveSessionTurnPresentation({ sessionId: choiceSession, legacyStatus: 'idle', surface: 'dashboard' });
        expect(approval.status).toBe('waiting_approval');
        expect(approval.stage).toBe('waiting_approval');
        expect(approval.approvalAgeMs).not.toBeNull();
        expect(choice.status).toBe('waiting_choice');
        expect(choice.stage).toBe('waiting_choice');
        expect(choice.choiceAgeMs).not.toBeNull();

        // Choice is NEVER mapped to approval by the divergence classifier either.
        expect(classifyShadowDivergence('waiting_approval', choice)).toBe('legacy_approval_choice_confusion');

        // Resume (generating) continues the SAME attempt — no new attemptId.
        recordTurnStage({ meshId: MESH, taskId: approvalTask, stage: 'generating', sessionId: approvalSession });
        const resumed = resolveSessionTurnPresentation({ sessionId: approvalSession, legacyStatus: 'generating', surface: 'session_status' });
        expect(resumed.stage).toBe('generating');
        expect(resumed.attemptId).toBe(approvalAttempt.attemptId);
        expect(resumed.attemptId).not.toBe(choiceAttempt.attemptId);
    });
});

describe('committed terminal projection', () => {
    it('completed commits once; repeated reads are stable and do not re-complete', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);

        const decision = proposeTurnCompletion({ meshId: MESH, taskId, sessionId, outcome: 'completed', source: 'provider_event' });
        expect(decision.committed).toBe(true);

        const first = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'notification' });
        expect(first.stage).toBe('completed');
        expect(first.status).toBe('idle'); // availability, not a completion writer
        expect(first.terminalOutcome).toBe('completed');
        expect(first.terminalAt).toBeTruthy();
        // The terminal commit frees the restart gate even when a stale provider
        // sample still reads generating.
        expect(isRestartBlockingPresentation(first, true)).toBe(false);

        // Repeated reads/legacy terminal signals do not duplicate the outcome.
        const second = resolveSessionTurnPresentation({ meshId: MESH, taskId, legacyStatus: 'generating', surface: 'mcp_pending' });
        expect(second.attemptId).toBe(first.attemptId);
        expect(second.terminalOutcome).toBe('completed');
        const dup = proposeTurnCompletion({ meshId: MESH, taskId, sessionId, outcome: 'completed', source: 'provider_event' });
        expect(dup.committed).toBe(true); // idempotent duplicate
        expect(dup.duplicate).toBe(true);
        const metrics = getTurnPresentationMetrics();
        expect(metrics.shadowDivergences['legacy_busy_turn_terminal|notification|kimi-cli']).toBe(1);
    });

    it('cancelled is terminal and maps to stopped', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        const decision = proposeTurnCompletion({ meshId: MESH, taskId, sessionId, outcome: 'cancelled', source: 'cancellation' });
        expect(decision.committed).toBe(true);
        const p = resolveSessionTurnPresentation({ sessionId, surface: 'session_status' });
        expect(p.stage).toBe('cancelled');
        expect(p.status).toBe('stopped');
    });
});

describe('shadow comparator', () => {
    it('records deterministic divergences by reason/surface/provider without changing authority', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'codex-cli' });
        driveToGenerating(MESH, taskId, sessionId);

        // Legacy mid-tool valley sample says idle — divergence recorded, projection wins.
        const p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', providerType: 'codex-cli', surface: 'read_chat' });
        expect(p.authority).toBe('turn_reducer');
        expect(p.status).toBe('generating');
        let metrics = getTurnPresentationMetrics();
        expect(metrics.shadowDivergenceTotal).toBe(1);
        expect(metrics.shadowDivergences['legacy_idle_turn_active|read_chat|codex-cli']).toBe(1);

        // Deterministic: the same comparison again increments the same key, never a new one.
        resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', providerType: 'codex-cli', surface: 'read_chat' });
        metrics = getTurnPresentationMetrics();
        expect(Object.keys(metrics.shadowDivergences)).toHaveLength(1);
        expect(metrics.shadowDivergences['legacy_idle_turn_active|read_chat|codex-cli']).toBe(2);
    });

    it('does not compare when the legacy surface produced no status', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        resolveSessionTurnPresentation({ sessionId, surface: 'restart_gate' });
        const metrics = getTurnPresentationMetrics();
        expect(metrics.shadowDivergenceTotal).toBe(0);
        expect(metrics.shadowAgreements).toBe(0);
    });
});

describe('restart / deferred-restart gate', () => {
    it('blocks on every nonterminal stage and never on terminal, regardless of the sample', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });

        // accepted: blocks even though the provider sample is idle.
        let p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        driveToGenerating(MESH, taskId, sessionId);
        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_choice', sessionId });
        p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        recordTurnStage({ meshId: MESH, taskId, stage: 'finalizing', sessionId });
        p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        proposeTurnCompletion({ meshId: MESH, taskId, sessionId, outcome: 'failed', source: 'provider_event' });
        p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'generating', surface: 'restart_gate' });
        expect(p.status).toBe('error');
        expect(isRestartBlockingPresentation(p, true)).toBe(false);
    });

    it('non-mesh sessions keep the legacy sample verdict', () => {
        const p = resolveSessionTurnPresentation({ sessionId: `sess-${randomUUID().slice(0, 8)}`, legacyStatus: 'generating', surface: 'restart_gate' });
        expect(p.authority).toBe('provider_fsm_fallback');
        expect(isRestartBlockingPresentation(p, true)).toBe(true);
        expect(isRestartBlockingPresentation(p, false)).toBe(false);
    });
});

describe('session → attempt resolution', () => {
    it('prefers the nonterminal attempt; falls back to the latest terminal row', () => {
        const taskA = `task-${randomUUID().slice(0, 8)}`;
        const taskB = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        // Older, completed attempt on the same session (an earlier turn).
        openAttempt({ taskId: taskA, sessionId, nowMs: Date.now() - 60_000 });
        proposeTurnCompletion({ meshId: MESH, taskId: taskA, sessionId, outcome: 'completed', source: 'provider_event', occurredAtMs: Date.now() - 50_000 });
        // Current nonterminal attempt.
        const current = openAttempt({ taskId: taskB, sessionId });
        const row = resolveTurnAttemptRow({ sessionId });
        expect(row?.attemptId).toBe(current.attemptId);
        expect(row?.terminalOutcome).toBeNull();
    });

    it('returns the latest terminal attempt when no nonterminal row exists', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const attempt = openAttempt({ taskId, sessionId });
        proposeTurnCompletion({ meshId: MESH, taskId, sessionId, outcome: 'completed', source: 'provider_event' });
        const row = resolveTurnAttemptRow({ sessionId });
        expect(row?.attemptId).toBe(attempt.attemptId);
        expect(row?.terminalOutcome).toBe('completed');
    });
});

describe('observability', () => {
    it('exposes bounded projection-source and age gauges, content-free', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);
        recordTurnStage({ meshId: MESH, taskId, stage: 'waiting_approval', sessionId });

        resolveSessionTurnPresentation({ sessionId, legacyStatus: 'waiting_approval', surface: 'dashboard' });
        resolveSessionTurnPresentation({ sessionId: `sess-${randomUUID().slice(0, 8)}`, legacyStatus: 'idle', surface: 'dashboard' });

        const metrics = getTurnPresentationMetrics();
        expect(metrics.projectionSource.turn_reducer).toBe(1);
        expect(metrics.projectionSource.provider_fsm_fallback).toBe(1);
        expect(metrics.maxProjectionAgeMs).toBeGreaterThanOrEqual(0);
        expect(metrics.maxApprovalAgeMs).toBeGreaterThanOrEqual(0);
        // No transcript/prompt content anywhere in the metrics payload.
        const serialized = JSON.stringify(metrics);
        expect(serialized).not.toContain('content');
    });
});
