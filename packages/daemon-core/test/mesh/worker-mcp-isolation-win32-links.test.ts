/**
 * ★Worker private-HOME links on UNPRIVILEGED win32 (release blocker, 2026-09-27).
 *
 * The existing worker-mcp-isolation tests stub `process.platform` but run on a
 * POSIX host, where `symlinkSync` always succeeds — so the win32 failure path
 * was never exercised. On a real win32 host without developer mode:
 *
 *   symlinkSync(src, dst)            → EPERM (needs SeCreateSymbolicLinkPrivilege)
 *   copyFileSync(<directory>, dst)   → EISDIR
 *
 * The old code fell back to copyFileSync for every symlink-mode import, so any
 * DIRECTORY import (codex `sessions`, antigravity `brain`/`conversations`, grok
 * `.grok/sessions`/`.grok/bin`, kimi `credentials`/`oauth`/`sessions`, hermes
 * `sessions`) threw EISDIR, the private HOME was abandoned, and the worker ran
 * on the REAL home with the coordinator's MCP servers in view (fail OPEN).
 *
 * This file mocks `fs` to reproduce those win32 semantics faithfully:
 *  - `symlinkSync` without a type, or with 'file'/'dir', throws EPERM;
 *  - `symlinkSync(..., 'junction')` succeeds for an absolute directory source
 *    (backed by a real POSIX dir symlink, which has the same write-through
 *    semantics the transcript surfaces rely on);
 *  - `copyFileSync` of a directory throws EISDIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

type FsModule = typeof import('fs')

const win32 = vi.hoisted(() => ({
  /** Emulate an unprivileged win32 host (no developer mode). */
  unprivileged: false,
  /** Make junction creation fail too (e.g. a home on a network volume). */
  junctionFails: false,
  /** Make copyFileSync fail for every source. */
  copyFails: false,
  symlinkCalls: [] as Array<{ source: string; target: string; type: string | undefined }>,
  copyCalls: [] as Array<{ source: string; target: string }>,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<FsModule>()
  const eperm = (op: string, p: string): NodeJS.ErrnoException => {
    const err = new Error(`EPERM: operation not permitted, ${op} '${p}'`) as NodeJS.ErrnoException
    err.code = 'EPERM'
    return err
  }
  const symlinkSync = ((source: string, target: string, type?: string | null) => {
    win32.symlinkCalls.push({ source: String(source), target: String(target), type: type ?? undefined })
    if (win32.unprivileged) {
      if (type !== 'junction') throw eperm('symlink', String(source))
      if (win32.junctionFails) throw eperm('junction', String(source))
      // Junction preconditions on real win32: absolute, existing directory.
      if (!isAbsolute(String(source)) || !actual.statSync(source).isDirectory()) {
        throw eperm('junction', String(source))
      }
    }
    return actual.symlinkSync(source, target)
  }) as FsModule['symlinkSync']
  const copyFileSync = ((source: string, target: string, mode?: number) => {
    win32.copyCalls.push({ source: String(source), target: String(target) })
    if (win32.copyFails) throw eperm('copyfile', String(source))
    if (win32.unprivileged && actual.statSync(source).isDirectory()) {
      const err = new Error(`EISDIR: illegal operation on a directory, copyfile '${source}'`) as NodeJS.ErrnoException
      err.code = 'EISDIR'
      throw err
    }
    return actual.copyFileSync(source, target, mode)
  }) as FsModule['copyFileSync']
  const mocked = { ...actual, symlinkSync, copyFileSync }
  return { ...mocked, default: mocked }
})

import * as realFs from 'fs'
import {
  deriveWorkerMcpDeliveryStatus,
  findWorkerPrivateHomeSpec,
  prepareWorkerPrivateHome,
  resolveWorkerMcpIsolation,
} from '../../src/mesh/worker-mcp-isolation'
import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-delegated-launch'
import { LOG } from '../../src/logging/logger.js'

const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = realFs

