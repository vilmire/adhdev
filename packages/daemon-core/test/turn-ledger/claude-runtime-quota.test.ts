import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { claudeRuntimeQuotaScreen, observeRuntimeQuota } from '../../src/providers/completion/runtime-quota.js';
import { createTurnEvidencePort } from '../../src/providers/turn-evidence-port.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { clearQuotaCache, readQuotaCache } from '../../src/quota/refresh.js';
import { preserveCliRateLimitEvidence } from '../../src/quota/exhaustion-hold.js';
import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing.js';
import { resolveRecoveryRelaunchProvider } from '../../src/mesh/mesh-quota-ranking-records.js';
import { NOW, POLICY, ev, makeAttempt } from './fixtures.js';

const WEEKLY = "You've hit your weekly limit · resets 12pm (Asia/Seoul)";
const AUTO = 'Usage limit reached · continuing automatically at 12pm · esc to cancel';
const RESET = 'Usage limit reached · limit resets 12pm';
const SCREEN = `\u001b[31m${WEEKLY}\u001b[0m\r\n${AUTO}\n${RESET}`;
const HASH = '61c4e43e5ff4ab53';
const fresh = (updatedAt: number) => ({ provider: 'claude-cli', status: 'ok' as const, updatedAt,
    session: { usedPercent: 17, windowMinutes: 300, resetsAt: null }, weekly: null });
const node = (quota: unknown) => ({ id: 'n1', nodeFacts: { schemaVersion: 1, reportedAt: NOW, quota: { 'claude-cli': quota } } });

afterEach(() => clearQuotaCache());
function fixture(screen = SCREEN) {
    const observed: TurnEvidence[] = [];
    const envelopes: unknown[] = [];
    const host = { type: 'claude-cli', instanceId: '7b57d632-19cc-418e-a105-2e851737803f',
        providerSessionId: '66c597e5-9a40-4460-96f8-327b03902e45',
        adapter: { getTerminalScreenSnapshot: () => ({ text: screen, hash: HASH }), getStatus: () => ({}) },
        currentAttemptRef: () => ({ attemptId: 'a1', generation: 1 }), isMeshWorkerSession: () => true,
        turnEvidencePort: createTurnEvidencePort({ observe: (e, opts) => { observed.push(e); envelopes.push(opts?.envelope); } }) };
    return { host, observed, envelopes };
}

