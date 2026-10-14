import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRecentLogs: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('../../src/logging/logger.js', () => ({
  getRecentLogs: mocks.getRecentLogs,
  getCurrentDaemonLogPath: () => '/tmp/adhdev-test-daemon.log',
  LOG: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    forComponent: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      asLogFn: vi.fn(() => vi.fn()),
    })),
  },
}))

// PARTIAL mock, not a replacement: only the two functions the get_logs file
// fallback calls are spied. A whole-module replacement broke once the router's
// import graph grew (it reaches src/assistant/* which calls fs.lstatSync on this
// same bare-'fs' specifier), and the missing export surfaced as the handler's
// catch returning `{success:false, error:'[vitest] No "lstatSync" export …'}` —
// i.e. the mock, not the code under test, decided the result. Spreading the real
// module keeps every other fs call real while these two stay asserted on.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}))

import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: false })) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
  })
}

describe('get_logs incremental polling', () => {
  beforeEach(() => {
    mocks.getRecentLogs.mockReset()
    mocks.existsSync.mockReset()
    mocks.readFileSync.mockReset()
  })

  it('does not replace an incremental structured poll with unfiltered file fallback text', async () => {
    mocks.getRecentLogs.mockReturnValue([
      { ts: 1000, level: 'info', category: 'Daemon', message: 'initial boot' },
    ])
    mocks.existsSync.mockReturnValue(true)
    mocks.readFileSync.mockReturnValue('[12:00:00.000] [INF] [Daemon] old file line\n')

    const result = await createRouter().execute('get_logs', { count: 200, minLevel: 'info', since: 1000 }, 'p2p')

    expect(result).toEqual({ success: true, logs: [], totalBuffered: 0 })
    expect(mocks.readFileSync).not.toHaveBeenCalled()
  })

  it('still uses file fallback on an initial poll when the structured buffer is empty', async () => {
    mocks.getRecentLogs.mockReturnValue([])
    mocks.existsSync.mockReturnValue(true)
    mocks.readFileSync.mockReturnValue('[12:00:00.000] [INF] [Daemon] boot complete\n')

    const result = await createRouter().execute('get_logs', { count: 200, minLevel: 'info' }, 'p2p')

    expect(result).toEqual({
      success: true,
      logs: '[12:00:00.000] [INF] [Daemon] boot complete\n',
      totalLines: 2,
    })
  })
})
