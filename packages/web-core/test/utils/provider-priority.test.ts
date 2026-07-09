import { describe, expect, it } from 'vitest'
import {
  addProviderPriorityItem,
  defaultProviderPriorityFromInventory,
  describeRepoMeshNodeProviderPriority,
  formatRepoMeshNodeProviderPriority,
  isAvailableCliProvider,
  moveProviderPriorityItem,
  normalizeAvailableCliProviders,
  normalizeProviderPriority,
  normalizeProviderPriorityForInventory,
  parseProviderPriorityInput,
  readRepoMeshNodePolicy,
  readRepoMeshNodeProviderPriority,
  removeProviderPriorityItem,
  modelOptionsForProvider,
  thinkingOptionsForProvider,
  buildProviderOptionMap,
} from '../../src/utils/provider-priority'

describe('provider-specific model / thinking option lookup', () => {
  const inv = [
    { type: 'codex-cli', modelOptions: ['gpt-5.5', ' gpt-5-codex '], thinkingLevelOptions: ['minimal', 'xhigh'] },
    { type: 'claude-cli', modelOptions: ['opus', 'sonnet', 'haiku'], thinkingLevelOptions: ['low', 'max'] },
    { type: 'antigravity-cli' }, // declares no lists
  ]

  it('modelOptionsForProvider returns each provider its own trimmed list', () => {
    expect(modelOptionsForProvider(inv, 'codex-cli')).toEqual(['gpt-5.5', 'gpt-5-codex'])
    expect(modelOptionsForProvider(inv, 'claude-cli')).toEqual(['opus', 'sonnet', 'haiku'])
    // codex has no haiku — the whole reason lists are provider-scoped.
    expect(modelOptionsForProvider(inv, 'codex-cli')).not.toContain('haiku')
  })

  it('returns [] for a provider that declares no list, and for unknown/empty types', () => {
    expect(modelOptionsForProvider(inv, 'antigravity-cli')).toEqual([])
    expect(modelOptionsForProvider(inv, 'gemini-cli')).toEqual([])
    expect(modelOptionsForProvider(inv, '')).toEqual([])
    expect(modelOptionsForProvider(undefined, 'codex-cli')).toEqual([])
  })

  it('thinkingOptionsForProvider preserves provider vocabulary verbatim', () => {
    expect(thinkingOptionsForProvider(inv, 'codex-cli')).toEqual(['minimal', 'xhigh'])
    expect(thinkingOptionsForProvider(inv, 'antigravity-cli')).toEqual([])
  })

  it('buildProviderOptionMap keys by type with cleaned lists', () => {
    const map = buildProviderOptionMap(inv)
    expect(map.get('codex-cli')).toEqual({ models: ['gpt-5.5', 'gpt-5-codex'], thinking: ['minimal', 'xhigh'] })
    expect(map.get('antigravity-cli')).toEqual({ models: [], thinking: [] })
    expect(map.has('gemini-cli')).toBe(false)
  })
})

