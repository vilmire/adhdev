import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { reportCompletion, progressUpdate, describeWorkerDeliveryAnswer } from '../src/tools/worker-tools.js';
import {
  WorkerReportDelivery,
  WORKER_OUTBOX_MAX_AGE_MS,
  resolveWorkerOutboxDir,
} from '../src/tools/worker-report-outbox.js';

// Durable worker-report delivery (missions d5ed7a7b / 62bbb95c / 4dc23885): under daemon
// overload a worker's report_completion timed out 3× in a row and the finished work never
// reached the coordinator. These pin the MCP half: the report survives IPC timeouts, is
// delivered exactly once when the daemon recovers, and the worker is told the truth.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-outbox-test-'));
}

function timeoutError(): Error {
  const e = new Error("Daemon IPC command='worker_report_completion' timed out after 15s");
  (e as any).ipcTimeout = true;
  return e;
}

/**
 * A daemon that processes every call it receives, keyed by deliveryId the way
 * daemon-core's replay record does — and a transport that LOSES the first `lostAnswers`
 * answers (the daemon did the work; the client timed out waiting). That is exactly the
 * overload shape: without a stable delivery id, each retry would be a fresh report.
 */
function overloadedDaemon(lostAnswers: number) {
  const effects: Array<{ deliveryId: string; reportedAtMs: number }> = [];
  const seen = new Map<string, any>();
  const calls: any[] = [];
  let remainingLost = lostAnswers;
  const transport = {
    async command(command: string, args: any) {
      calls.push({ command, args });
      let answer = seen.get(args.deliveryId);
      if (answer) {
        answer = { ...answer, duplicate: true };
      } else {
        effects.push({ deliveryId: args.deliveryId, reportedAtMs: args.reportedAtMs });
        answer = { success: true, taskId: 'task_1', outcome: 'completed', duplicate: false };
        seen.set(args.deliveryId, answer);
      }
      if (remainingLost > 0) {
        remainingLost -= 1;
        throw timeoutError();
      }
      return answer;
    },
    async ping() { return true; },
  } as any;
  return { transport, effects, calls };
}

const noSleep = async () => {};

test('a report survives repeated IPC timeouts: queued (not an error), then lands exactly once when the daemon recovers', async () => {
  const dir = tmpDir();
  const daemon = overloadedDaemon(3);
  const delivery = new WorkerReportDelivery({
    transport: daemon.transport, credentials: { bind: 'wsb_test' }, dir,
    sleep: noSleep, autoSchedule: false, describeAnswer: describeWorkerDeliveryAnswer, log: () => {},
  });

  const result = await reportCompletion(daemon.transport, { bind: 'wsb_test' }, {
    outcome: 'completed', summary: 'OS difference investigation: full findings', touched_files: [],
  }, delivery);

  // Two inline sends, both timed out → the worker is told it is QUEUED, not that it failed.
  assert.equal(result.isError, undefined);
  assert.match(result.text, /QUEUED for delivery/);
  assert.match(result.text, /NOT lost/);
  assert.equal(delivery.pendingCount(), 1);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 1, 'write-ahead entry is on disk');

  await delivery.flush(); // third send: still lost
  assert.equal(delivery.pendingCount(), 1);
  await delivery.flush(); // daemon recovered
  assert.equal(delivery.pendingCount(), 0);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 0);

  // Four sends, ONE daemon effect: every send carried the same delivery id + creation time.
  assert.equal(daemon.calls.length, 4);
  assert.equal(daemon.effects.length, 1);
  const ids = new Set(daemon.calls.map(c => c.args.deliveryId));
  const stamps = new Set(daemon.calls.map(c => c.args.reportedAtMs));
  assert.equal(ids.size, 1);
  assert.equal(stamps.size, 1);
  assert.equal(daemon.calls[0].args.bind, 'wsb_test');
  assert.deepEqual(daemon.calls[0].args.report.touchedFiles, []);

  // The recovery is surfaced on the worker's next tool response.
  const notices = delivery.takeNotices();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /reached the daemon after 4 attempt\(s\)/);
  assert.match(notices[0], /task_1/);
  assert.deepEqual(delivery.takeNotices(), []);
});

