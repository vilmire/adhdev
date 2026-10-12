import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('../../src/mesh/mesh-queue-assignment.js', () => ({ getMeshWithCache: () => undefined }));
vi.mock('../../src/mesh/mesh-auto-fast-forward.js', () => ({ startContinuousAutoFastForwardScheduler: () => ({ stop() {} }) }));
vi.mock('../../src/mesh/mesh-housekeeping-tick.js', () => ({ claimPendingQueues: async () => {}, startMeshHousekeeping: () => ({ stop() {} }) }));
vi.mock('../../src/quota/refresh.js', () => ({ hydrateQuotaCacheFromDisk: () => {}, quotaProviderEnabledFromLoader: () => () => false }));
vi.mock('../../src/quota/refresh-triggers.js', async (original) => ({ ...(await original<any>()), refreshQuotaCacheOnBoot: () => {} }));
vi.mock('../../src/models/registry.js', () => ({ hydrateModelCache: () => {}, refreshDueModelDiscovery: async () => {} }));
import { readSession } from '../../src/providers/native-history/codex-cli-transcript.js';
import { executeNativeHistory } from '../../src/providers/spec/native-history-executor.js';
import { emitGeneratingCompleted } from '../../src/providers/completion/completion-flush.js';
import { createTurnEvidencePort } from '../../src/providers/turn-evidence-port.js';
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js';
import { selectTurnTerminalMarker } from '../../src/chat/native-turn-signal.js';
import { analyzeProbeTranscript } from '../../src/boot/stages/loops.js';
import { probeEvidence } from '../../src/mesh/turn-ledger/probe.js';
import { admitTranscriptFinal } from '../../src/mesh/turn-ledger/admission.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { readTurnTerminalViews } from '../../src/mesh/mesh-local-records.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { isTurnEvidence } from '@adhdev/mesh-shared';
import { POLICY, REF, ev, makeAttempt } from './fixtures.js';
import { dispatch, evd, ledgerOn, memDb } from './ledger-harness.js';

