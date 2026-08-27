import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * RC32 lifecycle/restart reliability regression tests:
 *   A. whenIdle schedules are PERSISTED with mesh/node ownership and cleared on cancel
 *   B. keyed isolation — a second mesh/node schedule never clobbers or cross-cancels the first
 *   C. simulated boot: unexpired persisted records re-arm and execute on idle
 *   D. simulated boot: expired persisted records are dropped without executing
 *   E. pendingOutboundCount blocks the restart gate and is NOT waived by selfOnly;
 *      the deferred poll rechecks until the queue drains
 *
 * The low-family lifecycle handlers are mocked so no real npm/spawn/exit runs;
 * config.js getConfigDir is pointed at a per-run temp dir so state.json I/O is isolated.
 */

let configDir = ''

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => configDir,
}))

const { daemonUpgrade, daemonRestart } = vi.hoisted(() => ({
  daemonUpgrade: vi.fn(async () => ({ success: true, upgraded: false, alreadyLatest: true }) as any),
  daemonRestart: vi.fn(async () => ({ success: true, restarted: true, restarting: true, mode: 'restart' }) as any),
}))

vi.mock('../../src/commands/low-family/daemon-lifecycle.js', () => ({
  daemonLifecycleHandlers: {
    daemon_upgrade: daemonUpgrade,
    daemon_restart: daemonRestart,
  },
}))

import {
  __clearDeferredRestartsForTests,
  meshRestartHandlers,
  rearmPersistedDeferredRestarts,
} from '../../src/commands/med-family/mesh-restart'
import {
  deferredRestartScheduleKey,
  loadDeferredRestartSchedules,
  recordDeferredRestartSchedule,
} from '../../src/config/state-store'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const MESH_ID = 'mesh-restart-persist'
const SELF_DAEMON_ID = 'daemon_mach_self'

function makeCtx(states: any[]) {
  return {
    deps: {
      statusInstanceId: SELF_DAEMON_ID,
      instanceManager: { collectAllStates: () => states },
    },
    getMeshForCommand: vi.fn(async () => ({
      mesh: {
        nodes: [
          { id: 'node-1', daemonId: SELF_DAEMON_ID },
          { id: 'node-2', daemonId: SELF_DAEMON_ID },
        ],
      },
      inline: true,
      source: 'inline_cache',
    })),
  } as any
}

function baseArgs(extra: Record<string, unknown> = {}) {
  return { meshId: MESH_ID, nodeId: 'node-1', _meshDirectDispatch: true, ...extra }
}

const foreignWorkerSession = {
  instanceId: 'sess-worker',
  status: 'generating',
  settings: {},
}

const call = (ctx: any, args: any) => meshRestartHandlers.restart_daemon_node(ctx, args) as Promise<any>

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-restart-persist-'))
  daemonUpgrade.mockClear()
  daemonRestart.mockClear()
})

afterEach(() => {
  __clearDeferredRestartsForTests()
  vi.useRealTimers()
  // resolveSessionTurnPresentation() opens the mesh-runtime.db singleton
  // against this test's configDir. Close it before rmSync — on win32 an
  // open sqlite handle makes the directory removal fail with EBUSY (a
  // no-op unlink on POSIX, but not on NTFS).
  MeshRuntimeStore.resetForTests()
  if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true })
  configDir = ''
})

describe('A. schedule persistence with mesh/node ownership', () => {
  it('persists the schedule record on whenIdle and clears it on cancel (truthful cancel)', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx([foreignWorkerSession])

    const scheduled = await call(ctx, baseArgs({ whenIdle: true, mode: 'restart', killSessionHost: true }))
    expect(scheduled).toMatchObject({ success: true, scheduled: true, code: 'restart_scheduled_when_idle' })

    const persisted = loadDeferredRestartSchedules()
    const key = deferredRestartScheduleKey(MESH_ID, 'node-1')
    expect(Object.keys(persisted)).toEqual([key])
    expect(persisted[key]).toMatchObject({
      meshId: MESH_ID,
      nodeId: 'node-1',
      mode: 'restart',
      killSessionHost: true,
    })
    expect(typeof persisted[key].scheduledAt).toBe('number')
    expect(persisted[key].expiresAt).toBeGreaterThan(persisted[key].scheduledAt)

    const cancel = await call(ctx, baseArgs({ cancelWhenIdle: true }))
    expect(cancel).toMatchObject({ success: true, cancelled: true })
    expect(loadDeferredRestartSchedules()).toEqual({})

    // Truthful: a second cancel reports there was nothing to cancel.
    const cancelAgain = await call(ctx, baseArgs({ cancelWhenIdle: true }))
    expect(cancelAgain).toMatchObject({ success: true, cancelled: false })
  })

  it('drops the persisted record when the schedule expires without reaching idle', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx([foreignWorkerSession])

    await call(ctx, baseArgs({ whenIdle: true, timeoutMs: 60_000 }))
    expect(Object.keys(loadDeferredRestartSchedules())).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(loadDeferredRestartSchedules()).toEqual({})
  })
})

