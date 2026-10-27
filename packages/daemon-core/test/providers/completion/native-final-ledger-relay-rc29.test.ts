import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { CliProviderInstance } from '../../../src/providers/cli-provider-instance.js';
import { createCodexTurnProvenance } from '../../../src/providers/native-history/codex-turn-provenance.js';
import { selectTurnTerminalMarker } from '../../../src/chat/native-turn-signal.js';
import { captureCompletionIdentity } from '../../../src/providers/completion/native-completion-binding.js';
import { observeCancelledNativeCompletion } from '../../../src/providers/completion/cancel-recheck.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import { createTurnLedger } from '../../../src/mesh/turn-ledger/ledger.js';
import { ensureTurnLedgerSchema } from '../../../src/mesh/turn-ledger/schema.js';
import { ensureAssistantRelaySchema } from '../../../src/mesh/mesh-runtime-store-schema.js';
import { AssistantRelay } from '../../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../../src/assistant/assistant-input-log.js';
import { SqliteAssistantRelayStore } from '../../../src/assistant/assistant-relay-sqlite-store.js';
import { recoverAttemptReport } from '../../../src/assistant/attempt-report-recovery.js';
import { fakePublisher } from '../../turn-ledger/ledger-harness.js';

const T = 1_790_000_000_000;
const INPUT = 'Synthetic requested native turn';
const BODY = 'Synthetic genuine native final.';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const resources: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T + 10_000); });
afterEach(() => { for (const f of resources.splice(0)) f(); vi.useRealTimers(); vi.restoreAllMocks(); });

