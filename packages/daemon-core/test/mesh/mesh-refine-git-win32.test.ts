import { describe, expect, it, vi } from 'vitest'
import { resolveWin32Executable } from '../../src/cli-adapters/resolve-executable.js'
import { analyzeMeshRefineNodeChangeArea } from '../../src/mesh/mesh-refine-batch.js'
import { LOG } from '../../src/logging/logger.js'
import * as path from 'path'

// Fix (4): the refine/batch git helpers used a bare `git` for execFile(Sync)/execFileAsync.
// On win32 libuv's spawn search appends only .com/.exe (no PATHEXT) over the inherited PATH,
// so a `git.cmd`/`git.exe` that `where` resolves is missed → spawn ENOENT (the live failure).
// The module-level GIT const now resolves git to an absolute path via resolveWin32Executable
// (the same helper the validation/bootstrap spawn path already used).
describe('Fix (4) — win32 git executable resolution for refine/batch', () => {
  it('resolveWin32Executable("git") yields an absolute path on win32 (what GIT resolves to)', () => {
    const resolved = resolveWin32Executable('git')
    if (process.platform === 'win32') {
      // On win32 it must NOT stay the bare command; it resolves to an absolute git path.
      expect(resolved).not.toBe('git')
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved.toLowerCase()).toContain('git')
    } else {
      // No-op off win32 — the bare command is returned verbatim.
      expect(resolved).toBe('git')
    }
  })

  // Live spawn check: drive the real git-based change-area helper against this very
  // (git) repo. Pre-fix on win32 this ENOENT'd; with GIT resolved it spawns cleanly. The
  // assertion is platform-agnostic (git is on PATH off win32 too): no spawn/ENOENT error.
  it('analyzeMeshRefineNodeChangeArea spawns git without ENOENT (HEAD..HEAD → 0 ahead, no error)', async () => {
    const cwd = process.cwd()
    const result = await analyzeMeshRefineNodeChangeArea({
      nodeId: 'node_live',
      workspace: cwd,
      branch: 'HEAD',
      baseRef: 'HEAD',
      branchRef: 'HEAD',
      diffCwd: cwd,
      submodulePaths: new Set<string>(),
    })
    // HEAD..HEAD is empty, so the analysis completes cleanly with no error and 0 commits.
    expect(result.error).toBeUndefined()
    expect(result.aheadCount).toBe(0)
    expect(Array.isArray(result.changedFiles)).toBe(true)
  }, 30_000) // real git spawn against this (large, submodule'd) repo — generous under parallel load

  it('logs that a missing change-area cwd does not exist when git spawn fails with ENOENT', async () => {
    const missingCwd = path.join(process.cwd(), `.missing-refine-cwd-${process.pid}-${Date.now()}`)
    const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)
    try {
      const result = await analyzeMeshRefineNodeChangeArea({
        nodeId: 'node_missing_cwd',
        workspace: '/stored/workspace/path',
        branch: 'feat/missing-cwd',
        baseRef: 'HEAD',
        branchRef: 'HEAD',
        diffCwd: missingCwd,
        repoRoot: '/source/repo/root',
        submodulePaths: new Set(['oss']),
      })

      expect(result.error).toContain('ENOENT')
      expect(warn).toHaveBeenCalledWith('Mesh', expect.stringContaining('[Refinery] Change-area git call failed'))
      const diagnostic = warn.mock.calls.map(([, message]) => message).join('\n')
      expect(diagnostic).toContain(`"cwd":"${missingCwd}"`)
      expect(diagnostic).toContain('"cwdExists":false')
      expect(diagnostic).toContain('"code":"ENOENT"')
      expect(diagnostic).toContain('"syscall":"spawn git"')
      expect(diagnostic).toContain('"path":"git"')
      expect(diagnostic).toContain('"workspace":"/stored/workspace/path"')
      expect(diagnostic).toContain('"repoRoot":"/source/repo/root"')
      expect(diagnostic).toContain('"submodulePaths":["oss"]')
    } finally {
      warn.mockRestore()
    }
  })
})
