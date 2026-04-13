import { describe, expect, it } from 'vitest'
import { resolveCliSessionBinding } from '../../src/commands/cli-manager.js'

describe('resolveCliSessionBinding', () => {
  const hermesLikeProvider = {
    name: 'Hermes Agent',
    displayName: 'Hermes Agent',
    resume: {
      supported: true,
      stopStrategy: 'command',
      stopCommand: '/quit',
      shutdownGraceMs: 4000,
      sessionIdFormat: 'string',
      resumeSessionArgs: ['--resume', '{{id}}'],
      resumeArgs: ['--continue'],
    },
  } as any

  it('treats plain launches as new sessions when resume is not explicitly requested', () => {
    const binding = resolveCliSessionBinding(hermesLikeProvider, 'hermes-cli', undefined, undefined)

    expect(binding.launchMode).toBe('new')
    expect(binding.providerSessionId).toBeUndefined()
    expect(binding.cliArgs).toBeUndefined()
  })

  it('keeps explicit resume requests as resume launches', () => {
    const binding = resolveCliSessionBinding(hermesLikeProvider, 'hermes-cli', undefined, 'sess_123')

    expect(binding.launchMode).toBe('resume')
    expect(binding.providerSessionId).toBe('sess_123')
    expect(binding.cliArgs).toEqual(['--resume', 'sess_123'])
  })
})
