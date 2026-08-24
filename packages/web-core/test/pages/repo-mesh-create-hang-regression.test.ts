import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// MESH-CREATE-HANG (owner report 2026-08-24): on standalone the create form
// wiped the just-selected workspace and stranded on "Checking the workspace…".
// Two coupled defects, each pinned here at the source level because the fix is
// a guard ordering inside page-scale effects that no unit seam exposes:
//
//  1. RepoMesh.tsx's cloud auto-select effect fell into its CLEAR branch for
//     every standalone run (`!features.createDaemonPicker` short-circuited
//     into `setNewMeshWorkspace('')`), and newMeshWorkspace being a dependency
//     meant the user's own selection re-fired the wipe. Standalone must no-op.
//  2. useMeshList's plan effect early-return reset only the plan, not
//     planLoading — and the in-flight probe's finally is skipped by its
//     `cancelled` guard — so once (1) emptied the workspace, planLoading stayed
//     true forever and isMeshCreateDisabled kept Create dead.

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

describe('mesh create form — standalone hang regression', () => {
  it('the cloud auto-select effect no-ops on standalone BEFORE any workspace clear', () => {
    const source = read('../../src/pages/RepoMesh.tsx')
    const effect = source.slice(source.indexOf('Cloud: auto-select first workspace'))
    const noop = effect.indexOf('if (!features.createDaemonPicker) return')
    const firstClear = effect.indexOf("setNewMeshWorkspace('')")
    expect(noop).toBeGreaterThan(-1)
    expect(firstClear).toBeGreaterThan(-1)
    expect(noop).toBeLessThan(firstClear)
  })

  it('the plan effect early-return clears planLoading, not only the plan', () => {
    const source = read('../../src/pages/repo-mesh/useMeshList.ts')
    const earlyReturn = source.slice(
      source.indexOf('if (!showCreate || !createTargetDaemonId || !newMeshWorkspace)'),
    )
    const branch = earlyReturn.slice(0, earlyReturn.indexOf('return'))
    expect(branch).toContain('setCreateOnboardingPlan(null)')
    expect(branch).toContain('setCreatePlanLoading(false)')
  })
})