function rig() {
    const db = new Database(':memory:'); ensureTurnLedgerSchema(db); ensureAssistantRelaySchema(db);
    let event: (e: any) => void = () => {};
    const bus: any[] = [];
    const submits: string[] = [];
    const reports: unknown[] = [];
    const store = new SqliteAssistantRelayStore(db);
    const ledger = createTurnLedger({ db, selfDaemonId: 'host', autoFlush: false, now: () => Date.now(), publisher: fakePublisher(),
        ports: { bus: e => { bus.push(e); event({ ...e, at: Date.now() }); } } });
    const execute = async () => ({ success: true, coverage: 'full', agent: 'codex-cli', source: 'provider-native', providerObservedStatus: 'idle',
        providerSessionId: 'native-session', messages: [{ role: 'assistant', kind: 'standard', bubbleState: 'final', receivedAt: T + 35_000, content: BODY }] });
    const relay = new AssistantRelay({ subscribe: fn => { event = fn; return () => {}; }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'synthetic',
        rehydrateAttemptReport: (_m, _s, id) => recoverAttemptReport(db, ledger.getAttempt(id), 'mesh', 'coord', execute).then(r => { reports.push(r); return r; }),
        meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => 'assistant', isAssistantReady: () => true,
        submit: async (_sid, input) => { submits.push(input.text); return { kind: 'delivered' }; }, inputLog: new AssistantInputLog(), store, maxNudgeAttempts: 0 });
    relay.start(); relay.openThread('mesh');
    const opened = ledger.observe({ eventId: 'native-start', at: T + 44, source: 'fsm_edge', sessionId: 'coord', observedBy: 'host', kind: 'turn_started', retro: false });
    const id = opened.attempt!.attemptId;
    const instance = Object.create(CliProviderInstance.prototype) as any;
    let status = 'idle'; let outputAt = T + 9_999;
    Object.assign(instance, { type: 'codex-cli', instanceId: 'coord', providerSessionId: 'native-session', provider: { type: 'codex-cli', name: 'Codex', settings: {} },
        settings: {}, workingDir: '/synthetic/worktree', generatingStartedAt: T + 44, lastAcknowledgedUserInputAt: T - 10,
        lastAcknowledgedInputDigest: digest(INPUT), lastApprovalEventFingerprint: '', autoApproveBusy: false, busyEpoch: 1,
        lastNativeTurnTerminalMarkers: [], completedDebounceTimer: null, cancelledCompletionRecheck: null, cancelledCompletionRecheckTimer: null,
        completedDebouncePending: { chatTitle: 'Synthetic', duration: 10, timestamp: T + 10_000, firstObservedAt: T + 10_000,
            previousStatus: 'generating', turnStartedAt: T + 44, busyEpochAtArm: 1, lastOutputAtArm: T + 5_000 },
        adapter: { chatMessagesOwnedExternally: false, getStatus: () => ({ status, lastOutputAt: outputAt }), getPartialResponse: () => '',
            getScriptParsedStatus: () => ({ status, messages: [] }) }, shouldAutoApprove: () => false, markCurrentTurnStartupGraceCollapseSatisfied: () => {},
        readExternalCompletionMessages: () => [], pushEvent: () => {}, updateSettings: () => {},
        turnEvidencePort: createTurnEvidencePort({ observe: (e, opts) => ledger.observe(e, opts) }),
    });
    // SessionInputTarget normalizes even plain text to an InputEnvelope. Exercise that actual ACK seam.
    Object.assign(instance, { runtimeMessages: [], recentUserInputAcks: new Map(), historyWriter: { appendNewMessages() {} } });
    vi.setSystemTime(T - 10);
    instance.recordAcknowledgedUserInput({ parts: [{ type: 'text', text: INPUT }], textFallback: INPUT }, 'synthetic-input');
    vi.setSystemTime(T + 10_000);
    captureCompletionIdentity(instance, instance.completedDebouncePending);
    const provenance = createCodexTurnProvenance('native-session');
    provenance({ type: 'task_started', turn_id: 'native-turn' }, T);
    provenance({ type: 'user_message', message: INPUT }, T + 1);
    const final = () => provenance({ type: 'task_complete', turn_id: 'native-turn' }, T + 35_050,
        { outcome: 'completed', receivedAt: T + 35_050, turnId: 'native-turn', summary: BODY })!;
    resources.push(() => { relay.stop(); instance.clearCancelledCompletionRecheck(); db.close(); });
    return { db, ledger, id, relay, store, bus, submits, reports, instance, final, provenance,
        status: (s: string) => { status = s; }, output: (at: number) => { outputAt = at; } };
}
async function lateFinal(r: ReturnType<typeof rig>) {
    r.instance.flushCompletedDebounceIfFinalized(); // actual new_pty_output cancellation
    await vi.advanceTimersByTimeAsync(25_100); // timer budget exhausted, no new FSM edge
    r.instance.lastNativeTurnTerminalMarkers = [r.final()];
    if (typeof observeCancelledNativeCompletion === 'function') observeCancelledNativeCompletion(r.instance); // same seam attributed native hydration invokes
    await vi.advanceTimersByTimeAsync(2_000);
}

