import { describe, expect, it } from 'vitest'

import { normalizeMeshCommandConfig, validateMeshRefineConfig } from '../../src/mesh/refine-config'

// DOCS-ROOT: a validation command may declare change-impact `scopes`
// ('none' | 'web' | 'daemon') so a docs-only branch runs only the docs profile.
describe('refine-config change-impact scopes (DOCS-ROOT)', () => {
  it('normalizes a valid scopes array onto the command plan', () => {
    const { command, rejected } = normalizeMeshCommandConfig(
      { command: 'npm', args: ['run', 'docs:verify'], category: 'custom', scopes: ['none'] },
      'test',
    )
    expect(rejected).toBeUndefined()
    expect(command?.scopes).toEqual(['none'])
  })

  it('de-dupes scopes and drops an empty array (empty === no restriction)', () => {
    const dupe = normalizeMeshCommandConfig(
      { command: 'npm', args: ['run', 'typecheck'], scopes: ['web', 'daemon', 'web'] },
      'test',
    )
    expect(dupe.command?.scopes).toEqual(['web', 'daemon'])

    const empty = normalizeMeshCommandConfig(
      { command: 'npm', args: ['run', 'typecheck'], scopes: [] },
      'test',
    )
    // Empty scopes → runs everywhere → the field is omitted, not an empty array.
    expect(empty.command?.scopes).toBeUndefined()
  })

  it('rejects an unknown scope value', () => {
    const { command, rejected } = normalizeMeshCommandConfig(
      { command: 'npm', args: ['run', 'typecheck'], scopes: ['everywhere'] as any },
      'test',
    )
    expect(command).toBeUndefined()
    expect(rejected?.reason).toContain('scopes must be an array')
  })

  it('omits scopes when not provided (backward-compatible)', () => {
    const { command } = normalizeMeshCommandConfig(
      { command: 'npm', args: ['run', 'typecheck'] },
      'test',
    )
    expect(command?.scopes).toBeUndefined()
  })

  it('accepts a full refine config carrying scoped commands', () => {
    const result = validateMeshRefineConfig({
      version: 1,
      validation: {
        required: true,
        commands: [
          { command: 'npm run typecheck', category: 'typecheck', scopes: ['web', 'daemon'] },
          { command: 'npm run docs:verify', category: 'custom', scopes: ['none'] },
        ],
      },
    }, 'inline')
    expect(result.valid).toBe(true)
    expect(result.commands.map(c => c.scopes)).toEqual([['web', 'daemon'], ['none']])
  })

  it('rejects a config whose command carries an invalid scope', () => {
    const result = validateMeshRefineConfig({
      version: 1,
      validation: {
        required: true,
        commands: [
          { command: 'npm run typecheck', category: 'typecheck', scopes: ['nope'] },
        ],
      },
    }, 'inline')
    expect(result.valid).toBe(false)
  })
})