const ON = { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv

const tmpDirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

let platformDescriptor: PropertyDescriptor | undefined
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  win32.unprivileged = false
  win32.junctionFails = false
  win32.copyFails = false
  win32.symlinkCalls.length = 0
  win32.copyCalls.length = 0
})
afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  win32.unprivileged = false
  vi.restoreAllMocks()
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function emulateUnprivilegedWin32(): void {
  setPlatform('win32')
  win32.unprivileged = true
}

function file(p: string, content = 'x'): void {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content, { mode: 0o600 })
}
function dir(p: string): void {
  mkdirSync(p, { recursive: true })
  // A marker inside so write-through can be asserted from the worker side.
  writeFileSync(join(p, 'marker.txt'), 'real')
}

/**
 * Per provider: which imports are DIRECTORIES (must become junctions on win32)
 * and which are FILES (symlink → copy fallback), plus a fake real home.
 */
const CASES: Array<{
  providerType: string
  dirs: string[]
  files: string[]
}> = [
  { providerType: 'codex-cli', dirs: ['sessions'], files: ['auth.json'] },
  {
    providerType: 'antigravity-cli',
    dirs: [join('.gemini', 'antigravity-cli', 'brain'), join('.gemini', 'antigravity-cli', 'conversations')],
    files: [join('.gemini', 'antigravity-cli', 'history.jsonl')],
  },
  {
    providerType: 'grok-cli',
    dirs: [join('.grok', 'sessions'), join('.grok', 'bin')],
    files: [join('.grok', 'auth.json')],
  },
  { providerType: 'kimi', dirs: ['credentials', 'oauth', 'sessions'], files: ['config.toml'] },
  { providerType: 'hermes-cli', dirs: ['sessions'], files: ['.env'] },
]

function fakeRealHome(providerType: string, dirs: string[], files: string[]): { realHome: string; sourceBase: string } {
  const realHome = tmp(`adhdev-w32-real-${providerType}-`)
  const spec = findWorkerPrivateHomeSpec(providerType)!
  const sourceBase = spec.configRootPrefix ? join(realHome, spec.configRootPrefix) : realHome
  for (const d of dirs) dir(join(sourceBase, d))
  for (const f of files) file(join(sourceBase, f), `real-${f}`)
  return { realHome, sourceBase }
}

