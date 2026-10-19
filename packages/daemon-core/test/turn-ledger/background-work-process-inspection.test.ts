import { describe, expect, it, vi } from 'vitest';
import {
  PROCESS_TABLE_TIMING,
  createProcessTableSource,
  peekSessionBackgroundProcesses,
  readSessionBackgroundProcesses,
  readSystemProcessTableAsync,
} from '../../src/process/process-table-snapshot.js';
import {
  inspectSessionProcessTree,
  isPendingBackgroundWorkSummary,
  CPU_ACTIVE_MIN_GROWTH_MS,
  parsePosixPsOutput,
  parsePsCpuTime,
  parsePsElapsed,
  parseWin32ProcessOutput,
  sanitizeProcessCommandName,
  type ProcessNodeInfo,
} from '../../src/process/session-process-tree.js';

const ROOT = 100;
const T = 1_750_000_000_000;

/** Controllable ASYNC read: resolves only when the test says so. */
function deferredRead() {
  const calls: Array<{ resolve: (t: readonly ProcessNodeInfo[] | null) => void; reject: (e: unknown) => void }> = [];
  const read = vi.fn(() => new Promise<readonly ProcessNodeInfo[] | null>((resolve, reject) => { calls.push({ resolve, reject }); }));
  return { read, calls };
}

const TABLE: readonly ProcessNodeInfo[] = [
  { pid: 100, ppid: 1, comm: 'zsh', args: 'zsh' },
  { pid: 101, ppid: 100, comm: 'claude', args: 'claude' },
  { pid: 110, ppid: 101, comm: 'node', args: 'node build.js' },
];

function names(table: readonly ProcessNodeInfo[], opts: { startedAfterMs?: number; root?: number } = {}): string[] {
  return [...inspectSessionProcessTree(opts.root ?? ROOT, {
    processTable: table,
    selfPid: 999_999,
    ...(opts.startedAfterMs !== undefined ? { startedAfterMs: opts.startedAfterMs } : {}),
  }).liveProcessNames];
}

