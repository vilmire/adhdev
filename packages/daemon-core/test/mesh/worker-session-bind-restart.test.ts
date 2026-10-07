/**
 * Worker session binds survive a daemon restart for session-host-restored workers.
 *
 * The worker's MCP server reads `ADHDEV_WORKER_SESSION_BIND` once at spawn. With
 * session-host restore the worker outlives the daemon (`origin=restore`), so a
 * registry that lived only in memory refused every report / drain / progress
 * call from it after the restart (live 2026-10-07: bind issued 01:10:28,
 * session restored 01:18:36, `worker_report_completion ok=false` +
 * `worker_drain_mailbox ok=false` at 01:24:57).
 *
 * Pinned here:
 *   - mint → restart (in-memory registry AND task tokens cleared, store kept) →
 *     full restore → report_completion, drain_mailbox and progress succeed;
 *   - a session that did NOT come back is pruned and refused with
 *     `bind_unknown_after_restart`, distinct from `unauthenticated`;
 *   - the raw bind never reaches mesh-runtime.db (only its SHA-256);
 *   - `hasLiveWorkerSessionBind()` is true for a restored worker before its first call;
 *   - a `daemon_shutdown` termination keeps the persisted row, a real exit drops it.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workerReportHandlers } from '../../src/commands/low-family/worker-report'
import { workerMailboxHandlers } from '../../src/commands/low-family/worker-mailbox'
import { DaemonCliManager } from '../../src/commands/cli-manager.js'
import { ProviderLoader } from '../../src/providers/provider-loader.js'
import { __resetReportedSummariesForTest, __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report'
import { __resetProgressSurfaceForTest, __setWorkerProgressNoticeSinkForTests } from '../../src/mesh/worker-report-progress.js'
import { __resetWorkerDeliveryReplayForTests } from '../../src/mesh/worker-report-idempotency'
import { __resetWorkerMailboxForTest, depositWorkerMailboxMessage } from '../../src/mesh/worker-mailbox'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { SqliteWorkerSessionBindStore } from '../../src/mesh/worker-session-bind-store'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  hasLiveWorkerSessionBind,
  hashWorkerSessionBind,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
  reconcileWorkerSessionBindsAfterRestore,
  setWorkerSessionBindPersistence,
  subscribeWorkerBindRevocation,
} from '../../src/mesh/worker-mcp-isolation'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'

const ctx: any = { deps: { statusInstanceId: 'test-daemon', instanceManager: { getInstance: () => undefined } } }
const REPORT = { outcome: 'completed', summary: 'Restored worker finished the migration.', touchedFiles: [] }

let seq = 0
function fresh() {
  seq += 1
  const tag = `${Date.now().toString(36)}_${seq}`
  return { meshId: `mesh_rb_${tag}`, sessionId: `session_rb_${tag}`, nodeId: `node_rb_${tag}` }
}

function seedLiveTask(meshId: string, sessionId: string, nodeId: string, taskId: string): string {
  const iso = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'work', status: 'assigned',
    assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso,
  } as any)
  const attempt = seedMeshAttempt({ meshId, taskId, sessionId, nodeId, scope: 'mesh_direct', stage: 'consumed' })
  mintWorkerTaskToken({ meshId, taskId, attemptId: attempt.attemptId, sessionId, nodeId })
  return attempt.attemptId
}

/** Sessions live on "this daemon" — the liveness probe the boot stage derives from the registry/instance manager. */
const liveHere = new Set<string>()

/** What a daemon restart does to the process-memory state (the store survives). */
function simulateRestart() {
  __resetWorkerSessionBindsForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerDeliveryReplayForTests()
  liveHere.clear()
}

function bindRows() {
  return MeshRuntimeStore.getInstance().db.prepare('SELECT * FROM worker_session_binds').all() as Array<Record<string, unknown>>
}

beforeEach(() => {
  __resetReportedSummariesForTest()
  __resetProgressSurfaceForTest()
  __resetWorkerMailboxForTest()
  simulateRestart()
  MeshRuntimeStore.getInstance().db.prepare('DELETE FROM worker_session_binds').run()
  setWorkerSessionBindPersistence(new SqliteWorkerSessionBindStore(MeshRuntimeStore.getInstance().db), (sid) => liveHere.has(sid))
  __setHandoffNoteSinkForTests(() => {})
  __setWorkerProgressNoticeSinkForTests(() => {})
})

