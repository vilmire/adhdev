import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
function assertMatch(actual: any, expected: any): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === 'object') assertMatch(actual[key], value);
    else assert.equal(actual[key], value);
  }
}
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerReportDelivery } from '../src/tools/worker-report-outbox.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'strict-worker-outbox-')); dirs.push(dir); return dir; }
function entry(dir: string) { return JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith('.json'))!), 'utf8')); }
const credentials = { bind: 'synthetic-bind-no-live-credential' };

describe('strict worker outbox provenance and quarantine', () => {
  for (const kind of ['report','progress'] as const) it(`${kind} restores only its stored prepared claim after a lost preparation ACK and client restart`, async () => {
    const dir = directory(), calls: any[] = [];
    let prepared: any, lost = true, generation = 0;
    const transport: any = { command: async (command: string, args: any) => {
      calls.push({ command, args });
      if (command === 'worker_bridge_prepare') {
        if (args.resume) return prepared ? { success: true, protocol: 1, prepared } : { success: false };
        prepared = { meshId: 'mesh', taskId: 'task', attemptId: 'attempt', generation, sessionId: 'session', nodeId: 'node', ownerDaemonId: 'owner', deliveryId: args.deliveryId, reportedAtMs: args.reportedAtMs };
        if (lost) { lost = false; throw new Error('lost preparation ACK'); }
        return { success: true, protocol: 1, prepared };
      }
      return { success: true, taskId: 'task' };
    } };
    const options = { dir, credentials, transport, strictProtocol: true, autoSchedule: false, inlineAttempts: 1, log: () => {} };
    const first = new WorkerReportDelivery(options);
    const payload = kind === 'report' ? { report: { outcome: 'completed', summary: 'Synthetic retained report.' } } : { note: 'Synthetic retained progress.' };
    assertMatch(await first.submit(kind, payload), { status: 'answered', result: { success: false, error: 'worker_delivery_quarantined' } });
    const original = entry(dir);
    assert.equal(original.preparationIntent, true);
    assert.equal(original.quarantined, 'provenance_unavailable_at_creation');
    first.dispose(); generation = 1;
    const restarted = new WorkerReportDelivery(options);
    await restarted.flush();
    const restored = calls.find((call) => call.command === 'worker_bridge_prepare' && call.args.resume);
    assertMatch(restored.args, { deliveryId: original.id, reportedAtMs: original.createdAtMs });
    const sent = calls.find((call) => call.command !== 'worker_bridge_prepare');
    assert.equal(sent.args.prepared.generation, 0);
    assert.equal(sent.args.deliveryId, original.id);
    assert.equal(sent.args.reportedAtMs, original.createdAtMs);
    assert.equal(restarted.pendingCount(), 0);
    restarted.dispose();
  });

  it('never creates provenance later for an unacknowledged preparation that was never stored', async () => {
    const dir = directory(), calls: any[] = [];
    const transport: any = { command: async (command: string, args: any) => { calls.push({ command, args }); throw new Error('unsupported peer'); } };
    const options = { dir, credentials, transport, strictProtocol: true, autoSchedule: false, inlineAttempts: 1, log: () => {} };
    const first = new WorkerReportDelivery(options);
    await first.submit('report', { report: { summary: 'Retain me locally.' } }); first.dispose();
    const second = new WorkerReportDelivery(options); await second.flush();
    assert.equal((calls).length, 2);
    assert.equal(calls.every((call) => call.command === 'worker_bridge_prepare'), true);
    assert.equal(calls[1].args.resume, true);
    assert.equal(second.pendingCount(), 1);
    second.dispose();
  });

  it('retains expired unsupported envelopes across restart and reports quarantine once', async () => {
    const dir = directory(); let now = 1000;
    const transport: any = { command: async () => ({ success: false, error: 'worker_protocol_unsupported' }) };
    const options = { dir, credentials, transport, now: () => now, maxAgeMs: 100, autoSchedule: false, inlineAttempts: 1, log: () => {} };
    const first = new WorkerReportDelivery(options);
    await first.submit('report', { report: { summary: 'Expired body stays local.' } });
    const original = entry(dir); now = 1101; await first.flush();
    assert.equal(first.pendingCount(), 1);
    assert.match(first.takeNotices().join(), /not dropped/);
    const quarantined = entry(dir);
    assert.equal(quarantined.id, original.id);
    assert.equal(quarantined.createdAtMs, original.createdAtMs);
    assert.deepEqual(quarantined.payload, original.payload);
    assert.equal(quarantined.quarantined, 'expired_undelivered');
    first.dispose();
    const second = new WorkerReportDelivery(options); await second.flush();
    assert.equal(second.pendingCount(), 1); assert.deepEqual(second.takeNotices(), []); second.dispose();
  });

  it('strict delivery refuses to send without durable local storage', async () => {
    const root = directory(), file = join(root, 'not-a-directory'); writeFileSync(file, 'synthetic');
    let called = false;
    const delivery = new WorkerReportDelivery({ dir: file, credentials, strictProtocol: true, autoSchedule: false,
      transport: { command: async () => { called = true; return { success: true }; } } as any, log: () => {} });
    assertMatch(await delivery.submit('report', { report: { summary: 'Unsent.' } }), { status: 'answered', result: { success: false, error: 'outbox_storage_failed' } });
    assert.equal(called, false); delivery.dispose();
  });
});
