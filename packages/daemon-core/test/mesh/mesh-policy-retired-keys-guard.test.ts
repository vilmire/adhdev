import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { RETIRED_MESH_POLICY_KEYS, resolveMeshPolicy, DEFAULT_MESH_POLICY } from '../../src/repo-mesh-types.js'
import { DEFAULT_COORDINATOR_RULES } from '../../src/mesh/default-coordinator-rules.js'

// Source-shape guard: the checkpoint/dirty-workspace policy fields were RETIRED
// (docs/design/2026-10-07-mesh-workspace-policy.md B4) — 0 policy checkpoints in 670
// completed tasks, and the one real risk is closed by the refine branch_worktree_dirty
// gate, not a knob. This pins that no reader, writer, default or prompt line brings
// them back. Comments may still NAME them (history); code may not. The one allowed
// mention is RETIRED_MESH_POLICY_KEYS itself (repo-mesh-policy-resolve.ts), which is
// why that file is not in the scan list.

const SRC = join(import.meta.dirname, '../../src')
const RETIRED = ['requirePreTaskCheckpoint', 'requirePostTaskCheckpoint', 'dirtyWorkspaceBehavior', 'checkpoint_then_continue']

const GUARDED_FILES = [
  'repo-mesh-policy.ts',
  'repo-mesh-types.ts',
  'mesh/coordinator-prompt.ts',
  'mesh/mesh-onboarding-plan.ts',
  'mesh/mesh-queue-assignment.ts',
  'mesh/mesh-queue-autolaunch.ts',
  'mesh/mesh-autolaunch-usable-provider.ts',
  'mesh/mesh-runtime-store-claim.ts',
  'mesh/mesh-candidacy-predicates.ts',
  'mesh/mesh-dirty-write-verdict.ts',
  'mesh/mesh-skip-notify.ts',
  'mesh/mesh-task-terminal.ts',
  'config/mesh-config.ts',
  'config/mesh-config-store.ts',
  'commands/med-family/mesh-crud.ts',
]

/** Drop // and /* *\/ comments so documentation may keep naming the retired keys. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('retired mesh policy keys stay retired', () => {
  it.each(GUARDED_FILES)('%s has no code reference to a retired key', (rel) => {
    const code = codeOnly(readFileSync(join(SRC, rel), 'utf8'))
    for (const key of RETIRED) expect(code, `${rel} references ${key}`).not.toContain(key)
  })

  it('the bundled coordinator rules carry no Checkpoint workflow step', () => {
    for (const key of RETIRED) expect(DEFAULT_COORDINATOR_RULES).not.toContain(key)
    expect(DEFAULT_COORDINATOR_RULES).not.toMatch(/\*\*Checkpoint\*\*/)
    expect(DEFAULT_COORDINATOR_RULES).not.toContain('Only when the Policy section asks for one')
  })

  it('the defaults and the resolver never emit them', () => {
    for (const key of RETIRED_MESH_POLICY_KEYS) {
      expect(DEFAULT_MESH_POLICY).not.toHaveProperty(key)
      expect(resolveMeshPolicy({ [key]: 'block' })).not.toHaveProperty(key)
    }
  })
})