afterEach(() => {
  setWorkerSessionBindPersistence(null)
  __setHandoffNoteSinkForTests(undefined)
  __setWorkerProgressNoticeSinkForTests(undefined)
  simulateRestart()
})

describe('worker session bind — restart survival', () => {
  it('a restored worker reports completion, drains its mailbox and sends progress with its spawn-time bind', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    const taskId = `${meshId}_task`
    seedLiveTask(meshId, sessionId, nodeId, taskId)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId, spawnedForTaskId: taskId }).bind

    simulateRestart()
    expect(hasLiveWorkerSessionBind(sessionId)).toBe(false)

    // Full restore: the session came back and is registered here.
    liveHere.add(sessionId)
    expect(reconcileWorkerSessionBindsAfterRestore(new Set([sessionId]))).toEqual({ rehydrated: 1, pruned: 0 })
    // Before the worker's first call — the idle-edge detach gate reads this.
    expect(hasLiveWorkerSessionBind(sessionId)).toBe(true)

    expect(depositWorkerMailboxMessage({ meshId, taskId, text: 'also update the docs' }).ok).toBe(true)
    const drained: any = await workerMailboxHandlers.worker_drain_mailbox(ctx, { bind })
    expect(drained).toMatchObject({ success: true, taskId })
    expect(drained.messages.map((m: any) => m.text)).toEqual(['also update the docs'])

    const progress: any = await workerReportHandlers.worker_progress_update(ctx, { bind, note: 'Halfway: schema migrated, consumers next.' })
    expect(progress).toMatchObject({ success: true, taskId })

    const report: any = await workerReportHandlers.worker_report_completion(ctx, { bind, report: REPORT })
    expect(report).toMatchObject({ success: true, taskId, duplicate: false })
    expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId)?.status).toBe('completed')
  })

  it('a persisted bind whose session is live is honoured even before the post-restore reconcile ran', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    const taskId = `${meshId}_task`
    seedLiveTask(meshId, sessionId, nodeId, taskId)
    const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    simulateRestart()

    // Not registered here yet: refused, but not as "unknown" — the row exists.
    const early: any = await workerMailboxHandlers.worker_drain_mailbox(ctx, { bind })
    expect(early).toMatchObject({ success: false, error: 'unauthenticated' })

    liveHere.add(sessionId)
    const report: any = await workerReportHandlers.worker_report_completion(ctx, { bind, report: REPORT })
    expect(report).toMatchObject({ success: true, taskId })
  })

  it('a session that did not come back is pruned and refused with bind_unknown_after_restart', async () => {
    const back = fresh()
    const gone = fresh()
    seedLiveTask(back.meshId, back.sessionId, back.nodeId, `${back.meshId}_task`)
    seedLiveTask(gone.meshId, gone.sessionId, gone.nodeId, `${gone.meshId}_task`)
    mintWorkerSessionBind(back)
    const goneBind = mintWorkerSessionBind(gone).bind

    simulateRestart()
    liveHere.add(back.sessionId)
    expect(reconcileWorkerSessionBindsAfterRestore(new Set([back.sessionId]))).toEqual({ rehydrated: 1, pruned: 1 })
    expect(hasLiveWorkerSessionBind(gone.sessionId)).toBe(false)
    expect(bindRows().map((r) => r.session_id)).toEqual([back.sessionId])

    const report: any = await workerReportHandlers.worker_report_completion(ctx, { bind: goneBind, report: REPORT })
    expect(report).toMatchObject({ success: false, error: 'bind_unknown_after_restart' })
    expect(String(report.hint)).toMatch(/daemon restart/)
    const drain: any = await workerMailboxHandlers.worker_drain_mailbox(ctx, { bind: goneBind })
    expect(drain).toMatchObject({ success: false, error: 'bind_unknown_after_restart' })
    const progress: any = await workerReportHandlers.worker_progress_update(ctx, { bind: goneBind, note: 'still here?' })
    expect(progress).toMatchObject({ success: false, error: 'bind_unknown_after_restart' })
  })

  it('a bind revoked in this incarnation stays plain unauthenticated, not "unknown after restart"', async () => {
    const { meshId, sessionId, nodeId } = fresh()
    seedLiveTask(meshId, sessionId, nodeId, `${meshId}_task`)
    const first = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
    mintWorkerSessionBind({ meshId, sessionId, nodeId }) // re-spawn revokes the first
    const res: any = await workerMailboxHandlers.worker_drain_mailbox(ctx, { bind: first })
    expect(res).toMatchObject({ success: false, error: 'unauthenticated' })
    expect(bindRows()).toHaveLength(1)
  })

  it('never persists the raw bind — only its SHA-256', () => {
    const { meshId, sessionId, nodeId } = fresh()
    const { bind } = mintWorkerSessionBind({ meshId, sessionId, nodeId })
    const rows = bindRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].bind_hash).toBe(hashWorkerSessionBind(bind))
    expect(JSON.stringify(rows)).not.toContain(bind)
    expect(JSON.stringify(rows)).not.toContain('wsb_')
    // Nor anywhere in the database files.
    const dbPath = MeshRuntimeStore.getInstance().db.name
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(bind))).toBe(false)
    }
  })

  it('a daemon_shutdown termination keeps the persisted row; a real exit drops it', () => {
    const handlers: Array<(e: any) => void> = []
    const bus: any = { on: (_kind: string, fn: (e: any) => void) => { handlers.push(fn); return () => {} } }
    subscribeWorkerBindRevocation(bus)
    const a = fresh()
    const b = fresh()
    mintWorkerSessionBind(a)
    mintWorkerSessionBind(b)
    for (const h of handlers) h({ kind: 'terminated', sessionId: a.sessionId, cause: 'daemon_shutdown' })
    for (const h of handlers) h({ kind: 'terminated', sessionId: b.sessionId, cause: 'pty_exit' })
    expect(bindRows().map((r) => r.session_id)).toEqual([a.sessionId])
    expect(hasLiveWorkerSessionBind(b.sessionId)).toBe(false)
  })
})

