import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface.tsx'),
  'utf-8',
)

describe('MeshObservabilitySurface update (fast-forward) action', () => {
  it('is one click on a node that cannot lose work, with the outcome as a toast', () => {
    // 2026-09-27 simplification: the dry-run + confirm round trip added a dialog
    // without adding safety — the button is only offered for a clean node that is
    // strictly behind a VERIFIED upstream, and the daemon re-checks the same
    // preconditions before it moves anything.
    expect(source).toContain('fast_forward_mesh_node')
    expect(source).toContain('selectedGraphNode.behind > 0')
    expect(source).toContain('selectedGraphNode.ahead === 0')
    expect(source).toContain('selectedGraphNode.dirtyFiles === 0')
    expect(source).toContain('!selectedGraphNode.hasConflicts')
    expect(source).toContain("selectedGraphNode.upstreamStatus === 'fresh'")
    expect(source).toContain('execute: true')
    // No second step: neither a dry-run gate nor a confirm dialog.
    expect(source).not.toContain('dryRun: true')
    expect(source).not.toContain('await confirm(')
    expect(source).not.toContain('window.confirm')
    // Result is reported as a toast (success / failure with the reason).
    expect(source).toContain("eventManager.showToast(t('mesh.obs.healDone'")
    expect(source).toContain("t('mesh.obs.healFailed'")
    // Update must run the submodule-aware ff (same as the coordinator
    // mesh_fast_forward_node path) so the superproject ff doesn't leave
    // submodules drifted out-of-sync.
    expect(source).toContain('updateSubmodules: true')
  })
})
