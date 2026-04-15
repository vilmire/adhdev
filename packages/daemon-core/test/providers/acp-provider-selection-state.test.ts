import { describe, expect, it, vi } from 'vitest'
import { AcpProviderInstance } from '../../src/providers/acp-provider-instance.js'

describe('AcpProviderInstance selection state', () => {
  it('surfaces mode selection from config options in control values and summary metadata', () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    instance.parseConfigOptions([
      {
        category: 'model',
        configId: 'model',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Claude Sonnet 4' }],
      },
      {
        category: 'mode',
        configId: 'mode',
        currentValue: 'plan',
        options: [{ value: 'plan', name: 'Plan Mode' }],
      },
    ])

    expect(instance.getState()).toMatchObject({
      controlValues: {
        model: 'sonnet',
        mode: 'plan',
      },
      summaryMetadata: {
        items: [
          { id: 'model', label: 'Model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
          { id: 'mode', label: 'Mode', value: 'Plan Mode', shortValue: 'plan', order: 20 },
        ],
      },
    })
  })

  it('keeps mode selection in sync when mode is changed through set_config_option responses', async () => {
    const instance = new AcpProviderInstance({
      type: 'acp-test',
      name: 'ACP Test',
      category: 'acp',
    } as any, '/tmp/project') as any

    instance.sessionId = 'session-123'
    instance.connection = {
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            category: 'mode',
            configId: 'mode',
            currentValue: 'chat',
            options: [{ value: 'chat', name: 'Chat Mode' }],
          },
        ],
      }),
    }

    instance.parseConfigOptions([
      {
        category: 'mode',
        configId: 'mode',
        currentValue: 'plan',
        options: [{ value: 'plan', name: 'Plan Mode' }],
      },
    ])

    await instance.setConfigOption('mode', 'chat')

    expect(instance.connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-123',
      configId: 'mode',
      value: 'chat',
    })
    expect(instance.getState()).toMatchObject({
      controlValues: {
        mode: 'chat',
      },
      summaryMetadata: {
        items: [
          { id: 'mode', label: 'Mode', value: 'Chat Mode', shortValue: 'chat', order: 20 },
        ],
      },
    })
  })
})
