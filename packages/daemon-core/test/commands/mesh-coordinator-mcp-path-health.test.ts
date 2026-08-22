/**
 * Injection tests for `inspectMeshCoordinatorMcpServerPaths` (mission 3e9b5d83).
 *
 * The mesh coordinator launch writes `node <abs vendor/mcp-server/index.js>`
 * into config files the provider CLI owns (.mcp.json / .cursor/mcp.json /
 * opencode.json / ~/.codex/config.toml / hermes config.yaml). Those files
 * outlive the path they name — the exact failure class of the 2026-08-20
 * statusline incident, except repo-local .mcp.json can also be COMMITTED and
 * carry one machine's absolute path to every teammate.
 *
 * These tests pin the detection contract:
 *   - a dangling (deleted-install) path is reported `missing` with a warning;
 *   - an existing path under a worktree scratchpad / temp dir is `ok` but
 *     `volatile` with a warning (works today, dangles later);
 *   - a normal existing install path passes silently (no overcorrection);
 *   - a bare PATH command (`adhdev mcp …`) embeds nothing → `absent`.
 *
 * Revert the helper (or its wiring) and the first two cases go red.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { inspectMeshCoordinatorMcpServerPaths } from '../../src/commands/mesh-coordinator.js'

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'adhdev-mcp-path-health-'))
  fixtureRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('inspectMeshCoordinatorMcpServerPaths', () => {
  it('flags an injected dangling entry path (deleted install) as missing', () => {
    const health = inspectMeshCoordinatorMcpServerPaths(
      {
        command: '/definitely/not/here/node',
        args: ['/definitely/not/here/vendor/mcp-server/index.js', '--mode', 'local', '--repo-mesh', 'm1'],
      },
      { serverName: 'adhdev-mesh', target: 'MCP config /repo/.mcp.json' },
    )
    expect(health.state).toBe('missing')
    expect(health.referencedPath).toBe('/definitely/not/here/node')
    expect(health.warning).toBeTruthy()
    expect(health.warning).toContain('/definitely/not/here/node')
  })

  it('flags an existing path under a worktree scratchpad as volatile (the statusline failure class)', () => {
    const root = makeFixtureRoot()
    const entryDir = join(root, 'worktrees', 'task-x', 'scratchpad', 'vendor', 'mcp-server')
    mkdirSync(entryDir, { recursive: true })
    const entryFile = join(entryDir, 'index.js')
    writeFileSync(entryFile, '// fixture\n')
    const health = inspectMeshCoordinatorMcpServerPaths(
      { command: process.execPath, args: [entryFile, '--mode', 'local', '--repo-mesh', 'm1'] },
      { serverName: 'adhdev-mesh' },
    )
    expect(health.state).toBe('ok')
    expect(health.volatile).toBe(true)
    expect(health.volatileReason).toBeTruthy()
    expect(health.warning).toBeTruthy()
    expect(health.warning).toContain(entryFile)
  })

  it('goes missing once that volatile entry is actually cleaned up', () => {
    const root = makeFixtureRoot()
    const entryDir = join(root, 'worktrees', 'task-y', 'scratchpad', 'vendor', 'mcp-server')
    mkdirSync(entryDir, { recursive: true })
    const entryFile = join(entryDir, 'index.js')
    writeFileSync(entryFile, '// fixture\n')
    rmSync(entryFile)
    const health = inspectMeshCoordinatorMcpServerPaths(
      { command: process.execPath, args: [entryFile, '--mode', 'local'] },
      { serverName: 'adhdev-mesh' },
    )
    expect(health.state).toBe('missing')
    expect(health.referencedPath).toBe(entryFile)
    expect(health.warning).toBeTruthy()
  })

  it('passes a normal existing install path silently (no overcorrection)', () => {
    const health = inspectMeshCoordinatorMcpServerPaths(
      { command: process.execPath, args: [process.execPath, '--mode', 'local', '--repo-mesh', 'm1'] },
      { serverName: 'adhdev-mesh' },
    )
    expect(health.state).toBe('ok')
    expect(health.volatile).toBe(false)
    expect(health.warning).toBeNull()
  })

  it('treats a bare PATH command (default `adhdev mcp …` form) as absent — nothing embedded', () => {
    const health = inspectMeshCoordinatorMcpServerPaths({
      command: 'adhdev',
      args: ['mcp', '--mode', 'ipc', '--repo-mesh', 'm1'],
    })
    expect(health.state).toBe('absent')
    expect(health.referencedPath).toBeNull()
    expect(health.warning).toBeNull()
  })

  it('mentions commit propagation when the target config file is repo-local', () => {
    // Fixture sits under the OS temp dir → volatile → warning fires; the
    // repo-local note must ride along because .mcp.json can be committed.
    const root = makeFixtureRoot()
    const entryDir = join(root, 'vendor', 'mcp-server')
    mkdirSync(entryDir, { recursive: true })
    const entryFile = join(entryDir, 'index.js')
    writeFileSync(entryFile, '// fixture\n')
    const health = inspectMeshCoordinatorMcpServerPaths(
      { command: process.execPath, args: [entryFile, '--mode', 'local'] },
      { serverName: 'adhdev-mesh', target: 'MCP config /repo/.mcp.json', repoLocal: true },
    )
    expect(health.volatile).toBe(true)
    expect(health.warning).toMatch(/committed/i)
  })
})
