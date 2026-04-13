import { describe, expect, it } from 'vitest'
import { validateProviderDefinition } from '../../src/providers/provider-schema.js'

describe('validateProviderDefinition', () => {
  it('accepts a valid CLI provider with typed controls', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      controls: [
        {
          id: 'model',
          type: 'select',
          label: 'Model',
          placement: 'bar',
          dynamic: true,
          listScript: 'listModels',
          setScript: 'setModel',
          readFrom: 'model',
        },
        {
          id: 'new_session',
          type: 'action',
          label: 'New Session',
          placement: 'menu',
          invokeScript: 'newSession',
        },
      ],
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('rejects dynamic controls without a list script', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      controls: [
        {
          id: 'model',
          type: 'select',
          label: 'Model',
          placement: 'bar',
          dynamic: true,
          setScript: 'setModel',
        },
      ],
    })

    expect(result.errors).toContain("controls.model: dynamic controls require listScript")
  })

  it('rejects action controls without invokeScript', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      controls: [
        {
          id: 'clear_context',
          type: 'action',
          label: 'Clear Context',
          placement: 'menu',
        },
      ],
    })

    expect(result.errors).toContain("controls.clear_context: action controls require invokeScript")
  })

  it('rejects value controls without setScript', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      controls: [
        {
          id: 'auto_approve',
          type: 'toggle',
          label: 'Auto Approve',
          placement: 'bar',
        },
      ],
    })

    expect(result.errors).toContain("controls.auto_approve: toggle controls require setScript")
  })

  it('accepts provider-repo runtime and inventory metadata fields', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      providerVersion: '1.0.0',
      sendDelayMs: 500,
      sendKey: '\\r',
      submitStrategy: 'immediate',
      disableUpstream: true,
      status: 'Stable',
      details: 'Inventory metadata',
      contractVersion: 2,
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })
})
