import { describe, expect, it } from 'vitest'
import { getForcedNewSessionScriptName, waitForCliAdapterReady } from '../../src/providers/cli-provider-instance.js'

describe('getForcedNewSessionScriptName', () => {
  it('uses a provider new-session action when launch mode is new and no explicit new-session args exist', () => {
    const provider = {
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBe('newSession')
  })

  it('skips forced new-session scripts when provider already supports explicit new-session args', () => {
    const provider = {
      resume: {
        supported: true,
        newSessionArgs: ['--session-id', '{{id}}'],
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBeNull()
  })

  it('never forces a new-session script for resume launches', () => {
    const provider = {
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'resume')).toBeNull()
  })

  it('skips confirm-gated manual new-session actions for launch-time forcing', () => {
    const provider = {
      type: 'hermes-cli',
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
          confirmTitle: 'Start a new Hermes session?',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBeNull()
  })
})

describe('waitForCliAdapterReady', () => {
  it('waits until the adapter reports ready', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 20)

    await expect(waitForCliAdapterReady({
      isReady: () => ready,
      getStatus: () => ({ status: ready ? 'idle' : 'starting' }),
    }, {
      timeoutMs: 300,
      pollMs: 5,
    })).resolves.toBeUndefined()
  })

  it('fails early when the adapter stops before becoming ready', async () => {
    await expect(waitForCliAdapterReady({
      isReady: () => false,
      getStatus: () => ({ status: 'stopped' }),
    }, {
      timeoutMs: 300,
      pollMs: 5,
    })).rejects.toThrow(/stopped before it became ready/i)
  })
})
