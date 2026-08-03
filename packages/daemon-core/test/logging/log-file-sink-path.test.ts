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
 * These cases set the env then re-import with a fresh module registry. That is
 * no longer *required* — the log dir is resolved lazily now, see
 * log-dir-lazy-resolution.test.ts which asserts an env set AFTER import is
 * honored — but re-importing is still the cleanest way to assert the
 * import-time startup behavior (dir creation, legacy-layout migration) here.
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

    const logPath = logger.getCurrentDaemonLogPath()

    // AsyncBatchWriter batches behind a 50ms timer and then appends
    // asynchronously with no completion signal to await. A fixed sleep is a
    // guess at that latency; on a loaded machine the append lands after the
    // assertion and the test fails on scheduling rather than on behaviour.
    // Poll for the post-condition, returning as soon as it really holds.
    const deadline = Date.now() + 10_000
    let content = ''
    while (Date.now() < deadline) {
      content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
      if (content.includes('hello file sink persists') && content.includes('a failure line was recorded')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    expect(fs.existsSync(logPath)).toBe(true)
    expect(content).toContain('hello file sink persists')
    expect(content).toContain('a failure line was recorded')
    // The same lines feed the in-memory ring buffer the dashboard Logs tab reads,
    // so file and dashboard stay consistent.
    const recent = logger.getRecentLogs(50, 'info')
    expect(recent.some((e) => e.message.includes('hello file sink persists'))).toBe(true)
  })

  it('retains exactly three size-rotation generations while preserving .1 compatibility', async () => {
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    const logger = await import('../../src/logging/logger')
    const logPath = logger.getCurrentDaemonLogPath()
    fs.writeFileSync(logPath, 'active', 'utf-8')
    fs.writeFileSync(logPath.replace(/\.log$/, '.1.log'), 'generation-1', 'utf-8')
    fs.writeFileSync(logPath.replace(/\.log$/, '.2.log'), 'generation-2', 'utf-8')
    fs.writeFileSync(logPath.replace(/\.log$/, '.3.log'), 'generation-3', 'utf-8')

    logger.rotateSizeGenerations(logPath)

    expect(fs.readFileSync(logPath.replace(/\.log$/, '.1.log'), 'utf-8')).toBe('active')
    expect(fs.readFileSync(logPath.replace(/\.log$/, '.2.log'), 'utf-8')).toBe('generation-1')
    expect(fs.readFileSync(logPath.replace(/\.log$/, '.3.log'), 'utf-8')).toBe('generation-2')
    expect(fs.existsSync(logPath.replace(/\.log$/, '.4.log'))).toBe(false)
  })
})
