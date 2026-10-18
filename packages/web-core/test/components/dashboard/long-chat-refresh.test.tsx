// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildReadChatCommandResult } from '../../../../daemon-core/src/commands/read-chat-presentation'
import { configureTranscriptProjection } from '../../../../daemon-core/src/seqscribe/transcript-publisher'
import { createLiveChatPublisher } from '../../../../daemon-core/src/seqscribe/transcript-keyed-publish-runtime'
import { TranscriptTopicClaimRegistry } from '../../../../daemon-core/src/seqscribe/transcript-topic-claim'
import type { SeqscribeNodeHandle } from '../../../../daemon-core/src/seqscribe/node'
import { rig, waitFor, PRODUCER_WRITER, PRODUCER_DAEMON } from '../../transcript-transport/keyed-chat-rig'
import { subscribeSessionChat } from '../../../src/transcript-transport/transcript-session-subscription'
import { sessionChatPolicy, sessionChatTopic } from '../../../src/transcript-transport/topic-addressing'
import { readSession } from '../../../../daemon-core/src/providers/native-history/codex-cli-transcript'
import type { KeyedChatFrame } from '../../../../daemon-core/src/seqscribe/transcript-keyed-frame'
import type { TranscriptObservation } from '../../../../daemon-core/src/seqscribe/transcript-observation'
import { __resetMessageIdentityLedgersForTest } from '../../../../daemon-core/src/chat/message-identity-ledger'
import MemoizedChatMessageList from '../../../src/components/ChatMessageList'
import { SessionChatController } from '../../../src/components/dashboard/session-chat-controller'
import { buildVisibleConversationMessages, withPendingLocalMessages, type PendingLocalMessage } from '../../../src/components/dashboard/conversation-message-snapshot'
import { TranscriptViewMirror } from '../../../src/transcript-transport/transcript-view-mirror'

