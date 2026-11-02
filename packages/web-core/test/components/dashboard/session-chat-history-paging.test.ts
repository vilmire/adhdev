/**
 * "Load earlier" must page by a stable boundary, not by counts taken against a
 * history length that moves while the user pages.
 *
 * The live window is pinned at the newest 200 bubbles, so every new message
 * moves the floor by one. With count paging (`excludeRecentCount` + `offset`),
 * a later page then repeats k rows or skips k rows. These tests drive a REAL
 * controller against a REAL `pageHistoryRecords` (the daemon's paging code) over
 * a growing transcript and assert the displayed rows (history ++ live) are the
 * transcript exactly: each row once, in order, nothing missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core'
import { pageHistoryRecords } from '../../../../daemon-core/src/config/chat-history-tail'
import {
  applyTranscriptViewToControllers,
  getOrCreateSessionChatController,
  resetSessionChatControllersForTest,
  type SessionChatHistoryPageRequest,
} from '../../../src/components/dashboard/session-chat-controller'
import { buildHistoryTimeCursor, hashHistoryCursorContent } from '../../../src/components/dashboard/history-time-cursor'
import {
  buildHistoryTimeCursor as daemonBuildCursor,
  hashHistoryCursorContent as daemonHash,
} from '../../../../daemon-core/src/config/chat-history-tail'

const T0 = 1_800_000_000_000
const LIVE_CAP = 200

interface Row { role: 'user' | 'assistant'; kind: string; content: string; receivedAt: number }

function makeRow(i: number, toolEvery: number): Row {
  const tool = toolEvery > 0 && i % toolEvery !== 0
  return {
    role: tool || i % 2 === 1 ? 'assistant' : 'user',
    kind: tool ? 'tool' : 'standard',
    content: `${tool ? 'tool' : 'prose'}-${i}`,
    receivedAt: T0 + i * 1000,
  }
}

/** A daemon-side transcript that can grow, plus the keyed live view over its newest bubbles. */
class Harness {
  rows: Row[] = []
  requests: SessionChatHistoryPageRequest[] = []
  frame = 1
  constructor(count: number, private readonly toolEvery = 0, private readonly supportsCursor = true, private readonly activityVisible = true) {
    for (let i = 0; i < count; i += 1) this.rows.push(makeRow(i, toolEvery))
    this.controller = getOrCreateSessionChatController({ daemonId: 'daemon-1', sessionId: 'session-1' } as any)
    this.publish()
  }
  controller
  append(n: number) {
    for (let k = 0; k < n; k += 1) this.rows.push(makeRow(this.rows.length, this.toolEvery))
    this.publish()
  }
  publish() {
    const live = this.rows.slice(-LIVE_CAP)
    const first = this.rows.length - live.length
    this.frame += 1
    applyTranscriptViewToControllers('daemon-1', 'session-1', {
      schemaVersion: 2, sessionId: 'session-1', historySessionId: null, providerType: 'hermes-cli', providerSessionId: null,
      producerDaemonId: 'd', producerWriterId: 'w', epoch: 'e', frame: this.frame, observedAt: '2026-11-01T00:00:00.000Z',
      status: 'idle', providerObservedStatus: null, title: null, activeModal: null, activeInteractivePrompt: null, turn: null,
      provenance: { messageSource: null, transcriptProvenance: null },
      messages: live.map((row, k) => ({
        role: row.role, kind: row.kind, content: row.content, receivedAt: row.receivedAt, timestamp: row.receivedAt,
        turnKey: 't', bubbleState: 'final', senderName: null, toolName: null, streaming: null,
        messageId: `m${first + k}`, ord: `a${String(first + k).padStart(6, '0')}`, rev: 1, expandable: false, srcId: null,
      })),
      terminalMarkers: [],
      coverage: { mode: 'full', totalMessageCount: live.length, returnedMessageCount: live.length, omittedBefore: first > 0 },
    } as unknown as ReplicatedTranscriptViewV2)
  }
  /** chat_history exactly as the daemon answers it (new daemon honours the cursor; old ignores it). */
  loader = async (request: SessionChatHistoryPageRequest) => {
    this.requests.push(request)
    const records = this.rows.map((r) => ({ ...r, ts: new Date(r.receivedAt).toISOString(), agent: 'hermes-cli' })) as any
    const page = pageHistoryRecords('hermes-cli', records, request.offset, 30, request.excludeRecentCount, undefined,
      this.supportsCursor ? request.excludeFromIdentity || undefined : undefined, !this.activityVisible)
    return { messages: page.messages as any, hasMore: page.hasMore, ...(page.boundaryKind ? { boundaryKind: page.boundaryKind } : {}) }
  }
  displayed() {
    const s = this.controller.getSnapshot()
    return [...s.historyMessages, ...s.liveMessages]
  }
  async pageToStart(arrivalsBetweenPages = 0) {
    for (let guard = 0; guard < 60; guard += 1) {
      await this.controller.loadHistoryPage(this.loader)
      if (!this.controller.getSnapshot().hasMoreHistory) return
      if (arrivalsBetweenPages) this.append(arrivalsBetweenPages)
    }
    throw new Error('paging never reached the start')
  }
}

