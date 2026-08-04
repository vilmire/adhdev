import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it("this repo's own .adhdev/refine.json validates cleanly (currently 16 commands)", () => {
    const repoRoot = join(__dirname, '../../../../..')
    const raw = readFileSync(join(repoRoot, '.adhdev/refine.json'), 'utf-8')
    const config = JSON.parse(raw)
    const result = validateMeshRefineConfig(config, '.adhdev/refine.json')
    expect(result.valid).toBe(true)
    expect(result.rejectedCommands).toHaveLength(0)
    expect(result.commands.length).toBeGreaterThan(8)
  })
})