const isolated = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-chat-refresh-'))
  const previous = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = dir
  return { dir, previous }
})
afterAll(async () => {
  const fs = await import('node:fs')
  if (isolated.previous === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = isolated.previous
  fs.rmSync(isolated.dir, { recursive: true, force: true })
})

// Real read_chat choke point -> publisher rows -> commit-verifying folder ->
// bridge mirror -> controller -> the pane's message projection and actual list.
// SQLite storage and the seqscribe peer/subscription are real and isolated.
const SESSION = 'synthetic-refresh-session'
const DAEMON = 'synthetic-daemon'
let root: Root
let container: HTMLDivElement
let cleanup: (() => Promise<void>)[] = []
beforeEach(() => {
  __resetMessageIdentityLedgersForTest()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  configureTranscriptProjection(null)
  for (const close of cleanup.splice(0).reverse()) await close()
  __resetMessageIdentityLedgersForTest()
  delete (HTMLElement.prototype as any).scrollTo
  vi.unstubAllGlobals()
})

it.each([4, 600])('keeps %i committed bubbles through send, metadata-bearing empty refresh, read/page failures and restore', async (count) => {
  const controller = new SessionChatController({ daemonId: DAEMON, sessionId: SESSION })
  const r = await rig(SESSION)
  cleanup.push(() => r.close())
  const publisher = createLiveChatPublisher({
    node: r.producer.node, writerId: PRODUCER_WRITER, daemonId: PRODUCER_DAEMON,
    dbPath: ':memory:', topics: [{ topic: sessionChatTopic(SESSION), policy: sessionChatPolicy() }],
    authorityEnabled: true, authorityIsLocal: false, finalityLoop: null,
    onClose: () => {}, close: () => r.close(),
  } as SeqscribeNodeHandle, new TranscriptTopicClaimRegistry(), PRODUCER_DAEMON)
  const removeLedgerSeed = publisher.installLedgerSeed()
  cleanup.push(async () => removeLedgerSeed())
  const mirror = new TranscriptViewMirror()
  const sub = subscribeSessionChat(r.consumer, { sessionId: SESSION, peer: r.consumerPeer,
    ownerDaemonId: PRODUCER_DAEMON, onFrame: delta => {
      const update = mirror.apply({ kind: 'transcript-bridge-frame', ...delta })
      if (update) controller.applyTranscriptView(update.view)
    },
  })
  cleanup.push(async () => sub.close())
  let failRead = false
  let failWrite = false
  let lastObservation: TranscriptObservation | undefined
  const deps = {
    daemonId: () => PRODUCER_DAEMON, writerId: () => PRODUCER_WRITER,
    readPersistedChat: publisher.readPersistedChat,
    collectObservation: async () => { if (failRead) throw new Error('synthetic read unavailable'); return null },
    appendChatFrame: async (session: string, frame: KeyedChatFrame, observation: TranscriptObservation) => {
      if (failWrite) throw new Error('synthetic ENOSPC keyed append failure')
      lastObservation = observation
      await publisher.appendChatFrame(session, frame)
    },
  }
  const settle = async () => {
    await waitFor(() => {
      const service = currentService!
      const counters = service.getCounters()
      return counters.published + counters.deduped + counters.publishFailed + counters.collectFailed >= operations
    })
    const target = publisher.readPersistedChat(SESSION)?.committed.find(row => row.key === 'commit')?.payload as { frame: number; epoch: string } | undefined
    if (target) await waitFor(() => sub.view()?.frame === target.frame && sub.view()?.epoch === target.epoch)
  }
  let operations = 0
  let currentService: ReturnType<typeof configureTranscriptProjection>
  const service = configureTranscriptProjection(deps)!
  currentService = service
  const syntheticMessages = Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `synthetic history ${i}`, timestamp: 1700000000000 + i }))
  const fs = await import('node:fs')
  const path = await import('node:path')
  const nativeId = '11111111-2222-4333-8444-555555555555'
  const nativePath = path.join(isolated.dir, `${nativeId}.jsonl`)
  const nativeRow = (m: { role: string; content: string; timestamp: number }) => JSON.stringify({ type: 'response_item', timestamp: new Date(m.timestamp).toISOString(), payload: { type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }] } })
  fs.writeFileSync(nativePath, [JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: isolated.dir } }), ...syntheticMessages.map(nativeRow)].join('\n') + '\n')
  const messages = readSession(nativePath)!.messages
  expect(messages).toHaveLength(count + 1) // native session_start is filtered by the real read_chat projection
  const read = (rows: readonly unknown[] = messages, extra = {}) => {
    const result = buildReadChatCommandResult({ status: 'idle', title: 'Synthetic long chat', historySessionId: 'history-A', providerSessionId: 'provider-A', coverage: 'full', messages: rows, ...extra }, { targetSessionId: SESSION, agentType: 'codex-cli', tailLimit: 30 })
    expect(result.success).toBe(true)
    operations += 1
  }
  let pending: PendingLocalMessage[] = []
  function Pane() {
    const state = useSyncExternalStore(cb => controller.subscribe(cb), () => controller.getSnapshot())
    const rows = buildVisibleConversationMessages({ historyMessages: state.historyMessages, liveMessages: withPendingLocalMessages(state.liveMessages, pending, 1700000010000), visibleLiveCount: count + 10 })
    return createElement(MemoizedChatMessageList as any, { messages: rows, actionLogs: [], agentName: 'Codex', userName: 'You', contextKey: SESSION })
  }
  const render = () => root.render(createElement(Pane))
  await act(async () => { read(); await settle(); render() })
  const observedCounts: number[] = []
  const unsubscribe = controller.subscribe(state => observedCounts.push(state.liveMessages.length))
  const baselineIds = controller.getSnapshot().liveMessages.map(m => m.id)
  const node = [...container.querySelectorAll('*')].find(el => el.textContent === 'synthetic history 0')!
  expect(node).toBeTruthy()
  const assertHistory = () => {
    expect(controller.getSnapshot().liveMessages.slice(0, count).map(m => m.id)).toEqual(baselineIds)
    expect(container.textContent).toContain('synthetic history 0')
    expect(container.textContent).toContain(`synthetic history ${count - 1}`)
    expect(node.isConnected).toBe(true)
    expect(readSession(nativePath)!.messages.length).toBeGreaterThanOrEqual(count)
  }
  expect(readSession(`${nativePath}.unavailable`)).toBeNull()
  pending = [{ id: 'send-1', content: 'synthetic new send', sentAt: 1700000010000 }]
  await act(async () => { render(); read([], { status: 'generating' }); await settle() })
  assertHistory()
  expect(container.textContent).toContain('synthetic new send')
  // Modal metadata is another nonempty scalar; it grants no clear authority.
  await act(async () => { read([], { activeModal: { message: 'Synthetic choice', buttons: ['continue'] }, status: 'waiting_approval' }); await settle() })
  assertHistory()
  expect(sub.view()?.activeModal?.message).toBe('Synthetic choice')
  expect(sub.view()?.status).toBe('waiting_approval')
  await act(async () => { read([], { activeModal: null, status: 'generating' }); await settle() })
  assertHistory()
  expect(sub.view()?.activeModal).toBeNull()
  expect(sub.view()?.status).toBe('generating')
  failRead = true
  await act(async () => { operations += 1; service.markDirty(SESSION); await settle(); await controller.loadHistoryPage(async () => { throw new Error('synthetic page unavailable') }) })
  assertHistory()
  expect(controller.getSnapshot().historyError).toBe('synthetic page unavailable')
  // A failed append alone does not clear the verified consumer/store view.
  failWrite = true
  await act(async () => { read(messages, { status: 'generating', title: 'Synthetic failed write' }); await settle() })
  assertHistory()
  expect(service.getCounters().publishFailed).toBe(1)
  failWrite = false
  await act(async () => { read(); await settle() })
  assertHistory()
  // A partial tail is a window, not deletion of unseen older bubbles.
  await act(async () => { read(messages.slice(-2), { coverage: 'tail' }); await settle() })
  assertHistory()
  const echo = { role: 'user', content: 'synthetic new send', timestamp: 1700000010000 }
  const answer = { role: 'assistant', content: 'synthetic receipt answer', timestamp: 1700000010001 }
  fs.appendFileSync(nativePath, [echo, answer].map(nativeRow).join('\n') + '\n')
  const restoredMessages = readSession(nativePath)!.messages
  await act(async () => { read(restoredMessages); await settle() })
  assertHistory()
  const visible = withPendingLocalMessages(controller.getSnapshot().liveMessages, pending, 1700000010000)
  expect(visible.filter(m => m.content === echo.content)).toHaveLength(1)
  expect(visible.slice(-2).map(m => m.content)).toEqual([echo.content, answer.content])
  expect(service.getCounters().collectFailed).toBe(1)
  // Restore the producer from committed rows, then repeat the transient read.
  service.dispose()
  __resetMessageIdentityLedgersForTest()
  operations = 0
  currentService = configureTranscriptProjection({ ...deps, epoch: 'restored-producer' })
  await act(async () => { read([]); await settle() })
  assertHistory()
  await act(async () => { read(restoredMessages); await settle() })
  assertHistory()
  expect(observedCounts.every(n => n >= count)).toBe(true)
  unsubscribe()
  let finishOldPage!: (page: { messages: any[]; hasMore: boolean }) => void
  let oldPage!: Promise<boolean>
  act(() => {
    oldPage = controller.loadHistoryPage(() => new Promise(resolve => { finishOldPage = resolve }))
  })
  await act(async () => { read([], { historySessionId: 'history-B', providerSessionId: 'provider-B' }); await settle() })
  expect(lastObservation?.historySessionId).toBe('history-B')
  expect(sub.view()?.historySessionId).toBe('history-B')
  expect(controller.getSnapshot().liveMessages).toEqual([])
  expect(container.textContent).not.toContain('synthetic history 0')
  await act(async () => { finishOldPage({ messages: [{ role: 'user', content: 'old foreign page' }], hasMore: true }); await oldPage })
  expect(controller.getSnapshot().historyMessages).toEqual([])
  await act(async () => { read(restoredMessages, { historySessionId: 'history-B', providerSessionId: 'provider-B' }); await settle() })
  expect(controller.getSnapshot().liveMessages.length).toBeGreaterThanOrEqual(count)
  currentService!.dispose()
  operations = 1
  currentService = configureTranscriptProjection({ ...deps, collectObservation: async () => ({ observation: { ...lastObservation!, messages: [] }, verifiedClear: true }) })
  await act(async () => { currentService!.markDirty(SESSION); await settle() })
  expect(controller.getSnapshot().liveMessages).toEqual([])
  expect(sub.view()?.activeModal).toBeNull()
  expect(publisher.readPersistedChat(SESSION)?.committed.some(row => row.kind === 'chat.msg.v2')).toBe(false)
}, 20000)

