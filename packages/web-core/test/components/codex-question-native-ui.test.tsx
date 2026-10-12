// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { CodexAppServerAdapter } from '../../../daemon-core/src/providers/codex-app-server/adapter'
import { buildProviderState, type ProviderStateHost } from '../../../daemon-core/src/providers/cli-provider-state-projection'
import { ParsedIngestTimestampStamper } from '../../../daemon-core/src/providers/cli-provider-ingest-times'
import { applyInteractivePromptAnswer } from '../../../daemon-core/src/providers/interactive-prompt-apply'
import { meshEventsHandlers } from '../../../daemon-core/src/commands/high-family/mesh-events'
import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import { buildInteractivePromptResponse, findInteractivePromptSession, normalizeInteractivePromptPrompt } from '../../src/interactive-prompt/interactive-prompt-utils'
import { submitInteractivePromptResponse } from '../../src/interactive-prompt/interactive-prompt-transport'
import type { DaemonData } from '../../src/types'
import en from '../../src/i18n/locales/en/common.json'
import ko from '../../src/i18n/locales/ko/common.json'
import ja from '../../src/i18n/locales/ja/common.json'
import zh from '../../src/i18n/locales/zh-CN/common.json'
import es from '../../src/i18n/locales/es/common.json'

const isolation = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'codex-managed-ui-'))
  vi.stubEnv('ADHDEV_CONFIG_DIR', dir)
  return dir
})
afterAll(async () => { const { rmSync } = await import('node:fs'); rmSync(isolation, { recursive: true, force: true }); vi.unstubAllEnvs() })

let root: Root | undefined
let adapter: CodexAppServerAdapter | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; adapter?.shutdown(); document.body.innerHTML = '' })
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
function projection(native: CodexAppServerAdapter, persisted: unknown[][] = []) {
  const host = {
    type: 'codex-cli', instanceId: 'synthetic-session', workingDir: '.', provider: { type: 'codex-cli', name: 'Codex', category: 'cli' },
    presentationMode: 'chat', settings: {}, lastStatus: 'generating', activeInteractivePrompt: null, controlValues: {},
    summaryMetadata: null, suppressIdleHistoryReplay: false, autoApproveBusy: false, runtimeMessages: [],
    parsedIngestTimestamps: new ParsedIngestTimestampStamper(), lastPersistedHistoryMessages: [], lastCompletionSummary: null,
    adapter: native, historyWriter: { appendNewMessages(_type: string, messages: unknown[]) { persisted.push(messages) } },
    stabilizeFlappingApprovalStatus: (status: unknown) => status, maybeAutoApproveStatus: () => false, autoApproveMaskStalled: () => false,
    maybeAppendRuntimeRecoveryMessage() {}, shouldSuppressFreshLaunchStartupReplay: () => false,
    promoteProviderSessionId(id: string) { (host as any).providerSessionId = id }, shouldHydrateExistingProviderHistory: () => false,
    syncCanonicalSavedHistoryIfNeeded: () => false, shouldSuppressStaleParsedBusyStatus: () => false, applyProviderResponse() {},
  } as unknown as ProviderStateHost
  return () => buildProviderState(host)
}