describe('rc29 actual native completion -> reducer -> durable relay', () => {
    it('recovers new-output cancellation and 44ms native/FSM alignment after the timer budget, once', async () => {
        const r = rig();
        await lateFinal(r);
        expect(r.ledger.getAttempt(r.id)?.state).toBe('completed');
        expect(r.bus.filter(e => e.phase === 'committed')).toHaveLength(1);
        expect(r.store.listUndelivered()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(16_000); await r.relay.idle();
        expect(r.reports).toContainEqual(expect.objectContaining({ body: BODY, completeness: 'final_native' }));
        expect(r.submits).toHaveLength(1); expect(r.submits[0]).toContain(BODY);
        expect(r.store.listDeliveredCoverage(Date.now())).toHaveLength(1);
        observeCancelledNativeCompletion(r.instance); await vi.advanceTimersByTimeAsync(5_000);
        expect(r.bus.filter(e => e.phase === 'committed')).toHaveLength(1);
        expect(r.submits).toHaveLength(1);
    });
    it.each(['session', 'native-session', 'generation', 'input', 'turn', 'busy', 'disposed', 'missing-start', 'missing-proof', 'new-turn'])('rejects %s drift without committing', async defect => {
        const r = rig(); r.instance.flushCompletedDebounceIfFinalized(); await vi.advanceTimersByTimeAsync(25_100);
        const marker = r.final();
        if (defect === 'session') r.instance.instanceId = 'other';
        if (defect === 'native-session') marker.nativeSessionId = 'other';
        if (defect === 'generation') r.instance.currentAttemptRef = () => ({ attemptId: r.id, generation: 1 });
        if (defect === 'input') r.instance.lastAcknowledgedUserInputAt++;
        if (defect === 'turn') marker.turnId = 'other';
        if (defect === 'turn') r.instance.cancelledCompletionRecheck!.pending.completionBinding.nativeTurnId = 'native-turn';
        if (defect === 'busy') r.status('waiting_approval');
        if (defect === 'disposed') r.instance.disposed = true;
        if (defect === 'missing-start') marker.startedAt = 0;
        if (defect === 'new-turn') marker.supersededAt = T + 35_060;
        r.instance.lastNativeTurnTerminalMarkers = defect === 'missing-proof' ? [] : [marker];
        observeCancelledNativeCompletion(r.instance); await vi.advanceTimersByTimeAsync(5_000);
        expect(r.ledger.getAttempt(r.id)?.state).toBe('generating');
        expect(r.store.listUndelivered()).toEqual([]); expect(r.submits).toEqual([]);
    });
    it.each(['failed', 'aborted'] as const)('%s native outcomes never commit completed', async outcome => {
        const r = rig(); r.instance.flushCompletedDebounceIfFinalized(); await vi.advanceTimersByTimeAsync(25_100);
        r.instance.lastNativeTurnTerminalMarkers = [{ ...r.final(), outcome }];
        observeCancelledNativeCompletion(r.instance); await vi.advanceTimersByTimeAsync(2_000);
        expect(r.ledger.getAttempt(r.id)?.state).toBe(outcome === 'failed' ? 'failed' : 'generating');
        expect(r.bus.some(e => e.phase === 'committed' && e.outcome === 'completed')).toBe(false);
    });
    it('preserves a blocked report as the reducer terminal outcome', async () => {
        const r = rig();
        r.ledger.observe({ eventId: 'blocked-report', kind: 'worker_report', source: 'worker_tool', observedBy: 'host', sessionId: 'coord',
            attemptRef: { attemptId: r.id, generation: 0 }, at: T + 5_000, outcome: 'blocked', hasHandoffNotes: false });
        await lateFinal(r);
        expect(r.ledger.getAttempt(r.id)?.state).toBe('blocked');
        expect(r.bus.some(e => e.phase === 'committed' && e.outcome === 'completed')).toBe(false);
    });
    it('leaves a stopping mesh writer exclusive when a native final arrives', async () => {
        const r = rig();
        r.ledger.observe({ eventId: 'mesh-dispatch', kind: 'dispatch_accepted', source: 'dispatch', observedBy: 'host', sessionId: 'coord',
            attemptRef: { attemptId: 'mesh-writer', generation: 0 }, taskId: 'task', at: T + 44, scope: 'mesh_queue', meshId: 'mesh',
            messageId: 'message', nodeId: 'node', providerType: 'codex-cli', coordinator: { daemonId: 'host', coordinatorRunId: 'run' } });
        r.ledger.observe({ eventId: 'mesh-error', kind: 'session_error', source: 'fsm_edge', observedBy: 'host', sessionId: 'coord',
            attemptRef: { attemptId: 'mesh-writer', generation: 0 }, at: T + 5_000, reason: 'provider_error' });
        r.instance.currentAttemptRef = () => ({ attemptId: 'mesh-writer', generation: 0 });
        captureCompletionIdentity(r.instance, r.instance.completedDebouncePending);
        await lateFinal(r);
        expect(r.ledger.getAttempt('mesh-writer')).toMatchObject({ state: 'stopping', generation: 0, terminal: null });
        expect(r.bus.some(e => e.attemptId === 'mesh-writer' && e.phase === 'committed')).toBe(false);
    });
    it('keeps the strict timestamp fallback and accepts an identity-bound empty completed native turn', () => {
        const r = rig(); const marker = { ...r.final(), summary: '' };
        expect(selectTurnTerminalMarker([marker], T + 44)).toBeNull();
        expect(selectTurnTerminalMarker([marker], T + 44, r.instance.completedDebouncePending.completionBinding)).toEqual(marker);
    });
});
