import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { exitWhenParentGone, watchParentLifetime } from '../src/transports/parent-lifetime.js';

// MCP-IPC-LIFETIME: a stdio MCP server (`adhdev mcp --mode ipc --worker` and friends)
// exits when its parent session is gone, and adds nothing to an idle server's footprint.

const CHILD = fileURLToPath(new URL('./fixtures/parent-lifetime-child.ts', import.meta.url));
const MIDDLE = fileURLToPath(new URL('./fixtures/parent-lifetime-middle.ts', import.meta.url));

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return pred();
}

function jsonLines(child: ChildProcess): any[] {
  const lines: any[] = [];
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { lines.push(JSON.parse(line)); } catch { /* not ours */ }
    }
  });
  return lines;
}

test('stdin end fires onGone once with stdin_end', () => {
  const stdin = new PassThrough();
  const reasons: string[] = [];
  watchParentLifetime({ stdin, readPpid: () => 4242, isAlive: () => true, pollMs: 60_000, onGone: r => reasons.push(r) });
  stdin.emit('end');
  stdin.emit('close');
  assert.deepEqual(reasons, ['stdin_end']);
});

test('a dead or replaced parent pid fires parent_exited', async () => {
  for (const variant of ['dead', 'reparented'] as const) {
    const reasons: string[] = [];
    let ppid = 4242;
    const stop = watchParentLifetime({
      stdin: new PassThrough(),
      readPpid: () => ppid,
      isAlive: () => variant !== 'dead',
      pollMs: 10,
      onGone: r => reasons.push(r),
    });
    if (variant === 'reparented') ppid = 1;
    assert.ok(await waitFor(() => reasons.length > 0, 1000), variant);
    assert.deepEqual(reasons, ['parent_exited']);
    stop();
  }
});

test('a live parent with open stdin never fires', async () => {
  const reasons: string[] = [];
  const stop = watchParentLifetime({ stdin: new PassThrough(), readPpid: () => 4242, isAlive: () => true, pollMs: 10, onGone: r => reasons.push(r) });
  await new Promise(r => setTimeout(r, 120));
  stop();
  assert.deepEqual(reasons, []);
});

test('exitWhenParentGone exits even when shutdown hangs (bounded grace)', async () => {
  const stdin = new PassThrough();
  const codes: number[] = [];
  exitWhenParentGone({ label: 't', shutdown: () => new Promise(() => {}), graceMs: 50, exit: c => codes.push(c), watch: { stdin, readPpid: () => 0 } });
  stdin.emit('end');
  assert.ok(await waitFor(() => codes.length > 0, 1000));
  assert.deepEqual(codes, [0]);
});

test('idle baseline: the guard adds at most one handle, and an idle server neither grows nor exits', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    const lines = jsonLines(child);
    assert.ok(await waitFor(() => lines.filter(l => l.poll).length >= 3, 15_000), 'fixture reported its census');
    const head = lines.find(l => l.pid);
    // The only thing the guard may add is its (unref'd) probe timer.
    const added = head.after.length - head.before.length;
    assert.ok(added >= 0 && added <= 1, `guard added ${added} resources: ${JSON.stringify(head)}`);
    // Idle: no per-poll growth (the sampler's own timer is in every sample).
    const polls = lines.filter(l => l.poll).map(l => l.census.length);
    assert.ok(Math.max(...polls) - Math.min(...polls) <= 1, `census drifted: ${polls}`);
    assert.equal(child.exitCode, null, 'an idle server with a live parent stays up');
    assert.ok(!lines.some(l => l.shutdown));
  } finally {
    child.kill('SIGKILL');
  }
});

test('closing stdin (parent session ended) makes the server shut down and exit 0', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = jsonLines(child);
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  assert.ok(await waitFor(() => lines.some(l => l.pid), 15_000));
  child.stdin!.end();
  const code = await Promise.race([exited, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 8_000))]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0);
  assert.ok(lines.some(l => l.shutdown), 'shutdown ran before exit');
});

test('SIGKILL of the parent agent CLI does not leave the MCP child orphaned', { skip: process.platform === 'win32' ? 'POSIX signal semantics' : false }, async () => {
  const middle = spawn(process.execPath, ['--import', 'tsx', MIDDLE], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const lines = jsonLines(middle);
  assert.ok(await waitFor(() => lines.some(l => l.childPid), 15_000));
  const childPid = lines.find(l => l.childPid).childPid as number;
  // Let the grandchild boot (tsx) before killing its parent.
  await new Promise(r => setTimeout(r, 2_000));
  assert.ok(pidAlive(childPid));
  middle.kill('SIGKILL');
  const gone = await waitFor(() => !pidAlive(childPid), 8_000);
  if (!gone) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.ok(gone, 'MCP child exited after its parent was killed');
});

test('every stdio MCP entry point installs the lifetime guard', () => {
  for (const file of ['../src/server.ts', '../src/assistant-server.ts']) {
    const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const connects = src.match(/await server\.connect\(/g)?.length ?? 0;
    const guards = src.match(/exitWhenParentGone\(\{/g)?.length ?? 0;
    assert.ok(connects > 0, file);
    assert.equal(guards, connects, `${file}: ${connects} stdio connects, ${guards} lifetime guards`);
  }
});
