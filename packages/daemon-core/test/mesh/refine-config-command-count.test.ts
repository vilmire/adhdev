import { describe, expect, it } from 'vitest'

import { MESH_REFINE_CONFIG_SCHEMA, validateMeshRefineConfig } from '../../src/mesh/refine-config'

// GATE-COVERAGE-BLIND-SPOTS: MESH_REFINE_CONFIG_SCHEMA is documentation only
// (returned by get_mesh_refine_config_schema); validateMeshRefineConfig is the
// real gate and does not enforce array-length bounds. The schema previously
// declared commands.maxItems: 8 / bootstrapCommands.maxItems: 4 which were never
// checked anywhere — a lie a reader could trust and be burned by. Guard both
// halves of that gap so it can't silently come back.
describe('refine-config command count (declared vs enforced)', () => {
  it('does not declare a maxItems bound on validation.commands', () => {
    const commandsSchema = (MESH_REFINE_CONFIG_SCHEMA.properties.validation.properties as any).commands
    expect(commandsSchema.maxItems).toBeUndefined()
    expect(commandsSchema.minItems).toBeUndefined()
  })

  it('does not declare a maxItems bound on validation.bootstrapCommands', () => {
    const bootstrapSchema = (MESH_REFINE_CONFIG_SCHEMA.properties.validation.properties as any).bootstrapCommands
    expect(bootstrapSchema.maxItems).toBeUndefined()
  })

  it('validateMeshRefineConfig accepts more than the old maxItems: 8 bound', () => {
    const config = {
      version: 1,
      validation: {
        commands: Array.from({ length: 16 }, (_, i) => ({ command: 'node', args: [`script-${i}.js`] })),
      },
    }
    const result = validateMeshRefineConfig(config, 'test')
    expect(result.valid).toBe(true)
    expect(result.commands).toHaveLength(16)
    expect(result.rejectedCommands).toHaveLength(0)
  })

  // A realistic .adhdev/refine.json shape — mixed categories, a cwd-scoped entry
  // and a bootstrapCommands block, at the 16-command size that motivated dropping
  // the old maxItems: 8 bound.
  //
  // This deliberately does NOT read the root repo's real .adhdev/refine.json. That
  // version reached ACROSS the submodule boundary (join(__dirname,'../../../../..'))
  // and so could not load in the OSS-only CI checkout, which took the v1.0.32
  // release red. Refinery never caught it because Refinery runs from the root
  // worktree where the path resolves. The root config is now covered by a test in
  // the root repo that owns it (packages/daemon-cloud/test/refine-config-repo.test.ts).
  it('accepts a realistic 16-command config with bootstrapCommands', () => {
    const config = {
      version: 1,
      validation: {
        required: true,
        bootstrapCommands: [
          { command: 'node', args: ['scripts/refine-bootstrap.mjs'], category: 'custom', timeoutMs: 600000 },
        ],
        commands: [
          { command: 'node', args: ['scripts/check-submodule-sync.mjs'], category: 'custom', timeoutMs: 60000 },
          { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck', timeoutMs: 600000 },
          ...Array.from({ length: 12 }, (_, i) => ({
            command: 'npm',
            args: ['run', `test:pkg-${i}`],
            category: 'test',
            timeoutMs: 300000,
          })),
          { command: 'node', args: ['scripts/check-vendor-drift.mjs'], category: 'build', cwd: 'oss', timeoutMs: 300000 },
          { command: 'node', args: ['scripts/check-provider-channel-drift.mjs'], category: 'build', timeoutMs: 300000 },
        ],
      },
    }
    const result = validateMeshRefineConfig(config, '.adhdev/refine.json')
    expect(result.valid).toBe(true)
    expect(result.rejectedCommands).toHaveLength(0)
    expect(result.commands).toHaveLength(16)
    expect(result.commands.length).toBeGreaterThan(8)
    expect(result.bootstrapCommands).toHaveLength(1)
  })
})