describe('★unprivileged win32: directory imports become junctions, the private HOME survives', () => {
  for (const c of CASES) {
    it(`${c.providerType}: ${c.dirs.join(', ')} linked as junctions; files copied; HOME established`, () => {
      const { realHome, sourceBase } = fakeRealHome(c.providerType, c.dirs, c.files)
      emulateUnprivilegedWin32()
      const spec = findWorkerPrivateHomeSpec(c.providerType)!

      const prepared = prepareWorkerPrivateHome(spec, {
        workspace: tmp('adhdev-w32-ws-'),
        sessionKey: 'task_w32',
        realHome,
        baseDir: tmp('adhdev-w32-base-'),
      })

      expect(existsSync(prepared.home)).toBe(true)
      expect(prepared.failed).toEqual([])
      for (const d of c.dirs) {
        const source = join(sourceBase, d)
        const target = join(prepared.home, d)
        expect(prepared.imported).toContain(d)
        // The mechanism: a junction, never a bare symlink, never a copy.
        const call = win32.symlinkCalls.find((k) => k.target === target && k.type === 'junction')
        expect(call, `junction call for ${d}`).toBeTruthy()
        expect(isAbsolute(call!.source)).toBe(true)
        expect(win32.copyCalls.some((k) => k.source === source)).toBe(false)
        // The effect: write-through to the REAL home (the daemon reads there).
        expect(lstatSync(target).isSymbolicLink()).toBe(true)
        expect(realpathSync(target)).toBe(realpathSync(source))
        writeFileSync(join(target, 'from-worker.txt'), 'w')
        expect(readFileSync(join(source, 'from-worker.txt'), 'utf8')).toBe('w')
      }
      for (const f of c.files) {
        const target = join(prepared.home, f)
        expect(prepared.imported).toContain(f)
        // symlink attempted first ('file'), EPERM, then the copy fallback.
        expect(win32.symlinkCalls.some((k) => k.target === target && k.type === 'file')).toBe(true)
        expect(lstatSync(target).isSymbolicLink()).toBe(false)
        expect(readFileSync(target, 'utf8')).toBe(`real-${f}`)
      }
    })
  }

  it('codex-cli: resolveWorkerMcpIsolation keeps CODEX_HOME private (no privateHomeError)', () => {
    const { realHome } = fakeRealHome('codex-cli', ['sessions'], ['auth.json'])
    emulateUnprivilegedWin32()
    const result = resolveWorkerMcpIsolation({
      providerType: 'codex-cli',
      workspace: tmp('adhdev-w32-ws-codex-'),
      sessionKey: 'task_codex',
      realHome,
      baseDir: tmp('adhdev-w32-base-codex-'),
      mcpConfig: { mode: 'auto_import', format: 'codex_toml', path: '~/.codex/config.toml' },
    }, ON)!

    expect(result.privateHomeError).toBeUndefined()
    expect(result.workerHome).toBeTruthy()
    expect(result.workerHomeEnvVar).toBe('CODEX_HOME')
    expect(result.notes.join(' ')).not.toMatch(/private HOME unavailable/)
    // The coordinator's real config root is untouched.
    expect(existsSync(join(realHome, '.codex', 'config.toml'))).toBe(false)
  })

  it('cursor-cli workspace link (a directory) is a junction too', () => {
    const realHome = tmp('adhdev-w32-real-cursor-')
    emulateUnprivilegedWin32()
    const prepared = prepareWorkerPrivateHome(findWorkerPrivateHomeSpec('cursor-cli')!, {
      workspace: tmp('adhdev-w32-ws-cursor-'),
      sessionKey: 'task_cursor',
      realHome,
      baseDir: tmp('adhdev-w32-base-cursor-'),
    })
    const linked = prepared.imported.filter((p) => p.endsWith('agent-transcripts'))
    expect(linked).toHaveLength(1)
    expect(win32.symlinkCalls.some((k) => k.target === join(prepared.home, linked[0]) && k.type === 'junction')).toBe(true)
  })
})

describe('★per-import failure keeps the private HOME (WARN, never silent)', () => {
  it('a directory import that cannot be linked even as a junction is skipped with a WARN — HOME still private', () => {
    const { realHome } = fakeRealHome('codex-cli', ['sessions'], ['auth.json'])
    emulateUnprivilegedWin32()
    win32.junctionFails = true
    const warn = vi.spyOn(LOG, 'warn')

    const result = resolveWorkerMcpIsolation({
      providerType: 'codex-cli',
      workspace: tmp('adhdev-w32-ws-jfail-'),
      sessionKey: 'task_jfail',
      realHome,
      baseDir: tmp('adhdev-w32-base-jfail-'),
      mcpConfig: { mode: 'auto_import', format: 'codex_toml', path: '~/.codex/config.toml' },
    }, ON)!

    expect(result.privateHomeError).toBeUndefined()
    expect(result.workerHome).toBeTruthy()
    expect(result.notes.join(' ')).toMatch(/failed imports \(private HOME kept\): sessions/)
    expect(warn.mock.calls.some((args) => /import sessions failed/.test(String(args[1])))).toBe(true)
    // Never copied — a copied transcript dir would sever write-through.
    expect(win32.copyCalls.some((k) => k.source.endsWith('sessions'))).toBe(false)
  })
})

