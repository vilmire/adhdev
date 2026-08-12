import { describe, expect, it } from 'vitest'
import { readProviderPriorityFromPolicy } from '../../src/mesh/mesh-node-identity'

// PROVIDER-PRIORITY-FROM-SLOTS read fallback: a node that declares capability
// slots but no explicit providerPriority still has a determined preference order
// (slot order = preference — ORCHESTRATION_NODE_SLOTS.md). Readers of the legacy
// providerPriority field must derive it from the slots instead of reporting the
// node as launch-blocked (missing_provider_priority).
describe('readProviderPriorityFromPolicy slots fallback', () => {
  it('derives the priority from slots when providerPriority is absent', () => {
    expect(readProviderPriorityFromPolicy({
      slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }, { provider: 'claude-cli' }],
    })).toEqual(['claude-cli', 'codex-cli'])
  })

  it('an explicit providerPriority always wins over the slots-derived order', () => {
    expect(readProviderPriorityFromPolicy({
      providerPriority: ['codex-cli'],
      slots: [{ provider: 'claude-cli' }],
    })).toEqual(['codex-cli'])
  })

  it('an explicit empty providerPriority array falls back to slots', () => {
    // Writes never persist [] (empty means "delete"), but a hand-edited file that
    // carries one must not read as launch-blocked while slots declare providers.
    expect(readProviderPriorityFromPolicy({
      providerPriority: [],
      slots: [{ provider: 'hermes-cli' }],
    })).toEqual(['hermes-cli'])
  })

  it('returns [] when there is nothing to derive from', () => {
    expect(readProviderPriorityFromPolicy(undefined)).toEqual([])
    expect(readProviderPriorityFromPolicy({})).toEqual([])
    expect(readProviderPriorityFromPolicy({ slots: 'nope' })).toEqual([])
    expect(readProviderPriorityFromPolicy({ providerPriority: [' claude-cli ', 'claude-cli', ''] }))
      .toEqual(['claude-cli'])
  })
})
