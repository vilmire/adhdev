import { describe, expect, it } from 'vitest'
import {
  addProviderPriorityItem,
  defaultProviderPriorityFromInventory,
  DEFAULT_REPO_MESH_PROVIDER_PRIORITY,
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
      { type: 'kimi', category: 'cli', machineStatus: 'detected', displayName: 'Kimi', detectedPath: '/bin/kimi' },
      { type: 'codex-cli', category: 'cli', machineStatus: 'not_detected', displayName: 'Codex' },
      { type: 'cursor', category: 'ide', machineStatus: 'detected', displayName: 'Cursor' },
      { type: 'claude-cli', category: 'cli', enabled: false, installed: true, displayName: 'Claude' },
      { type: 'gemini-cli', category: 'cli', installed: true, displayName: 'Gemini' },
    ])

    expect(providers.map(provider => provider.type)).toEqual(['kimi', 'gemini-cli'])
    expect(providers[0].statusLabel).toBe('Detected at /bin/kimi')
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
      { type: 'kimi', category: 'cli', machineStatus: 'detected' },
      { type: 'codex-cli', category: 'cli', machineStatus: 'detected' },
    ])

    expect(normalizeProviderPriority(' kimi, codex-cli kimi unknown-cli ')).toEqual([
      'kimi',
      'codex-cli',
      'unknown-cli',
    ])
    expect(normalizeProviderPriorityForInventory(['unknown-cli', 'codex-cli', 'kimi', 'codex-cli'], inventory)).toEqual([
      'codex-cli',
      'kimi',
    ])
    expect(defaultProviderPriorityFromInventory(inventory)).toEqual(['kimi', 'codex-cli'])
  })

  it('adds, removes, and reorders priority items without duplicates', () => {
    expect(addProviderPriorityItem(['kimi'], 'codex-cli')).toEqual(['kimi', 'codex-cli'])
    expect(addProviderPriorityItem(['kimi'], 'kimi')).toEqual(['kimi'])
    expect(removeProviderPriorityItem(['kimi', 'codex-cli'], 'kimi')).toEqual(['codex-cli'])
    expect(moveProviderPriorityItem(['kimi', 'codex-cli', 'claude-cli'], 'claude-cli', 'up')).toEqual([
      'kimi',
      'claude-cli',
      'codex-cli',
    ])
    expect(moveProviderPriorityItem(['kimi', 'codex-cli'], 'kimi', 'bottom')).toEqual(['codex-cli', 'kimi'])
  })

  it('does not default new users onto the retired Gemini vendor (2026-07-24 retirement)', () => {
    expect(DEFAULT_REPO_MESH_PROVIDER_PRIORITY.toLowerCase()).not.toContain('gemini')
    expect(parseProviderPriorityInput(DEFAULT_REPO_MESH_PROVIDER_PRIORITY)).not.toContain('gemini-cli')
  })
})

describe('repo mesh node provider priority', () => {
  it('parses free-form input, canonicalizing known types and deduplicating', () => {
    expect(parseProviderPriorityInput('Claude-CLI, CODEX-CLI claude-cli, my-custom-agent'))
      .toEqual(['claude-cli', 'codex-cli', 'my-custom-agent'])
    expect(parseProviderPriorityInput('   ')).toEqual([])
  })

  it('reads node policy from node_policy/policy_json/policy fields', () => {
    expect(readRepoMeshNodePolicy({ node_policy: '{"a":1}' })).toEqual({ a: 1 })
    expect(readRepoMeshNodePolicy({ policy: { b: 2 } })).toEqual({ b: 2 })
    expect(readRepoMeshNodePolicy(null)).toEqual({})
  })

  it('reads provider priority from node fields or policy, trimming and deduplicating', () => {
    expect(readRepoMeshNodeProviderPriority({ providerPriority: [' kimi ', 'codex-cli', 'kimi'] }))
      .toEqual(['kimi', 'codex-cli'])
    expect(readRepoMeshNodeProviderPriority({ provider_priority: ['gemini-cli'] })).toEqual(['gemini-cli'])
    expect(readRepoMeshNodeProviderPriority({ policy: { providerPriority: ['claude-cli'] } })).toEqual(['claude-cli'])
    expect(readRepoMeshNodeProviderPriority({ providerPriority: 'not-an-array' })).toEqual([])
  })

  it('formats and describes node provider priority', () => {
    expect(formatRepoMeshNodeProviderPriority({ providerPriority: ['kimi', 'codex-cli'] }))
      .toBe('kimi → codex-cli')
    expect(describeRepoMeshNodeProviderPriority({ providerPriority: ['kimi'] })).toEqual({
      configured: true,
      label: 'kimi',
      launchReady: true,
    })
    expect(describeRepoMeshNodeProviderPriority({})).toEqual({
      configured: false,
      label: 'not configured',
      launchReady: false,
      launchBlockedMessage: 'launch not ready unless an explicit provider is selected',
    })
  })

  it('falls back to the slots-derived order when no explicit providerPriority is set', () => {
    // Slot order = preference: a slots-only node reads as configured/launch-ready.
    expect(readRepoMeshNodeProviderPriority({ policy: { slots: [{ provider: 'codex-cli' }, { provider: 'claude-cli' }] } }))
      .toEqual(['codex-cli', 'claude-cli'])
    expect(describeRepoMeshNodeProviderPriority({ policy: { slots: [{ provider: 'claude-cli' }] } })).toEqual({
      configured: true,
      label: 'claude-cli',
      launchReady: true,
    })
    // An explicit providerPriority always wins over the slots-derived order.
    expect(readRepoMeshNodeProviderPriority({
      providerPriority: ['kimi'],
      policy: { slots: [{ provider: 'claude-cli' }] },
    })).toEqual(['kimi'])
    // Slots alone never fabricate a priority when they carry no usable provider.
    expect(readRepoMeshNodeProviderPriority({ policy: { slots: [] } })).toEqual([])
  })
})
