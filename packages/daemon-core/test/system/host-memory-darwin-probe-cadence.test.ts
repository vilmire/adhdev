import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Audit 2(d) (IPC load audit, 2026-09-23): getHostMemorySnapshot's darwin branch
// spawned `vm_stat` on a fixed 3s interval, unconditionally, for the rest of the
// daemon's lifetime once any status snapshot had ever been built — about 28,800
// spawns/day regardless of how often a caller actually reads the snapshot. Status
// is built roughly every 30s (idle) / 5s (generating). These tests pin: (1) the
// refresh cadence matches the slower status cadence (30s), not 3s; (2) the probe
// is spawned asynchronously and never blocks the synchronous snapshot read; (3) a
// tick that fires while a previous vm_stat is still in flight is skipped, so at
// most one vm_stat process is ever outstanding.

const execMock = vi.fn()

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    exec: (...args: any[]) => execMock(...args),
  }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    platform: () => 'darwin',
    totalmem: () => 16_000_000_000,
    freemem: () => 500_000_000,
  }
})

const VM_STAT_OUTPUT = [
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
  'Pages free:                              100000.',
  'Pages inactive:                          200000.',
  'Pages speculative:                       10000.',
  'Pages purgeable:                         5000.',
  'Pages stored in compressor:              0.',
].join('\n')

function respondSuccess(command: string, _opts: any, callback: (err: any, result: { stdout: string; stderr: string }) => void) {
  callback(null, { stdout: VM_STAT_OUTPUT, stderr: '' })
}

describe('getHostMemorySnapshot darwin probe cadence', () => {
  beforeEach(() => {
    vi.resetModules()
    execMock.mockReset()
    execMock.mockImplementation(respondSuccess)
    vi.useFakeTimers()
  })

  afterEach(async () => {
    const { __resetHostMemoryStateForTests } = await import('../../src/system/host-memory.js')
    __resetHostMemoryStateForTests()
    vi.useRealTimers()
  })

  it('the synchronous read never blocks on the vm_stat probe', async () => {
    const { getHostMemorySnapshot } = await import('../../src/system/host-memory.js')
    // First call starts the probe asynchronously (fire-and-forget) and returns
    // immediately using whatever was cached before (nothing yet → freeMem
    // fallback), rather than awaiting the child process.
    const snapshot = getHostMemorySnapshot()
    expect(snapshot.totalMem).toBe(16_000_000_000)
    expect(snapshot.availableMem).toBe(snapshot.freeMem) // no cached darwin value yet
  })

  it('refreshes on a 30s cadence, not 3s — only one spawn per 30s window', async () => {
    const { getHostMemorySnapshot } = await import('../../src/system/host-memory.js')
    getHostMemorySnapshot() // starts the interval + first fire-and-forget probe
    await vi.advanceTimersByTimeAsync(0) // let the initial probe resolve
    expect(execMock).toHaveBeenCalledTimes(1)

    // Advancing 3s (the OLD cadence) must NOT trigger a second spawn.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(execMock).toHaveBeenCalledTimes(1)

    // Advancing to the full 30s window triggers exactly one more.
    await vi.advanceTimersByTimeAsync(27_000)
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('the cached value updates asynchronously and is served on the next synchronous read', async () => {
    const { getHostMemorySnapshot } = await import('../../src/system/host-memory.js')
    getHostMemorySnapshot()
    await vi.advanceTimersByTimeAsync(0)

    // free(100000) + inactive(200000) + speculative(10000) + purgeable(5000) = 315000 pages * 4096
    const expectedAvailable = 315_000 * 4096
    const snapshot = getHostMemorySnapshot()
    expect(snapshot.availableMem).toBe(expectedAvailable)
  })

  it('skips a tick when the previous vm_stat is still in flight (no overlapping spawns)', async () => {
    let resolveFirst: ((value: { stdout: string; stderr: string }) => void) | null = null
    execMock.mockImplementationOnce((_cmd: string, _opts: any, callback: (err: any, result: any) => void) => {
      // Never auto-resolves — simulates a slow/wedged vm_stat still running
      // when the next 30s tick fires.
      resolveFirst = (result) => callback(null, result)
    })

    const { getHostMemorySnapshot } = await import('../../src/system/host-memory.js')
    getHostMemorySnapshot() // kicks off the first (stuck) probe
    await vi.advanceTimersByTimeAsync(0)
    expect(execMock).toHaveBeenCalledTimes(1)

    // The 30s tick fires while the first probe is still outstanding — it must
    // be skipped, not queued as a second concurrent spawn.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(execMock).toHaveBeenCalledTimes(1)

    // Once the stuck probe finally resolves, the NEXT tick is free to spawn again.
    resolveFirst!({ stdout: VM_STAT_OUTPUT, stderr: '' })
    await vi.advanceTimersByTimeAsync(0)
    execMock.mockImplementation(respondSuccess)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(execMock).toHaveBeenCalledTimes(2)
  })
})
