import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isSpawnResolutionError, describeSpawnError } from '../../src/commands/router'
import { resolveWin32Executable } from '../../src/cli-adapters/resolve-executable'

// B1 + B2 for mission Q-B: the Refinery validation gate resolves win32 .cmd
// shims to an absolute path before the spawn boundary, and classifies a
// spawn-ENOENT distinctly (not as a generic / missing_dependencies failure).

describe('refine spawn resolution (B1)', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let tmp: string
  const originalAppData = process.env.APPDATA

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    tmp = mkdtempSync(join(tmpdir(), 'refine-spawn-'))
  })
  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    rmSync(tmp, { recursive: true, force: true })
  })

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  it('on non-win32 is a passthrough (no behavior change to the spawned command)', () => {
    setPlatform('linux')
    expect(resolveWin32Executable('npm')).toBe('npm')
    expect(resolveWin32Executable('node')).toBe('node')
    expect(resolveWin32Executable('vitest')).toBe('vitest')
  })

  it('on win32 resolves a bare .cmd shim (npm) to an absolute path, NOT bare "npm"', () => {
    setPlatform('win32')
    // Simulate npm's off-PATH global bin: only npm.cmd exists there (no .exe),
    // which is exactly why libuv's spawn search (only .com/.exe) ENOENTs.
    const npmDir = join(tmp, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'npm.cmd'), '@echo off\n', 'utf-8')
    process.env.APPDATA = tmp

    const resolved = resolveWin32Executable('npm')
    // The value handed to the spawn boundary must be a resolved absolute path,
    // not the bare command the spawn search cannot find.
    expect(resolved).not.toBe('npm')
    expect(resolved).toBe(join(npmDir, 'npm.cmd'))
  })

  it('documents the node-vs-npm asymmetry: a real .exe needs no global-bin fallback, an off-PATH .cmd does', () => {
    setPlatform('win32')
    // `node`/`git` are real .exe on PATH → libuv's spawn search (.com/.exe)
    // resolves them, which is why git/node refine commands work on win32 today
    // and only the npm-family .cmd shims break. We stage an off-PATH npm.cmd to
    // represent npm's %APPDATA%\npm prefix: the resolver must turn it absolute.
    const npmDir = join(tmp, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'npm.cmd'), '@echo off\n', 'utf-8')
    process.env.APPDATA = tmp
    // The .cmd shim (npm) is resolved to the staged absolute path...
    expect(resolveWin32Executable('npm')).toBe(join(npmDir, 'npm.cmd'))
    // ...while a command that resolves nowhere stays the bare command (no
    // corruption / no false absolute path injected).
    const unresolvable = `definitely-not-a-real-binary-${Math.abs(npmDir.length)}`
    expect(resolveWin32Executable(unresolvable)).toBe(unresolvable)
  })
})

describe('refine spawn ENOENT classification (B2)', () => {
  it('classifies a synthetic spawn ENOENT as a spawn-resolution failure (not missing_dependencies, not unclassified)', () => {
    const error = { code: 'ENOENT', syscall: 'spawn npm', message: 'spawn npm ENOENT' }
    expect(isSpawnResolutionError(error)).toBe(true)

    // The earlier-audit hypothesis was that ENOENT is misclassified as
    // missing_dependencies. It is not: "ENOENT" does not match the
    // missing-dependency regex, so without B2 it falls through to UNCLASSIFIED.
    const missingDepRegex = /Cannot find module|MODULE_NOT_FOUND|node_modules|command not found|not found/i
    expect(missingDepRegex.test(error.message)).toBe(false)
  })

  it('classifies a code-only ENOENT (mock without syscall) as spawn-resolution', () => {
    expect(isSpawnResolutionError({ code: 'ENOENT' })).toBe(true)
  })

  it('does NOT classify a non-zero exit (command ran and failed) as spawn-resolution', () => {
    expect(isSpawnResolutionError({ code: 1, stderr: 'tests failed' })).toBe(false)
    expect(isSpawnResolutionError({ code: 'ETIMEDOUT', killed: true })).toBe(false)
    expect(isSpawnResolutionError(null)).toBe(false)
    expect(isSpawnResolutionError(undefined)).toBe(false)
  })

  it('describeSpawnError names the unresolved command with a win32 .cmd hint', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const msg = describeSpawnError({ code: 'ENOENT', message: 'spawn npm ENOENT' }, 'npm', true)
      expect(msg).toContain('npm')
      expect(msg.toLowerCase()).toContain('spawn enoent')
      expect(msg).toMatch(/\.cmd/i)
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('describeSpawnError falls back to the raw message for a non-spawn failure', () => {
    expect(describeSpawnError({ message: 'exit code 1' }, 'npm', false)).toBe('exit code 1')
  })
})