test('an entry queued by one MCP process is delivered by its successor (same bind ⇒ same outbox)', async () => {
  const base = tmpDir();
  const dir = resolveWorkerOutboxDir({ bind: 'wsb_successor' }, { ADHDEV_WORKER_OUTBOX_DIR: base } as any)!;
  const down = { async command() { throw new Error('Cannot connect to daemon IPC at ws://127.0.0.1:19223/ipc'); }, async ping() { return false; } } as any;
  const first = new WorkerReportDelivery({ transport: down, credentials: { bind: 'wsb_successor' }, dir, sleep: noSleep, autoSchedule: false, log: () => {} });
  const queued = await first.submit('report', { report: { outcome: 'completed', summary: 'done' } });
  assert.equal(queued.status, 'queued');
  first.dispose();

  const received: any[] = [];
  const up = { async command(_c: string, args: any) { received.push(args); return { success: true, taskId: 't', outcome: 'completed' }; }, async ping() { return true; } } as any;
  const second = new WorkerReportDelivery({ transport: up, credentials: { bind: 'wsb_successor' }, dir, sleep: noSleep, autoSchedule: false, log: () => {} });
  assert.equal(second.pendingCount(), 1);
  await second.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].deliveryId, queued.status === 'queued' ? queued.entryId : '');
  assert.equal(second.pendingCount(), 0);
});

test('the outbox directory is keyed by a hash of the bind, never the bind itself', () => {
  const dir = resolveWorkerOutboxDir({ bind: 'wsb_SECRET_value' }, { ADHDEV_WORKER_OUTBOX_DIR: '/x' } as any)!;
  assert.ok(!dir.includes('SECRET'));
  assert.equal(resolveWorkerOutboxDir({}, {} as any), null);
});

test('a definitive refusal is answered once and not retried; a retryable one is kept', async () => {
  const calls: string[] = [];
  const refusing = { async command(c: string) { calls.push(c); return { success: false, error: 'invalid_report', validationErrors: [{ field: 'summary', message: 'summary is required' }] }; }, async ping() { return true; } } as any;
  const d1 = new WorkerReportDelivery({ transport: refusing, credentials: { bind: 'wsb_a' }, dir: null, sleep: noSleep, autoSchedule: false, log: () => {} });
  const refused = await reportCompletion(refusing, { bind: 'wsb_a' }, { outcome: 'completed' }, d1);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /summary is required/);
  assert.equal(calls.length, 1);
  assert.equal(d1.pendingCount(), 0);

  let n = 0;
  const flaky = { async command() { n += 1; return n < 3 ? { success: false, error: 'forward_failed', detail: 'owner unreachable' } : { success: true, taskId: 't', outcome: 'completed' }; }, async ping() { return true; } } as any;
  const d2 = new WorkerReportDelivery({ transport: flaky, credentials: { bind: 'wsb_b' }, dir: null, sleep: noSleep, autoSchedule: false, log: () => {} });
  const queued = await reportCompletion(flaky, { bind: 'wsb_b' }, { outcome: 'completed', summary: 'x' }, d2);
  assert.match(queued.text, /QUEUED/);
  assert.match(queued.text, /forward_failed/);
  await d2.flush();
  assert.equal(d2.pendingCount(), 0);
  assert.equal(n, 3);
});

test('re-calling report_completion with the same report reuses the queued delivery id', async () => {
  const ids: string[] = [];
  const down = { async command(_c: string, args: any) { ids.push(args.deliveryId); throw timeoutError(); }, async ping() { return true; } } as any;
  const d = new WorkerReportDelivery({ transport: down, credentials: { bind: 'wsb_c' }, dir: null, sleep: noSleep, autoSchedule: false, inlineAttempts: 1, log: () => {} });
  await reportCompletion(down, { bind: 'wsb_c' }, { outcome: 'completed', summary: 'same' }, d);
  await reportCompletion(down, { bind: 'wsb_c' }, { outcome: 'completed', summary: 'same' }, d);
  assert.equal(d.pendingCount(), 1);
  assert.equal(new Set(ids).size, 1);
  assert.ok(d.daemonRecentlyUnreachable());
});

test('an entry past the delivery window is dropped with a notice telling the worker to restate it', async () => {
  let now = 1_000_000;
  const down = { async command() { throw timeoutError(); }, async ping() { return true; } } as any;
  const d = new WorkerReportDelivery({ transport: down, credentials: { bind: 'wsb_d' }, dir: null, sleep: noSleep, autoSchedule: false, inlineAttempts: 1, now: () => now, log: () => {} });
  await d.submit('report', { report: { outcome: 'completed', summary: 'late' } });
  now += WORKER_OUTBOX_MAX_AGE_MS + 1;
  await d.flush();
  assert.equal(d.pendingCount(), 0);
  const [notice] = d.takeNotices();
  assert.match(notice, /could not be delivered/);
  assert.match(notice, /final message/);
});

test('progress_update is queued, not failed, when the daemon does not answer', async () => {
  const down = { async command() { throw timeoutError(); }, async ping() { return true; } } as any;
  const d = new WorkerReportDelivery({ transport: down, credentials: { bind: 'wsb_e' }, dir: null, sleep: noSleep, autoSchedule: false, log: () => {} });
  const result = await progressUpdate(down, { bind: 'wsb_e' }, { note: 'phase one done' }, d);
  assert.equal(result.isError, undefined);
  assert.match(result.text, /queued for delivery/);
});