describe('★isolation-core failure fails CLOSED', () => {
  it('private root cannot be created ⇒ privateHomeError, no config, reason private_home_failed, WARN', () => {
    const { realHome } = fakeRealHome(
      'antigravity-cli',
      [join('.gemini', 'antigravity-cli', 'brain')],
      [join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')],
    )
    const notADir = join(tmp('adhdev-w32-base-file-'), 'blocker')
    writeFileSync(notADir, 'not a directory')
    const warn = vi.spyOn(LOG, 'warn')

    // A format + path that WOULD be written (with a bind) had the HOME been built.
    const result = resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace: tmp('adhdev-w32-ws-core-'),
      sessionKey: 'task_core',
      realHome,
      baseDir: notADir,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
      server: { command: 'adhdev-mcp', args: ['--mode', 'worker'] },
      bindContext: { meshId: 'mesh_1', sessionId: 'sess_1' },
    }, ON)!

    expect(result.privateHomeError).toBeTruthy()
    expect(result.workerHome).toBeUndefined()
    expect(result.configPath).toBeUndefined()
    expect(result.bind).toBeUndefined()
    expect(deriveWorkerMcpDeliveryStatus(result, true)).toEqual({ delivered: false, reason: 'private_home_failed' })
    expect(warn.mock.calls.some((args) => /refusing to launch the worker un-isolated/.test(String(args[1])))).toBe(true)
    // Nothing landed in the coordinator's real config either.
    expect(existsSync(join(realHome, '.gemini', 'config', 'mcp_config.json'))).toBe(false)
  })

  it('launch seam refuses to start the worker (explicit error, no env pointing at the real home)', () => {
    const { realHome } = fakeRealHome('codex-cli', ['sessions'], ['auth.json'])
    const notADir = join(tmp('adhdev-w32-base-file2-'), 'blocker')
    writeFileSync(notADir, 'not a directory')

    expect(() => buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace: tmp('adhdev-w32-ws-launch-'),
      sessionKey: 'task_launch',
      realHome,
      workerHomeBaseDir: notADir,
      mcpConfig: { mode: 'auto_import', format: 'codex_toml', path: '~/.codex/config.toml' },
      runtimeEnv: ON,
    })).toThrow(/worker_private_home_failed: codex-cli/)
  })

  it('a REQUIRED file import that cannot be linked nor copied refuses the launch (grok auth.json)', () => {
    const { realHome } = fakeRealHome('grok-cli', [join('.grok', 'sessions')], [join('.grok', 'auth.json')])
    emulateUnprivilegedWin32()
    win32.copyFails = true

    expect(() => buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'grok-cli',
      workspace: tmp('adhdev-w32-ws-grok-'),
      sessionKey: 'task_grok',
      realHome,
      workerHomeBaseDir: tmp('adhdev-w32-base-grok-'),
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json' },
      runtimeEnv: ON,
    })).toThrow(/worker_private_home_failed: grok-cli: worker_private_home_import_failed: required .*auth\.json/)
  })

  it('gate OFF is still the explicit opt-out: no isolation attempted, no throw', () => {
    const notADir = join(tmp('adhdev-w32-base-file3-'), 'blocker')
    writeFileSync(notADir, 'not a directory')
    expect(() => buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'codex-cli',
      workspace: tmp('adhdev-w32-ws-off-'),
      sessionKey: 'task_off',
      workerHomeBaseDir: notADir,
      mcpConfig: { mode: 'auto_import', format: 'codex_toml', path: '~/.codex/config.toml' },
      runtimeEnv: { ADHDEV_WORKER_MCP: 'off' } as NodeJS.ProcessEnv,
    })).not.toThrow()
  })
})

describe('POSIX is unchanged', () => {
  it('darwin: plain two-argument symlinkSync for files and directories, no junction, no copy', () => {
    const { realHome } = fakeRealHome('codex-cli', ['sessions'], ['auth.json'])
    setPlatform('darwin')
    const prepared = prepareWorkerPrivateHome(findWorkerPrivateHomeSpec('codex-cli')!, {
      workspace: tmp('adhdev-posix-ws-'),
      sessionKey: 'task_posix',
      realHome,
      baseDir: tmp('adhdev-posix-base-'),
    })
    expect(prepared.imported).toEqual(['auth.json', 'sessions'])
    expect(win32.symlinkCalls).toHaveLength(2)
    expect(win32.symlinkCalls.every((k) => k.type === undefined)).toBe(true)
    expect(win32.copyCalls).toHaveLength(0)
  })
})
