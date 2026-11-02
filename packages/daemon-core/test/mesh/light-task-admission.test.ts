import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { admitLightBaseNode } from '../../src/mesh/light-task-admission.js'

const dirs: string[] = []
function checkout(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-admit-'))
  dirs.push(d)
  fs.mkdirSync(path.join(d, '.adhdev'))
  fs.writeFileSync(path.join(d, '.adhdev', 'light-workspace.json'), JSON.stringify({ version: 1, linkNodeModules: [], copyDirs: [], copyExclude: [], freshDirs: [] }))
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('admitLightBaseNode', () => {
  it('admits a base node with no daemonId (the mesh host own node, as standalone creates it)', () => {
    const ws = checkout()
    const r = admitLightBaseNode({ nodes: [{ id: 'node_a', workspace: ws }] }, 'standalone_mach_1')
    expect(r.lightBaseNodeId).toBe('node_a')
    expect(r.checkoutRoot).toBe(ws)
  })

  it('admits a base node whose daemonId is this daemon', () => {
    const ws = checkout()
    expect(admitLightBaseNode({ nodes: [{ id: 'node_a', workspace: ws, daemonId: 'daemon_mach_1' }] }, 'daemon_mach_1').lightBaseNodeId).toBe('node_a')
  })

  it('refuses when the only base node belongs to another daemon', () => {
    const ws = checkout()
    expect(() => admitLightBaseNode({ nodes: [{ id: 'node_b', workspace: ws, daemonId: 'daemon_mach_2' }] }, 'daemon_mach_1')).toThrow(/light_requires_local_base/)
  })

  it('skips local worktree nodes when picking the base', () => {
    const ws = checkout()
    expect(() => admitLightBaseNode({ nodes: [{ id: 'node_wt', workspace: ws, isLocalWorktree: true }] }, 'daemon_mach_1')).toThrow(/light_requires_local_base/)
  })
})
