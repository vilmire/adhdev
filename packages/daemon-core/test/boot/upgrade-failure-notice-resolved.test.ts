// 2026-10-01: `adhdev update` to 1.0.63 failed and its rollback failed too, so
// the notice said "NO healthy daemon is running". The owner then installed
// 1.0.63 with `brew upgrade`; the daemon booted healthy on 1.0.63 and still
// reported that notice on every status read. A notice whose failed target (or
// something newer) is what booted is cleared at boot.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readUpgradeFailureNotice, emitUpgradeFailureNotice } from '../../src/commands/upgrade-failure-notice'
import { upgradeFailureResolvedBy } from '../../src/boot/stages/platform'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function noticeFor(targetVersion: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-notice-'))
  dirs.push(dir)
  emitUpgradeFailureNotice([
    `adhdev adhdev@${targetVersion} failed its boot health gate AND the automatic rollback failed.`,
    'NO healthy daemon is running on this machine.',
  ], dir, { targetVersion })
  const notice = readUpgradeFailureNotice(dir)
  expect(notice?.targetVersion).toBe(targetVersion)
  return notice!
}

describe('upgrade-failure notice resolved by the running version', () => {
  it('is resolved when the failed target is what booted', () => {
    expect(upgradeFailureResolvedBy(noticeFor('1.0.63'), '1.0.63')).toBe(true)
  })

  it('is resolved when a newer version booted', () => {
    expect(upgradeFailureResolvedBy(noticeFor('1.0.63'), '1.0.64')).toBe(true)
  })

  it('stays when the daemon still runs the previous version (a real rollback)', () => {
    expect(upgradeFailureResolvedBy(noticeFor('1.0.63'), '1.0.62')).toBe(false)
  })

  it('stays when an rc of the failed target runs (older than the release)', () => {
    expect(upgradeFailureResolvedBy(noticeFor('1.0.63'), '1.0.63-rc.1')).toBe(false)
  })
})
