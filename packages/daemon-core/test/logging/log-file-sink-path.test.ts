import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * The daemon log file MUST persist under the unified ADHDev home (~/.adhdev/logs/)
 * on every platform — alongside config.json, providers/, history/ and
 * session-host.log — instead of an OS-specific dir (~/Library/Logs/adhdev on
 * macOS etc.) that made the daemon log undiscoverable. ADHDEV_CONFIG_DIR
 * overrides the ~/.adhdev base so isolated/standalone homes keep their own logs.
 *
 * LOG_DIR is resolved once at module load, so each case sets the env then
 * re-imports the logger with a fresh module registry.
 */
describe('daemon log file sink path', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-logsink-'))
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.ADHDEV_CONFIG_DIR
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
    vi.resetModules()
  })

  it('honors ADHDEV_CONFIG_DIR and resolves logs under <home>/logs', async () => {
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    const logger = await import('../../src/logging/logger')

    const expectedDir = path.join(tmpHome, 'logs')
    expect(logger.getDaemonLogDir()).toBe(expectedDir)
    expect(logger.getCurrentDaemonLogPath().startsWith(expectedDir)).toBe(true)
    expect(fs.existsSync(expectedDir)).toBe(true)
  })

  it('defaults to ~/.adhdev/logs when ADHDEV_CONFIG_DIR is unset (every platform)', async () => {
    delete process.env.ADHDEV_CONFIG_DIR
    const logger = await import('../../src/logging/logger')
    const expectedDir = path.join(os.homedir(), '.adhdev', 'logs')
    expect(logger.getDaemonLogDir()).toBe(expectedDir)
  })

  it('actually writes INFO + ERROR lines to the dated log file', async () => {
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    const logger = await import('../../src/logging/logger')

    logger.LOG.info('SinkTest', 'hello file sink persists')
    logger.LOG.error('SinkTest', 'a failure line was recorded')

    // AsyncBatchWriter flushes on a 50ms timer — wait past it.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const logPath = logger.getCurrentDaemonLogPath()
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8')
    expect(content).toContain('hello file sink persists')
    expect(content).toContain('a failure line was recorded')
    // The same lines feed the in-memory ring buffer the dashboard Logs tab reads,
    // so file and dashboard stay consistent.
    const recent = logger.getRecentLogs(50, 'info')
    expect(recent.some((e) => e.message.includes('hello file sink persists'))).toBe(true)
  })
})
