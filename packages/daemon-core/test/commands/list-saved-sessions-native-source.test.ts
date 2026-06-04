import * as fs from 'fs'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockHomeDir = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => mockHomeDir,
  }
})

function writeCodexSession(workspace: string, historySessionId: string): string {
  const dir = path.join(mockHomeDir, '.codex', 'sessions', '2026', '04', '29')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `rollout-2026-04-29T00-27-22-${historySessionId}.jsonl`)
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-04-29T03:00:00.000Z',
      payload: { id: historySessionId, cwd: workspace, timestamp: '2026-04-29T03:00:00.000Z' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-29T03:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native codex list user' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-29T03:00:02.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native codex list assistant' }] },
    }),
  ].join('\n') + '\n', 'utf-8')
  return filePath
}

describe('list_saved_sessions native-source command surface', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-list-native-source-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('surfaces provider-native source metadata per saved session', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    const sourcePath = writeCodexSession(workspace, historySessionId)

    const { DaemonCommandRouter } = await import('../../src/commands/router.js')
    const router = new DaemonCommandRouter({
      commandHandler: { handle: vi.fn(async () => ({ success: false, error: 'unexpected delegation' })) } as any,
      cliManager: { handleCliCommand: vi.fn(async () => ({ success: false, error: 'unexpected cli delegation' })) } as any,
      cdpManagers: new Map(),
      providerLoader: {
        getMeta: () => ({
          type: 'codex-cli',
          name: 'Codex CLI',
          category: 'cli',
          nativeHistory: {
            format: 'codex-provider-native',
            watchPath: '~/.codex/sessions/**/*.jsonl',
            mode: 'native-source',
            scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
          },
          scripts: {
            listNativeHistory: () => ({
              sessions: [{
                historySessionId,
                messageCount: 3,
                firstMessageAt: Date.parse('2026-04-29T03:00:00.000Z'),
                lastMessageAt: Date.parse('2026-04-29T03:00:02.000Z'),
                sessionTitle: 'native codex list assistant',
                preview: 'native codex list assistant',
                workspace,
                sourcePath,
                sourceMtimeMs: 1_800_000_000_000,
              }],
            }),
          },
          resume: { supported: true, resumeSessionArgs: ['resume', '{{id}}'] },
        }),
      } as any,
      instanceManager: {} as any,
      detectedIdes: { value: [] },
      sessionRegistry: {} as any,
    })

    const result = await router.execute('list_saved_sessions', { providerType: 'codex-cli' }, 'standalone')

    expect(result).toMatchObject({
      success: true,
      source: 'provider-native',
      sessions: [expect.objectContaining({
        id: historySessionId,
        providerSessionId: historySessionId,
        providerType: 'codex-cli',
        title: 'native codex list assistant',
        workspace,
        preview: 'native codex list assistant',
        messageCount: 3,
        canResume: true,
        historySource: 'provider-native',
        sourcePath,
      })],
    })
    const session = (result.sessions as any[])[0]
    expect(session.sourceMtimeMs).toBeGreaterThan(0)
  })

  it('loads resolved provider scripts before listing native-source sessions', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    const sourcePath = writeCodexSession(workspace, historySessionId)
    const nativeHistoryScript = vi.fn(() => ({
      sessions: [{
        historySessionId,
        messageCount: 3,
        firstMessageAt: Date.parse('2026-04-29T03:00:00.000Z'),
        lastMessageAt: Date.parse('2026-04-29T03:00:02.000Z'),
        sessionTitle: 'native codex list assistant',
        preview: 'native codex list assistant',
        workspace,
        sourcePath,
        sourceMtimeMs: 1_800_000_000_000,
      }],
    }))
    const rawMeta = {
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      nativeHistory: {
        format: 'codex-provider-native',
        watchPath: '~/.codex/sessions/**/*.jsonl',
        mode: 'native-source',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      resume: { supported: true, resumeSessionArgs: ['resume', '{{id}}'] },
    }
    const resolve = vi.fn(() => ({
      ...rawMeta,
      scripts: { listNativeHistory: nativeHistoryScript },
    }))

    const { DaemonCommandRouter } = await import('../../src/commands/router.js')
    const router = new DaemonCommandRouter({
      commandHandler: { handle: vi.fn(async () => ({ success: false, error: 'unexpected delegation' })) } as any,
      cliManager: { handleCliCommand: vi.fn(async () => ({ success: false, error: 'unexpected cli delegation' })) } as any,
      cdpManagers: new Map(),
      providerLoader: {
        getMeta: () => rawMeta,
        resolve,
      } as any,
      instanceManager: {} as any,
      detectedIdes: { value: [] },
      sessionRegistry: {} as any,
    })

    const result = await router.execute('list_saved_sessions', { providerType: 'codex-cli' }, 'standalone')

    expect(resolve).toHaveBeenCalledWith('codex-cli')
    expect(nativeHistoryScript).toHaveBeenCalled()
    expect(result).toMatchObject({
      success: true,
      source: 'provider-native',
      sessions: [expect.objectContaining({
        providerSessionId: historySessionId,
        title: 'native codex list assistant',
        historySource: 'provider-native',
      })],
    })
  })
})
