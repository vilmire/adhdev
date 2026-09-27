import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression for the "foreground daemon floods the terminal with routine
 * INFO telemetry" fix: `daemonLog`/`LOG.*` now gate the log FILE + ring
 * buffer on `currentLevel` (unchanged: `setLogLevel`, default 'info') and the
 * TERMINAL ECHO on a separate `consoleLevel` (new: `setConsoleLogLevel`,
 * default 'warn'). A line can therefore be recorded (file/ring buffer) but
 * NOT echoed to an interactive terminal, and `--log-level`/`--verbose`/
 * `--dev` restore console visibility by calling `setConsoleLogLevel`
 * explicitly (see adhdev-daemon.ts applyDebugRuntime).
 *
 * `origConsoleLog` inside logger.ts is captured via `console.log.bind(console)`
 * at MODULE LOAD time, so a `vi.spyOn(console, 'log')` installed AFTER the
 * module is already imported would not be seen by it. Each test below resets
 * the module registry and re-imports fresh AFTER installing the spy, so the
 * module's own `origConsoleLog` binds to the spy.
 */
describe('logger console-level split', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('drops an INFO line from the terminal by default (consoleLevel defaults to warn) but still records it', async () => {
    const { LOG, getRecentLogs } = await import('../../src/logging/logger.js')
    const message = `console-split-info-${Date.now()}`

    LOG.info('ConsoleSplit', message)

    // Not echoed to the terminal...
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes(message))).toBe(false)
    // ...but still recorded (file + ring buffer unaffected by the console gate).
    expect(getRecentLogs(200, 'info')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'ConsoleSplit', message }),
      ]),
    )
  })

  it('still echoes WARN and ERROR to the terminal by default', async () => {
    const { LOG } = await import('../../src/logging/logger.js')
    const warnMessage = `console-split-warn-${Date.now()}`
    const errorMessage = `console-split-error-${Date.now()}`

    LOG.warn('ConsoleSplit', warnMessage)
    LOG.error('ConsoleSplit', errorMessage)

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes(warnMessage))).toBe(true)
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes(errorMessage))).toBe(true)
  })

  it('setConsoleLogLevel("info") restores INFO visibility on the terminal (the --log-level info / --verbose path)', async () => {
    const { LOG, setConsoleLogLevel, getConsoleLogLevel } = await import('../../src/logging/logger.js')
    expect(getConsoleLogLevel()).toBe('warn')

    setConsoleLogLevel('info')
    const message = `console-split-verbose-${Date.now()}`
    LOG.info('ConsoleSplit', message)

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes(message))).toBe(true)
  })

  it('setConsoleLogLevel does not affect the file/ring-buffer level (setLogLevel)', async () => {
    const { LOG, setLogLevel, setConsoleLogLevel, getLogLevel, getRecentLogs } = await import('../../src/logging/logger.js')
    setConsoleLogLevel('error')
    setLogLevel('debug')
    expect(getLogLevel()).toBe('debug')

    const message = `console-split-file-only-${Date.now()}`
    LOG.debug('ConsoleSplit', message)

    // Not echoed (consoleLevel is 'error')...
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes(message))).toBe(false)
    // ...but still recorded, because currentLevel ('debug') is the file/ring-buffer gate.
    expect(getRecentLogs(200, 'debug')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'ConsoleSplit', message }),
      ]),
    )
  })
})