describe('native JSON-RPC producer → daemon projection → common React UI → native resolution', () => {
  it('renders descriptions and a required free-input question, dispatches the exact native response and retracts it', async () => {
    const producer = resolve(process.cwd(), '../daemon-core/test/fixtures/codex-question-producer.mjs')
    adapter = new CodexAppServerAdapter(process.cwd(), 'synthetic-session', process.execPath, [], {}, [producer])
    await adapter.spawn(); await adapter.sendMessage('rpc'); await wait(() => !!adapter!.questions.active())
    const state = projection(adapter)
    const session = () => findInteractivePromptSession([{ ...state(), id: 'synthetic-route', daemonId: 'synthetic-daemon', sessionId: 'synthetic-session' } as unknown as DaemonData], { sessionId: 'synthetic-session' })
    const instance = { getState: state, applyInteractivePromptResponse: (data: unknown) => applyInteractivePromptAnswer({ held: state().activeInteractivePrompt ?? null, data, adapter: adapter!, providerType: 'codex-cli' }) }
    const ctx = { deps: { instanceManager: { getInstance: (id: string) => id === 'synthetic-session' ? instance : undefined } } } as any
    const native = adapter
    const errors: unknown[] = []
    const mount = document.createElement('div'); document.body.appendChild(mount); root = createRoot(mount)
    function render() {
      act(() => root!.render(<InteractivePromptModal promptSession={session()} onCancel={() => {}}
        onSubmit={async selection => {
          const current = session()!
          try {
            await submitInteractivePromptResponse({ promptSession: current,
              response: buildInteractivePromptResponse(current.prompt, selection), useP2PCommand: true,
              sendCommand: (_route, _type, payload) => meshEventsHandlers.interactive_prompt_response(ctx, payload),
            })
          } catch (error) { errors.push(error) }
        }} />))
    }
    render()
    expect(document.body.textContent).toContain('First synthetic track')
    expect(document.body.textContent).toContain('Choose a sample track')
    expect(document.body.textContent).toContain('Enter a sample note')
    const submit = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === en.interactivePrompt.submit)!
    expect(submit().disabled).toBe(true)
    act(() => document.querySelector<HTMLButtonElement>('[role=radio]')!.click())
    expect(submit().disabled).toBe(true)
    const note = document.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Synthetic UI note')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
    expect(submit().disabled).toBe(false)
    act(() => submit().click())
    await wait(() => !native.questions.active())
    render()
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(errors).toEqual([])
    const observations = await native.transport.request('test/observations', {}) as any[]
    expect(observations.filter(o => o.id === 'request-1')).toEqual([{ id: 'request-1', result: { answers: { track: { answers: ['Alpha'] }, note: { answers: ['Synthetic UI note'] } } } }])
    expect(state().activeChat?.messages.some(message => message.content === 'Synthetic question resolved')).toBe(true)
  })

  it('shows cached unknown Codex questions as uncertain, with no answer controls', () => {
    const prompt = normalizeInteractivePromptPrompt({ promptId: 'cached', providerType: 'codex-cli', origin: 'cli', createdAt: 1,
      questions: [{ questionId: 'cached-question', question: 'Synthetic cached question', multiSelect: false, options: [{ label: 'Synthetic option' }] }] })!
    expect(prompt.support).toBe('uncertain')
    const mount = document.createElement('div'); document.body.appendChild(mount); root = createRoot(mount)
    act(() => root!.render(<InteractivePromptModal promptSession={{ prompt, daemonId: 'synthetic-daemon', routeId: 'synthetic-route', sessionId: 'synthetic-session', providerType: 'codex-cli' }} onSubmit={() => { throw new Error('Must not dispatch') }} onCancel={() => {}} />))
    expect(document.body.textContent).toContain(en.interactivePrompt.codexUncertain)
    expect(document.querySelector('[role=radio]')).toBeNull()
    expect(document.body.textContent).not.toContain('Synthetic cached question')
    expect(normalizeInteractivePromptPrompt({ ...prompt, questions: [null] })?.support).toBe('uncertain')
  })

  it('masks native secret free input without showing it in an answer preview', () => {
    const mount = document.createElement('div'); document.body.appendChild(mount); root = createRoot(mount)
    const prompt = { promptId: 'synthetic-secret', providerType: 'codex-cli', origin: 'cli' as const, createdAt: 1,
      support: 'request_bound' as const, lifecycle: 'pending' as const,
      binding: { transport: 'codex_rpc' as const, sessionId: 'synthetic-session', generation: 'synthetic-generation', threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item', requestId: 'synthetic-request' },
      questions: [{ questionId: 'secret', question: 'Synthetic secret input', multiSelect: false, options: [], allowFreeform: true, required: true, isSecret: true }] }
    act(() => root!.render(<InteractivePromptModal promptSession={{ prompt, daemonId: 'synthetic-daemon', routeId: 'synthetic-route', sessionId: 'synthetic-session', providerType: 'codex-cli' }} onSubmit={() => {}} onCancel={() => {}} />))
    const input = document.querySelector<HTMLInputElement>('input[type=password]')!
    expect(input).not.toBeNull(); expect(input.autocomplete).toBe('off')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Synthetic private value')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('Synthetic private value')
  })

  it('keeps async question and reply bodies out of additional durable daemon history copies', async () => {
    const producer = resolve(process.cwd(), '../daemon-core/test/fixtures/codex-question-producer.mjs')
    adapter = new CodexAppServerAdapter(process.cwd(), 'synthetic-session', process.execPath, [], {}, [producer])
    await adapter.spawn(); await adapter.sendMessage('async'); await wait(() => !!adapter!.questions.active())
    const persisted: unknown[][] = []
    const state = projection(adapter, persisted)
    state()
    const prompt = adapter.questions.active()!
    await adapter.setInteractivePromptResponse({ promptId: prompt.promptId, binding: prompt.binding,
      answers: { [prompt.questions[0].questionId]: { selectedLabels: ['Blue'] } } })
    await adapter.interruptTurn()
    state()
    const text = JSON.stringify(persisted)
    expect(text).not.toContain('Synthetic async bundle')
    expect(text).not.toContain('Choose a color')
    expect(text).not.toContain('send_user_message_question_reply')
    expect(state().activeChat?.messages.some(message => String(message.content).includes('Blue'))).toBe(true)
  })

  it('keeps all five locales aligned for managed transport and honest async lifecycle', () => {
    for (const locale of [en, ko, ja, zh, es]) {
      expect(locale.newSession.codexManagedQuestions).toBeTruthy()
      expect(locale.newSession.codexManagedQuestionsDescription).toBeTruthy()
      for (const key of ['codexRequestBound', 'codexAsyncLocal', 'codexAwaitingResolution', 'codexUncertain', 'codexDismissLocal'] as const) expect(locale.interactivePrompt[key]).toBeTruthy()
    }
  })
})