describe('provider priority utilities', () => {
  it('filters inventory to detected CLI providers only', () => {
    const providers = normalizeAvailableCliProviders([
      { type: 'hermes-cli', category: 'cli', machineStatus: 'detected', displayName: 'Hermes', detectedPath: '/bin/hermes' },
      { type: 'codex-cli', category: 'cli', machineStatus: 'not_detected', displayName: 'Codex' },
      { type: 'cursor', category: 'ide', machineStatus: 'detected', displayName: 'Cursor' },
      { type: 'claude-cli', category: 'cli', enabled: false, installed: true, displayName: 'Claude' },
      { type: 'gemini-cli', category: 'cli', installed: true, displayName: 'Gemini' },
    ])

    expect(providers.map(provider => provider.type)).toEqual(['hermes-cli', 'gemini-cli'])
    expect(providers[0].statusLabel).toBe('Detected at /bin/hermes')
  })

  it('treats machineStatus as authoritative when present', () => {
    expect(isAvailableCliProvider({
      type: 'codex-cli',
      category: 'cli',
      machineStatus: 'enabled_unchecked',
      installed: true,
    })).toBe(false)
  })

  it('normalizes, deduplicates, and filters priority against inventory', () => {
    const inventory = normalizeAvailableCliProviders([
      { type: 'hermes-cli', category: 'cli', machineStatus: 'detected' },
      { type: 'codex-cli', category: 'cli', machineStatus: 'detected' },
    ])

    expect(normalizeProviderPriority(' hermes-cli, codex-cli hermes-cli unknown-cli ')).toEqual([
      'hermes-cli',
      'codex-cli',
      'unknown-cli',
    ])
    expect(normalizeProviderPriorityForInventory(['unknown-cli', 'codex-cli', 'hermes-cli', 'codex-cli'], inventory)).toEqual([
      'codex-cli',
      'hermes-cli',
    ])
    expect(defaultProviderPriorityFromInventory(inventory)).toEqual(['hermes-cli', 'codex-cli'])
  })

  it('adds, removes, and reorders priority items without duplicates', () => {
    expect(addProviderPriorityItem(['hermes-cli'], 'codex-cli')).toEqual(['hermes-cli', 'codex-cli'])
    expect(addProviderPriorityItem(['hermes-cli'], 'hermes-cli')).toEqual(['hermes-cli'])
    expect(removeProviderPriorityItem(['hermes-cli', 'codex-cli'], 'hermes-cli')).toEqual(['codex-cli'])
    expect(moveProviderPriorityItem(['hermes-cli', 'codex-cli', 'claude-cli'], 'claude-cli', 'up')).toEqual([
      'hermes-cli',
      'claude-cli',
      'codex-cli',
    ])
    expect(moveProviderPriorityItem(['hermes-cli', 'codex-cli'], 'hermes-cli', 'bottom')).toEqual(['codex-cli', 'hermes-cli'])
  })
})

describe('repo mesh node provider priority', () => {
  it('parses free-form input, canonicalizing known types and deduplicating', () => {
    expect(parseProviderPriorityInput('Hermes-CLI, CODEX-CLI hermes-cli, my-custom-agent'))
      .toEqual(['hermes-cli', 'codex-cli', 'my-custom-agent'])
    expect(parseProviderPriorityInput('   ')).toEqual([])
  })

  it('reads node policy from node_policy/policy_json/policy fields', () => {
    expect(readRepoMeshNodePolicy({ node_policy: '{"a":1}' })).toEqual({ a: 1 })
    expect(readRepoMeshNodePolicy({ policy: { b: 2 } })).toEqual({ b: 2 })
    expect(readRepoMeshNodePolicy(null)).toEqual({})
  })

  it('reads provider priority from node fields or policy, trimming and deduplicating', () => {
    expect(readRepoMeshNodeProviderPriority({ providerPriority: [' hermes-cli ', 'codex-cli', 'hermes-cli'] }))
      .toEqual(['hermes-cli', 'codex-cli'])
    expect(readRepoMeshNodeProviderPriority({ provider_priority: ['gemini-cli'] })).toEqual(['gemini-cli'])
    expect(readRepoMeshNodeProviderPriority({ policy: { providerPriority: ['claude-cli'] } })).toEqual(['claude-cli'])
    expect(readRepoMeshNodeProviderPriority({ providerPriority: 'not-an-array' })).toEqual([])
  })

  it('formats and describes node provider priority', () => {
    expect(formatRepoMeshNodeProviderPriority({ providerPriority: ['hermes-cli', 'codex-cli'] }))
      .toBe('hermes-cli → codex-cli')
    expect(describeRepoMeshNodeProviderPriority({ providerPriority: ['hermes-cli'] })).toEqual({
      configured: true,
      label: 'hermes-cli',
      launchReady: true,
    })
    expect(describeRepoMeshNodeProviderPriority({})).toEqual({
      configured: false,
      label: 'not configured',
      launchReady: false,
      launchBlockedMessage: 'launch not ready unless an explicit provider is selected',
    })
  })
})