const START = 1_750_000_000_000;
const SID = '019feb8e-cf2d-7241-9e00-9eb1f199c5af';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const event = (type: string, timestamp: number, payload: object = {}) => ({ type: 'event_msg', timestamp, payload: { type, ...payload } });
const message = (text: string, timestamp: number) => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] } });
function readers(records: object[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provenance-')); dirs.push(dir);
    const file = path.join(dir, `rollout-${SID}.jsonl`);
    const rows = [{ type: 'session_meta', timestamp: START - 2000, payload: { id: SID, cwd: dir } }, ...records];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(fs.statSync(file).size).toBeLessThan(8192);
    const builtin = readSession(file)!;
    const spec = executeNativeHistory({ source: { kind: 'jsonl', path: dir, file_pattern: '*.jsonl', session_id_from: 'filename_uuid',
        message_filter: { where: "$.type == 'response_item' && $.payload.type == 'message'" },
        message_map: { role: '$.payload.role', content: '$.payload.content[0].text', timestamp_ms: '$.timestamp' } } } as any,
    { agentType: 'codex-cli', historySessionId: SID, workspace: dir })!;
    expect(builtin).toBeTruthy(); expect(spec).toBeTruthy();
    return [builtin, spec];
}
const start = () => event('task_started', START, { turn_id: 'new-turn' });
const complete = (id = 'new-turn', at = START + 2000, text: string | null = null) => event('task_complete', at, { turn_id: id, last_agent_message: text });
function analyze(result: ReturnType<typeof readers>[number], boundary = START) {
    return analyzeProbeTranscript({ ...result, status: 'idle', messages: result.messages.map((m: any) => ({ ...m, timestamp: m.receivedAt ?? m.timestamp })) }, { turnStartedAtMs: boundary, providerType: 'codex-cli' });
}
function evidence(result: ReturnType<typeof readers>[number]) {
    return probeEvidence(makeAttempt('generating', { consumedAt: START, providerType: 'codex-cli' }),
        { presence: 'present', transcript: analyze(result) }, { nowMs: START + 10_000, observedBy: 'dc', policy: POLICY })[0];
}

describe('Codex native producer terminal truth', () => {
    for (const [code, failure] of [['usage_limit_exceeded', 'usage_limit_exceeded'], ['server_overloaded', 'server_overloaded'], ['authentication_error', 'auth_failed']] as const) {
        it(`${code}: both real readers reject old final + failed null completion and commit truthful task_failed`, () => {
            for (const result of readers([message('old completed result', START - 1000), start(), event('error', START + 1000, { error: { type: code } }), complete()])) {
                const marker = selectTurnTerminalMarker(result.turnTerminalMarkers, START)!;
                expect(marker).toMatchObject({ outcome: 'failed', summary: '', turnId: 'new-turn', startedAt: START, errorAt: START + 1000, providerFailure: failure });
                expect(analyze(result).finalAssistantAt).toBeUndefined();
                expect(validateReadChatResultPayload({ id: SID, title: 'fixture', status: 'idle', messages: [], turnTerminalMarkers: result.turnTerminalMarkers }, 'fixture').turnTerminalMarkers).toEqual(result.turnTerminalMarkers);
                for (const weak of [false, true]) {
                    const emitted: any[] = [];
                    emitGeneratingCompleted({ instanceId: 's1', settings: {}, busyEpoch: 1, lastCompletionSummary: null, lastEmittedCompletion: null, pushEvent: () => {}, updateSettings: () => {},
                        currentAttemptRef: () => ({ attemptId: 'a1', generation: 1 }),
                        turnEvidencePort: createTurnEvidencePort({ observe: (e) => { emitted.push(e); } }) },
                    { chatTitle: 'fixture', timestamp: START + 2000, duration: 2, completionDiagnostic: { nativeTurnOutcome: marker.outcome, nativeProviderFailure: marker.providerFailure, nativeMarker: { outcome: marker.outcome, turnId: marker.turnId, receivedAt: marker.receivedAt, startedAt: marker.startedAt, errorAt: marker.errorAt }, ...(weak ? { blockReason: 'missing_final_assistant' } : {}) } });
                    expect(emitted).toHaveLength(1);
                    expect(isTurnEvidence(emitted[0])).toBe(true);
                    expect(emitted[0]).toMatchObject({ nativeOutcome: 'failed', providerFailure: failure, attemptRef: { attemptId: 'a1', generation: 1 } });
                    expect(reduce({ attempt: makeAttempt('generating'), holds: [], evidence: emitted[0], policy: POLICY, nowMs: START + 10_000 }).attempt?.state).toBe('failed');
                }
                const retro = probeEvidence(makeAttempt('delivered', { deliveredAt: START, consumedAt: null }), { presence: 'present', transcript: analyze(result) }, { nowMs: START + 10_000, observedBy: 'dc', policy: POLICY });
                expect(retro).toEqual([expect.objectContaining({ kind: 'turn_started', retro: true })]);
                const e = evidence(result);
                expect(isTurnEvidence(e)).toBe(true);
                expect(e).toMatchObject({ kind: 'turn_end', nativeOutcome: 'failed', nativeMarker: { turnId: 'new-turn', startedAt: START, errorAt: START + 1000, receivedAt: START + 2000 }, providerFailure: failure, attemptRef: { attemptId: 'a1', generation: 1 } });
                const r = reduce({ attempt: makeAttempt('generating', { consumedAt: START }), holds: [], evidence: e, policy: POLICY, nowMs: START + 10_000 });
                expect(r.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: `provider_${failure}`, strength: 'genuine' });
                expect(r.effects).toContainEqual(expect.objectContaining({ kind: 'task_terminal', outcome: 'failed' }));
                expect(admitTranscriptFinal(ev('transcript_final', { nativeRead: true, selfAttributing: false, nativeMarker: { outcome: 'failed' }, live: { modal: false, adapterPending: false, trailingTool: false } }) as any, POLICY).kind).toBe('decline');
                const db = memDb();
                try {
                    vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db } as any);
                    const ledger = ledgerOn(db, { now: () => START + 10_000 });
                    ledger.observe(dispatch({ scope: 'mesh_queue' }));
                    ledger.observe(evd('turn_started', { retro: false }, { at: START }));
                    ledger.observe({ ...e, attemptRef: { attemptId: 'a1', generation: 0 } });
                    expect(readTurnTerminalViews('m1')).toEqual([expect.objectContaining({ kind: 'task_failed', payload: expect.objectContaining({ reason: `provider_${failure}` }) })]);
                } finally { vi.restoreAllMocks(); db.close(); }
            }
        });
    }
    it('valid empty success and genuine final/legacy marker remain accepted; quoted errors are ordinary output', () => {
        for (const records of [[start(), complete()], [start(), event('error', START + 1000, { error: { type: 'server_overloaded' } }), complete('new-turn', START + 2000, 'Recovered and done')], [start(), message('quote: usage_limit_exceeded server_overloaded authentication_error', START + 1000), complete()], [complete('legacy', START + 2000, 'Done')]]) {
            for (const result of readers(records)) {
                expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START)?.outcome).toBe('completed');
                const r = reduce({ attempt: makeAttempt('generating', { consumedAt: START }), holds: [], evidence: evidence(result), policy: POLICY, nowMs: START + 10_000 });
                expect(r.attempt?.state).toBe('completed');
            }
        }
    });
    it('turn mismatch and late old terminal cannot prove a new attempt or retry ended', () => {
        for (const result of readers([start(), complete('old-turn')])) {
            expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START)).toBeNull();
            expect(evidence(result).kind).not.toBe('transcript_final');
        }
        for (const result of readers([start(), complete('new-turn', START + 20_000)])) expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START + 10_000)).toBeNull();
    });
    it('a retry resets errors; late previous-generation failures never mutate the new attempt', () => {
        for (const result of readers([start(), event('error', START + 1000, { error: { type: 'server_overloaded' } }), complete(), event('task_started', START + 3000, { turn_id: 'retry' }), complete('retry', START + 4000)])) {
            expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START + 3000)?.outcome).toBe('completed');
        }
        const r = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: ev('turn_end', { strength: 'genuine', nativeOutcome: 'failed', providerFailure: 'server_overloaded' }, { sessionId: 's0', attemptRef: { attemptId: 'a1', generation: 0 } }), policy: POLICY, nowMs: START });
        expect(r.attempt?.state).toBe('generating'); expect(r.attempt?.terminal).toBeNull();
    });
    it('a parked modal holds a failed native terminal without inventing a completion', () => {
        for (const result of readers([start(), event('error', START + 1000, { error: { type: 'usage_limit_exceeded' } }), complete()])) {
            const observation = { ...analyze(result), activeModal: true };
            const e = probeEvidence(makeAttempt('generating', { consumedAt: START }), { presence: 'present', transcript: observation }, { nowMs: START + 10_000, observedBy: 'dc', policy: POLICY })[0];
            const r = reduce({ attempt: makeAttempt('generating'), holds: [], evidence: e, policy: POLICY, nowMs: START + 10_000 });
            expect(r.attempt?.terminal).toBeNull();
            expect(r.holds).toContainEqual(expect.objectContaining({ reason: 'live_pending' }));
        }
    });
    it('unknown errors and unscoped failures fail closed; old quoted output never taints a new empty turn', () => {
        for (const result of readers([start(), event('error', START + 1000, { error: { type: 'unknown_failure' } }), complete()])) expect(evidence(result)).toMatchObject({ kind: 'turn_end', providerFailure: 'provider_error' });
        for (const result of readers([event('error', START - 1000, { error: { type: 'usage_limit_exceeded' } }), complete()])) expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START)).toBeNull();
        for (const result of readers([message('quoted server_overloaded', START - 1000), start(), event('error', START - 500, { error: { type: 'server_overloaded' } }), complete()])) expect(selectTurnTerminalMarker(result.turnTerminalMarkers, START)?.outcome).toBe('completed');
    });
    it('a prior worker-result JSON bubble cannot self-attribute to the new turn', () => {
        for (const result of readers([message('{"status":"completed","summary":"old"}', START - 1000), start()])) {
            expect(analyze(result)).toMatchObject({ selfAttributing: false });
            expect(analyze(result).finalSummary).toBeUndefined();
            expect(evidence(result).kind).not.toBe('transcript_final');
        }
    });
    it('an accepted report_completion tool_report retains authority over the failed null terminal', () => {
        const report = reduce({ attempt: makeAttempt('generating', { consumedAt: START }), holds: [], evidence: ev('worker_report', { outcome: 'completed', summary: REF, hasHandoffNotes: true }, { source: 'worker_tool' }), policy: POLICY, nowMs: START });
        for (const result of readers([start(), event('error', START + 1000, { error: { type: 'usage_limit_exceeded' } }), complete()])) {
            const r = reduce({ attempt: report.attempt, holds: [], evidence: evidence(result), policy: POLICY, nowMs: START + 10_000 });
            expect(r.attempt?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' });
        }
    });
});