describe('B. keyed schedule/cancel isolation', () => {
  it('a second mesh/node schedule neither clobbers nor cross-cancels the first', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx([foreignWorkerSession])

    await call(ctx, baseArgs({ whenIdle: true }))
    // Separate mesh/node ownership — a distinct schedule on the same daemon.
    await call(ctx, baseArgs({ meshId: 'mesh-OTHER', nodeId: 'node-2', whenIdle: true, mode: 'restart' }))

    const statusA = await call(ctx, baseArgs({ whenIdleStatus: true }))
    const statusB = await call(ctx, baseArgs({ meshId: 'mesh-OTHER', nodeId: 'node-2', whenIdleStatus: true }))
    expect(statusA.deferredRestart).toMatchObject({ meshId: MESH_ID, nodeId: 'node-1', mode: 'upgrade' })
    expect(statusB.deferredRestart).toMatchObject({ meshId: 'mesh-OTHER', nodeId: 'node-2', mode: 'restart' })
    expect(Object.keys(loadDeferredRestartSchedules())).toHaveLength(2)

    // Cancelling A must not touch B.
    const cancelA = await call(ctx, baseArgs({ cancelWhenIdle: true }))
    expect(cancelA).toMatchObject({ success: true, cancelled: true })

    const statusAAfter = await call(ctx, baseArgs({ whenIdleStatus: true }))
    const statusBAfter = await call(ctx, baseArgs({ meshId: 'mesh-OTHER', nodeId: 'node-2', whenIdleStatus: true }))
    expect(statusAAfter.deferredRestart).toBeNull()
    expect(statusBAfter.deferredRestart).toMatchObject({ meshId: 'mesh-OTHER', nodeId: 'node-2' })
    expect(Object.keys(loadDeferredRestartSchedules())).toEqual([deferredRestartScheduleKey('mesh-OTHER', 'node-2')])
  })
})

describe('C/D. simulated boot re-arm and expiry', () => {
  it('re-arms an unexpired persisted schedule on boot and executes it once idle', async () => {
    vi.useFakeTimers()
    const states = [foreignWorkerSession]
    const ctx = makeCtx(states)

    await call(ctx, baseArgs({ whenIdle: true, mode: 'restart' }))
    expect(Object.keys(loadDeferredRestartSchedules())).toHaveLength(1)

    // Simulate the daemon dying and booting fresh: in-memory schedules are gone,
    // the persisted record survives.
    __clearDeferredRestartsForTests()
    expect(Object.keys(loadDeferredRestartSchedules())).toHaveLength(1)

    states.length = 0 // the rebooted daemon is idle
    rearmPersistedDeferredRestarts(ctx.deps)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(daemonRestart).toHaveBeenCalledTimes(1)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    // Executed → the persisted record is cleared.
    expect(loadDeferredRestartSchedules()).toEqual({})
  })

  it('audits and drops an expired persisted schedule on boot without executing', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx([])

    recordDeferredRestartSchedule({
      meshId: MESH_ID,
      nodeId: 'node-1',
      mode: 'upgrade',
      killSessionHost: false,
      scheduledAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1_000, // expired while the daemon was down
    })

    rearmPersistedDeferredRestarts(ctx.deps)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(daemonRestart).not.toHaveBeenCalled()
    expect(loadDeferredRestartSchedules()).toEqual({})
  })
})

describe('E. pendingOutbound restart-blocking', () => {
  const coordinatorWithQueuedOutbound = {
    instanceId: 'sess-cody',
    status: 'idle',
    pendingOutboundCount: 1,
    settings: { meshCoordinatorFor: MESH_ID },
  }

  it('a queued outbound coordinator message blocks the restart even when every session reads idle', async () => {
    const result = await call(makeCtx([coordinatorWithQueuedOutbound]), baseArgs())
    expect(result).toMatchObject({ success: false, restarted: false, code: 'blocking_sessions' })
    expect(result.blockingSessions).toHaveLength(1)
    expect(result.blockingSessions[0]).toMatchObject({ instanceId: 'sess-cody', pendingOutbound: true })
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(daemonRestart).not.toHaveBeenCalled()
  })

  it('selfOnly does NOT waive a pendingOutbound block on the mesh\'s own coordinator session', async () => {
    const result = await call(makeCtx([coordinatorWithQueuedOutbound]), baseArgs({ selfOnly: true }))
    expect(result).toMatchObject({ success: false, code: 'blocking_sessions' })
    expect(daemonUpgrade).not.toHaveBeenCalled()
  })

  it('the deferred poll rechecks and executes only after the outbound queue drains', async () => {
    vi.useFakeTimers()
    const session = { ...coordinatorWithQueuedOutbound }
    const states = [session]
    const ctx = makeCtx(states)

    const scheduled = await call(ctx, baseArgs({ whenIdle: true }))
    expect(scheduled).toMatchObject({ success: true, scheduled: true })

    // Queue still non-empty — the poll must not execute.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()

    // Queue drained — the next poll executes.
    session.pendingOutboundCount = 0
    await vi.advanceTimersByTimeAsync(10_000)
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)
  })
})