describe('captured Claude weekly quota wait through supported writer stop and provider selection', () => {
    it.each([WEEKLY, AUTO, RESET, SCREEN])('recognizes real whole chrome and ANSI: %s', screen => {
        expect(claudeRuntimeQuotaScreen(screen)).not.toBeNull();
    });
    it.each(['', 'cargo test --release\nCompiling crate (123/400)', 'Permission required: run cargo test?',
        'Error: connection reset by peer', 'limit resets 12pm', `The docs say "${WEEKLY}"`,
        `\`\`\`text\n${AUTO}\n\`\`\``, `> ${WEEKLY}`, `    ${AUTO}`,
        `⏺ Documentation example:\n${AUTO}`, `${AUTO}\n${'ordinary output\n'.repeat(9)}`])('rejects silence, normal work, errors and quoted documentation: %s', screen => {
        const f = fixture(screen);
        expect(observeRuntimeQuota(f.host, NOW)).toBe(false);
        expect(f.observed).toEqual([]);
        expect(readQuotaCache()?.['claude-cli']).toBeUndefined();
    });
    it('preserves exact session/native/hash/reset evidence, blocks stale 83% and no-data, then selects an alternative only after stop', () => {
        const f = fixture();
        expect(observeRuntimeQuota(f.host, NOW)).toBe(true);
        expect(f.observed).toHaveLength(1);
        const q = readQuotaCache()!['claude-cli']!;
        expect(q.metadata?.cliRateLimit).toMatchObject({ observedAt: NOW,
            runtime: { sessionId: f.host.instanceId, screenHash: HASH, resetText: [WEEKLY, AUTO, RESET].join('\n') } });
        expect(f.envelopes[0]).toMatchObject({ providerType: 'claude-cli', notice: { completionMetadata: {
            diagnosticReason: 'quota_blocked', providerSessionId: f.host.providerSessionId, screenHash: HASH } } });
        const stale = preserveCliRateLimitEvidence(q, fresh(NOW - 1));
        expect(evaluateProviderQuotaGate(node(stale), 'claude-cli', null, NOW)).not.toBeNull();
        const noData = preserveCliRateLimitEvidence(q, { provider: 'claude-cli', status: 'unavailable', updatedAt: NOW + 100_000_000, session: null, weekly: null });
        expect(evaluateProviderQuotaGate(node(noData), 'claude-cli', null, NOW + 100_000_000)).not.toBeNull();
        const attempt = makeAttempt('finalizing', { sessionId: f.host.instanceId });
        const stopping = reduce({ attempt, holds: [], evidence: f.observed[0]!, nowMs: NOW, policy: POLICY });
        expect(stopping.attempt?.state).toBe('stopping');
        expect(stopping.effects.some(e => e.kind === 'cancel_dispatch')).toBe(true);
        expect(stopping.effects.some(e => ['reclaim', 'queue_status', 'release_attempt_ref', 'task_terminal'].includes(e.kind))).toBe(false);
        const pending = reduce({ attempt: stopping.attempt!, holds: stopping.holds,
            evidence: ev('operator_status', { status: 'failed', reason: 'operator_update' }, { sessionId: f.host.instanceId }), nowMs: NOW + 1, policy: POLICY });
        expect(pending.attempt?.state).toBe('stopping');
        const settled = reduce({ attempt: stopping.attempt!, holds: stopping.holds, stopConfirmed: true,
            evidence: ev('operator_status', { status: 'failed', reason: 'operator_update' }, { sessionId: f.host.instanceId }), nowMs: NOW + 1, policy: POLICY });
        expect(settled.rule).toBe('writer_settled');
        expect(settled.effects).toContainEqual(expect.objectContaining({ kind: 'queue_status', status: 'pending' }));
        expect(resolveRecoveryRelaunchProvider(node(stale), 'claude-cli', ['claude-cli', 'codex-cli'], null, NOW)).toMatchObject({ action: 'fallback', providerType: 'codex-cli' });
        expect(resolveRecoveryRelaunchProvider(node(stale), 'claude-cli', ['claude-cli'], null, NOW).action).toBe('block');
    });
    it('direct dispatch only notifies failed after the exact writer settles', () => {
        const f = fixture(); observeRuntimeQuota(f.host, NOW);
        const stopping = reduce({ attempt: makeAttempt('finalizing', { scope: 'mesh_direct', sessionId: f.host.instanceId }), holds: [], evidence: f.observed[0]!, nowMs: NOW, policy: POLICY });
        expect(stopping.attempt?.state).toBe('stopping');
        expect(stopping.attempt?.terminal).toBeNull();
        const settled = reduce({ attempt: stopping.attempt!, holds: stopping.holds, stopConfirmed: true,
            evidence: ev('operator_status', { status: 'failed', reason: 'operator_update' }, { sessionId: f.host.instanceId }), nowMs: NOW + 1, policy: POLICY });
        expect(settled.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_usage_limit_exceeded' });
    });
    it('repeated screen polls keep runtime evidence newer than cache while emitting one stop per generation', () => {
        const f = fixture(); observeRuntimeQuota(f.host, NOW); observeRuntimeQuota(f.host, NOW + 1);
        expect(f.observed).toHaveLength(1);
        expect(readQuotaCache()!['claude-cli']!.metadata?.cliRateLimit).toMatchObject({ observedAt: NOW + 1 });
    });
    it('does not read or stop permission waits, non-Claude providers, unbound or non-worker sessions', () => {
        const f = fixture(); const screen = vi.spyOn(f.host.adapter, 'getTerminalScreenSnapshot');
        f.host.adapter.getStatus = () => ({ activeModal: { buttons: ['Allow'] } });
        expect(observeRuntimeQuota(f.host, NOW)).toBe(false);
        expect(observeRuntimeQuota({ ...f.host, type: 'codex-cli' }, NOW)).toBe(false);
        expect(observeRuntimeQuota({ ...f.host, currentAttemptRef: () => null }, NOW)).toBe(false);
        expect(observeRuntimeQuota({ ...f.host, isMeshWorkerSession: () => false }, NOW)).toBe(false);
        expect(screen).not.toHaveBeenCalled();
    });
});

// Exercise the real authenticated stop receipt boundary as well as the pure
// reducer: an unrelated session's success must never release this writer.
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';

afterEach(() => { setActiveTurnLedger(null); MeshRuntimeStore.resetForTests(); });

it.each([true, false])('real ledger requires exact native stop receipt (matching session=%s)', async matching => {
    const attempt = seedMeshAttempt({ meshId: `runtime-quota-${matching}`, taskId: `task-${matching}`, sessionId: `quota-session-${matching}`,
        nodeId: 'node', providerType: 'claude-cli', stage: 'finalizing', scope: 'mesh_queue' });
    let finishStop!: () => void;
    const cancel = vi.fn((request: any) => new Promise(resolve => {
        expect(readQuotaCache()!['claude-cli']!.metadata?.cliRateLimit).toBeTruthy();
        finishStop = () => resolve({ ...request, sessionId: matching ? request.sessionId : 'unrelated-session',
            success: true, quiescent: true, incarnation: 'host-incarnation', evidence: { kind: 'native_tree_gone' } });
    }));
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'test-daemon', publisher: null, autoFlush: false,
        ports: { cancelDispatch: cancel } });
    setActiveTurnLedger(ledger);
    const f = fixture();
    const host = { ...f.host, instanceId: attempt.sessionId,
        currentAttemptRef: () => ({ attemptId: attempt.attemptId, generation: attempt.generation }),
        turnEvidencePort: createTurnEvidencePort({ observe: (e, opts) => { ledger.observe(e, opts); } }) };
    observeRuntimeQuota(host);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('stopping');
    expect(ledger.getAttempt(attempt.attemptId)?.generation).toBe(attempt.generation);
    finishStop();
    if (matching) {
        await vi.waitFor(() => expect(ledger.getAttempt(attempt.attemptId)?.generation).toBe(attempt.generation + 1));
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('accepted');
    } else {
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(ledger.getAttempt(attempt.attemptId)?.state).toBe('stopping');
        expect(ledger.getAttempt(attempt.attemptId)?.terminal).toBeNull();
    }
});
