// R4f LIVE acked-hold harness — exercises the REAL src/mesh/mesh-reconcile-loop.ts (no vitest
// mocks) against a REAL MeshRuntimeStore + ledger + pending-events queue persisted to an isolated
// temp ~/.adhdev. It reproduces the R4e live FAIL scenario (a long worker turn whose real
// generating_completed emit lags behind win32-style idle reads) and demonstrates that:
//   (1) ACKED-HOLD: the coordinator does NOT synth a completion while the worker is alive mid-turn,
//       no matter how many idle ticks elapse (R4e would have synthed and pre-empted).
//   (2) REAL-EMIT-WINS: when the worker's REAL completion finally lands, it surfaces intact and the
//       later (idempotent) synth never masks it — accurate duration, no premature completedAt.
//   (3) DEATH BACKSTOP (b): a genuinely-wedged worker (idle past the death-deadline) IS eventually
//       synthesized — a finite notification-loss net, not an infinite hold.
//
// Run: HOME=<tmp> npx tsx scripts/r4f-live-acked-hold.mts  (HOME is set by the runner below)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate ~/.adhdev to a throwaway dir BEFORE importing anything that reads config.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r4f-live-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.adhdev'), { recursive: true });
// A stable machineId for the local coordinator daemon.
fs.writeFileSync(path.join(tmpHome, '.adhdev', 'config.json'), JSON.stringify({ machineId: 'live-machine' }));

const { runMeshReconcileTick } = await import('../src/mesh/mesh-reconcile-loop.ts');
const { insertDirectDispatch, getActiveDirectDispatches, updateDirectDispatchStatus } = await import('../src/mesh/mesh-work-queue.ts');
const { appendLedgerEntry, readLedgerEntries } = await import('../src/mesh/mesh-ledger.ts');
const { getPendingMeshCoordinatorEvents, queuePendingMeshCoordinatorEvent } = await import('../src/mesh/mesh-events-pending.ts');
const { listMeshes } = await import('../src/config/mesh-config.ts');

const NODE = 'live-node';
const RESULTS: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  RESULTS.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

// Persist a REAL one-node mesh to ~/.adhdev/meshes.json (the file listMeshes reads). The node is
// LOCAL (no daemonId, and the local machineId owns it) so read_chat resolves through the stub
// commandHandler. This drives the REAL listMeshes/daemonHostsMesh path, not a monkeypatch.
function withMesh(meshId: string) {
  const now = new Date().toISOString();
  const cfg = {
    meshes: [{
      id: meshId, name: meshId, repoIdentity: `live-repo-${meshId}`,
      policy: {}, coordinator: { mode: 'local' },
      nodes: [{ id: NODE, workspace: '/repo/live', machineId: 'live-machine', userOverrides: {} }],
      createdAt: now, updatedAt: now,
    }],
  };
  fs.writeFileSync(path.join(tmpHome, '.adhdev', 'meshes.json'), JSON.stringify(cfg, null, 2));
  // Sanity: the reconcile loop will only act on a mesh listMeshes returns AND this daemon hosts.
  const got = listMeshes().find((m: any) => m.id === meshId);
  if (!got) throw new Error(`withMesh: listMeshes did not return ${meshId} after save`);
}

function seedAcked(meshId: string, sessionId: string, taskId: string, dispatchSecondsAgo: number) {
  const ts = new Date(Date.now() - dispatchSecondsAgo * 1000).toISOString();
  appendLedgerEntry(meshId, {
    kind: 'task_dispatched', nodeId: NODE, sessionId, providerType: 'claude-cli',
    payload: { source: 'direct', via: 'local_direct', taskId, message: 'do long work' },
    timestamp: ts,
  } as any);
  insertDirectDispatch(meshId, {
    taskId, nodeId: NODE, sessionId, providerType: 'claude-cli', message: 'do long work',
    via: 'local_direct', dispatchedAt: ts,
  });
  // The worker ECHOED agent:generating_started → row flips to 'acked' (updated_at = now).
  updateDirectDispatchStatus(meshId, sessionId, 'acked', taskId);
}

// A commandHandler stub whose read_chat status is driven by a mutable closure — this is the only
// part that simulates the live worker. Everything else (reconcile decision, store, ledger, queue)
// is the REAL compiled-from-source code path.
function makeComponents(sessionId: string, getStatus: () => string, getFinalSummary: () => string) {
  const handle = async (cmd: string) => {
    if (cmd === 'get_status_metadata') {
      // Keep the session PRESENT so PHASE 5 never prunes the row mid-experiment.
      return { success: true, status: { sessions: [{ id: sessionId, status: getStatus() }] } };
    }
    if (cmd === 'read_chat') {
      return {
        success: true,
        status: getStatus(),
        providerSessionId: 'claude-history-live',
        messages: [{ role: 'assistant', content: getFinalSummary(), timestamp: Date.now() }],
      };
    }
    return { success: true };
  };
  return { instanceManager: { getByCategory: () => [], getInstance: () => undefined }, commandHandler: { handle } } as any;
}

