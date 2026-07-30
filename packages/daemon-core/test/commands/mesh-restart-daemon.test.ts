import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Regression tests for the restart_daemon_node extension:
 *   A. mode="restart" restarts even when already latest (no npm reinstall path)
 *   B. selfOnly waives the mesh's own coordinator session (self-deadlock break)
 *   C. another node's generating session is STILL refused (safety gate intact)
 *   D. whenIdle schedules and executes on idle transition; cancel/expiry work
 *   E. killSessionHost never reaches the lifecycle path without explicit opt-in
 * Plus backward-compat: a bare call behaves exactly like the pre-extension v1.
 *
 * The low-family lifecycle handlers are mocked so no real npm/spawn/exit runs.
 * config.js getConfigDir is pointed at a per-run temp dir: whenIdle schedules
 * now PERSIST to state.json, and the test must never touch the real one.
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

import { meshRestartHandlers } from '../../src/commands/med-family/mesh-restart'

const MESH_ID = 'mesh-restart-test'
const SELF_DAEMON_ID = 'daemon_mach_self'

function makeCtx(states: any[]) {
  return {
    deps: {
      statusInstanceId: SELF_DAEMON_ID,
      instanceManager: { collectAllStates: () => states },
    },
    getMeshForCommand: vi.fn(async () => ({
      mesh: { nodes: [{ id: 'node-1', daemonId: SELF_DAEMON_ID }] },
      inline: true,
      source: 'inline_cache',
    })),
  } as any
}

function baseArgs(extra: Record<string, unknown> = {}) {
  return { meshId: MESH_ID, nodeId: 'node-1', _meshDirectDispatch: true, ...extra }
}

const selfCoordinatorSession = {
  instanceId: 'sess-cody',
  status: 'generating',
  settings: { meshCoordinatorFor: MESH_ID },
}
const foreignWorkerSession = {
  instanceId: 'sess-worker',
  status: 'generating',
  settings: {},
}

const call = (ctx: any, args: any) => meshRestartHandlers.restart_daemon_node(ctx, args) as Promise<any>

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-restart-test-'))
  daemonUpgrade.mockClear()
  daemonRestart.mockClear()
})

afterEach(async () => {
  // Drop any schedule left over from a test so module state never leaks.
  await call(makeCtx([]), baseArgs({ cancelWhenIdle: true }))
  vi.useRealTimers()
  if (configDir && existsSync(configDir)) rmSync(configDir, { recursive: true, force: true })
  configDir = ''
})

describe('restart_daemon_node — backward compatibility', () => {
  it('bare call with no options goes through daemon_upgrade and maps restarting like v1', async () => {
    daemonUpgrade.mockResolvedValueOnce({ success: true, upgraded: true, restarting: true, version: '1.2.3' })
    const result = await call(makeCtx([]), baseArgs())
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)
    expect(daemonRestart).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, restarted: true, mode: 'upgrade' })
  })

  it('bare call on already-latest stays a no-op (no restart)', async () => {
    const result = await call(makeCtx([]), baseArgs())
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, restarted: false, alreadyLatest: true })
  })

  it('bare call against an active session is refused with blocking_sessions (v1 gate intact)', async () => {
    const result = await call(makeCtx([foreignWorkerSession]), baseArgs())
    expect(result).toMatchObject({ success: false, restarted: false, code: 'blocking_sessions' })
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(daemonRestart).not.toHaveBeenCalled()
  })
})

describe('restart_daemon_node — A. restart-only mode', () => {
  it('mode="restart" restarts via daemon_restart even when already latest', async () => {
    const result = await call(makeCtx([]), baseArgs({ mode: 'restart' }))
    expect(daemonRestart).toHaveBeenCalledTimes(1)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, restarted: true, mode: 'restart' })
    expect(result.clientHint).toMatch(/retry your next call/)
  })
})