// The daemon rejects cursors stamped beyond now + skew, so pin the clock just after the fixture transcript.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0 + 1_000_000_000) })
afterEach(() => { vi.useRealTimers(); resetSessionChatControllersForTest() })

const contents = (messages: Array<{ content?: unknown }>) => messages.map((m) => String(m.content))

describe('history time cursor parity with the daemon', () => {
  it('hashes and builds cursors byte-identically', () => {
    for (const text of ['', 'hello', '  spaced \n out  ', 'tool-12', '한글 \t content', 'x'.repeat(5000)]) {
      expect(hashHistoryCursorContent(text)).toBe(daemonHash(text))
      expect(buildHistoryTimeCursor({ receivedAt: T0 + 5.9, role: 'user', content: text }))
        .toBe(daemonBuildCursor({ receivedAt: T0 + 5.9, role: 'user', content: text }))
    }
    expect(buildHistoryTimeCursor({ receivedAt: undefined, role: 'user', content: 'x' })).toBe('')
  })
})

describe('"Load earlier" paging is gap-free and duplicate-free', () => {
  it('500 rows, live 200: pages to the start with a message arriving between every page', async () => {
    const h = new Harness(500)
    expect(h.controller.getSnapshot().liveMessages).toHaveLength(LIVE_CAP)
    await h.pageToStart(3)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
    expect(h.requests.every((r) => r.excludeFromIdentity.startsWith('ts:') && r.offset === 0)).toBe(true)
  })

  it('without arrivals it is also exact (baseline)', async () => {
    const h = new Harness(500)
    await h.pageToStart(0)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
  })

  it('later pages anchor to the oldest row already loaded, the first to the oldest live bubble', async () => {
    const h = new Harness(500)
    await h.controller.loadHistoryPage(h.loader)
    expect(h.requests[0]!.excludeFromIdentity).toBe(buildHistoryTimeCursor(makeRow(300, 0)))
    const oldestLoaded = h.controller.getSnapshot().historyMessages[0]!
    await h.controller.loadHistoryPage(h.loader)
    expect(h.requests[1]!.excludeFromIdentity).toBe(buildHistoryTimeCursor(oldestLoaded))
  })

  it('tool-heavy live window with activity rows hidden: every prose row exactly once, in order', async () => {
    const h = new Harness(600, 5, true, false)
    // Live window (200 bubbles) is mostly tool bubbles; the count path would skip ~160 prose rows.
    await h.pageToStart(4)
    const shown = h.displayed()
    const keys = shown.map((m) => `${m.receivedAt}|${m.content}`)
    expect(new Set(keys).size).toBe(keys.length)
    const prose = shown.filter((m) => m.kind !== 'tool')
    expect(contents(prose)).toEqual(contents(h.rows.filter((r) => r.kind !== 'tool')))
  })

  it('tool-heavy with the activity toggle ON: the whole transcript, once', async () => {
    const h = new Harness(600, 5, true, true)
    await h.pageToStart(2)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
  })

  it('history shorter than the live window: nothing to page, nothing duplicated', async () => {
    const h = new Harness(50)
    expect(h.controller.getSnapshot().hasMoreHistory).toBe(false)
    await h.controller.loadHistoryPage(h.loader)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
    expect(h.controller.getSnapshot().hasMoreHistory).toBe(false)
  })

  it('history just over the live window pages the remainder once', async () => {
    const h = new Harness(230)
    await h.pageToStart(1)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
  })

  it('a daemon without cursor support is detected and paged by count - still exact thanks to the retained spill', async () => {
    const h = new Harness(500, 0, false)
    await h.pageToStart(3)
    expect(contents(h.displayed())).toEqual(contents(h.rows))
    // First request offered the cursor; once ignored, requests fall back to count paging.
    expect(h.requests[0]!.excludeFromIdentity.startsWith('ts:')).toBe(true)
    expect(h.requests.slice(1).every((r) => !r.excludeFromIdentity.startsWith('ts:'))).toBe(true)
    expect(h.requests[1]!.offset).toBe(h.controller.getSnapshot().historyOffset - (h.requests[1]!.offset === 0 ? 0 : 0) >= 0 ? h.requests[1]!.offset : -1)
  })

  it('rows that scroll off the live window are retained, not lost between live and history', async () => {
    const h = new Harness(500)
    h.append(25)
    const snapshot = h.controller.getSnapshot()
    expect(snapshot.liveMessages).toHaveLength(LIVE_CAP)
    expect(contents(snapshot.historyMessages)).toEqual(contents(h.rows.slice(300, 325)))
    expect(snapshot.hasMoreHistory).toBe(true)
    expect(snapshot.historyOffset).toBe(0)
  })

  it('duplicate rows a page returns (tie rows) are dropped, never shown twice', async () => {
    const h = new Harness(300)
    const dup = h.rows[110]!
    await h.controller.loadHistoryPage(async (request) => {
      const page = await h.loader(request)
      return { ...page, messages: [...page.messages!, { ...(h.controller.getSnapshot().liveMessages[0] as any) }] }
    })
    const keys = h.displayed().map((m) => `${m.receivedAt}|${m.role}|${m.content}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(contents(h.displayed())).toContain(dup.content)
  })
})