// ── Scenario 1: ACKED-HOLD + REAL-EMIT-WINS ────────────────────────────────────
// The exact R4e live FAIL shape: a long worker turn whose read_chat flips to idle mid-turn (a
// win32-style inter-tool-call settle) BEFORE the real generating_completed emit arrives. R4e would
// synth ~16s early and mask the real emit. R4f must hold indefinitely, then let the real emit win.
{
  const meshId = `live_acked_hold_${Date.now()}`;
  withMesh(meshId);
  const sessionId = 'sess-live-hold';
  const taskId = 'task-live-hold';
  seedAcked(meshId, sessionId, taskId, 5 * 60); // ack ≈ now; dispatch old enough to clear grace

  // The worker reads idle mid-turn (the lagging-emit race) for many ticks.
  let status = 'idle';
  const components = makeComponents(sessionId, () => status, () => 'mid-turn rendered text (NOT the final result)');

  // Drive 10 reconcile ticks — a finite R4e timer would have fired well within this.
  for (let i = 0; i < 10; i++) await runMeshReconcileTick(components);

  const synthBefore = readLedgerEntries(meshId).filter((e: any) => e.kind === 'task_completed' && (e.payload as any)?.source === 'daemon_reconcile_transcript_completion');
  check('S1 acked-hold: NO synth across 10 idle ticks while worker alive (ack≈now, default 8min deadline)',
    synthBefore.length === 0, `synth count=${synthBefore.length} (expected 0)`);
  check('S1 acked-hold: dispatch row still active (not falsely completed)',
    getActiveDirectDispatches(meshId).some((d: any) => d.taskId === taskId), 'row present & non-terminal');

  // The worker's REAL completion finally lands (the lagging emit R4e pre-empted).
  const realCompletedAt = Date.now();
  queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed', meshId, nodeLabel: `Node '${NODE}'`, nodeId: NODE,
    metadataEvent: { taskId, sessionId, providerSessionId: 'claude-history-live', finalSummary: 'REAL worker completion — full long-turn result.', completedAt: realCompletedAt, timestamp: realCompletedAt },
    coordinatorMessage: `Node '${NODE}' has completed its task.`, queuedAt: realCompletedAt,
  } as any);

  // One more tick: the real emit is queued → worker-emit-priority yields AND the indefinite hold
  // still applies → no masking synth is ever written.
  await runMeshReconcileTick(components);

  const synthAfter = readLedgerEntries(meshId).filter((e: any) => e.kind === 'task_completed' && (e.payload as any)?.source === 'daemon_reconcile_transcript_completion');
  const pending = getPendingMeshCoordinatorEvents(meshId).filter((p: any) => p.event === 'agent:generating_completed');
  check('S1 real-emit-wins: NO synthesized terminal masks the real emit',
    synthAfter.length === 0, `synth count=${synthAfter.length} (expected 0)`);
  check('S1 real-emit-wins: the worker\'s OWN completion surfaces intact in the queue',
    pending.length === 1 && /REAL worker completion/.test(String((pending[0]?.metadataEvent as any)?.finalSummary)),
    `pending=${pending.length}, summary="${(pending[0]?.metadataEvent as any)?.finalSummary}"`);
  // Duration accuracy: the surfaced completedAt is the worker's REAL emit time, never a synth time
  // that precedes it (the R4e bug was synth-completedAt < worker-emit).
  check('S1 duration accurate: surfaced completedAt == worker real emit (no premature synth time)',
    Number((pending[0]?.metadataEvent as any)?.completedAt) === realCompletedAt,
    `completedAt=${(pending[0]?.metadataEvent as any)?.completedAt} == realEmit=${realCompletedAt}`);
}

// ── Scenario 2: DEATH BACKSTOP (b) — finite notification-loss net ───────────────
// A genuinely-wedged worker: emit permanently lost, session sits idle. With the death-deadline
// forced to 0 (sinceAck≈0 crosses it), the synth MUST eventually fire so the notification is never
// lost forever — proving the hold is finite, not infinite.
{
  const meshId = `live_death_deadline_${Date.now()}`;
  withMesh(meshId);
  process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0';
  const sessionId = 'sess-live-zombie';
  const taskId = 'task-live-zombie';
  seedAcked(meshId, sessionId, taskId, 5 * 60);
  const components = makeComponents(sessionId, () => 'idle', () => 'All done — full result that was never emitted as a completion event.');

  await runMeshReconcileTick(components);
  const completed = readLedgerEntries(meshId).find((e: any) => e.kind === 'task_completed' && e.sessionId === sessionId);
  const pending = getPendingMeshCoordinatorEvents(meshId).some((p: any) => p.event === 'agent:generating_completed');
  check('S2 death-deadline: a wedged (idle-past-deadline) acked task IS synthesized (finite loss-net)',
    !!completed && (completed?.payload as any)?.source === 'daemon_reconcile_transcript_completion',
    `completed=${!!completed}`);
  check('S2 death-deadline: the synthesized completion is queued for the coordinator (notification not lost)',
    pending, `pending=${pending}`);
  delete process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS;
}

// ── Summary ────────────────────────────────────────────────────────────────────
const failed = RESULTS.filter(r => !r.pass);
console.log(`\n=== R4f LIVE acked-hold: ${RESULTS.length - failed.length}/${RESULTS.length} checks passed ===`);
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(failed.length === 0 ? 0 : 1);
