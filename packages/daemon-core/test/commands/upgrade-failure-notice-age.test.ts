import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Stale-notice diagnosability (`daemon-upgrade-last-error.txt`).
 *
 * The notice is durable and NOT self-expiring: boot/daemon-lifecycle re-prints
 * it on EVERY start until an upgrade succeeds and clears it. A days-old failure
 * that reads identically to a fresh one is how a resolved incident gets
 * re-diagnosed as a new one — which is exactly what happened when a notice for
 * v1.0.38-rc.9 was re-printed after an unrelated rc.2 attempt.
 *
 * So a read must return, alongside the body:
 *   - `recordedAt`/`ageMs`/`ageLabel` parsed from the `[ISO]` header,
 *   - `targetVersion` from the structured marker, so a reader can tell whether
 *     the notice describes the attempt they are looking at.
 * And clearing the notice must be LOUD on failure: a silent unlink error leaves
 * the file re-warning forever with no explanation.
 *
 * Dropping the age/target parsing back to `{ noticePath, logPath, notice }`, or
 * restoring the bare `try { unlink } catch {}`, turns these tests red.
 */

import {
  clearUpgradeFailureNotice,
  emitUpgradeFailureNotice,
  readUpgradeFailureNotice,
} from '../../src/commands/upgrade-helper'

let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-notice-'))
})

afterEach(() => {
  vi.useRealTimers()
  try { fs.rmSync(configDir, { recursive: true, force: true }) } catch { /* noop */ }
})

const noticePath = () => path.join(configDir, 'daemon-upgrade-last-error.txt')

describe('upgrade-failure notice — age + target parsing', () => {
  it('returns null when no notice exists', () => {
    expect(readUpgradeFailureNotice(configDir)).toBeNull()
  })

  it('parses the [ISO] header into recordedAt/ageMs/ageLabel', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'))
    emitUpgradeFailureNotice(['install blocked by a file lock'], configDir)

    // Read three hours later — the notice is unchanged on disk.
    vi.setSystemTime(new Date('2026-08-07T03:00:00.000Z'))
    const read = readUpgradeFailureNotice(configDir)

    expect(read?.recordedAt).toBe('2026-08-07T00:00:00.000Z')
    expect(read?.ageMs).toBe(3 * 60 * 60 * 1000)
    expect(read?.ageLabel).toBe('3h ago')
    expect(read?.notice).toContain('install blocked by a file lock')
  })

  it('formats age across minute/hour/day scales', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    emitUpgradeFailureNotice(['boom'], configDir)

    vi.setSystemTime(new Date('2026-08-01T00:00:30.000Z'))
    expect(readUpgradeFailureNotice(configDir)?.ageLabel).toBe('just now')
    vi.setSystemTime(new Date('2026-08-01T00:07:00.000Z'))
    expect(readUpgradeFailureNotice(configDir)?.ageLabel).toBe('7m ago')
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    expect(readUpgradeFailureNotice(configDir)?.ageLabel).toBe('2d ago')
  })

  it('records the attempted targetVersion as a structured field', () => {
    emitUpgradeFailureNotice(
      ['adhdev adhdev@1.0.38-rc.9 upgrade failed and was rolled back'],
      configDir,
      { targetVersion: '1.0.38-rc.9' },
    )

    const read = readUpgradeFailureNotice(configDir)
    expect(read?.targetVersion).toBe('1.0.38-rc.9')
    // The human body is still intact and still leads the notice.
    expect(read?.notice).toContain('upgrade failed and was rolled back')
  })

  it('reports targetVersion null for a legacy notice written without the marker', () => {
    // A notice produced by a pre-marker daemon: header + body only.
    fs.writeFileSync(
      noticePath(),
      '[2026-08-01T10:00:00.000Z]\nadhdev adhdev@1.0.38-rc.9 upgrade failed\n',
      'utf8',
    )

    const read = readUpgradeFailureNotice(configDir)
    expect(read?.targetVersion).toBeNull()
    // Age still parses — the header format is unchanged.
    expect(read?.recordedAt).toBe('2026-08-01T10:00:00.000Z')
  })

  it('reports recordedAt/ageMs null when the header is unparseable, without discarding the body', () => {
    fs.writeFileSync(noticePath(), 'no timestamp header here\n', 'utf8')

    const read = readUpgradeFailureNotice(configDir)
    expect(read?.recordedAt).toBeNull()
    expect(read?.ageMs).toBeNull()
    expect(read?.ageLabel).toBeNull()
    expect(read?.notice).toBe('no timestamp header here')
  })
})

describe('upgrade-failure notice — clearing is silent on success, loud on failure', () => {
  const readUpgradeLog = () => {
    try {
      return fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
    } catch {
      return ''
    }
  }

  it('removes the notice after a successful upgrade', () => {
    emitUpgradeFailureNotice(['previous failure'], configDir)
    expect(fs.existsSync(noticePath())).toBe(true)

    clearUpgradeFailureNotice(configDir)

    expect(fs.existsSync(noticePath())).toBe(false)
    expect(readUpgradeFailureNotice(configDir)).toBeNull()
  })

  it('stays quiet when there is no notice to clear (ENOENT is the normal case)', () => {
    clearUpgradeFailureNotice(configDir)
    expect(readUpgradeLog()).not.toMatch(/Failed to clear stale upgrade-failure notice/)
  })

  it('logs an actionable error when the unlink fails, instead of swallowing it', () => {
    // Real unlink failure rather than a mock: a directory at the notice path
    // makes unlinkSync throw a genuine OS error (EPERM on darwin, EISDIR on
    // linux) — the same class of undeletable-path condition (lock/permissions)
    // this branch exists to report.
    fs.mkdirSync(noticePath(), { recursive: true })

    // Must not throw — clearing is housekeeping and can never abort an
    // otherwise-successful upgrade.
    expect(() => clearUpgradeFailureNotice(configDir)).not.toThrow()

    const log = readUpgradeLog()
    expect(log).toMatch(/Failed to clear stale upgrade-failure notice \((EPERM|EISDIR)\)/)
    expect(log).toContain(noticePath())
    // Names the consequence the reader will otherwise misdiagnose.
    expect(log).toMatch(/ALREADY-RESOLVED/)
  })
})
