import { describe, expect, it, vi } from 'vitest'
import { handleProviderScript } from '../../src/commands/stream-commands.js'

describe('handleProviderScript legacy control result bridging', () => {
  function createIdeHelpers(params: {
    scriptName: string
    result: Record<string, unknown>
  }) {
    const provider = {
      type: 'antigravity',
      category: 'ide',
      scripts: {
        [params.scriptName]: () => '(() => "ok")()',
      },
    }

    const evaluate = vi.fn(async () => JSON.stringify(params.result))
    const helpers: any = {
      currentSession: {
        providerType: 'antigravity',
        cdpManagerKey: 'antigravity',
      },
      currentProviderType: 'antigravity',
      currentManagerKey: 'antigravity',
      currentIdeType: 'antigravity',
      ctx: {
        providerLoader: {
          resolve: vi.fn(() => provider),
        },
      },
      getCdp: vi.fn(() => ({
        isConnected: true,
        evaluate,
      })),
      getProvider: vi.fn(),
      getProviderScript: vi.fn(),
      evaluateProviderScript: vi.fn(),
      getCliAdapter: vi.fn(() => null),
      historyWriter: {},
    }

    return { helpers, evaluate }
  }

  it('normalizes legacy listModels payloads into typed controlResult options', async () => {
    const { helpers } = createIdeHelpers({
      scriptName: 'listModels',
      result: {
        models: [
          { name: 'GPT-5.4', selected: true },
          { name: 'GPT-5.2-Codex', selected: false },
        ],
        current: 'GPT-5.4',
      },
    })

    const result = await handleProviderScript(helpers, { providerType: 'antigravity', scriptName: 'listModels' })

    expect(result).toMatchObject({
      success: true,
      controlResult: {
        options: [
          { value: 'GPT-5.4', label: 'GPT-5.4' },
          { value: 'GPT-5.2-Codex', label: 'GPT-5.2-Codex' },
        ],
        currentValue: 'GPT-5.4',
      },
    })
  })

  it('normalizes legacy setMode payloads into typed controlResult mutations', async () => {
    const { helpers } = createIdeHelpers({
      scriptName: 'setMode',
      result: {
        success: true,
        mode: 'Medium',
        changed: true,
      },
    })

    const result = await handleProviderScript(helpers, {
      providerType: 'antigravity',
      scriptName: 'setMode',
      value: 'Medium',
    })

    expect(result).toMatchObject({
      success: true,
      controlResult: {
        ok: true,
        currentValue: 'Medium',
      },
    })
  })
})
