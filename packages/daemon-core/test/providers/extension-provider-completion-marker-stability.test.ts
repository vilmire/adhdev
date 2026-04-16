import { describe, expect, it } from 'vitest'
import { ExtensionProviderInstance } from '../../src/providers/extension-provider-instance.js'
import { getSessionCompletionMarker } from '../../src/status/snapshot.js'

function createInstance() {
  return new ExtensionProviderInstance({
    type: 'claude-code-vscode',
    name: 'Claude Code',
    category: 'extension',
  } as any)
}

describe('ExtensionProviderInstance completion marker stability', () => {
  it('keeps the completion marker stable across stream resets for the same transcript', () => {
    const instance = createInstance()
    const payload = {
      status: 'idle',
      title: 'Claude Code',
      messages: [
        { role: 'assistant', content: 'done' },
      ],
    }

    instance.onEvent('stream_update', payload)
    const firstMarker = getSessionCompletionMarker(instance.getState() as any)

    instance.onEvent('stream_reset')
    instance.onEvent('stream_update', payload)
    const secondMarker = getSessionCompletionMarker(instance.getState() as any)

    expect(firstMarker).toBeTruthy()
    expect(secondMarker).toBe(firstMarker)
  })

  it('changes the completion marker when the same assistant text appears again later in the transcript', () => {
    const instance = createInstance()

    instance.onEvent('stream_update', {
      status: 'idle',
      title: 'Claude Code',
      messages: [
        { role: 'assistant', content: 'done' },
      ],
    })
    const firstMarker = getSessionCompletionMarker(instance.getState() as any)

    instance.onEvent('stream_update', {
      status: 'idle',
      title: 'Claude Code',
      messages: [
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'again' },
        { role: 'assistant', content: 'done' },
      ],
    })
    const secondMarker = getSessionCompletionMarker(instance.getState() as any)

    expect(secondMarker).toBeTruthy()
    expect(secondMarker).not.toBe(firstMarker)
  })
})
