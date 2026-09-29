import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearPosixUpgradeJournal,
  describePosixHealthGateSkip,
  gatePosixUpgradeRestart,
  inspectPosixUpgradeJournal,
  readPosixUpgradeJournal,
  resolvePosixHealthGatePort,
  writePosixUpgradeJournal,
  type DaemonHealthProbe,
  type PosixUpgradeGateHooks,
  type PosixUpgradeJournal,
  type SpawnedDaemonHandle,
} from '../../src/commands/posix-upgrade-health-gate'

/**
 * Unit coverage for the POSIX boot health gate orchestration with every edge
 * injected: a virtual clock, a scripted IPC port, and scripted spawns. The
 * end-to-end helper wiring is covered by upgrade-helper-posix-boot-health-gate.
 */

interface FakeWorld {
  hooks: PosixUpgradeGateHooks
  spawns: number
  stopped: number[]
  logs: string[]
  /** What the port answers right now. */
  port: DaemonHealthProbe
}

type Boot =
  | { kind: 'crash' }
  | { kind: 'serve'; version: string; pid?: number }
  | { kind: 'launcher-then-nothing' }

function makeWorld(options: {
  boots: Boot[]
  restore?: () => 'snapshot' | 'reinstall'
}): FakeWorld {
  let clock = 0
  const world: FakeWorld = {
    spawns: 0,
    stopped: [],
    logs: [],
    port: { alive: false, pid: null, version: null },
    hooks: undefined as unknown as PosixUpgradeGateHooks,
  }
  world.hooks = {
    spawnDaemon: (): SpawnedDaemonHandle => {
      const boot = options.boots[world.spawns++] ?? { kind: 'crash' }
      const pid = 3_000_000_000 + world.spawns
      if (boot.kind === 'crash') {
        return { pid, exitStatus: () => ({ code: 1, signal: null }) }
      }
      if (boot.kind === 'launcher-then-nothing') {
        // e.g. `service install`: exits 0 immediately, nothing ever listens.
        return { pid, exitStatus: () => ({ code: 0, signal: null }) }
      }
      world.port = { alive: true, pid: boot.pid ?? pid, version: boot.version }
      return { pid, exitStatus: () => null }
    },
    probe: async () => ({ ...world.port }),
    stopPid: async (pid) => {
      world.stopped.push(pid)
      if (world.port.pid === pid) world.port = { alive: false, pid: null, version: null }
      return true
    },
    restorePrevious: options.restore ?? (() => 'snapshot'),
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    log: (message) => { world.logs.push(message) },
  }
  return world
}

const base = {
  targetVersion: '2.0.0',
  previousVersion: '1.0.0',
  restartArgv: ['/prefix/node_modules/adhdev/cli.js', 'daemon', '-p', '19223'],
  port: 19223,
  healthTimeoutMs: 10_000,
}

describe('gatePosixUpgradeRestart', () => {
  it('passes when the replacement reports the target version', async () => {
    const world = makeWorld({ boots: [{ kind: 'serve', version: '2.0.0' }] })
    const result = await gatePosixUpgradeRestart({ ...base, hooks: world.hooks })
    expect(result.outcome).toBe('healthy')
    expect(world.spawns).toBe(1)
    expect(world.stopped).toEqual([])
  })

  it('fails fast on a crash during boot and rolls back to the previous version', async () => {
    const world = makeWorld({ boots: [{ kind: 'crash' }, { kind: 'serve', version: '1.0.0' }] })
    let restored = 0
    world.hooks.restorePrevious = () => { restored++; return 'snapshot' }
    const phases: string[] = []
    const result = await gatePosixUpgradeRestart({
      ...base,
      hooks: world.hooks,
      onPhase: (phase) => phases.push(phase),
    })
    expect(result).toMatchObject({ outcome: 'rolled_back', restoredVia: 'snapshot', previousVersion: '1.0.0' })
    expect(result.outcome === 'rolled_back' && result.reason).toMatch(/exited during boot \(code 1\)/)
    expect(restored).toBe(1)
    expect(phases).toEqual(['gating', 'rolling_back'])
    // The crash was detected on the first probe, not after the 10s budget.
    expect(world.logs.join('\n')).not.toMatch(/within 10000ms/)
  })

  it('keeps waiting through a launcher that exits 0 and then times out', async () => {
    const world = makeWorld({ boots: [{ kind: 'launcher-then-nothing' }, { kind: 'serve', version: '1.0.0' }] })
    const result = await gatePosixUpgradeRestart({ ...base, hooks: world.hooks })
    expect(result.outcome).toBe('rolled_back')
    expect(result.outcome === 'rolled_back' && result.reason).toMatch(/no daemon answered health on 127\.0\.0\.1:19223 within 10000ms/)
  })

  it('rolls back on a wrong version and stops the wrong daemon first', async () => {
    const world = makeWorld({ boots: [{ kind: 'serve', version: '1.9.9', pid: 4_000_000_001 }, { kind: 'serve', version: '1.0.0' }] })
    const result = await gatePosixUpgradeRestart({ ...base, hooks: world.hooks })
    expect(result.outcome).toBe('rolled_back')
    expect(result.outcome === 'rolled_back' && result.reason).toMatch(/reports version 1\.9\.9, not 2\.0\.0/)
    expect(world.stopped).toContain(4_000_000_001)
  })

  it('never stops the helper itself or an excluded pid', async () => {
    const world = makeWorld({ boots: [{ kind: 'serve', version: '1.9.9', pid: process.pid }, { kind: 'serve', version: '1.0.0' }] })
    await gatePosixUpgradeRestart({ ...base, excludePids: [3_000_000_001], hooks: world.hooks })
    expect(world.stopped).not.toContain(process.pid)
    expect(world.stopped).not.toContain(3_000_000_001)
  })

  it('keeps the last-known daemon running when the restore fails but a restart comes up', async () => {
    const world = makeWorld({
      boots: [{ kind: 'serve', version: '1.9.9' }, { kind: 'serve', version: '1.9.9' }],
      restore: () => { throw new Error('disk full') },
    })
    const result = await gatePosixUpgradeRestart({ ...base, hooks: world.hooks })
    expect(result).toMatchObject({ outcome: 'rollback_failed', daemonRunning: true, runningVersion: '1.9.9' })
    expect(result.outcome === 'rollback_failed' && result.rollbackError).toMatch(/disk full/)
  })

  it('reports rollback_failed with no daemon when the previous version never comes back', async () => {
    const world = makeWorld({ boots: [{ kind: 'crash' }, { kind: 'crash' }, { kind: 'crash' }] })
    const result = await gatePosixUpgradeRestart({ ...base, hooks: world.hooks })
    expect(result).toMatchObject({ outcome: 'rollback_failed', daemonRunning: false })
    expect(result.outcome === 'rollback_failed' && result.rollbackError).toMatch(/restored but did not come back healthy/)
    // Replacement + two rollback restarts.
    expect(world.spawns).toBe(3)
  })

  it('retries the rollback restart after a service manager respawned the new code', async () => {
    // First rollback restart finds the NEW version holding the port (launchd /
    // systemd respawned it before the files were restored): stop it, retry.
    const world = makeWorld({
      boots: [
        { kind: 'crash' },
        { kind: 'serve', version: '2.0.0-respawned', pid: 4_000_000_009 },
        { kind: 'serve', version: '1.0.0' },
      ],
    })
    const result = await gatePosixUpgradeRestart({ ...base, rollbackHealthTimeoutMs: 2_000, hooks: world.hooks })
    expect(result.outcome).toBe('rolled_back')
    expect(world.stopped).toContain(4_000_000_009)
    expect(world.spawns).toBe(3)
  })
})

