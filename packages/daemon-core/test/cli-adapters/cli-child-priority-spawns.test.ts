import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  priority: vi.fn((spawn: () => unknown) => spawn()),
  spawn: vi.fn(() => ({ pid: 3210 })),
}));
vi.mock('@adhdev/session-host-core', async (original) => ({
  ...await original<object>(), spawnCliChild: mocks.priority,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/logging/logger.js', () => ({ LOG: { info: vi.fn() } }));

import { hiddenSpawn, hiddenSpawnCli } from '../../src/process/hidden-spawn.js';
import { NodePtyTransportFactory, __setNodePtyLoaderForTests } from '../../src/cli-adapters/pty-transport.js';
import { PtySessionRuntime } from '../../../session-host-daemon/src/runtime.js';

afterEach(() => {
  vi.clearAllMocks();
  __setNodePtyLoaderForTests(null);
});

it('lowers an explicit stdio CLI workload and preserves windowsHide', () => {
  const env = { ADHDEV_CLI_CHILD_NICE: '0' };
  hiddenSpawnCli('codex', ['app-server'], { env });
  expect(mocks.priority).toHaveBeenCalledOnce();
  expect(mocks.priority.mock.calls[0][1]).toBe(env);
  expect(mocks.spawn).toHaveBeenCalledWith('codex', ['app-server'], { windowsHide: true, env });
});

it('keeps helper execs, session-host and a future P2P signal child normal', () => {
  for (const [command, args] of [['git', ['status']], ['agy', ['--version']], ['node', ['session-host']], ['node', ['p2p-signal-worker']]] as const) {
    hiddenSpawn(command, args);
  }
  expect(mocks.priority).not.toHaveBeenCalled();
  // The actual IPC owner must not acquire the workload policy by accident.
  const managedHost = readFileSync(new URL('../../src/session-host/managed-host.ts', import.meta.url), 'utf8');
  expect(managedHost).not.toMatch(/\b(?:hiddenSpawnCli|spawnCliChild)\s*\(/);
});

it('lowers the direct PTY CLI immediately after native spawn', () => {
  __setNodePtyLoaderForTests(() => ({ spawn: mocks.spawn }));
  const env = { PATH: process.env.PATH! };
  new NodePtyTransportFactory().spawn(process.execPath, [], { cwd: '.', env, cols: 80, rows: 24 });
  expect(mocks.priority).toHaveBeenCalledOnce();
  expect(mocks.priority.mock.calls[0][1]).toBe(env);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.each(['cli', 'acp'])('lowers the hosted %s agent PTY while leaving its IPC owner normal', (category) => {
  const handle = { pid: 3210, onData: vi.fn(), onExit: vi.fn() };
  mocks.spawn.mockReturnValueOnce(handle);
  const runtime = new PtySessionRuntime({
    sessionId: 'priority-test',
    payload: { category, launchCommand: { command: process.execPath, args: [] }, workspace: process.cwd() } as any,
    onData: vi.fn(), onExit: vi.fn(),
  });
  expect(runtime.start()).toBe(handle.pid);
  expect(mocks.priority).toHaveBeenCalledOnce();
  expect(mocks.priority.mock.calls[0][1]).toHaveProperty('PATH');
});

it.each(['shell', undefined])('keeps hosted user/unknown category %s at normal priority', (category) => {
  const handle = { pid: 3210, onData: vi.fn(), onExit: vi.fn() };
  mocks.spawn.mockReturnValueOnce(handle);
  const runtime = new PtySessionRuntime({
    sessionId: 'priority-shell-test',
    payload: { category, launchCommand: { command: process.execPath, args: [] }, workspace: process.cwd() } as any,
    onData: vi.fn(), onExit: vi.fn(),
  });
  expect(runtime.start()).toBe(handle.pid);
  expect(mocks.priority).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.skipIf(process.platform === 'win32')('starts the direct PTY CLI through nice so early forks inherit low priority', () => {
  __setNodePtyLoaderForTests(() => ({ spawn: mocks.spawn }));
  const env = { PATH: process.env.PATH! };
  new NodePtyTransportFactory().spawn(process.execPath, ['--x'], { cwd: '.', env, cols: 80, rows: 24 });
  expect((mocks.spawn.mock.calls[0] as unknown[])[0]).toBe('/usr/bin/nice');
  expect((mocks.spawn.mock.calls[0] as unknown[])[1]).toEqual(['-n', '10', process.execPath, '--x']);
  expect(mocks.priority.mock.calls[0][3]).toEqual({ preApplied: true });
});

it.skipIf(process.platform === 'win32')('starts the stdio CLI through nice and keeps windowsHide', () => {
  const env = { PATH: process.env.PATH! };
  hiddenSpawnCli('codex', ['app-server'], { env });
  expect(mocks.spawn).toHaveBeenCalledWith('/usr/bin/nice', ['-n', '10', 'codex', 'app-server'], { windowsHide: true, env });
});

it.skipIf(process.platform === 'win32')('starts hosted cli agents through nice but not shells', () => {
  const handle = { pid: 3210, onData: vi.fn(), onExit: vi.fn() };
  mocks.spawn.mockReturnValue(handle);
  const mk = (category: string) => new PtySessionRuntime({
    sessionId: 'nice-' + category,
    payload: { category, launchCommand: { command: process.execPath, args: [] }, workspace: process.cwd() } as any,
    onData: vi.fn(), onExit: vi.fn(),
  });
  mk('cli').start();
  expect((mocks.spawn.mock.calls[0] as unknown[])[0]).toBe('/usr/bin/nice');
  mocks.spawn.mockClear();
  mk('shell').start();
  expect((mocks.spawn.mock.calls[0] as unknown[])[0]).not.toBe('/usr/bin/nice');
});
