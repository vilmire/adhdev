import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ensureLightWorkspaceSchema, findLightWorkspaceByPath, setLightWorkspaceState, upsertLightWorkspace } from '../../src/mesh/mesh-light-workspace-store.js'

function row(id: string, path: string) {
  const at = new Date().toISOString()
  return { workspaceId: id, meshId: 'm', taskId: `t-${id}`, repoRoot: '/opt/repo', path, rootBaseSha: 'a'.repeat(40), submoduleBases: {}, branchRefs: {}, state: 'ready' as const, createdAt: at, updatedAt: at, linkDirs: [] }
}

describe('findLightWorkspaceByPath', () => {
  it('identifies a light session by its working directory, including after the workspace was removed', () => {
    const db = new Database(':memory:')
    ensureLightWorkspaceSchema(db)
    upsertLightWorkspace(db, row('lw_1', '/opt/lw/a/1') as any)
    expect(findLightWorkspaceByPath(db, '/opt/lw/a/1')?.workspaceId).toBe('lw_1')
    setLightWorkspaceState(db, 'lw_1', 'removed')
    expect(findLightWorkspaceByPath(db, '/opt/lw/a/1')?.workspaceId).toBe('lw_1')
    expect(findLightWorkspaceByPath(db, '/opt/repo')).toBeUndefined()
    db.close()
  })
})
