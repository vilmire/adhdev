import { describe, expect, it } from 'vitest'
import { readProviderPriorityFromPolicy } from '../../src/mesh/mesh-node-identity'
import { resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots'

// PROVIDER-PRIORITY-FROM-SLOTS: slots are authoritative when present, while the
// legacy providerPriority remains the fallback for slotless configurations.
describe('readProviderPriorityFromPolicy slots precedence', () => {
  it('derives the priority from slots when providerPriority is absent', () => {
    expect(readProviderPriorityFromPolicy({
      slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }, { provider: 'claude-cli' }],
    })).toEqual(['claude-cli', 'codex-cli'])
  })

  it('slots win over a stale explicit providerPriority', () => {
    expect(readProviderPriorityFromPolicy({
      providerPriority: ['codex-cli'],
      slots: [{ provider: 'claude-cli' }],
    })).toEqual(['claude-cli'])
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

  it('keeps providerPriority as the legacy fallback when slots are absent', () => {
    expect(readProviderPriorityFromPolicy({
      providerPriority: ['codex-cli', 'claude-cli'],
    })).toEqual(['codex-cli', 'claude-cli'])
  })

  it('keeps a slotless legacy node routable through derived capability slots', () => {
    const slots = resolveNodeCapabilitySlots({
      id: 'node-legacy',
      policy: { providerPriority: ['codex-cli', 'claude-cli'] },
    })
    expect(slots.map(slot => slot.provider)).toEqual(['codex-cli', 'claude-cli'])
  })
})
