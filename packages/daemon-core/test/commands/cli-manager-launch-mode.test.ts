import { describe, expect, it } from 'vitest'
import { resolveCliSessionBinding } from '../../src/commands/cli-manager.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

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

  const codexLikeProvider = {
    name: 'Codex CLI',
    displayName: 'Codex CLI',
    resume: {
      supported: true,
      stopStrategy: 'command',
      stopCommand: 'exit',
      shutdownGraceMs: 1000,
      sessionIdFormat: 'string',
      resumeSessionArgs: ['--resume', '{{id}}'],
      sessionIdFromSubcommand: ['resume', 'fork'],
    },
  } as ProviderModule

  const gooseLikeProvider = {
    name: 'Goose CLI',
    displayName: 'Goose CLI',
    resume: {
      supported: true,
      stopStrategy: 'command',
      stopCommand: 'exit',
      shutdownGraceMs: 1000,
      sessionIdFormat: 'string',
      sessionIdIsNewByDefault: true,
    },
  } as ProviderModule

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

  it('reads provider session ids from declared resume subcommands', () => {
    const binding = resolveCliSessionBinding(codexLikeProvider, 'codex-cli', ['resume', 'sess_456'], undefined)

    expect(binding.launchMode).toBe('resume')
    expect(binding.providerSessionId).toBe('sess_456')
    expect(binding.cliArgs).toEqual(['resume', 'sess_456'])
  })

  it('treats --session-id as manual when the provider declares it as a new-session flag by default', () => {
    const binding = resolveCliSessionBinding(gooseLikeProvider, 'goose-cli', ['--session-id', 'sess_newish'], undefined)

    expect(binding.launchMode).toBe('manual')
    expect(binding.providerSessionId).toBeUndefined()
    expect(binding.cliArgs).toEqual(['--session-id', 'sess_newish'])
  })
})
