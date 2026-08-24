import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface.tsx'),
  'utf-8',
)

describe('MeshObservabilitySurface heal action', () => {
  it('keeps mesh node healing dry-run first with explicit confirmation before execute', () => {
    expect(source).toContain('fast_forward_mesh_node')
    expect(source).toContain('dryRun: true')
    expect(source).toContain("dryRun.code !== 'fast_forward_available'")
    // In-app confirm dialog (useConfirmDialog) — window.confirm is auto-dismissed
    // in embedded browsers, which would have made Heal silently unexecutable there.
    expect(source).toContain('await confirm(')
    expect(source).toContain('execute: true')
    // Heal must run the submodule-aware ff (same as the coordinator
    // mesh_fast_forward_node path) so the superproject ff doesn't leave
    // submodules drifted out-of-sync.
    expect(source).toContain('updateSubmodules: true')
    expect(source).toContain('selectedGraphNode.behind > 0')
    expect(source).toContain('selectedGraphNode.dirtyFiles === 0')
  })
})
