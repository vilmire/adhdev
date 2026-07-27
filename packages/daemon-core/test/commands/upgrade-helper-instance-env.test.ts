import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildUpgradeHelperChildEnv,
  emitUpgradeFailureNotice,
  stopSessionHostProcesses,
} from '../../src/commands/upgrade-helper'

// Stage 3 invariant 7: the detached upgrade/restart helper must preserve the
// CALLER's instance identity across the process boundary — its env pins
// ADHDEV_CONFIG_DIR and every POSIX handoff path (upgrade log, failure
// notice, session-host pid, daemon pid) resolves under that instance dir.
// A preview upgrade must never write into the stable ~/.adhdev directory.

const UPGRADE_HELPER_ENV = 'ADHDEV_DAEMON_UPGRADE_HELPER'

const tempRoots: string[] = []
let originalConfigDir: string | undefined

beforeEach(() => {
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-instance-'))
  tempRoots.push(dir)
  return dir
}

function basePayload(configDir?: string) {
  return {
    packageName: 'adhdev',
    targetVersion: '9.9.9',
    parentPid: 1234,
    restartArgv: ['cli.js', 'daemon'],
    ...(configDir ? { configDir } : {}),
  }
}

describe('buildUpgradeHelperChildEnv', () => {
  it('pins the payload configDir into the child env and round-trips it in the payload', () => {
    const root = makeTempRoot()
    const previewDir = path.join(root, '.adhdev-preview')

    const env = buildUpgradeHelperChildEnv(basePayload(previewDir), { PATH: '/usr/bin' })

    expect(env.ADHDEV_CONFIG_DIR).toBe(previewDir)
    const payload = JSON.parse(env[UPGRADE_HELPER_ENV]!)
    expect(payload.configDir).toBe(previewDir)
    expect(payload.packageName).toBe('adhdev')
    expect(payload.restartArgv).toEqual(['cli.js', 'daemon'])
  })

  it('falls back to the caller process config dir when the payload omits one', () => {
    const root = makeTempRoot()
    const previewDir = path.join(root, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewDir

    const env = buildUpgradeHelperChildEnv(basePayload(), {})

    // Even with an EMPTY base env (caller env not carried over), the child
    // still gets the caller's resolved instance pinned explicitly.
    expect(env.ADHDEV_CONFIG_DIR).toBe(previewDir)
    const payload = JSON.parse(env[UPGRADE_HELPER_ENV]!)
    expect(payload.configDir).toBe(previewDir)
  })
})

describe('POSIX upgrade handoff paths follow the instance config dir', () => {
  it('emitUpgradeFailureNotice writes under the given instance dir only', () => {
    const root = makeTempRoot()
    const stableDir = path.join(root, '.adhdev')
    const previewDir = path.join(root, '.adhdev-preview')

    emitUpgradeFailureNotice(['upgrade failed: test'], previewDir)

    expect(fs.existsSync(path.join(previewDir, 'daemon-upgrade-last-error.txt'))).toBe(true)
    expect(fs.existsSync(path.join(previewDir, 'daemon-upgrade.log'))).toBe(true)
    expect(fs.existsSync(path.join(stableDir, 'daemon-upgrade-last-error.txt'))).toBe(false)
    expect(fs.existsSync(path.join(stableDir, 'daemon-upgrade.log'))).toBe(false)
  })

  it('stopSessionHostProcesses reads and removes the pid file inside the given instance dir', async () => {
    const root = makeTempRoot()
    const stableDir = path.join(root, '.adhdev')
    const previewDir = path.join(root, '.adhdev-preview')
    fs.mkdirSync(previewDir, { recursive: true })
    const appName = `adhdev-upgrade-ns-${process.pid}`
    const previewPidFile = path.join(previewDir, `${appName}-session-host.pid`)
    // A pid that is not alive (and not this process): the stale file must be
    // unlinked WITHOUT any kill, and the stable dir must stay untouched.
    fs.writeFileSync(previewPidFile, '99999999', 'utf8')

    await stopSessionHostProcesses(appName, previewDir)

    expect(fs.existsSync(previewPidFile)).toBe(false)
    expect(fs.existsSync(path.join(stableDir, `${appName}-session-host.pid`))).toBe(false)
  })

  it('stopSessionHostProcesses default resolves via getConfigDir (env-pinned instance)', async () => {
    const root = makeTempRoot()
    const previewDir = path.join(root, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewDir
    fs.mkdirSync(previewDir, { recursive: true })
    const appName = `adhdev-upgrade-def-${process.pid}`
    const pidFile = path.join(previewDir, `${appName}-session-host.pid`)
    fs.writeFileSync(pidFile, '99999999', 'utf8')

    await stopSessionHostProcesses(appName)

    expect(fs.existsSync(pidFile)).toBe(false)
    // And it never looked at the stable default location.
    expect(fs.existsSync(path.join(root, '.adhdev', `${appName}-session-host.pid`))).toBe(false)
  })
})