describe('resolvePosixHealthGatePort', () => {
  it('prefers an explicit port in the restart argv', () => {
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'daemon', '-p', '19555'], instanceDir: '.adhdev' })).toBe(19555)
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'daemon', '--port', '19223'], instanceDir: '.adhdev' })).toBe(19223)
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'daemon', '--port=19224'], instanceDir: '.adhdev' })).toBe(19224)
  })

  it('uses the preview port for a non-stable instance with no explicit port (macOS `service install`)', () => {
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'service', 'install'], instanceDir: '.adhdev-preview' })).toBe(19223)
  })

  it('uses the build track default for the stable instance', () => {
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'daemon'], instanceDir: '.adhdev', env: {} })).toBe(19222)
    expect(resolvePosixHealthGatePort({ restartArgv: ['cli', 'daemon'], instanceDir: '.adhdev', env: { ADHDEV_BUILD_CHANNEL: 'preview' } })).toBe(19223)
  })
})

describe('describePosixHealthGateSkip', () => {
  it('skips when no restart was requested or for the standalone package', () => {
    expect(describePosixHealthGateSkip('adhdev', [])).toMatch(/no daemon restart/)
    expect(describePosixHealthGateSkip('@adhdev/daemon-standalone', ['cli'])).toMatch(/does not serve/)
    expect(describePosixHealthGateSkip('adhdev', ['cli', 'daemon'])).toBeNull()
  })
})

describe('posix upgrade journal', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })
  function journalFor(helperPid: number, updatedAt: string): PosixUpgradeJournal {
    return {
      helperPid,
      packageName: 'adhdev',
      targetVersion: '2.0.0',
      previousVersion: '1.0.0',
      installPrefix: '/p',
      packageRoot: '/p/lib/node_modules/adhdev',
      backupDir: '/cfg/upgrade-backup-x',
      restartArgv: [],
      phase: 'gating',
      spawnedPid: null,
      startedAt: updatedAt,
      updatedAt,
    }
  }

  it('reports busy for a live, recent owner and stale otherwise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-journal-'))
    roots.push(dir)
    expect(inspectPosixUpgradeJournal(dir).state).toBe('none')

    writePosixUpgradeJournal(dir, journalFor(777, new Date().toISOString()))
    expect(readPosixUpgradeJournal(dir)?.phase).toBe('gating')
    expect(inspectPosixUpgradeJournal(dir, { selfPid: 1, isAlive: () => true }).state).toBe('busy')
    expect(inspectPosixUpgradeJournal(dir, { selfPid: 1, isAlive: () => false }).state).toBe('stale')
    // A recycled pid cannot keep a journal "busy" forever.
    expect(inspectPosixUpgradeJournal(dir, { selfPid: 1, isAlive: () => true, now: Date.now() + 60 * 60_000 }).state).toBe('stale')
  })

  it('only the owner clears the journal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-journal-'))
    roots.push(dir)
    writePosixUpgradeJournal(dir, journalFor(777, new Date().toISOString()))
    clearPosixUpgradeJournal(dir, 1)
    expect(readPosixUpgradeJournal(dir)).not.toBeNull()
    clearPosixUpgradeJournal(dir, 777)
    expect(readPosixUpgradeJournal(dir)).toBeNull()
  })
})
