import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE,
  createBackgroundWorkMonitor,
  evaluateTurnEndBackgroundWork,
} from '../../src/mesh/turn-ledger/background-work-guard.js';
import { createTurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from '../../src/mesh/turn-ledger/policy.js';
import {
  createComponentsProbeReader,
  type TranscriptAnalyzer,
} from '../../src/mesh/turn-ledger/probe.js';
import { createTurnScheduler } from '../../src/mesh/turn-ledger/scheduler.js';
import { TurnStore } from '../../src/mesh/turn-ledger/store.js';
import {
  inspectSessionProcessTree,
  parsePosixPsOutput,
  parseWin32ProcessOutput,
  sanitizeProcessCommandName,
  SESSION_PROCESS_EXCLUSIONS,
  type ProcessNodeInfo,
} from '../../src/process/session-process-tree.js';
import { analyzeProbeTranscript } from '../../src/boot/stages/loops.js';
import { dispatch, evd, LIVE_IDLE, memDb, SUMMARY, T0 } from './ledger-harness.js';

const SELF = 'dc';

const TEST_POLICY: TurnPolicy = {
  ...DEFAULT_TURN_POLICY,
  tickMs: 1_000,
  quietWindowMs: 500,
  weakConfirmCapMs: 4_000,
  awaitReportMs: 10_000,
  stallNoticeMs: 60_000,
};

function createFakeWorkerFixture(opts?: {
  taskId?: string;
  attemptId?: string;
  sessionId?: string;
  ptyPid?: number;
  timeoutMs?: number;
}) {
  const taskId = opts?.taskId ?? '2c1bdbd2';
  const attemptId = opts?.attemptId ?? `a-${taskId}`;
  const sessionId = opts?.sessionId ?? 'sess-worker-1';
  const ptyPid = opts?.ptyPid ?? 4000;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  let clock = T0;
  let workerStatus = 'generating';
  let workerMessages: Array<{ role: string; content: string; timestamp: string }> = [];
  let currentProcessTable: readonly ProcessNodeInfo[] = [
    { pid: ptyPid, ppid: 1, comm: '-zsh', args: '-zsh' },
    { pid: ptyPid + 1, ppid: ptyPid, comm: 'node', args: 'node /usr/local/bin/agy --headless' },
  ];

  const db = memDb();
  db.exec(`
    CREATE TABLE mesh_queue (
      mesh_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (mesh_id, task_id)
    );
  `);
  db.prepare(`INSERT INTO mesh_queue (mesh_id, task_id, status) VALUES (?, ?, 'assigned')`).run(
    'm1',
    taskId,
  );

  const store = new TurnStore(db);
  const nudges: Array<{ sessionId: string; text: string; messageId: string; reason: string; at: number }> = [];
  const coordinatorNotices: Array<{
    coordinatorSessionId: string | null;
    text: string;
    sessionId: string;
    taskId: string | null;
    liveProcessNames: readonly string[];
    at: number;
  }> = [];

  const inspectTreeForPid = (pid: number | undefined) =>
    inspectSessionProcessTree(pid, {
      processTable: currentProcessTable,
      selfPid: 999999,
      platform: 'darwin',
    });

  let schedulerRef: ReturnType<typeof createTurnScheduler> | undefined;

  const ledger = createTurnLedger({
    db,
    store,
    selfDaemonId: SELF,
    policy: TEST_POLICY,
    now: () => clock,
    autoFlush: false,
    inspectBackgroundProcesses: (sid) => {
      if (sid !== sessionId) return undefined;
      const tree = inspectTreeForPid(ptyPid);
      return tree.liveProcessNames.length > 0 ? tree.liveProcessNames : undefined;
    },
    host: {
      requeue(effect) {
        db.prepare(`UPDATE mesh_queue SET status = 'pending' WHERE mesh_id = ? AND task_id = ?`).run(
          effect.meshId,
          effect.taskId,
        );
      },
      taskTerminal(effect) {
        db.prepare(`UPDATE mesh_queue SET status = ? WHERE mesh_id = ? AND task_id = ?`).run(
          effect.outcome,
          effect.meshId,
          effect.taskId,
        );
        return { transitioned: true };
      },
    },
    ports: {
      probe: ({ attemptId: id }) => {
        schedulerRef?.requestProbe(id);
      },
    },
  });

  const backgroundWork = createBackgroundWorkMonitor({
    timeoutMs,
    nudgeWorker: (sid, text, meta) => {
      nudges.push({
        sessionId: sid,
        text,
        messageId: meta.messageId,
        reason: meta.reason,
        at: clock,
      });
    },
    notifyCoordinator: (coordSid, text, meta) => {
      coordinatorNotices.push({
        coordinatorSessionId: coordSid,
        text,
        sessionId: meta.sessionId,
        taskId: meta.taskId,
        liveProcessNames: meta.liveProcessNames,
        at: meta.at,
      });
    },
  });

  const fakeComponents = {
    sessionRegistry: {
      get: (sid: string) =>
        sid === sessionId ? { sessionId, instanceKey: sessionId, transport: 'pty' as const } : undefined,
    },
    instanceManager: {
      getInstance: (key: string) =>
        key === sessionId
          ? {
              getState: () => ({ status: workerStatus }),
              adapter: { getPid: () => ptyPid },
            }
          : undefined,
    },
    commandHandler: {
      handle: async (cmd: string) => {
        if (cmd === 'read_chat') {
          return {
            success: true,
            status: workerStatus,
            providerObservedStatus: workerStatus,
            messages: workerMessages,
          };
        }
        return { success: true };
      },
    },
  };

  const reader = createComponentsProbeReader(fakeComponents as any, {
    analyzer: analyzeProbeTranscript as TranscriptAnalyzer,
    inspectProcessTree: inspectTreeForPid,
  });

  const scheduler = createTurnScheduler({
    ledger,
    store,
    policy: TEST_POLICY,
    selfDaemonId: SELF,
    now: () => clock,
    backgroundWork,
    probe: {
      reader,
      locate: () => ({ kind: 'local' }),
    },
  });
  schedulerRef = scheduler;

  // Open dispatch -> delivered -> turn_started so the worker attempt is in `generating` (generation 0).
  expect(
    ledger.observe(
      dispatch({
        attemptId,
        session: sessionId,
        scope: 'mesh_queue',
        meshId: 'm1',
        taskId,
      }),
    ).rule,
  ).toBe('R1');
  expect(
    ledger.observe(
      evd(
        'delivered',
        { messageId: 'msg-1', outcome: 'delivered', via: 'local' },
        {
          at: clock + 10,
          source: 'input_service',
          sessionId,
          observedBy: SELF,
          attemptRef: { attemptId, generation: 0 },
        },
      ),
    ).rule,
  ).toBe('R2');
  expect(
    ledger.observe(
      evd(
        'turn_started',
        { retro: false },
        {
          at: clock + 20,
          sessionId,
          observedBy: SELF,
          attemptRef: { attemptId, generation: 0 },
        },
      ),
    ).rule,
  ).toBe('R4');
  clock = T0 + 1_000;

  return {
    attemptId,
    taskId,
    sessionId,
    db,
    store,
    ledger,
    scheduler,
    backgroundWork,
    nudges,
    coordinatorNotices,
    get now() {
      return clock;
    },
    advance(deltaMs: number) {
      clock += deltaMs;
    },
    setWorkerState(patch: {
      status?: string;
      messages?: Array<{ role: string; content: string; timestamp: string }>;
      processTable?: readonly ProcessNodeInfo[];
    }) {
      if (patch.status !== undefined) workerStatus = patch.status;
      if (patch.messages !== undefined) workerMessages = patch.messages;
      if (patch.processTable !== undefined) currentProcessTable = patch.processTable;
    },
    queueStatus(tid = taskId) {
      const row = db
        .prepare(`SELECT status FROM mesh_queue WHERE mesh_id = 'm1' AND task_id = ?`)
        .get(tid) as { status: string } | undefined;
      return row?.status;
    },
    notifiesForAttempt(aid = attemptId) {
      const rows = db
        .prepare(`SELECT payload_json FROM turn_events WHERE attempt_id = ? AND kind = 'notify' ORDER BY recorded_at ASC`)
        .all(aid) as Array<{ payload_json: string }>;
      return rows.map((r) => {
        const parsed = JSON.parse(r.payload_json) as { entry?: { notify?: string } } & Record<string, unknown>;
        return { notify: String(parsed.entry?.notify ?? ''), payload: parsed };
      });
    },
  };
}

describe('premature weak completion when worker ends turn with background work running', () => {
  describe('(A) Turn ends with a live background child and no report_completion', () => {
    it('(A1) keeps task in-progress (not completed) while child runs, sends exactly one nudge when child exits, and never loops the nudge', async () => {
      const fx = createFakeWorkerFixture({
        taskId: '2c1bdbd2',
        sessionId: 'sess-worker-2c1bdbd2',
        ptyPid: 5000,
        timeoutMs: 60_000,
      });
      const waitingLine =
        'Running `npm run test:scripts 2>&1 | tee /tmp/test-scripts.log` in the background. Waiting for it to complete.';

      // Worker starts background job `npm run test:scripts 2>&1 | tee /tmp/...` (with secret arg)
      // alongside long-lived MCP and LSP helpers, writes waiting line, and ends its turn.
      fx.setWorkerState({
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: waitingLine,
            timestamp: new Date(T0 + 500).toISOString(),
          },
        ],
        processTable: [
          { pid: 5000, ppid: 1, comm: '-zsh', args: '-zsh' },
          { pid: 5001, ppid: 5000, comm: 'agy', args: 'agy --session sess-worker-2c1bdbd2' },
          // Long-lived helpers that must be excluded:
          { pid: 5002, ppid: 5001, comm: 'node', args: 'node /opt/adhdev-mcp/dist/index.js --stdio' },
          { pid: 5003, ppid: 5001, comm: 'tsserver', args: 'tsserver --useInferredProjectPerProjectRoot' },
          // Worker-started background pipeline:
          {
            pid: 5010,
            ppid: 5001,
            comm: '/usr/local/bin/npm',
            args: '/usr/local/bin/npm run test:scripts --api-key=secret-token-123',
          },
          {
            pid: 5011,
            ppid: 5010,
            comm: '/usr/bin/tee',
            args: '/usr/bin/tee /tmp/test-scripts-secret.log',
          },
        ],
      });

      // Provider-side premature weak turn_end arrives:
      fx.ledger.observe(
        evd(
          'turn_end',
          { strength: 'weak', live: LIVE_IDLE },
          {
            at: fx.now,
            sessionId: fx.sessionId,
            observedBy: SELF,
            attemptRef: { attemptId: fx.attemptId, generation: 0 },
          },
        ),
        { envelope: { finalSummary: waitingLine } },
      );

      // Tick scheduler across the weak_candidate window (4s) and await_report window (10s).
      await fx.scheduler.tick();
      fx.advance(5_000);
      await fx.scheduler.tick();
      fx.advance(12_000);
      await fx.scheduler.tick();

      // Task MUST NOT be completed or finalizing, and no weak candidate/completed notice emitted:
      const attemptWhileRunning = fx.store.getAttempt(fx.attemptId)!;
      expect(attemptWhileRunning.state).toBe('generating');
      expect(attemptWhileRunning.terminal).toBeNull();
      expect(fx.queueStatus()).toBe('assigned');
      expect(fx.notifiesForAttempt()).toEqual([]);
      expect(fx.nudges).toHaveLength(0);
      expect(fx.coordinatorNotices).toHaveLength(0);

      // Now the worker's background child processes (5010 npm, 5011 tee) exit,
      // leaving only the root PTY, CLI binary, MCP server, and tsserver:
      fx.setWorkerState({
        processTable: [
          { pid: 5000, ppid: 1, comm: '-zsh', args: '-zsh' },
          { pid: 5001, ppid: 5000, comm: 'agy', args: 'agy --session sess-worker-2c1bdbd2' },
          { pid: 5002, ppid: 5001, comm: 'node', args: 'node /opt/adhdev-mcp/dist/index.js --stdio' },
          { pid: 5003, ppid: 5001, comm: 'tsserver', args: 'tsserver --useInferredProjectPerProjectRoot' },
        ],
      });

      fx.advance(2_000);
      await fx.scheduler.tick();

      // Exactly ONE bounded auto-nudge is sent to the worker session:
      expect(fx.nudges).toHaveLength(1);
      expect(fx.nudges[0]).toMatchObject({
        sessionId: 'sess-worker-2c1bdbd2',
        text: BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE,
        reason: 'live_background_processes',
      });

      // Subsequent ticks while waiting for the worker to respond must NOT loop the nudge
      // and must NOT complete the task with the old waiting text:
      fx.advance(5_000);
      await fx.scheduler.tick();
      fx.advance(5_000);
      await fx.scheduler.tick();
      expect(fx.nudges).toHaveLength(1);
      expect(fx.store.getAttempt(fx.attemptId)!.state).toBe('generating');
      expect(fx.queueStatus()).toBe('assigned');
    });

    it('(A2) emits exactly one coordinator notice with sanitized process names (no args/secrets) if the background child never exits before timeout', async () => {
      const fx = createFakeWorkerFixture({
        taskId: '2c1bdbd2-timeout',
        sessionId: 'sess-worker-timeout',
        ptyPid: 6000,
        timeoutMs: 25_000,
      });

      fx.setWorkerState({
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: 'Running `npm run test:scripts` in the background. Waiting for it to complete.',
            timestamp: new Date(T0 + 500).toISOString(),
          },
        ],
        processTable: [
          { pid: 6000, ppid: 1, comm: 'zsh', args: 'zsh' },
          { pid: 6001, ppid: 6000, comm: 'claude', args: 'claude' },
          {
            pid: 6010,
            ppid: 6001,
            comm: '/usr/local/bin/npm',
            args: '/usr/local/bin/npm run test:scripts --secret=TOP_SECRET_VALUE',
          },
          {
            pid: 6011,
            ppid: 6010,
            comm: '/usr/bin/tee',
            args: '/usr/bin/tee /tmp/private-token-xyz.log',
          },
        ],
      });

      // Force initial probe when turn ends:
      fx.scheduler.requestProbe(fx.attemptId);
      await fx.scheduler.tick();
      expect(fx.coordinatorNotices).toHaveLength(0);
      expect(fx.nudges).toHaveLength(0);
      expect(fx.queueStatus()).toBe('assigned');

      // Advance 15s (< 25s timeout): still no coordinator notice or completion.
      fx.advance(15_000);
      await fx.scheduler.tick();
      expect(fx.coordinatorNotices).toHaveLength(0);
      expect(fx.store.getAttempt(fx.attemptId)!.state).toBe('generating');

      // Advance past the 25s timeout (total elapsed = 26s):
      fx.advance(11_000);
      await fx.scheduler.tick();

      expect(fx.coordinatorNotices).toHaveLength(1);
      const notice = fx.coordinatorNotices[0]!;
      expect(notice.text).toContain('ended turn with background work running, no results');
      expect(notice.text).toContain('sess-worker-timeout');
      expect(notice.text).toContain('2c1bdbd2-timeout');
      expect(notice.text).toContain('npm, tee');
      // Must NOT leak arguments or secrets:
      expect(notice.text).not.toContain('TOP_SECRET_VALUE');
      expect(notice.text).not.toContain('private-token-xyz');
      expect(notice.text).not.toContain('test:scripts');
      expect(notice.liveProcessNames).toEqual(['npm', 'tee']);
      expect(fx.backgroundWork.getEntry(fx.attemptId)?.resolution).toBe('no_results');

      // Further ticks must NOT emit a second coordinator notice or nudge:
      fx.advance(10_000);
      await fx.scheduler.tick();
      fx.advance(20_000);
      await fx.scheduler.tick();
      expect(fx.coordinatorNotices).toHaveLength(1);
      expect(fx.nudges).toHaveLength(0);
      expect(fx.queueStatus()).toBe('assigned');
    });
  });

  describe('(B) Turn ends with "waiting for it to complete" final text and no report, but child already exited', () => {
    it('resolves as "no_results" rather than a silent/weak completion and sends a single nudge to the worker', async () => {
      const fx = createFakeWorkerFixture({
        taskId: '9af9ee9f',
        sessionId: 'sess-worker-9af9ee9f',
        ptyPid: 7000,
        timeoutMs: 30_000,
      });
      const waitingSummary =
        'Running `npm run test:scripts | wc -c` in the background. Waiting for it to complete.';

      // Child has ALREADY exited (only root PTY + provider CLI remain),
      // but there is no report_completion and the final text is the waiting line:
      fx.setWorkerState({
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: waitingSummary,
            timestamp: new Date(T0 + 500).toISOString(),
          },
        ],
        processTable: [
          { pid: 7000, ppid: 1, comm: '-zsh', args: '-zsh' },
          { pid: 7001, ppid: 7000, comm: 'agy', args: 'agy' },
        ],
      });

      // Provider-side turn_end arrives with the waiting line:
      fx.ledger.observe(
        evd(
          'turn_end',
          { strength: 'weak', live: LIVE_IDLE },
          {
            at: fx.now,
            sessionId: fx.sessionId,
            observedBy: SELF,
            attemptRef: { attemptId: fx.attemptId, generation: 0 },
          },
        ),
        { envelope: { finalSummary: waitingSummary } },
      );

      await fx.scheduler.tick();

      // Resolved as 'no_results' rather than a silent/weak completion, with a single nudge:
      expect(fx.store.getAttempt(fx.attemptId)!.state).toBe('generating');
      expect(fx.store.getAttempt(fx.attemptId)!.terminal).toBeNull();
      expect(fx.queueStatus()).toBe('assigned');
      expect(fx.notifiesForAttempt()).toEqual([]);
      expect(fx.backgroundWork.getEntry(fx.attemptId)?.resolution).toBe('no_results');
      expect(fx.nudges).toHaveLength(1);
      expect(fx.nudges[0]).toMatchObject({
        sessionId: 'sess-worker-9af9ee9f',
        text: BACKGROUND_WORK_FINISHED_NUDGE_MESSAGE,
        reason: 'pending_background_work_text',
      });

      // Advance past weak_candidate / await_report windows: still not completed, no duplicate nudge:
      fx.advance(5_000);
      await fx.scheduler.tick();
      fx.advance(15_000);
      await fx.scheduler.tick();
      expect(fx.nudges).toHaveLength(1);
      expect(fx.store.getAttempt(fx.attemptId)!.state).toBe('generating');
      expect(fx.queueStatus()).toBe('assigned');
    });
  });

  describe('Controls: structured report_completion and normal turn-end summary', () => {
    it('Control 1: a normal report_completion completes immediately even if background processes exist', async () => {
      const fx = createFakeWorkerFixture({
        taskId: 'ctrl-report',
        sessionId: 'sess-ctrl-report',
        ptyPid: 8000,
      });

      fx.setWorkerState({
        processTable: [
          { pid: 8000, ppid: 1, comm: 'zsh', args: '/bin/zsh -l' },
          { pid: 8001, ppid: 8000, comm: 'node', args: 'node background-helper.js' },
        ],
      });

      const reportAt = fx.now;
      const reportSummary = 'Fixed premature weak completion and verified regression tests.';
      fx.ledger.observe(
        evd(
          'worker_report',
          {
            outcome: 'completed',
            summary: SUMMARY,
            hasHandoffNotes: false,
          },
          {
            at: reportAt,
            source: 'worker_tool',
            sessionId: fx.sessionId,
            observedBy: SELF,
            attemptRef: { attemptId: fx.attemptId, generation: 0 },
            taskId: fx.taskId,
          },
        ),
        {
          envelope: {
            finalSummary: reportSummary,
          },
        },
      );

      fx.setWorkerState({
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: reportSummary,
            timestamp: new Date(reportAt).toISOString(),
          },
        ],
      });

      fx.advance(TEST_POLICY.quietWindowMs + 100);
      fx.scheduler.requestProbe(fx.attemptId);
      await fx.scheduler.tick();

      const attempt = fx.store.getAttempt(fx.attemptId)!;
      expect(attempt.state).toBe('completed');
      expect(attempt.terminal?.reason).toBe('worker_reported');
      expect(attempt.terminal?.strength).toBe('tool_report');
      expect(fx.queueStatus()).toBe('completed');
      expect(fx.nudges).toHaveLength(0);
      expect(fx.coordinatorNotices).toHaveLength(0);
    });

    it('Control 2: a turn end with no live children and a real final summary is handled as today', async () => {
      const fx = createFakeWorkerFixture({
        taskId: 'ctrl-summary',
        sessionId: 'sess-ctrl-summary',
        ptyPid: 8100,
      });
      const realSummary = 'All 18 unit tests in turn-ledger passed with zero errors.';

      fx.setWorkerState({
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: realSummary,
            timestamp: new Date(T0 + 400).toISOString(),
          },
        ],
        processTable: [
          { pid: 8100, ppid: 1, comm: '-zsh', args: '-zsh' },
          { pid: 8101, ppid: 8100, comm: 'claude', args: 'claude' },
        ],
      });

      const decision = evaluateTurnEndBackgroundWork({
        attempt: fx.store.getAttempt(fx.attemptId)!,
        finalSummary: realSummary,
        liveBackgroundProcesses: [],
      });
      expect(decision).toEqual({ complete: true });

      fx.ledger.observe(
        evd(
          'turn_end',
          { strength: 'weak', live: LIVE_IDLE },
          {
            at: fx.now,
            sessionId: fx.sessionId,
            observedBy: SELF,
            attemptRef: { attemptId: fx.attemptId, generation: 0 },
          },
        ),
        { envelope: { finalSummary: realSummary } },
      );

      // Enters finalizing (weak_candidate) as today, and commits after weakConfirmMs + liveness confirm:
      expect(fx.store.getAttempt(fx.attemptId)!.state).toBe('finalizing');
      expect(fx.nudges).toHaveLength(0);
      expect(fx.coordinatorNotices).toHaveLength(0);

      fx.advance(500);
      await fx.scheduler.tick();
      fx.advance(500);
      await fx.scheduler.tick();

      const committed = fx.store.getAttempt(fx.attemptId)!;
      expect(committed.state).toBe('completed');
      expect(committed.terminal?.reason).toBe('weak_end_confirmed');
      expect(fx.queueStatus()).toBe('completed');
    });
  });

  describe('OS process-tree enumeration and helper exclusions', () => {
    it('documents safety reasons for every exclusion category and excludes MCP, LSP, sidecars, and CLI harness while detecting worker children', () => {
      expect(SESSION_PROCESS_EXCLUSIONS.map((e) => e.id)).toEqual([
        'root_pty_and_cli_harness',
        'mcp_server_helper',
        'language_server_and_code_intel',
        'cli_internal_sidecar_and_watcher',
        'self_inspection_probe',
      ]);
      for (const rule of SESSION_PROCESS_EXCLUSIONS) {
        expect(rule.reason.length).toBeGreaterThan(20);
        expect(rule.examples.length).toBeGreaterThan(0);
      }

      const posixStdout = [
        '  100     1 -zsh -zsh',
        '  101   100 node /usr/local/bin/agy --flag=1',
        '  102   101 node /Users/dev/.npm/_npx/adhdev-mcp/index.js --secret=abc',
        '  103   102 python3 /Users/dev/mcp-helper-child.py',
        '  104   101 tsserver /Applications/TypeScript/tsserver.js',
        '  105   101 esbuild /node_modules/esbuild/bin/esbuild --service=0.20.0 --ping',
        '  106   101 zsh -c npm run test:scripts | wc -c',
        '  107   106 npm npm run test:scripts --token=xyz',
        '  108   106 wc wc -c',
      ].join('\n');

      const parsed = parsePosixPsOutput(posixStdout);
      const tree = inspectSessionProcessTree(100, { processTable: parsed, selfPid: 9999 });
      expect(tree.hasLiveBackgroundProcesses).toBe(true);
      expect(tree.liveProcessNames).toEqual(['zsh', 'npm', 'wc']);
      expect(tree.excludedPids).toEqual(expect.arrayContaining([101, 102, 104, 105]));
    });

    it('parses Win32 CIM JSON and WMIC CSV process tables and sanitizes command names without leaking args', () => {
      const winJson = JSON.stringify([
        { ProcessId: 200, ParentProcessId: 4, Name: 'pwsh.exe', CommandLine: 'pwsh.exe -NoLogo' },
        { ProcessId: 201, ParentProcessId: 200, Name: 'conhost.exe', CommandLine: 'conhost.exe 0x4' },
        { ProcessId: 202, ParentProcessId: 200, Name: 'codex.exe', CommandLine: 'codex.exe' },
        { ProcessId: 203, ParentProcessId: 202, Name: 'node.exe', CommandLine: 'node.exe C:\\repo\\vitest.mjs --apiKey=SECRET' },
      ]);
      const table = parseWin32ProcessOutput(winJson);
      const tree = inspectSessionProcessTree(200, { processTable: table, selfPid: 9999, platform: 'win32' });
      expect(tree.hasLiveBackgroundProcesses).toBe(true);
      expect(tree.liveProcessNames).toEqual(['node.exe']);
      expect(sanitizeProcessCommandName('C:\\Program Files\\nodejs\\node.exe --secret=123')).toBe('node.exe');
    });
  });
});