describe('process-table source: asynchronous, single-flight, throttled, never blocks', () => {
  it('peek() answers UNKNOWN immediately while the first read is pending; nothing is awaited', async () => {
    const { read, calls } = deferredRead();
    const source = createProcessTableSource({ platform: 'linux', read, now: () => T });
    expect(source.peek()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(source.stats().inFlight).toBe(true);
    // Still pending: further peeks neither start another read nor block.
    expect(source.peek()).toBeNull();
    expect(source.peek()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    calls[0]!.resolve(TABLE);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.peek()?.table).toBe(TABLE);
  });

  it('SINGLE FLIGHT: many sessions and both entry points share exactly one read, and one table serves them all', async () => {
    const { read, calls } = deferredRead();
    const source = createProcessTableSource({ platform: 'linux', read, now: () => T });
    const sessions = [100, 200, 300, 400, 500, 600, 700, 800];
    const pending = sessions.map((pid) => readSessionBackgroundProcesses(pid, { source, maxWaitMs: 1_000 }));
    for (const pid of sessions) peekSessionBackgroundProcesses(pid, { source });
    expect(read).toHaveBeenCalledTimes(1);
    calls[0]!.resolve([
      ...TABLE,
      { pid: 200, ppid: 1, comm: 'zsh', args: 'zsh' },
      { pid: 210, ppid: 200, comm: 'node', args: 'node other.js' },
    ]);
    const results = await Promise.all(pending);
    expect(results[0]!.liveProcessNames).toContain('node');
    expect(results[1]!.livePids).toEqual([210]);
    expect(results[2]!.hasLiveBackgroundProcesses).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('TTL cache: no new read inside the TTL, one refresh after it', async () => {
    let clock = T;
    const read = vi.fn(async () => TABLE);
    const source = createProcessTableSource({ platform: 'linux', read, now: () => clock, ttlMs: 3_000, maxStaleMs: 12_000 });
    await source.snapshot();
    clock += 2_000;
    await source.snapshot();
    source.peek();
    expect(read).toHaveBeenCalledTimes(1);
    clock += 2_000; // 4 s since the read: past the TTL
    const stale = source.peek();
    expect(stale?.table).toBe(TABLE); // serves the stale-but-usable snapshot while refreshing
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('a snapshot older than maxStaleMs is UNKNOWN, never trusted', async () => {
    let clock = T;
    const read = vi.fn<() => Promise<readonly ProcessNodeInfo[] | null>>().mockResolvedValueOnce(TABLE).mockResolvedValue(null);
    const source = createProcessTableSource({ platform: 'linux', read, now: () => clock, ttlMs: 3_000, maxStaleMs: 12_000, failureBackoffMs: 1_000 });
    await source.snapshot();
    clock += 13_000;
    expect(source.peek()).toBeNull();
    expect(peekSessionBackgroundProcesses(ROOT, { source })).toBeNull();
  });

  it('a failed read is UNKNOWN, never throws, and backs off instead of retrying every tick', async () => {
    let clock = T;
    const read = vi.fn(async () => { throw new Error('ps: Resource temporarily unavailable'); });
    const source = createProcessTableSource({ platform: 'linux', read, now: () => clock, ttlMs: 3_000, failureBackoffMs: 15_000 });
    expect(await source.snapshot()).toBeNull();
    expect(source.stats().failures).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      clock += 500;
      expect(source.peek()).toBeNull();
      expect(await source.snapshot()).toBeNull();
    }
    expect(read).toHaveBeenCalledTimes(1); // 10 s of ticks, still inside the 15 s backoff
    clock += 6_000;
    source.peek();
    expect(read).toHaveBeenCalledTimes(2);
    // The caller-visible contract for unknown: no process evidence, no throw.
    expect(await readSessionBackgroundProcesses(ROOT, { source })).toBeNull();
  });

  it('an empty table counts as a failed read (an empty process list is never "nothing is running")', async () => {
    const read = vi.fn(async () => []);
    const source = createProcessTableSource({ platform: 'linux', read, now: () => T });
    expect(await source.snapshot()).toBeNull();
    expect(source.stats().failures).toBe(1);
  });

  it('Windows is throttled harder: CIM is slow, so ≥ 15 s between reads and a 90 s failure backoff', async () => {
    expect(PROCESS_TABLE_TIMING.win32.ttlMs).toBeGreaterThanOrEqual(15_000);
    expect(PROCESS_TABLE_TIMING.win32.failureBackoffMs).toBeGreaterThanOrEqual(90_000);
    expect(PROCESS_TABLE_TIMING.win32.ttlMs).toBeGreaterThan(PROCESS_TABLE_TIMING.posix.ttlMs * 4);

    let clock = T;
    const read = vi.fn(async () => TABLE);
    const source = createProcessTableSource({ platform: 'win32', read, now: () => clock });
    await source.snapshot();
    for (let i = 0; i < 28; i += 1) { // 14 s of 500 ms ticks
      clock += 500;
      source.peek();
      await source.snapshot();
    }
    expect(read).toHaveBeenCalledTimes(1);
    clock += 2_000; // 16 s
    source.peek();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    let failClock = T;
    const failing = vi.fn(async () => null);
    const winFail = createProcessTableSource({ platform: 'win32', read: failing, now: () => failClock });
    await winFail.snapshot();
    failClock += 60_000;
    winFail.peek();
    await winFail.snapshot();
    expect(failing).toHaveBeenCalledTimes(1); // still inside the 90 s backoff
    failClock += 31_000;
    winFail.peek();
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  });

  it('snapshot() waits at most maxWaitMs for a hung read and returns unknown; the read stays single-flight', async () => {
    const { read } = deferredRead(); // never resolves
    const source = createProcessTableSource({ platform: 'linux', read });
    const startedAt = Date.now();
    expect(await source.snapshot(60)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await source.snapshot(60)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('the event loop keeps turning while a slow read is in flight (no synchronous wait anywhere on the path)', async () => {
    const read = vi.fn(() => new Promise<readonly ProcessNodeInfo[]>((resolve) => setTimeout(() => resolve(TABLE), 300)));
    const source = createProcessTableSource({ platform: 'linux', read });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const pending = source.snapshot(2_000);
      await pending;
    } finally {
      clearInterval(timer);
    }
    // A 300 ms synchronous `ps` would leave ~0 ticks; a truly async read leaves most of them.
    expect(ticks).toBeGreaterThanOrEqual(8);
  });
});

describe.skipIf(process.platform === 'win32')('readSystemProcessTableAsync (real ps)', () => {
  it('returns the live process table asynchronously, with start times, including this process under its parent', async () => {
    const table = await readSystemProcessTableAsync(process.platform);
    expect(table).not.toBeNull();
    const self = table!.find((n) => n.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBe(process.ppid);
    expect(self!.startedAtMs).toBeGreaterThan(Date.now() - 24 * 3_600_000);
    expect(self!.startedAtMs).toBeLessThanOrEqual(Date.now() + 2_000);
    // cumulative CPU time (this test process has burned some): the new ps `time=` column
    expect(self!.cpuTimeMs).toBeGreaterThan(0);
  });
});

describe('table parsing', () => {
  it('parses etime in every ps shape', () => {
    expect(parsePsElapsed('05:09')).toBe((5 * 60 + 9) * 1000);
    expect(parsePsElapsed('01:02:03')).toBe(((1 * 60 + 2) * 60 + 3) * 1000);
    expect(parsePsElapsed('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
    expect(parsePsElapsed('node')).toBeNull();
    expect(parsePsElapsed('-zsh')).toBeNull();
  });

  it('turns etime into an absolute start time and keeps the legacy 4-column shape working', () => {
    const rows = parsePosixPsOutput([
      '  100     1    01:00:00 -zsh -zsh',
      '  101   100       00:30 node node /usr/local/bin/agy --flag=1',
      '  102   101       00:05 /usr/bin/tee /usr/bin/tee /tmp/a log',
    ].join('\n'), T);
    expect(rows.map((r) => [r.pid, r.comm, r.startedAtMs])).toEqual([
      [100, '-zsh', T - 3_600_000],
      [101, 'node', T - 30_000],
      [102, '/usr/bin/tee', T - 5_000],
    ]);
    expect(rows[1]!.args).toBe('node /usr/local/bin/agy --flag=1');
    const legacy = parsePosixPsOutput('  100     1 -zsh -zsh\n  101   100 node node x.js', T);
    expect(legacy.every((r) => r.startedAtMs === undefined)).toBe(true);
    expect(legacy[1]!.comm).toBe('node');
  });

  it('reads StartMs from the CIM JSON', () => {
    const [row] = parseWin32ProcessOutput(JSON.stringify([{ ProcessId: 5, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node.exe a.js', StartMs: T }]));
    expect(row!.startedAtMs).toBe(T);
    const [noStart] = parseWin32ProcessOutput(JSON.stringify([{ ProcessId: 5, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node.exe a.js', StartMs: null }]));
    expect(noStart!.startedAtMs).toBeUndefined();
  });
});

describe('exclusions match process identity and ancestry, never substrings of the command line', () => {
  const under = (...rows: Array<Partial<ProcessNodeInfo> & { pid: number; ppid: number; comm: string; args: string }>): ProcessNodeInfo[] => [
    { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
    { pid: 101, ppid: 100, comm: 'claude', args: 'claude' },
    ...rows,
  ];

  it('a worker job that merely MENTIONS a helper or a provider stays visible', () => {
    // Every one of these was swallowed by the previous substring matching.
    const jobs: Array<[string, string, string]> = [
      ['node', 'node /repo/node_modules/vitest/vitest.mjs run test/providers/spec/fsm-evaluator-claude.test.ts', 'node'],
      ['node', 'node /repo/node_modules/vitest/vitest.mjs run test/providers/codex-app-server.test.ts', 'node'],
      ['go', 'go test ./cmd/gopls/...', 'go'],
      ['npm', 'npm run test:mcp-server -w oss/packages/mcp-server', 'npm'],
      ['node', 'node --test oss/packages/mcp-server/test/tools.test.js', 'node'],
      ['node', 'node scripts/mcp-sync.js --all', 'node'],
      ['python3', 'python3 -m pytest tests/test_hermes.py', 'python3'],
      ['node', 'node tools/codex-sync.js', 'node'],
      ['node', 'node scripts/crashpad_handler-notes.js', 'node'],
    ];
    for (const [comm, args, expected] of jobs) {
      const live = names(under({ pid: 120, ppid: 101, comm, args }));
      expect(live, args).toEqual([expected]);
    }
  });

  it('the real helpers are still excluded, whole subtree included', () => {
    const helpers: Array<[string, string]> = [
      ['npx', 'npx -y @modelcontextprotocol/server-filesystem /tmp'],
      ['node', 'node /h/.npm/_npx/abc/node_modules/@adhdev/mcp-server/dist/index.js --stdio'],
      ['node', 'node /app/vendor/mcp-server/index.js --worker'],
      ['node', 'node /opt/adhdev-mcp/dist/index.js --stdio'],
      ['uvx', 'uvx mcp-server-git --repository .'],
      ['python3', 'python3 -m mcp_server_fetch'],
      ['adhdev-mcp', '/usr/local/bin/adhdev-mcp'],
      ['node', 'node /x/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot'],
      ['gopls', '/go/bin/gopls serve'],
      ['rust-analyzer', 'rust-analyzer'],
      ['esbuild', '/x/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping'],
      ['watchman', 'watchman --foreground'],
    ];
    for (const [comm, args] of helpers) {
      const live = names(under(
        { pid: 120, ppid: 101, comm, args },
        { pid: 121, ppid: 120, comm: 'node', args: 'node helper-child.js' }, // a helper's child belongs to the helper
      ));
      expect(live, args).toEqual([]);
    }
  });

  it('an esbuild WATCHER (the worker\'s own dev loop) is a job; only `esbuild --service` is a sidecar', () => {
    expect(names(under({ pid: 120, ppid: 101, comm: 'esbuild', args: 'esbuild src/index.ts --bundle --watch' }))).toEqual(['esbuild']);
  });

  it('the provider CLI is recognised by identity ALONG THE LAUNCH CHAIN, for script and native CLIs alike', () => {
    // root zsh → `node …/@anthropic-ai/claude-code/cli.js` → the worker's job
    expect(names([
      { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
      { pid: 101, ppid: 100, comm: 'node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      { pid: 120, ppid: 101, comm: 'npm', args: 'npm run dev' },
    ])).toEqual(['npm']);
    // root = the node launcher itself → native `codex` child (npm launcher shape)
    expect(names([
      { pid: 100, ppid: 1, comm: 'node', args: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js' },
      { pid: 101, ppid: 100, comm: 'codex', args: '/usr/lib/node_modules/@openai/codex/vendor/codex' },
      { pid: 120, ppid: 101, comm: 'sleep', args: 'sleep 300' },
    ])).toEqual(['sleep']);
    // `agy` (Go binary) with node helpers: helpers that the guard cannot name are baseline instead
    expect(names([
      { pid: 100, ppid: 1, comm: 'agy', args: 'agy', startedAtMs: T - 60_000 },
      { pid: 101, ppid: 100, comm: 'node', args: 'node /opt/agy/ext-host.js', startedAtMs: T - 59_000 },
    ], { startedAfterMs: T })).toEqual([]);
    // Windows: cmd.exe wrapper → node(claude) chain
    expect(names([
      { pid: 100, ppid: 1, comm: 'cmd.exe', args: 'cmd.exe /c claude.cmd' },
      { pid: 101, ppid: 100, comm: 'node.exe', args: 'node.exe C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' },
      { pid: 120, ppid: 101, comm: 'node.exe', args: 'node.exe C:\\repo\\vitest.mjs' },
    ])).toEqual(['node.exe']);
  });

  it('a provider-named process NOT on the launch chain is a job (the agent ran `claude -p …` itself)', () => {
    const live = names([
      { pid: 100, ppid: 1, comm: 'claude', args: 'claude' }, // native CLI is the PTY root
      { pid: 101, ppid: 100, comm: 'claude', args: 'claude -p summarise the repo' },
    ]);
    expect(live).toEqual(['claude']);
    // and under a non-launcher parent it is a job even at depth 2
    expect(names([
      { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
      { pid: 101, ppid: 100, comm: 'claude', args: 'claude' },
      { pid: 102, ppid: 101, comm: 'make', args: 'make all' },
      { pid: 103, ppid: 102, comm: 'codex', args: 'codex exec build-it' },
    ]).sort()).toEqual(['codex', 'make']);
  });

  it('an idle interactive shell is a prompt, not a job; a shell running a command is', () => {
    expect(names(under({ pid: 120, ppid: 101, comm: 'bash', args: 'bash --login' }))).toEqual([]);
    expect(names(under({ pid: 120, ppid: 101, comm: 'bash', args: "bash -c 'npm run build'" }))).toEqual(['bash']);
    expect(names(under(
      { pid: 120, ppid: 101, comm: 'bash', args: 'bash' },
      { pid: 121, ppid: 120, comm: 'npm', args: 'npm test' },
    ))).toEqual(['bash', 'npm']);
  });
});

describe('baseline: only what started AFTER the attempt was delivered can be worker-started work', () => {
  const DELIVERED = T;
  const table: ProcessNodeInfo[] = [
    { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh', startedAtMs: T - 7_200_000 },
    { pid: 101, ppid: 100, comm: 'claude', args: 'claude', startedAtMs: T - 7_200_000 },
    // leftover dev server from an earlier task, and the child it respawns during this one
    { pid: 110, ppid: 101, comm: 'node', args: 'node server.js', startedAtMs: T - 3_600_000 },
    { pid: 111, ppid: 110, comm: 'node', args: 'node server.js --worker', startedAtMs: T + 30_000 },
    // this task's job, started through the CLI's shell tool
    { pid: 120, ppid: 101, comm: 'npm', args: 'npm run test:scripts', startedAtMs: T + 20_000 },
  ];

  it('excludes the leftover and its lineage but keeps the new job (the harness predating the attempt does not hide its children)', () => {
    expect(names(table, { startedAfterMs: DELIVERED })).toEqual(['npm']);
  });

  it('without a baseline everything below the CLI counts', () => {
    expect(names(table).sort()).toEqual(['node', 'npm']);
  });

  it('a process with an UNKNOWN start time is never baseline', () => {
    const noStart = table.map(({ startedAtMs: _drop, ...rest }) => rest);
    expect(names(noStart, { startedAfterMs: DELIVERED }).sort()).toEqual(['node', 'npm']);
  });

  it('start-time slack: a process begun within the delivery second still counts as baseline (etime has 1 s resolution)', () => {
    const edge: ProcessNodeInfo[] = [
      { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
      { pid: 101, ppid: 100, comm: 'claude', args: 'claude' },
      { pid: 110, ppid: 101, comm: 'node', args: 'node late-helper.js', startedAtMs: T + 800 },
      { pid: 111, ppid: 101, comm: 'node', args: 'node job.js', startedAtMs: T + 5_000 },
    ];
    expect(inspectSessionProcessTree(100, { processTable: edge, selfPid: 9, startedAfterMs: T }).livePids).toEqual([111]);
  });
});

describe('secondary text signal: a small allow-list that only ever HOLDS, and only for a trailing waiting line', () => {
  it('matches the waiting line, not a result that happens to mention waiting earlier on', () => {
    expect(isPendingBackgroundWorkSummary('Running `npm test` in the background. Waiting for it to complete.')).toBe(true);
    expect(isPendingBackgroundWorkSummary('The background command is still running.')).toBe(true);
    const longResult = `I was waiting for the build to finish and it did. ${'All 412 tests passed across 31 suites. '.repeat(10)}No regressions; report below.`;
    expect(longResult.length).toBeLessThanOrEqual(600);
    expect(isPendingBackgroundWorkSummary(longResult)).toBe(false);
    expect(isPendingBackgroundWorkSummary(null)).toBe(false);
    expect(isPendingBackgroundWorkSummary('{"outcome":"completed","summary":"waiting for it to finish"}')).toBe(false);
  });
});

describe('CPU activity: cumulative CPU time per pid, growth between two snapshots', () => {
  it('parses ps time= in the macOS and Linux shapes, alone and as the extra ps column', () => {
    expect(parsePsCpuTime('0:01.23')).toBe(1_230);
    expect(parsePsCpuTime('12:34.50')).toBe((12 * 60 + 34) * 1000 + 500);
    expect(parsePsCpuTime('1:02:03')).toBe(((1 * 60 + 2) * 60 + 3) * 1000);
    expect(parsePsCpuTime('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
    expect(parsePsCpuTime('node')).toBeNull();
    const rows = parsePosixPsOutput([
      '  100     1    01:00:00    0:02.50 -zsh -zsh',
      '  101   100       00:30 1-00:00:01 node node server.js',
      '  102   101       00:05    0:00.00 /usr/bin/tee /usr/bin/tee /tmp/a log',
    ].join('\n'), T);
    expect(rows.map((r) => [r.pid, r.comm, r.cpuTimeMs, r.startedAtMs])).toEqual([
      [100, '-zsh', 2_500, T - 3_600_000],
      [101, 'node', 86_401_000, T - 30_000],
      [102, '/usr/bin/tee', 0, T - 5_000],
    ]);
    expect(rows[1]!.args).toBe('node server.js');
    // the etime-only shape keeps working and reports CPU as unknown (undefined), never 0
    const noCpu = parsePosixPsOutput('  100     1    01:00:00 -zsh -zsh\n  101   100       00:30 node node a.js', T);
    expect(noCpu.every((r) => r.cpuTimeMs === undefined)).toBe(true);
    expect(noCpu[1]!.comm).toBe('node');
  });

  it('reads CpuMs from the CIM JSON (null = unknown)', () => {
    const rows = parseWin32ProcessOutput(JSON.stringify([
      { ProcessId: 5, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node.exe a.js', CpuMs: 1234 },
      { ProcessId: 6, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node.exe b.js', CpuMs: null },
    ]));
    expect(rows[0]!.cpuTimeMs).toBe(1234);
    expect(rows[1]!.cpuTimeMs).toBeUndefined();
  });

  const table = (cpu: number | undefined, extra: ProcessNodeInfo[] = []): ProcessNodeInfo[] => [
    { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
    { pid: 101, ppid: 100, comm: 'claude', args: 'claude' },
    { pid: 110, ppid: 101, comm: 'npm', args: 'npm test', ...(cpu !== undefined ? { cpuTimeMs: cpu } : {}) },
    ...extra,
  ];
  const activity = (prev: ProcessNodeInfo[] | undefined, cur: ProcessNodeInfo[], intervalMs = 3_000) =>
    inspectSessionProcessTree(100, { processTable: cur, selfPid: 9, ...(prev ? { previousProcessTable: prev, snapshotIntervalMs: intervalMs } : {}) }).cpuActivity;

  it('active when CPU grew, idle when it did not, unknown when it cannot be told', () => {
    expect(activity(table(1_000), table(2_000))).toBe('active');
    expect(activity(table(1_000), table(1_000))).toBe('idle');
    expect(activity(undefined, table(2_000))).toBe('unknown'); // no earlier snapshot
    expect(activity(table(undefined), table(undefined))).toBe('unknown'); // CPU not reported: NOT idle
    expect(activity(table(1_000), table(undefined))).toBe('unknown');
  });

  it('a process absent from the earlier snapshot just started: activity', () => {
    expect(activity(table(1_000), table(1_000, [{ pid: 120, ppid: 110, comm: 'tsc', args: 'tsc -b', cpuTimeMs: 0 }]))).toBe('active');
  });

  it('noise floor: a watcher ticking a few ms is idle; ≥ 1 % of a core over the interval is active', () => {
    expect(CPU_ACTIVE_MIN_GROWTH_MS).toBeGreaterThanOrEqual(10);
    expect(activity(table(1_000), table(1_010), 3_000)).toBe('idle'); // 10 ms in 3 s ≈ 0.3 %
    expect(activity(table(1_000), table(1_040), 3_000)).toBe('active'); // 40 ms in 3 s ≈ 1.3 %
    expect(activity(table(1_000), table(1_100), 60_000)).toBe('idle'); // 100 ms in 60 s ≈ 0.17 %
    expect(activity(table(1_000), table(2_000), 60_000)).toBe('active');
  });

  it('mixed known/unknown: any growth is active; otherwise unknown, never idle', () => {
    const prev = table(1_000, [{ pid: 120, ppid: 110, comm: 'tee', args: 'tee a' }]);
    const grew = table(5_000, [{ pid: 120, ppid: 110, comm: 'tee', args: 'tee a' }]);
    const flat = table(1_000, [{ pid: 120, ppid: 110, comm: 'tee', args: 'tee a' }]);
    expect(activity(prev, grew)).toBe('active');
    expect(activity(prev, flat)).toBe('unknown');
  });
});

describe('snapshot pairs for CPU growth', () => {
  const mk = (cpu: number): ProcessNodeInfo[] => [{ pid: 100, ppid: 1, comm: 'zsh', args: 'zsh' }, { pid: 110, ppid: 100, comm: 'npm', args: 'npm t', cpuTimeMs: cpu }];

  it('keeps the previous sample (one deep), drops it when too old, and reports growth through the single-flight source', async () => {
    let clock = T;
    let cpu = 1_000;
    const read = vi.fn(async () => mk(cpu));
    const source = createProcessTableSource({ platform: 'linux', read, now: () => clock, ttlMs: 3_000, maxStaleMs: 12_000 });
    const first = await source.snapshot();
    expect(first!.previous).toBeNull();
    await expect(readSessionBackgroundProcesses(100, { source })).resolves.toMatchObject({ cpuActivity: 'unknown' });
    clock += 4_000;
    cpu += 5_000;
    const second = await source.snapshot();
    expect(second!.previous!.readAtMs).toBe(T);
    expect(second!.previous!.table[1]!.cpuTimeMs).toBe(1_000);
    const inspected = await readSessionBackgroundProcesses(100, { source });
    expect(inspected).toMatchObject({ cpuActivity: 'active', snapshotAtMs: T + 4_000 });
    clock += 30_000; // longer than maxStaleMs since the previous read: no usable pair
    const third = await source.snapshot();
    expect(third!.previous).toBeNull();
  });

  it('Windows keeps the 15 s throttle: CPU pairs are ≥ 15 s apart, one CIM read per interval', async () => {
    let clock = T;
    const read = vi.fn(async () => mk(1_000));
    const source = createProcessTableSource({ platform: 'win32', read, now: () => clock });
    await source.snapshot();
    for (let i = 0; i < 28; i += 1) { clock += 500; source.peek(); }
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('7b & 7c: provider lazy sidecars (codex-code-mode-host) and macOS MAXCOMLEN truncated comm', () => {
  it('7b: codex-code-mode-host (and other provider sidecars) spawned after delivery are ignored, while a real sleep child is held', () => {
    const deliveredAt = T;
    const codexWithLazyHelperOnly: ProcessNodeInfo[] = [
      { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh', startedAtMs: T - 30_000 },
      { pid: 101, ppid: 100, comm: 'node', args: 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', startedAtMs: T - 29_000 },
      { pid: 102, ppid: 101, comm: 'codex', args: '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex', startedAtMs: T - 29_000 },
      // Lazy helper spawned by @openai/codex on the first tool call (after deliveredAt):
      { pid: 110, ppid: 102, comm: 'codex-code-mode-', args: '/usr/local/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host', startedAtMs: T + 5_000 },
      { pid: 111, ppid: 102, comm: 'codex-voice-hos', args: '/usr/local/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-voice-host', startedAtMs: T + 5_000 },
      { pid: 112, ppid: 102, comm: 'node', args: 'node /usr/local/bin/adhdev mcp --mode ipc --worker', startedAtMs: T + 5_000 },
    ];
    expect(names(codexWithLazyHelperOnly, { startedAfterMs: deliveredAt })).toEqual([]);

    const codexWithHelperAndSleep: ProcessNodeInfo[] = [
      ...codexWithLazyHelperOnly,
      { pid: 120, ppid: 102, comm: 'sleep', args: 'sleep 150', startedAtMs: T + 6_000 },
    ];
    expect(names(codexWithHelperAndSleep, { startedAfterMs: deliveredAt })).toEqual(['sleep']);
  });

  it('7c: macOS 16-char MAXCOMLEN truncated comm prefers argv[0] from args without leaking arguments', () => {
    // Prompt regression case: truncated comm with args `/Users/x/.nvm/versions/node/v22/bin/node script.js` → "node"
    expect(sanitizeProcessCommandName('/Users/x/.nvm/ve', '/Users/x/.nvm/versions/node/v22/bin/node script.js')).toBe('node');
    // Live standalone case: comm `/Users/vilmire/.` (basename ".") with full node/codex args → "node", never "."
    expect(sanitizeProcessCommandName('/Users/vilmire/.', '/Users/vilmire/.nvm/versions/node/v22.17.0/bin/node /repo/script.js --secret=123')).toBe('node');
    // Truncated binary name in comm with full binary name in args:
    expect(sanitizeProcessCommandName('codex-code-mode-', '/opt/codex/bin/codex-code-mode-host --token=secret')).toBe('codex-code-mode-host');
    // Bare "." without args falls back to "unknown", never "."
    expect(sanitizeProcessCommandName('/Users/vilmire/.')).toBe('unknown');

    // Full tree inspection when macOS ps -o comm= truncates paths to `/Users/vilmire/.`:
    const macTruncatedTable: ProcessNodeInfo[] = [
      { pid: 100, ppid: 1, comm: '-zsh', args: '-zsh' },
      { pid: 101, ppid: 100, comm: '/Users/vilmire/.', args: '/Users/vilmire/.nvm/versions/node/v22/bin/node /Users/vilmire/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js' },
      { pid: 102, ppid: 101, comm: '/Users/vilmire/.', args: '/Users/vilmire/.nvm/versions/node/v22/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex' },
      { pid: 103, ppid: 102, comm: '/Users/vilmire/.', args: '/Users/vilmire/.nvm/versions/node/v22/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host' },
      { pid: 110, ppid: 102, comm: '/Users/vilmire/.', args: '/Users/vilmire/.nvm/versions/node/v22/bin/node script.js --secret=xyz' },
    ];
    expect(names(macTruncatedTable)).toEqual(['node']);
  });
});
