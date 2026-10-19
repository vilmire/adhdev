import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// S7 turn-ledger wiring (wiring-unification C integration): the ONE ledger
// wireTurnLedger builds is what the MCP turn IPC reads, every provider
// instance holds the evidence port over it, and mesh_index_query reads the
// same mesh_topic_index the cursors write — all unbound again on dispose.

const testTmpDir = path.join(tmpdir(), `adhdev-turn-wiring-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { wireTurnLedger } from '../../src/boot/stages/mesh-runtime.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { getActiveTurnLedgerForIpc, turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { meshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';
import { startTurnLoops, stopTurnLoops } from '../../src/boot/stages/loops.js';
import { __setSharedProcessTableSourceForTests, createProcessTableSource } from '../../src/process/process-table-snapshot.js';
import { parsePosixPsOutput, type ProcessNodeInfo } from '../../src/process/session-process-tree.js';
import type { TurnEvidencePort } from '../../src/providers/turn-evidence-port.js';

afterEach(() => {
    __setSharedProcessTableSourceForTests(null);
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function fakeComponents(settingsBySession: Record<string, Record<string, unknown>>) {
    const portCalls: Array<TurnEvidencePort | null> = [];
    const instanceManager = {
        setTurnEvidencePort: (port: TurnEvidencePort | null) => { portCalls.push(port); },
        listInstanceIds: () => Object.keys(settingsBySession),
        getInstance: (id: string) => (settingsBySession[id] ? { getState: () => ({ settings: settingsBySession[id] }) } : undefined),
    };
    const components = {
        bus: createSessionLifecycleBus(),
        instanceManager,
        // D2 (C-W8): notices submit through the daemon's one SessionInputService.
        cliManager: { input: { submit: async () => ({ kind: 'delivered' }) } },
        seqscribe: null,
        statusInstanceId: 'daemon_wiring',
    } as any;
    return { components, portCalls };
}

const baseEvidence = { at: 1_000, source: 'fsm_edge', observedBy: 'daemon_wiring' } as const;

describe('wireTurnLedger — S7 wiring', () => {
    it('binds the turn IPC to the ONE ledger + the notice runtime, and unbinds both on dispose', () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            expect(getActiveTurnLedgerForIpc()).toBe(wiring.ledger);
            expect(meshNoticeRuntime.current()).toBe(wiring.notices);
        } finally {
            wiring.dispose();
        }
        expect(getActiveTurnLedgerForIpc()).toBeNull();
        expect(meshNoticeRuntime.current()).toBeNull();
    });

    it('C-W5c: hands every instance the evidence port, and it is the SOLE producer — a plain session and a mesh-bound one both take every kind (no PORT_KINDS_FOR_MESH_SESSIONS gate); detached on dispose', () => {
        const { components, portCalls } = fakeComponents({ plain: {}, worker: { meshNodeFor: 'm1', meshActiveTaskId: 't1' } });
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            expect(portCalls).toHaveLength(1);
            const port = portCalls[0]!;
            expect(port).not.toBeNull();

            // Plain session: the port opens a plain attempt.
            port.observe({ ...baseEvidence, eventId: 'ev-plain-start', sessionId: 'plain', kind: 'turn_started', retro: false } as any);
            expect(wiring.ledger.openAttemptForSession('plain')).toMatchObject({ scope: 'plain' });
            expect(wiring.ledger.store.hasEvent('ev-plain-start')).toBe(true);

            // Mesh-bound session: this fake instanceManager carries no `category`/
            // `workspace`, so `resolveEvidenceOwner`'s `resolveWorkerDelegateRouting`
            // call rejects early (not_cli / no_workspace) — `ownerFor` resolves
            // `null`, which the port treats as "this daemon owns it" (the common
            // coordinator-local case), so EVERY kind reaches the ledger directly,
            // same as a plain session. This is the C-W5c behavior change: no gate
            // filters turn_started/turn_end/etc. out for a mesh-bound sessionId.
            port.observe({ ...baseEvidence, eventId: 'ev-worker-start', sessionId: 'worker', kind: 'turn_started', retro: false } as any);
            expect(wiring.ledger.store.hasEvent('ev-worker-start')).toBe(true);
            expect(wiring.ledger.openAttemptForSession('worker')).toMatchObject({ sessionId: 'worker' });
            // session_error still observes too (unchanged — it never needed the gate).
            port.observe({ ...baseEvidence, eventId: 'ev-worker-err', sessionId: 'worker', kind: 'session_error', reason: 'auth_failed' } as any);
            expect(wiring.ledger.store.hasEvent('ev-worker-err')).toBe(true);
        } finally {
            wiring.dispose();
        }
        expect(portCalls[portCalls.length - 1]).toBeNull();
    });

    it('C-W5c: a genuine mesh delegate worker (category cli, workspace, meshNodeFor + meshCoordinatorDaemonId) resolves a REMOTE owner via resolveEvidenceOwner — text is dropped (no appendHandoff wired in this fake), owner tag still reaches the ledger', async () => {
        const meshConfig = await import('../../src/config/mesh-config.js');
        (meshConfig.getMesh as any).mockReturnValue({ id: 'm1', nodes: [{ id: 'node_1', workspace: '/repo/wt' }], policy: {} });
        const instanceManager = {
            setTurnEvidencePort: (_port: TurnEvidencePort | null) => {},
            listInstanceIds: () => ['worker'],
            getInstance: (id: string) => (id === 'worker' ? {
                category: 'cli',
                getState: () => ({
                    instanceId: 'worker', workspace: '/repo/wt',
                    settings: { meshNodeFor: 'm1', meshNodeId: 'node_1', meshCoordinatorDaemonId: 'daemon_coord' },
                }),
            } : undefined),
        };
        const portCalls: Array<TurnEvidencePort | null> = [];
        const wrappedInstanceManager = { ...instanceManager, setTurnEvidencePort: (p: TurnEvidencePort | null) => { portCalls.push(p); } };
        const components = {
            bus: createSessionLifecycleBus(),
            instanceManager: wrappedInstanceManager,
            cliManager: { input: { submit: async () => ({ kind: 'delivered' }) } },
            seqscribe: null,
            statusInstanceId: 'daemon_wiring',
        } as any;
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const port = portCalls[0]!;
            // A real remote-owned worker producer carries its own attemptRef
            // (e.g. `host.currentAttemptRef()` in completion-flush.ts, sourced
            // from `settings.meshActiveAttemptId`/generation) — the ledger's
            // `forward()` path requires one (`no_attempt` otherwise), since a
            // remote owner's attempt is not something this daemon ever opened.
            port.observe({ ...baseEvidence, eventId: 'ev-remote-start', sessionId: 'worker', kind: 'turn_started', retro: false, attemptRef: { attemptId: 'att_remote_1', generation: 1 } } as any);
            expect(wiring.ledger.store.hasEvent('ev-remote-start')).toBe(true);
            // A remote-owned evidence takes the ledger's `forward()` path (never
            // opens a LOCAL attempt — that is the owner daemon's job on its own
            // machine): the row is recorded with verdict 'forwarded', proving
            // resolveEvidenceOwner found the coordinator anchor and the ledger
            // routed by it, not that this daemon adopted the attempt.
            const row = wiring.ledger.store.getEvent('ev-remote-start');
            expect(row).toMatchObject({ sessionId: 'worker', verdict: 'forwarded' });
            // No local attempt is opened for a forwarded (remote-owned) evidence.
            expect(wiring.ledger.openAttemptForSession('worker')).toBeNull();
        } finally {
            wiring.dispose();
        }
    });

    it('mesh_index_query reads the bound mesh_topic_index, re-projected onto the mesh_record allow-list', async () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const meshId = 'mesh_idx';
            expect(wiring.index.ingest({
                meshId, writer: 'w-peer', seq: 1, kind: 'adhdev.mesh.ledger',
                payload: {
                    id: 'rec-1', timestamp: new Date(5_000).toISOString(), ledgerKind: 'task_dispatched', taskId: 't1', nodeId: 'n1',
                    payload: { taskId: 't1', status: 'assigned', finalSummary: 'AGENT TEXT MUST NOT CROSS' },
                },
            })).toBe(true);
            const result: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId, writer: 'fleet' });
            expect(result.success).toBe(true);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0]).toMatchObject({ writer: 'w-peer', seq: 1, meshId, eventId: 'rec-1', kind: 'task_dispatched', taskId: 't1' });
            expect(result.rows[0].payload).toEqual({ taskId: 't1', status: 'assigned' });
            expect(JSON.stringify(result)).not.toContain('AGENT TEXT');
            // Own scope with no seqscribe writer (standalone without a node) answers empty, not the fleet.
            const own: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId, writer: 'own' });
            expect(own).toMatchObject({ success: true, rows: [] });
        } finally {
            wiring.dispose();
        }
        const unbound: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId: 'mesh_idx' });
        expect(unbound).toMatchObject({ success: false, code: 'turn_ledger_unavailable', rows: [] });
    });

    it('mesh_record answers the real append coordinate: seq 0 = not appended (no seqscribe node in this process)', async () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const result: any = await turnLedgerIpcHandlers.mesh_record!({} as any, { v: 1, meshId: 'mesh_rec', ledgerKind: 'task_dispatched', payload: { taskId: 't1' } });
            expect(result.success).toBe(true);
            expect(typeof result.eventId).toBe('string');
            expect(result.seq).toBe(0);
        } finally {
            wiring.dispose();
        }
    });

    it('7a: production backgroundWork monitor has nudgeWorker wired to cliManager.input.submit (resolving sessionRegistry adapterKey)', async () => {
        const submitted: any[] = [];
        const { components } = fakeComponents({ worker_inst: { meshNodeFor: 'm1', meshActiveTaskId: 't1' } });
        components.sessionRegistry = {
            get: (id: string) => (id === 'sess_worker_1' ? { adapterKey: 'adapter_worker_1', instanceKey: 'worker_inst' } : undefined),
        };
        components.cliManager = {
            input: {
                submit: vi.fn(async (req: any) => {
                    submitted.push(req);
                    return { kind: 'delivered' };
                }),
            },
        };
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const attempt: any = {
                attemptId: 'att_bg_1',
                generation: 0,
                scope: 'mesh',
                state: 'generating',
                terminal: null,
                sessionId: 'sess_worker_1',
                meshId: 'm1',
                nodeId: 'n1',
                taskId: 't1',
                coordinator: { daemonId: 'daemon_wiring', sessionId: 'sess_coord_1' },
                ownerDaemonId: 'daemon_wiring',
                workerDaemonId: 'daemon_wiring',
                startedAt: 1_000,
                updatedAt: 1_000,
                lastLiveness: null,
                data: {},
            };
            // First observation with a live background child holds the turn:
            const held = await wiring.backgroundWork.observe({
                attempt,
                nowMs: 2_000,
                status: 'idle',
                liveBackgroundProcesses: ['sleep'],
                processesKnown: true,
            });
            expect(held.holdTurnEnd).toBe(true);
            expect(held.nudgedWorker).toBe(false);
            expect(submitted).toHaveLength(0);

            // Second observation after the background child exits sends the nudge via cliManager.input.submit:
            const exited = await wiring.backgroundWork.observe({
                attempt,
                nowMs: 5_000,
                status: 'idle',
                liveBackgroundProcesses: [],
                processesKnown: true,
            });
            expect(exited.holdTurnEnd).toBe(true);
            expect(exited.nudgedWorker).toBe(true);
            expect(submitted).toHaveLength(1);
            expect(submitted[0]).toMatchObject({
                messageId: 'bg-nudge:att_bg_1:g0',
                sessionId: 'adapter_worker_1',
                origin: 'mesh',
                policy: { mode: 'queue' },
            });
        } finally {
            wiring.dispose();
        }
    });

    it('emits 120s coordinator notice naming real process while codex-cli background work is live (PTY held generating by background-terminal footer), then nudges and releases after exit without holding on sidecar', async () => {
        const T0 = 1_792_411_000_000;
        let currentNowMs = T0;
        vi.spyOn(Date, 'now').mockImplementation(() => currentNowMs);
        let instanceStatus: 'generating' | 'idle' = 'generating';
        let sleepRunning = true;
        let turnEndedInTranscript = false;
        const submitted: any[] = [];

        const buildPsTable = (): ProcessNodeInfo[] => {
            const lines = [
                // Root codex PTY process (started 30s before T0)
                '20000     1    01:00   00:01.00 codex            codex --dangerously-bypass-approvals-and-sandbox',
                // Lazy sidecar spawned during the turn with macOS truncated comm '.' (started at T0 + 15_000)
                '20010 20000    00:05   00:00.10 .                /Users/dev/.nvm/versions/node/v22.22.0/bin/node /Users/dev/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/bin/codex-code-mode-host.js',
            ];
            if (sleepRunning) {
                lines.push(
                    '20020 20000    00:02   00:00.01 /bin/zsh         /bin/zsh -lc sleep 150 && echo done',
                    '20021 20020    00:02   00:00.00 sleep            sleep 150',
                );
            }
            const parsed = parsePosixPsOutput(lines.join('\n'), T0 + 20_000);
            return parsed.map((row) => {
                if (row.pid === 20000) return { ...row, startedAtMs: T0 - 30_000 };
                if (row.pid === 20010) return { ...row, startedAtMs: T0 + 15_000 };
                return { ...row, startedAtMs: T0 + 18_000 };
            });
        };

        __setSharedProcessTableSourceForTests(
            createProcessTableSource({
                now: () => currentNowMs,
                ttlMs: 0,
                maxStaleMs: 600_000,
                read: async () => buildPsTable(),
            }),
        );

        const workerInstance = {
            category: 'cli',
            getState: () => ({
                instanceId: 'inst_worker_c1',
                status: instanceStatus,
                pid: 20000,
                settings: { meshNodeFor: 'm1', meshNodeId: 'n1', meshActiveTaskId: 'task_c1' },
            }),
            adapter: {
                getPid: () => 20000,
                getStatus: () => ({ status: instanceStatus, lastOutputAt: T0 + 21_000 }),
            },
        };

        const { components } = fakeComponents({});
        components.instanceManager = {
            setTurnEvidencePort: () => {},
            listInstanceIds: () => ['inst_worker_c1'],
            getInstance: (id: string) => (id === 'inst_worker_c1' || id === 'sess_worker_c1' ? workerInstance : undefined),
        };
        components.sessionRegistry = {
            has: (id: string) => id === 'sess_worker_c1',
            get: (id: string) => (id === 'sess_worker_c1'
                ? { sessionId: 'sess_worker_c1', instanceKey: 'inst_worker_c1', adapterKey: 'adapter_worker_c1', transport: 'pty', status: instanceStatus }
                : undefined),
            list: () => [],
        };
        components.providerLoader = {
            getAvailableProviderInfos: () => [],
        };
        components.cliManager = {
            input: {
                submit: vi.fn(async (req: any) => {
                    submitted.push({ at: currentNowMs, req });
                    return { kind: 'delivered' };
                }),
            },
        };
        components.commandHandler = {
            handle: vi.fn(async (cmd: string) => {
                if (cmd !== 'read_chat') return { success: false };
                if (!turnEndedInTranscript) {
                    return {
                        success: true,
                        status: 'generating',
                        providerObservedStatus: 'generating',
                        turnTerminalMarkers: [],
                        messages: [
                            { role: 'user', content: 'start sleep 150', timestamp: new Date(T0 + 14_000).toISOString() },
                        ],
                    };
                }
                return {
                    success: true,
                    // Raw PTY status stays 'generating' while `1 background terminal running` is on screen,
                    // whereas native rollout markers reconcile providerObservedStatus to 'idle'.
                    status: instanceStatus,
                    providerObservedStatus: 'idle',
                    turnTerminalMarkers: [
                        { receivedAt: T0 + 21_000, outcome: 'completed', turnId: 'turn_c1' },
                    ],
                    messages: [
                        { role: 'user', content: 'start sleep 150', timestamp: new Date(T0 + 14_000).toISOString() },
                        {
                            role: 'assistant',
                            content: 'Background sleep 150 started; ending turn without calling report_completion yet.',
                            timestamp: new Date(T0 + 21_000).toISOString(),
                        },
                    ],
                };
            }),
        };

        const wiring = wireTurnLedger(components, { runMigration: false });
        components.turnLedger = wiring.ledger;
        components.turnProbePort = wiring.probePort;
        components.meshTurn = wiring;
        startTurnLoops(components);
        // Stop background interval timers so deterministic `turnScheduler.tick(nowMs)` drives time.
        components.turnScheduler!.stop();

        try {
            const attemptId = 'att_c1_live_notice';
            expect(wiring.ledger.observe({
                eventId: 'ev_c1_enq',
                at: T0 + 5_000,
                source: 'dispatch',
                observedBy: 'daemon_wiring',
                sessionId: 'sess_worker_c1',
                kind: 'dispatch_accepted',
                scope: 'mesh_direct',
                attemptRef: { attemptId, generation: 0 },
                messageId: 'msg_c1_1',
                meshId: 'm1',
                nodeId: 'n1',
                taskId: 'task_c1',
                providerType: 'codex-cli',
                coordinator: { daemonId: 'daemon_wiring', coordinatorRunId: 'run_c1', sessionId: 'sess_coord_1' },
            } as any).rule).toBe('R1');
            expect(wiring.ledger.observe({
                eventId: 'ev_c1_deliv',
                at: T0 + 6_000,
                source: 'input_service',
                observedBy: 'daemon_wiring',
                sessionId: 'sess_worker_c1',
                kind: 'delivered',
                attemptRef: { attemptId, generation: 0 },
                messageId: 'msg_c1_1',
                outcome: 'delivered',
                via: 'local',
            } as any).rule).toBe('R2');

            // Pre-turn probe while in `delivered` state (stamps last_probe_at = T0 + 8_000, matching live C1-retry):
            currentNowMs = T0 + 8_000;
            await components.turnScheduler!.tick(currentNowMs);

            // Worker turn starts at T0 + 14_000:
            currentNowMs = T0 + 14_000;
            expect(wiring.ledger.observe({
                eventId: 'ev_c1_start',
                at: T0 + 14_000,
                source: 'fsm_edge',
                observedBy: 'daemon_wiring',
                sessionId: 'sess_worker_c1',
                kind: 'turn_started',
                attemptRef: { attemptId, generation: 0 },
                retro: false,
            } as any).rule).toBe('R4');

            // Worker launches `sleep 150` at T0 + 18_000 and ends its assistant turn at T0 + 21_000
            // without calling report_completion. PTY screen stays 'generating' due to background terminal footer.
            turnEndedInTranscript = true;

            // Tick every 4s up to T0 + 144_000 (123s after turn ended at T0 + 21_000, while sleep 150 is still running
            // and has 24s remaining before exiting at T0 + 168_000):
            const noticeEventId = `background_work_timeout:m1:task_c1:sess_worker_c1:${attemptId}:g0`;
            for (let t = T0 + 24_000; t <= T0 + 144_000; t += 4_000) {
                currentNowMs = t;
                await components.turnScheduler!.tick(currentNowMs);
                if (t < T0 + 141_000) expect(wiring.ledger.store.getEvent(noticeEventId)).toBeNull();
            }

            // 1. At ~120s into the background hold (while sleep 150 is still alive), the coordinator notice MUST have fired once:
            const timeoutNoticeRow = wiring.ledger.store.getEvent(noticeEventId);
            expect(timeoutNoticeRow).not.toBeNull();
            expect(timeoutNoticeRow).toMatchObject({
                eventId: noticeEventId,
                kind: 'notify',
                verdict: 'applied',
                atMs: T0 + 144_000,
            });
            expect(wiring.ledger.getAttempt(attemptId)?.terminal).toBeNull();
            expect((timeoutNoticeRow as any)?.payload?.event).toBe('mesh:background_work_no_results');
            const noticeText = String((timeoutNoticeRow as any)?.payload?.local?.payload?.coordinatorMessage ?? '');
            expect(noticeText).toContain('background work still running (live processes:');
            expect(noticeText).toContain('sleep');
            expect(noticeText).not.toContain('(live processes: .)');
            expect(noticeText).not.toContain('codex-code-mode-host');

            // No worker nudge yet while sleep 150 is still alive:
            expect(submitted.filter((s) => String(s.req?.messageId).startsWith('bg-nudge:'))).toHaveLength(0);

            // 2. At T0 + 168_000 (150s after T0 + 18_000), sleep 150 exits; only codex + sidecar codex-code-mode-host remain:
            sleepRunning = false;
            instanceStatus = 'idle';
            currentNowMs = T0 + 172_000;
            await components.turnScheduler!.tick(currentNowMs);

            const nudges = submitted.filter((s) => String(s.req?.messageId).startsWith('bg-nudge:'));
            expect(nudges).toHaveLength(1);
            expect(nudges[0]!.req).toMatchObject({
                messageId: `bg-nudge:${attemptId}:g0`,
                sessionId: 'adapter_worker_c1',
                origin: 'mesh',
            });

            // 3. After the 180s post-nudge grace expires with no worker report (T0 + 360_000, well before the 600s inactivity release),
            // the hold releases instead of holding 10m on the sidecar:
            for (let t = T0 + 176_000; t <= T0 + 360_000; t += 4_000) {
                currentNowMs = t;
                await components.turnScheduler!.tick(currentNowMs);
            }
            expect(wiring.backgroundWork.isReleased(attemptId, 0)).toBe(true);
            expect(wiring.ledger.getAttempt(attemptId)?.state).toBe('completed');
            // Still only 1 background_work_timeout notice row (no duplicate notice on release):
            const allTimeoutNotices = wiring.ledger.store.db
                .prepare(`SELECT event_id FROM turn_events WHERE event_id LIKE 'background_work_timeout:%'`)
                .all();
            expect(allTimeoutNotices).toHaveLength(1);
        } finally {
            stopTurnLoops(components);
            wiring.dispose();
        }
    });
});
