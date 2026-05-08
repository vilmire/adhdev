import { describe, expect, it } from 'vitest'
import {
  addProviderPriorityItem,
  defaultProviderPriorityFromInventory,
  isAvailableCliProvider,
  moveProviderPriorityItem,
  normalizeAvailableCliProviders,
  normalizeProviderPriority,
  normalizeProviderPriorityForInventory,
  removeProviderPriorityItem,
} from '../../src/utils/provider-priority'

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
