import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * B: the diagnosis path follows the INSTANCE config dir.
 *
 * The real-world scenario is the coexisting preview install: the preview
 * daemon runs with ADHDEV_CONFIG_DIR=~/.adhdev-preview, so its upgrade trace
 * must land in ~/.adhdev-preview/daemon-upgrade.log — never in the stable
 * instance's ~/.adhdev. config-dir resolution reads ADHDEV_CONFIG_DIR at CALL
 * time, so setting the env var per test exercises exactly that path.
 *
 * C: the durable failure notice round-trips through the same config dir.
 */
import { emitUpgradeFailureNotice, getUpgradeLogPath, readUpgradeFailureNotice } from '../../src/commands/upgrade-helper.js'

describe('upgrade log path follows ADHDEV_CONFIG_DIR (preview track scenario)', () => {
  let prevConfigDir: string | undefined
  let configDir = ''

  beforeEach(() => {
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), '.adhdev-preview-'))
    process.env.ADHDEV_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
    if (configDir) rmSync(configDir, { recursive: true, force: true })
    configDir = ''
  })

  it('getUpgradeLogPath() resolves to <ADHDEV_CONFIG_DIR>/daemon-upgrade.log', () => {
    expect(getUpgradeLogPath()).toBe(join(configDir, 'daemon-upgrade.log'))
  })

  it('a preview-style override (~/.adhdev-preview) keeps the log inside the preview instance', () => {
    const previewDir = join(configDir, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewDir
    expect(getUpgradeLogPath()).toBe(join(previewDir, 'daemon-upgrade.log'))
  })

  it('failure notice round-trips through the same config dir', () => {
    expect(readUpgradeFailureNotice(configDir)).toBeNull()

    emitUpgradeFailureNotice(['upgrade failed and was rolled back: install exploded'], configDir)

    const notice = readUpgradeFailureNotice(configDir)
    expect(notice).not.toBeNull()
    expect(notice!.noticePath).toBe(join(configDir, 'daemon-upgrade-last-error.txt'))
    expect(notice!.logPath).toBe(join(configDir, 'daemon-upgrade.log'))
    expect(notice!.notice).toContain('install exploded')
  })
})