// ─── Through the real boot restore path ─────────────────────────────────────

class TestProviderLoader extends ProviderLoader {
  constructor(userDir: string, private readonly testConfig: any) {
    super({ userDir, disableUpstream: true })
  }
  protected override readConfig(): any | null { return this.testConfig }
  protected override writeConfig(config: any): void { Object.assign(this.testConfig, config) }
}

describe('restoreHostedSessions — full boot restore re-adopts worker binds', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  function setupLoader(): ProviderLoader {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-bind-restore-providers-'))
    dirs.push(root)
    const dir = join(root, 'cli', 'sample-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({
      type: 'sample-cli', name: 'Sample CLI', category: 'cli', spawn: { command: 'sample-cli-definitely-missing' },
      patterns: ['sample'], settings: {},
    }), 'utf-8')
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({
      $schema: 'adhdev:cli/spec@4', id: 'sample-cli', name: 'sample-cli', binary: 'sample-cli',
      send_message: { submit_key: '\r' }, sections: {},
      states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }], transitions: [],
    }), 'utf-8')
    const executable = join(root, 'bin', 'sample-cli')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(executable, 0o755)
    const loader = new TestProviderLoader(root, { machineProviders: { 'sample-cli': { enabled: true, executable } } })
    loader.loadAll()
    return loader
  }

  it('re-adopts the bind of a restored runtime and prunes one that did not come back', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-bind-restore-ws-'))
    dirs.push(workspace)
    const back = fresh()
    const gone = fresh()
    const backBind = mintWorkerSessionBind(back).bind
    const goneBind = mintWorkerSessionBind(gone).bind
    simulateRestart()

    const addInstance = vi.fn(async (key: string) => { liveHere.add(key) })
    const records = [{ runtimeId: back.sessionId, cliType: 'sample-cli', workspace }]
    const cli = new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
      listHostedCliRuntimes: async () => records,
    } as any, setupLoader())
    expect(await cli.restoreHostedSessions()).toBe(1)

    expect(hasLiveWorkerSessionBind(back.sessionId)).toBe(true)
    expect(hasLiveWorkerSessionBind(gone.sessionId)).toBe(false)
    expect(bindRows().map((r) => r.bind_hash)).toEqual([hashWorkerSessionBind(backBind)])
    const res: any = await workerMailboxHandlers.worker_drain_mailbox(ctx, { bind: goneBind })
    expect(res).toMatchObject({ success: false, error: 'bind_unknown_after_restart' })
  }, 15000)
})