describe('restart_daemon_node — B. self-restart', () => {
  it('selfOnly waives the mesh\'s own coordinator session blocker', async () => {
    const result = await call(makeCtx([selfCoordinatorSession]), baseArgs({ selfOnly: true }))
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, restarted: false, alreadyLatest: true })
  })

  it('selfOnly does NOT waive an unmarked (ad-hoc) coordinator session', async () => {
    const result = await call(makeCtx([foreignWorkerSession]), baseArgs({ selfOnly: true }))
    expect(result).toMatchObject({ success: false, code: 'blocking_sessions' })
    expect(daemonUpgrade).not.toHaveBeenCalled()
  })

  it('force bypasses any blocker and carries the pendingOutboundQueue loss warning', async () => {
    daemonUpgrade.mockResolvedValueOnce({ success: true, upgraded: true, restarting: true })
    const result = await call(makeCtx([foreignWorkerSession]), baseArgs({ force: true }))
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)
    expect(result.restarted).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/pendingOutboundQueue/)
  })
})

describe('restart_daemon_node — C. other-node protection', () => {
  it('another node\'s generating session is still refused even with selfOnly', async () => {
    const otherMeshCoordinator = {
      instanceId: 'sess-other-cody',
      status: 'generating',
      settings: { meshCoordinatorFor: 'mesh-OTHER' },
    }
    const result = await call(makeCtx([selfCoordinatorSession, otherMeshCoordinator]), baseArgs({ selfOnly: true }))
    expect(result).toMatchObject({ success: false, restarted: false, code: 'blocking_sessions' })
    expect(result.blockingSessions).toHaveLength(2)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(daemonRestart).not.toHaveBeenCalled()
  })
})

describe('restart_daemon_node — D. deferred (when_idle)', () => {
  it('schedules instead of refusing, then executes automatically on idle transition', async () => {
    vi.useFakeTimers()
    const states = [foreignWorkerSession]
    const ctx = makeCtx(states)

    const scheduled = await call(ctx, baseArgs({ whenIdle: true }))
    expect(scheduled).toMatchObject({ success: true, restarted: false, scheduled: true, code: 'restart_scheduled_when_idle' })
    expect(scheduled.deferredRestart).toMatchObject({ meshId: MESH_ID, nodeId: 'node-1', mode: 'upgrade' })
    expect(daemonUpgrade).not.toHaveBeenCalled()

    // Still blocked — poll must not execute.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()

    // Idle transition — the next poll executes the scheduled restart.
    states.length = 0
    await vi.advanceTimersByTimeAsync(10_000)
    expect(daemonUpgrade).toHaveBeenCalledTimes(1)

    // Schedule consumed — status query reports nothing pending.
    const status = await call(ctx, baseArgs({ whenIdleStatus: true }))
    expect(status.deferredRestart).toBeNull()
  })

  it('cancel_when_idle cancels a schedule before it executes', async () => {
    vi.useFakeTimers()
    const states = [foreignWorkerSession]
    const ctx = makeCtx(states)

    await call(ctx, baseArgs({ whenIdle: true }))
    const cancel = await call(ctx, baseArgs({ cancelWhenIdle: true }))
    expect(cancel).toMatchObject({ success: true, cancelled: true })

    states.length = 0
    await vi.advanceTimersByTimeAsync(30_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()
    expect(daemonRestart).not.toHaveBeenCalled()
  })

  it('expires without executing when the daemon never goes idle', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx([foreignWorkerSession])

    const scheduled = await call(ctx, baseArgs({ whenIdle: true, timeoutMs: 60_000 }))
    expect(scheduled.scheduled).toBe(true)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(daemonUpgrade).not.toHaveBeenCalled()

    const status = await call(ctx, baseArgs({ whenIdleStatus: true }))
    expect(status.deferredRestart).toBeNull()
  })
})

describe('restart_daemon_node — E. session-host kill opt-in', () => {
  it('killSessionHost reaches daemon_restart only when explicitly requested', async () => {
    await call(makeCtx([]), baseArgs({ mode: 'restart', killSessionHost: true }))
    expect(daemonRestart).toHaveBeenCalledWith(expect.anything(), { killSessionHost: true })

    daemonRestart.mockClear()
    await call(makeCtx([]), baseArgs({ mode: 'restart' }))
    expect(daemonRestart).toHaveBeenCalledWith(expect.anything(), { killSessionHost: false })
  })

  it('killSessionHost response carries the all-sessions-destroyed warning', async () => {
    const result = await call(makeCtx([]), baseArgs({ mode: 'restart', killSessionHost: true }))
    expect(result.warnings.join(' ')).toMatch(/ALL hosted CLI sessions/)
  })
})