it.each(['reply', 'error'])('does not let a pre-clear history %s resurrect cleared rows or block the new page', async (outcome) => {
  const c = new SessionChatController({ daemonId: DAEMON, sessionId: SESSION })
  let finish!: (page: { messages: any[]; hasMore: boolean }) => void
  let fail!: (error: Error) => void
  const stale = c.loadHistoryPage(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  c.clearLiveSnapshot()
  const fresh = c.loadHistoryPage(async () => ({ messages: [{ role: 'user', content: 'new history' }], hasMore: false }))
  if (outcome === 'error') fail(new Error('stale page failed'))
  else finish({ messages: [{ role: 'user', content: 'old history' }], hasMore: true })
  await Promise.all([stale, fresh])
  expect(c.getSnapshot().historyMessages.map(m => m.content)).toEqual(['new history'])
  expect(c.getSnapshot().hasMoreHistory).toBe(false)
  expect(c.getSnapshot().historyError).toBeNull()
})

it('fences page replies across native history switches, but keeps concurrent same-history streaming pages', async () => {
  const c = new SessionChatController({ daemonId: DAEMON, sessionId: SESSION })
  const mirror = new TranscriptViewMirror()
  const apply = (sessionId: string, historySessionId: string, frame: number) => {
    const update = mirror.apply({ kind: 'transcript-bridge-frame', sessionId, epoch: 'fixture', frame, reset: true, upserts: [], deletes: [], meta: {
      schemaVersion: 2, sessionId, historySessionId, providerType: 'codex-cli', providerSessionId: historySessionId,
      producerDaemonId: DAEMON, producerWriterId: 'fixture', epoch: 'fixture', frame, observedAt: 'synthetic',
      status: 'idle', providerObservedStatus: 'idle', title: null, activeModal: null, activeInteractivePrompt: null,
      turn: null, provenance: { messageSource: null, transcriptProvenance: null }, terminalMarkers: [],
      coverage: { mode: 'full', omittedBefore: false, totalMessageCount: 0, returnedMessageCount: 0 },
    } })!
    c.applyTranscriptView(update.view)
  }
  apply(SESSION, 'history-a', 1)
  const requests: ((page: { messages: any[]; hasMore: boolean }) => void)[] = []
  const loader = vi.fn(() => new Promise<{ messages: any[]; hasMore: boolean }>(resolve => { requests.push(resolve) }))
  const old = c.loadHistoryPage(loader)
  apply(SESSION, 'history-b', 2)
  const fresh = c.loadHistoryPage(loader)
  // Same-history live versions don't invalidate a page anchored by identity.
  apply(SESSION, 'history-b', 3)
  requests[0]({ messages: [{ role: 'user', content: 'history-a page' }], hasMore: true })
  await old
  const duplicate = c.loadHistoryPage(loader)
  expect(loader).toHaveBeenCalledTimes(2)
  requests[1]({ messages: [{ role: 'user', content: 'history-b page' }], hasMore: false })
  await Promise.all([fresh, duplicate])
  expect(c.getSnapshot().historyMessages.map(m => m.content)).toEqual(['history-b page'])
  const before = c.getSnapshot()
  apply('another-session', 'foreign-history', 4)
  expect(c.getSnapshot()).toBe(before)
  const other = new SessionChatController({ daemonId: DAEMON, sessionId: 'another-session' })
  expect(other.getSnapshot().liveMessages).toEqual([])
  c.clearLiveSnapshot()
  expect(c.getSnapshot().historyMessages).toEqual([])
})
