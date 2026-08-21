import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  LOG,
  getCurrentDaemonLogPath,
  getDaemonLogDir,
  getLogDirPath,
} from '../../src/logging/logger.js'

/**
 * The log directory must be resolved LAZILY, not frozen at module import.
 *
 * As a module-level `const`, LOG_DIR was captured the moment the logger was
 * first imported. A test that sets ADHDEV_CONFIG_DIR afterwards — the normal
 * shape, since the logger is transitively imported by almost everything — was
 * silently ignored, so `LOG.warn`/`LOG.info` emitted by production code under
 * test appended to the REAL ~/.adhdev/logs/daemon-<date>.log that the live
 * daemon writes. That is how win32-only fixture lines surfaced in a live darwin
 * daemon log and were misread as a production defect.
 *
 * Note these tests deliberately do NOT use vi.resetModules(): the whole point is
 * that a logger imported BEFORE the env is set still honors it. Re-importing
 * would hide exactly the regression being guarded.
 */

/**
 * Wait until a marker actually lands in a log file.
 *
 * AsyncBatchWriter batches behind a 50ms timer and then appends
 * asynchronously, exposing no completion signal to await. A fixed sleep is a
 * guess at that latency rather than an observation of it: on a loaded machine
 * the timer fires late and the append lands after the assertion, so the test
 * fails on scheduling instead of on behaviour. Polling returns as soon as the
 * write is really visible and only spends the deadline when it never arrives.
 *
 * Returns the file contents so callers assert on what was actually observed.
 */
async function waitForMarker(logPath: string, marker: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let contents = ''
  while (Date.now() < deadline) {
    contents = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    if (contents.includes(marker)) return contents
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return contents
}
describe('daemon log dir lazy resolution', () => {
  let tmpHome: string
  const originalEnv = process.env.ADHDEV_CONFIG_DIR
  const originalHomeEnvs = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
  }

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-lazylog-'))
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalEnv
    for (const [key, value] of Object.entries(originalHomeEnvs)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
  })

  /**
   * Exercising the production no-override fallback through process.env requires
   * stepping out of the test-runtime fail-fast gate: resolveConfigDir throws on
   * an un-pinned PROCESS-env fallback under vitest, which is exactly the shape
   * these production-default cases need. HOME/USERPROFILE (win) are pinned to
   * tmpHome FIRST so the fallback — and prepareLogDirOnce's mkdir/cleanOldLogs/
   * legacy-migration side effects — lands in this suite's tmp dir, never the
   * real home. (Before the gate these cases resolved and prepared the REAL
   * ~/.adhdev/logs, including its retention sweep.)
   */
  function exerciseProductionFallbackInTmpHome(): void {
    delete process.env.ADHDEV_CONFIG_DIR
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    delete process.env.VITEST
    delete process.env.NODE_ENV
  }

  it('honors ADHDEV_CONFIG_DIR set AFTER the logger was imported', () => {
    // The logger module is already loaded (static import at the top of this
    // file) before this line runs — that is the regression scenario.
    process.env.ADHDEV_CONFIG_DIR = tmpHome

    const expectedDir = path.join(tmpHome, 'logs')
    expect(getDaemonLogDir()).toBe(expectedDir)
    expect(getLogDirPath()).toBe(expectedDir)
    expect(getCurrentDaemonLogPath().startsWith(expectedDir)).toBe(true)
  })

  it('routes actual log writes to a directory set after import', async () => {
    process.env.ADHDEV_CONFIG_DIR = tmpHome

    const marker = `lazy-resolution-marker-${Date.now()}`
    LOG.error('LazyLogDirTest', marker)

    const logPath = getCurrentDaemonLogPath()
    expect(logPath.startsWith(path.join(tmpHome, 'logs'))).toBe(true)

    const contents = await waitForMarker(logPath, marker)

    expect(fs.existsSync(logPath)).toBe(true)
    expect(contents).toContain(marker)
  })

  it('does not leak a redirected write back into the real ~/.adhdev/logs', async () => {
    // The actual harm being fixed: a test writing into the live daemon's file.
    const realLogPath = path.join(
      os.homedir(),
      '.adhdev',
      'logs',
      `daemon-${new Date().toISOString().slice(0, 10)}.log`,
    )
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    const marker = `must-not-reach-real-log-${Date.now()}`
    LOG.error('LazyLogDirTest', marker)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Byte-for-byte equality of the file before/after is NOT asserted: a live
    // daemon on this machine may concurrently append unrelated lines to the
    // same real log file between reads. The contract under test is that OUR
    // marker never reaches it — the unique marker string is sufficient proof
    // since it cannot appear in the file except from this test's own write.
    const after = fs.existsSync(realLogPath) ? fs.readFileSync(realLogPath, 'utf-8') : ''
    expect(after).not.toContain(marker)
  })

  it('switches directories when ADHDEV_CONFIG_DIR changes again', async () => {
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    const firstMarker = `first-home-${Date.now()}`
    LOG.error('LazyLogDirTest', firstMarker)
    const firstPath = getCurrentDaemonLogPath()
    await waitForMarker(firstPath, firstMarker)

    const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-lazylog2-'))
    try {
      process.env.ADHDEV_CONFIG_DIR = secondHome
      const secondMarker = `second-home-${Date.now()}`
      LOG.error('LazyLogDirTest', secondMarker)

      const secondPath = getCurrentDaemonLogPath()
      await waitForMarker(secondPath, secondMarker)
      expect(secondPath.startsWith(path.join(secondHome, 'logs'))).toBe(true)
      expect(secondPath).not.toBe(firstPath)
      expect(fs.readFileSync(secondPath, 'utf-8')).toContain(secondMarker)
      // The first home keeps its own line and does not receive the second one.
      expect(fs.readFileSync(firstPath, 'utf-8')).toContain(firstMarker)
      expect(fs.readFileSync(firstPath, 'utf-8')).not.toContain(secondMarker)
    } finally {
      try { fs.rmSync(secondHome, { recursive: true, force: true }) } catch { /* noop */ }
    }
  })

  // ★ Production invariant: the daemon's real log path must not change.
  it('defaults to ~/.adhdev/logs/daemon-YYYY-MM-DD.log with no env override', () => {
    exerciseProductionFallbackInTmpHome()

    const expectedDir = path.join(tmpHome, '.adhdev', 'logs')
    expect(getDaemonLogDir()).toBe(expectedDir)
    expect(getLogDirPath()).toBe(expectedDir)

    const today = new Date().toISOString().slice(0, 10)
    expect(getCurrentDaemonLogPath()).toBe(path.join(expectedDir, `daemon-${today}.log`))
  })

  it('ignores a blank/whitespace ADHDEV_CONFIG_DIR and keeps the production path', () => {
    exerciseProductionFallbackInTmpHome()
    process.env.ADHDEV_CONFIG_DIR = '   '
    const expectedDir = path.join(tmpHome, '.adhdev', 'logs')
    expect(getDaemonLogDir()).toBe(expectedDir)
  })

  it('resolves the dated file per call so a rollover is not snapshotted', () => {
    exerciseProductionFallbackInTmpHome()
    const expectedDir = path.join(tmpHome, '.adhdev', 'logs')
    const someDay = new Date('2026-01-02T03:04:05.000Z')
    expect(getCurrentDaemonLogPath(someDay)).toBe(path.join(expectedDir, 'daemon-2026-01-02.log'))
  })
})
