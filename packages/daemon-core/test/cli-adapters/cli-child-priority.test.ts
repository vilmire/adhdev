import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createCliChildPriorityPolicy, niceLaunch, CLI_CHILD_NICE_ENV, CLI_CHILD_SCHEDULING_ENV } from '../../../session-host-core/src/cli-child-priority.js';

function fixture(platform: NodeJS.Platform = 'linux', current = 0) {
  const getPriority = vi.fn(() => current);
  const setPriority = vi.fn();
  const logInfo = vi.fn();
  const policy = createCliChildPriorityPolicy({ platform, getPriority, setPriority });
  const child = { pid: 12345 };
  return { getPriority, setPriority, logInfo, policy, child };
}

describe('CLI child priority policy', () => {
  it.each(['linux', 'darwin', 'freebsd'] as const)('lowers only the newly spawned PID by +10 on %s', (platform) => {
    const f = fixture(platform);
    const spawn = vi.fn(() => f.child);
    expect(f.policy(spawn, {}, f.logInfo)).toBe(f.child);
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.getPriority).toHaveBeenCalledWith(f.child.pid);
    expect(f.setPriority).toHaveBeenCalledExactlyOnceWith(f.child.pid, 10);
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(f.getPriority.mock.invocationCallOrder[0]);
    expect(f.logInfo).not.toHaveBeenCalled();
  });

  it.each([[5, 15], [15, 19], [19, 19]])('adjusts inherited nice %i to %i without raising it', (current, target) => {
    const f = fixture('linux', current);
    f.policy(() => f.child, {}, f.logInfo);
    expect(f.setPriority).toHaveBeenCalledWith(f.child.pid, target);
  });

  it('sets Windows BELOW_NORMAL without reading POSIX niceness', () => {
    const f = fixture('win32');
    f.policy(() => f.child, {}, f.logInfo);
    expect(f.getPriority).not.toHaveBeenCalled();
    expect(f.setPriority).toHaveBeenCalledExactlyOnceWith(f.child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it.each(['linux', 'darwin', 'win32'] as const)('honors the escape hatch on %s', (platform) => {
    const f = fixture(platform);
    expect(f.policy(() => f.child, { [CLI_CHILD_NICE_ENV]: '0' }, f.logInfo)).toBe(f.child);
    expect(f.getPriority).not.toHaveBeenCalled();
    expect(f.setPriority).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, NaN])('never changes the parent for invalid PID %s', (pid) => {
    const f = fixture();
    f.policy(() => ({ pid }), {}, f.logInfo);
    expect(f.getPriority).not.toHaveBeenCalled();
    expect(f.setPriority).not.toHaveBeenCalled();
  });

  it.each((['linux', 'win32'] as const).flatMap((platform) =>
    ['EACCES', 'EPERM', 'ESRCH', 'unexpected'].map((code) => ({ platform, code })),
  ))('continues on $code ($platform) and logs just once', ({ platform, code }) => {
    const f = fixture(platform);
    f.setPriority.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(f.policy(() => f.child, {}, f.logInfo)).toBe(f.child);
    expect(f.policy(() => f.child, {}, f.logInfo)).toBe(f.child);
    expect(f.logInfo).toHaveBeenCalledOnce();
    expect(f.logInfo.mock.calls[0][0]).toContain(code);
  });

  it('tolerates a failed priority read and leaves spawn errors intact', () => {
    const f = fixture();
    f.getPriority.mockImplementation(() => { throw new Error('ESRCH'); });
    expect(f.policy(() => f.child, {}, f.logInfo)).toBe(f.child);
    expect(f.setPriority).not.toHaveBeenCalled();
    expect(() => f.policy(() => { throw new Error('ENOENT'); })).toThrow('ENOENT');
  });

  it.each(['darwin', 'linux', 'win32'] as const)('enables optional background policy only on Darwin (%s)', (platform) => {
    const setDarwinBackground = vi.fn();
    const f = fixture(platform);
    const policy = createCliChildPriorityPolicy({ platform, ...f, setDarwinBackground });
    policy(() => f.child, { [CLI_CHILD_SCHEDULING_ENV]: 'darwin-bg' }, f.logInfo);
    expect(f.setPriority).toHaveBeenCalledOnce();
    expect(setDarwinBackground).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
  });

  it('disables both policies with the common opt-out', () => {
    const setDarwinBackground = vi.fn();
    const f = fixture('darwin');
    const policy = createCliChildPriorityPolicy({ platform: 'darwin', ...f, setDarwinBackground });
    policy(() => f.child, { [CLI_CHILD_NICE_ENV]: '0', [CLI_CHILD_SCHEDULING_ENV]: 'darwin-bg' }, f.logInfo);
    expect(f.setPriority).not.toHaveBeenCalled();
    expect(setDarwinBackground).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'])('tolerates %s taskpolicy failures and logs once', async (when) => {
    const setDarwinBackground = vi.fn((_pid: number, onFailure: (error: unknown) => void) => {
      if (when === 'sync') throw new Error('EACCES');
      queueMicrotask(() => onFailure(new Error('EPERM')));
    });
    const f = fixture('darwin');
    const policy = createCliChildPriorityPolicy({ platform: 'darwin', ...f, setDarwinBackground });
    const env = { [CLI_CHILD_SCHEDULING_ENV]: 'darwin-bg' };
    expect(policy(() => f.child, env, f.logInfo)).toBe(f.child);
    expect(policy(() => f.child, env, f.logInfo)).toBe(f.child);
    await Promise.resolve();
    expect(f.logInfo).toHaveBeenCalledOnce();
  });
});

describe('niceLaunch (fork-race closure)', () => {
  it.each(['linux', 'darwin'] as const)('wraps the command in nice -n 10 on %s, args kept verbatim', (platform) => {
    const launch = niceLaunch('codex', ['--flag', 'a b', "it's"], {}, platform, () => true);
    expect(launch).toEqual({ command: '/usr/bin/nice', args: ['-n', '10', 'codex', '--flag', 'a b', "it's"], preApplied: true });
  });

  it('leaves win32 untouched', () => {
    expect(niceLaunch('codex', ['x'], {}, 'win32', () => true)).toEqual({ command: 'codex', args: ['x'], preApplied: false });
  });

  it('falls back to the post-spawn path when nice is missing or escape hatch is set', () => {
    expect(niceLaunch('codex', ['x'], {}, 'linux', () => false).preApplied).toBe(false);
    expect(niceLaunch('codex', ['x'], { [CLI_CHILD_NICE_ENV]: '0' }, 'linux', () => true)).toEqual({ command: 'codex', args: ['x'], preApplied: false });
  });

  it('does not lower a second time when the child was pre-applied', () => {
    const f = fixture('linux');
    f.policy(() => f.child, {}, f.logInfo, { preApplied: true });
    expect(f.getPriority).not.toHaveBeenCalled();
    expect(f.setPriority).not.toHaveBeenCalled();
  });
});
