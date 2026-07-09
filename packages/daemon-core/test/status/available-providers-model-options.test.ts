import { describe, expect, it } from 'vitest'
import { buildAvailableProviders } from '../../src/status/snapshot.js'

/**
 * Regression: a provider's advisory modelOptions / thinkingLevelOptions must
 * survive the status-snapshot projection. The web dashboard reads this list off
 * `daemon.availableProviders` to drive the New-session dialog AND the mesh node
 * slot editor's provider-specific Model / Thinking dropdowns. If the projection
 * drops these fields, every provider (codex included) falls back to a free-text
 * Model field — the exact bug this guards against.
 */
describe('buildAvailableProviders — model/thinking option passthrough', () => {
  const loader = {
    getAvailableProviderInfos: () => [
      {
        type: 'codex-cli',
        category: 'cli' as const,
        machineStatus: 'detected' as const,
        modelOptions: ['gpt-5.5', 'gpt-5.4', 'gpt-5-codex'],
        thinkingLevelOptions: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      },
      {
        type: 'claude-cli',
        category: 'cli' as const,
        machineStatus: 'detected' as const,
        modelOptions: ['fable', 'opus', 'sonnet', 'haiku'],
        thinkingLevelOptions: ['low', 'medium', 'high', 'max'],
      },
      {
        // A provider with no advisory lists must simply omit the fields.
        type: 'gemini-cli',
        category: 'cli' as const,
        machineStatus: 'detected' as const,
      },
    ],
    getAll: () => [],
  }

  it('carries each provider its own modelOptions verbatim', () => {
    const out = buildAvailableProviders(loader as any)
    const codex = out.find(p => p.type === 'codex-cli')!
    const claude = out.find(p => p.type === 'claude-cli')!
    expect(codex.modelOptions).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5-codex'])
    expect(codex.thinkingLevelOptions).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    // codex has no haiku — the whole point of provider-specific lists.
    expect(claude.modelOptions).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(claude.modelOptions).not.toContain('gpt-5.5')
  })

  it('omits the fields for a provider that declares none', () => {
    const out = buildAvailableProviders(loader as any)
    const gemini = out.find(p => p.type === 'gemini-cli')!
    expect(gemini.modelOptions).toBeUndefined()
    expect(gemini.thinkingLevelOptions).toBeUndefined()
  })
})
