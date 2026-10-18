/**
 * Opt-in real-machine saturation test. Run alone; never part of the fast suite:
 * ADHDEV_CLI_PRIORITY_LOAD=1 npx vitest run test/cli-adapters/cli-child-priority.load.test.ts
 * Revert proof: prefix the same command with ADHDEV_CLI_CHILD_NICE=0.
 */
import * as os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { NodePtyTransportFactory, type PtyRuntimeTransport } from '../../src/cli-adapters/pty-transport.js';

type Mode = 'none' | 'nice' | 'darwin-bg';
const durationMs = 10_000;
const cores = os.cpus().length;
// Exactly K pure CPU hogs; a separate idle CLI probe measures responsiveness
// without letting the saturation workers sleep or yield.
const hog = `console.log('ready');for(;;){}`;
const probe = `console.log('ready');setInterval(()=>console.log('beat'),200);`;

async function measure(mode: Mode) {
  const factory = new NodePtyTransportFactory();
  const children: Array<{ pid: number; transport: PtyRuntimeTransport; exited: Promise<void> }> = [];
  const heartbeatGaps: number[] = [];
  const readiness: Promise<void>[] = [];
  const startupOutput: string[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  // Preserve an externally supplied opt-out for nice mode: the assertion must
  // actually go red when the implementation is disabled, not bypass the env.
  delete env.ADHDEV_CLI_CHILD_SCHEDULING;
  if (mode === 'none') env.ADHDEV_CLI_CHILD_NICE = '0';
  if (mode === 'darwin-bg') env.ADHDEV_CLI_CHILD_SCHEDULING = 'darwin-bg';
  let measuring = false;
  try {
    for (let index = 0; index <= cores; index++) {
      const script = index === cores ? probe : hog;
      const transport = factory.spawn(process.execPath, ['-e', script], { cwd: process.cwd(), env, cols: 80, rows: 24 });
      // Save each exact PID before doing anything else. No process-group kill,
      // process-name matching, or interaction with existing CLI sessions.
      const exited = new Promise<void>((resolve) => transport.onExit(() => resolve()));
      children.push({ pid: transport.pid, transport, exited });
      readiness.push(new Promise<void>((resolve) => {
        let lastBeat = performance.now();
        transport.onData((data) => {
          if (!measuring) startupOutput[index] = ((startupOutput[index] ?? '') + data).slice(-300);
          if (data.includes('ready')) resolve();
          if (data.includes('beat')) {
            const now = performance.now();
            if (measuring) heartbeatGaps.push(now - lastBeat);
            lastBeat = now;
          }
        });
      }));
    }
    await Promise.race([
      Promise.all(readiness),
      delay(20_000).then(() => { throw new Error(`CPU hog failed to become ready (${mode}): ${JSON.stringify(startupOutput)}`); }),
    ]);
    await delay(1000);
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    // Model an active daemon doing modest CPU work per tick (signaling + IPC),
    // rather than an otherwise idle timer process. Identical in every mode.
    const work = setInterval(() => {
      const end = performance.now() + 4;
      while (performance.now() < end) { /* parent CPU work */ }
    }, 10);
    histogram.enable();
    measuring = true;
    try {
      await delay(durationMs);
    } finally {
      measuring = false;
      histogram.disable();
      clearInterval(work);
    }
    heartbeatGaps.sort((a, b) => a - b);
    const result = {
      mode, cores, durationMs, optOut: env.ADHDEV_CLI_CHILD_NICE === '0',
      p50Ms: histogram.percentile(50) / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
      samples: histogram.count,
      parentNice: os.getPriority(process.pid),
      childNice: children.map(({ pid }) => os.getPriority(pid)),
      childHeartbeatP99Ms: heartbeatGaps[Math.floor(heartbeatGaps.length * 0.99)] ?? null,
      childHeartbeats: heartbeatGaps.length,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
  } finally {
    for (const { pid } of children) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await Promise.all(children.map(({ exited }) => exited));
  }
}

it.skipIf(process.env.ADHDEV_CLI_PRIORITY_LOAD !== '1' || process.platform === 'win32')(
  'LOAD: nice CLI children improve parent p99 under K-core saturation',
  async () => {
    const none = await measure('none');
    const nice = await measure('nice');
    const background = process.platform === 'darwin' ? await measure('darwin-bg') : null;
    // Timing noise must not let an opt-out/no-op implementation appear to
    // improve scheduling. Verify the actual OS policy as well as its effect.
    const expectedNice = Math.min(19, none.parentNice + 10);
    expect.soft(nice.childNice, 'every CLI/probe must actually be lowered').toEqual(nice.childNice.map(() => expectedNice));
    expect.soft(nice.parentNice, 'the parent must retain its priority').toBe(none.parentNice);
    expect.soft(nice.p99Ms, `nice p99=${nice.p99Ms}ms; none p99=${none.p99Ms}ms`).toBeLessThan(none.p99Ms * 0.8);
    if (background) {
      expect.soft(background.childNice).toEqual(background.childNice.map(() => expectedNice));
      expect.soft(background.p99Ms, 'Darwin BG should improve p99 by at least 20%').toBeLessThan(none.p99Ms * 0.8);
      expect.soft(background.childHeartbeats, 'background CLI probe must stay responsive').toBeGreaterThan(20);
      expect.soft(background.childHeartbeatP99Ms, 'background CLI heartbeat p99 must stay below 2s').toBeLessThan(2000);
    }
  },
  120_000,
);
