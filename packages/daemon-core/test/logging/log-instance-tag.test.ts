import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Per-instance daemon log file naming (daemon-<port>-YYYY-MM-DD.log).
 *
 * Co-running daemons that share one log dir (a second `adhdev daemon --port`,
 * a standalone server pinned to the same ADHDEV_CONFIG_DIR) used to append to
 * the same daemon-YYYY-MM-DD.log and interleave lines. The daemon entrypoint
 * now declares its port via setLogInstancePort(); a non-default port moves the
 * file to daemon-<port>-YYYY-MM-DD.log while the DEFAULT_DAEMON_PORT instance
 * keeps the legacy name (same convention as daemon.pid vs daemon-<port>.pid),
 * so mesh get_mesh_node_logs / get_logs / docs keep working for the primary
 * daemon unchanged.
 */

const TODAY = new Date().toISOString().slice(0, 10)

type LoggerModule = typeof import('../../src/logging/logger')

async function importFreshLogger(): Promise<LoggerModule> {
  return import('../../src/logging/logger')
}

async function waitForFileContent(file: string, needle: string): Promise<string> {
  // AsyncBatchWriter batches behind a timer with no completion signal — poll
  // for the post-condition instead of guessing a fixed sleep.
  const deadline = Date.now() + 10_000
  let content = ''
  while (Date.now() < deadline) {
    content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    if (content.includes(needle)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return content
}

describe('per-instance daemon log file naming', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-logtag-'))
    process.env.ADHDEV_CONFIG_DIR = tmpHome
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.ADHDEV_CONFIG_DIR
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
    vi.resetModules()
  })

  it('keeps the legacy daemon-YYYY-MM-DD.log name when no instance port is set', async () => {
    const logger = await importFreshLogger()
    expect(logger.getLogInstanceTag()).toBeNull()
    expect(path.basename(logger.getCurrentDaemonLogPath())).toBe(`daemon-${TODAY}.log`)
    expect(path.basename(logger.getLogPath())).toBe(`daemon-${TODAY}.log`)
  })

  it('keeps the legacy name for the DEFAULT_DAEMON_PORT instance (backward compat)', async () => {
    const logger = await importFreshLogger()
    logger.setLogInstancePort(19_222)
    expect(logger.getLogInstanceTag()).toBeNull()
    expect(path.basename(logger.getCurrentDaemonLogPath())).toBe(`daemon-${TODAY}.log`)
  })

  it('ignores invalid ports and keeps the legacy name', async () => {
    const logger = await importFreshLogger()
    logger.setLogInstancePort(Number.NaN)
    logger.setLogInstancePort(0)
    logger.setLogInstancePort(-1)
    expect(logger.getLogInstanceTag()).toBeNull()
    expect(path.basename(logger.getCurrentDaemonLogPath())).toBe(`daemon-${TODAY}.log`)
  })

  it('moves the active file to daemon-<port>-YYYY-MM-DD.log for a non-default port', async () => {
    const logger = await importFreshLogger()
    logger.setLogInstancePort(19_223)
    expect(logger.getLogInstanceTag()).toBe('19223')
    expect(path.basename(logger.getCurrentDaemonLogPath())).toBe(`daemon-19223-${TODAY}.log`)
    // The write path target moves too (startup banner / next lines).
    expect(path.basename(logger.getLogPath())).toBe(`daemon-19223-${TODAY}.log`)
    // Arbitrary dates (log-tail-reader date arg) get the same tag.
    expect(path.basename(logger.getCurrentDaemonLogPath(new Date('1999-01-02T00:00:00.000Z'))))
      .toBe('daemon-19223-1999-01-02.log')
  })

  it('writes each instance tag to its own file — two daemons never interleave', async () => {
    const logger = await importFreshLogger()
    const logDir = logger.getDaemonLogDir()
    const fileA = path.join(logDir, `daemon-19223-${TODAY}.log`)
    const fileB = path.join(logDir, `daemon-3847-${TODAY}.log`)
    const legacyFile = path.join(logDir, `daemon-${TODAY}.log`)

    logger.setLogInstancePort(19_223)
    logger.LOG.info('TagTest', 'line from preview daemon')
    logger.setLogInstancePort(3_847)
    logger.LOG.info('TagTest', 'line from standalone daemon')

    const contentA = await waitForFileContent(fileA, 'line from preview daemon')
    const contentB = await waitForFileContent(fileB, 'line from standalone daemon')

    expect(contentA).toContain('line from preview daemon')
    expect(contentA).not.toContain('line from standalone daemon')
    expect(contentB).toContain('line from standalone daemon')
    expect(contentB).not.toContain('line from preview daemon')
    // Nothing leaked into the legacy shared file.
    expect(fs.existsSync(legacyFile)).toBe(false)
  })

  it('switches back to the legacy name when reset to the default port', async () => {
    const logger = await importFreshLogger()
    logger.setLogInstancePort(19_223)
    logger.setLogInstancePort(19_222)
    expect(logger.getLogInstanceTag()).toBeNull()
    expect(path.basename(logger.getLogPath())).toBe(`daemon-${TODAY}.log`)
  })

  it('ages out tagged files on the same 7-day retention as legacy files', async () => {
    const logger = await importFreshLogger()
    // Do NOT call getDaemonLogDir()/getCurrentDaemonLogPath() before seeding:
    // they run the one-time housekeeping sweep eagerly, and the sweep must fire
    // on the first write below, after the fixtures exist.
    const logDir = path.join(tmpHome, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const oldTagged = path.join(logDir, 'daemon-19223-1999-01-02.log')
    const oldTaggedBackup = path.join(logDir, 'daemon-19223-1999-01-02.1.log')
    const oldLegacy = path.join(logDir, 'daemon-1999-01-02.log')
    const recentTagged = path.join(logDir, `daemon-19223-${TODAY}.log`)
    fs.writeFileSync(oldTagged, 'ancient tagged\n', 'utf-8')
    fs.writeFileSync(oldTaggedBackup, 'ancient tagged backup\n', 'utf-8')
    fs.writeFileSync(oldLegacy, 'ancient legacy\n', 'utf-8')
    fs.writeFileSync(recentTagged, 'recent tagged\n', 'utf-8')

    // The first write into a fresh dir runs the one-time housekeeping sweep.
    logger.setLogInstancePort(19_223)
    logger.LOG.info('TagTest', 'trigger housekeeping sweep')
    await waitForFileContent(recentTagged, 'trigger housekeeping sweep')

    expect(fs.existsSync(oldTagged)).toBe(false)
    expect(fs.existsSync(oldTaggedBackup)).toBe(false)
    expect(fs.existsSync(oldLegacy)).toBe(false)
    expect(fs.existsSync(recentTagged)).toBe(true)
  })

  it('readDaemonLogTail (mesh get_mesh_node_logs path) reads the tagged file of this instance', async () => {
    const logger = await importFreshLogger()
    logger.setLogInstancePort(19_223)
    const { readDaemonLogTail } = await import('../../src/logging/log-tail-reader')

    logger.LOG.info('TagTest', 'remote tail sentinel line')
    const taggedPath = logger.getCurrentDaemonLogPath()
    await waitForFileContent(taggedPath, 'remote tail sentinel line')

    const result = readDaemonLogTail({ grep: 'remote tail sentinel' })
    expect(result.success).toBe(true)
    expect(result.logPath).toBe(taggedPath)
    expect(result.lines.some((line) => line.includes('remote tail sentinel line'))).toBe(true)
  })

  it('readDaemonLogTail does not fall back to another instance\'s file', async () => {
    const logger = await importFreshLogger()
    const logDir = logger.getDaemonLogDir()
    fs.mkdirSync(logDir, { recursive: true })
    // Only the LEGACY (default-port) file exists; this instance is tagged.
    fs.writeFileSync(path.join(logDir, `daemon-${TODAY}.log`), 'stable daemon line\n', 'utf-8')
    logger.setLogInstancePort(19_223)
    const { readDaemonLogTail } = await import('../../src/logging/log-tail-reader')

    const result = readDaemonLogTail({})
    // Must report "no log" rather than silently serving the stable daemon's file.
    expect(result.success).toBe(false)
    expect(result.logPath).toBe(logger.getCurrentDaemonLogPath())
  })
})
