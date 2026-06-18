import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))
vi.mock('child_process', () => cp)

// The source imports `* as fs from 'fs'`; mock that specifier so we can simulate
// a locked native binary (rmSync → EPERM) for a single path while every other
// fs call — including rmSync for other paths — passes through to the real impl.
// vitest aliases 'fs' and 'node:fs' to the same mock, so the test's own fs
// helpers go through this wrapper too; passthrough keeps them working.
const fsCtl = vi.hoisted(() => ({
  lockedPath: null as string | null,
  rmCalls: [] as string[],
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const rmSync = ((target: any, opts: any) => {
    fsCtl.rmCalls.push(String(target))
    if (fsCtl.lockedPath !== null && String(target) === fsCtl.lockedPath) {
      throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
    }
    return actual.rmSync(target, opts)
  }) as typeof actual.rmSync
  const patched = { ...actual, rmSync }
  return { ...patched, default: patched }
})

import {
  cleanupStaleGlobalInstallDirs,
  safeRemoveStaleEntry,
  type CurrentGlobalInstallSurface,
} from '../../src/commands/upgrade-helper'

const tempRoots: string[] = []

function mkTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-stale-cleanup-'))
  tempRoots.push(root)
  return root
}

beforeEach(() => {
  cp.execFileSync.mockReset()
  cp.spawn.mockClear()
  fsCtl.lockedPath = null
  fsCtl.rmCalls = []
})

afterEach(() => {
  fsCtl.lockedPath = null
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('safeRemoveStaleEntry', () => {
  it('removes an unlocked entry', () => {
    const root = mkTempRoot()
    const target = path.join(root, '.adhdev-abc')
    fs.mkdirSync(target, { recursive: true })

    safeRemoveStaleEntry(target, 'Removed stale staging dir')

    expect(fs.existsSync(target)).toBe(false)
  })

  it('does not throw when the entry is locked (EPERM)', () => {
    const locked = path.join(os.tmpdir(), '.adhdev-xyz', 'ghostty-vt.dll')
    fsCtl.lockedPath = locked

    expect(() => safeRemoveStaleEntry(locked, 'Removed stale staging dir')).not.toThrow()
    expect(fsCtl.rmCalls).toContain(locked)
  })
})

describe('cleanupStaleGlobalInstallDirs', () => {
  function surfaceFor(npmRoot: string, prefix: string): CurrentGlobalInstallSurface {
    cp.execFileSync.mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes('root')) return `${npmRoot}\n`
      if (args.includes('prefix')) return `${prefix}\n`
      return '\n'
    })
    return {
      npmExecutable: 'npm',
      npmArgsPrefix: [],
      packageRoot: path.join(npmRoot, 'adhdev'),
      installPrefix: prefix,
      execOptions: { shell: false },
    }
  }

  it('keeps cleaning sibling entries when one stale dir is locked, without throwing', () => {
    const prefix = mkTempRoot()
    const npmRoot = path.join(prefix, 'node_modules')
    const locked = path.join(npmRoot, '.adhdev-locked')
    const removable = path.join(npmRoot, '.adhdev-removable')
    fs.mkdirSync(locked, { recursive: true })
    fs.mkdirSync(removable, { recursive: true })

    const surface = surfaceFor(npmRoot, prefix)
    fsCtl.lockedPath = locked

    expect(() => cleanupStaleGlobalInstallDirs('adhdev', surface)).not.toThrow()
    // Locked leftover survives (best-effort); the unlocked sibling is cleaned.
    expect(fs.existsSync(locked)).toBe(true)
    expect(fs.existsSync(removable)).toBe(false)
  })

  it('never throws when npm root probing fails', () => {
    cp.execFileSync.mockImplementation(() => {
      throw new Error('npm not found')
    })
    const surface: CurrentGlobalInstallSurface = {
      npmExecutable: 'npm',
      npmArgsPrefix: [],
      packageRoot: null,
      installPrefix: null,
      execOptions: { shell: false },
    }

    expect(() => cleanupStaleGlobalInstallDirs('adhdev', surface)).not.toThrow()
  })
})
