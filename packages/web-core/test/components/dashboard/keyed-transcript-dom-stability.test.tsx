// @vitest-environment jsdom
/**
 * ★ Keyed replica lane, end to end on the main thread (design 2026-09-28
 * message-keyed storage §5.4, §9.1 "리마운트 0"):
 *
 *   worker frame → TranscriptViewMirror → applyTranscriptViewToControllers
 *   → controller snapshot → ChatMessageList DOM
 *
 * A streaming tick that changes ONE bubble must
 *   - reach the controller as the SAME `DashboardMessage` objects for every
 *     other bubble (rev-based change detection, not a whole-list remap),
 *   - keep every other bubble's DOM node — no unmount, no remount,
 *   - still update the bubble that changed, even when it is not the last one
 *     (the coarse last-message signature could never see that).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptMessageV2 } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import MemoizedChatMessageList from '../../../src/components/ChatMessageList'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  applyTranscriptViewToControllers,
  getOrCreateSessionChatController,
  requestTranscriptBaseForSession,
  resetSessionChatControllersForTest,
} from '../../../src/components/dashboard/session-chat-controller'
import type { TranscriptBridgeFrameMessage, TranscriptViewMeta } from '../../../src/transcript-transport/bridge-protocol'
import { TranscriptViewMirror } from '../../../src/transcript-transport/transcript-view-mirror'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'

function bubble(id: string, ord: string, rev: number, content: string, role = 'assistant'): ReplicatedTranscriptMessageV2 {
  return {
    messageId: id, ord, rev, role, kind: 'standard', content, receivedAt: 1_700_000_000_000 + Number(ord.slice(1)),
    timestamp: null, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null,
    expandable: false, srcId: null,
  }
}

const META: TranscriptViewMeta = {
  schemaVersion: 2, sessionId: SESSION, historySessionId: null, providerType: 'claude-cli', providerSessionId: null,
  producerDaemonId: DAEMON, producerWriterId: 'w1', epoch: 'e1', frame: 1, observedAt: 'now', status: 'generating',
  providerObservedStatus: null, title: null, activeModal: null, activeInteractivePrompt: null, turn: null,
  provenance: { messageSource: 'native-history', transcriptProvenance: null }, terminalMarkers: [],
  coverage: { mode: 'full', omittedBefore: false, totalMessageCount: 3, returnedMessageCount: 3 },
}

function frame(partial: Partial<TranscriptBridgeFrameMessage>): TranscriptBridgeFrameMessage {
  return { kind: 'transcript-bridge-frame', sessionId: SESSION, epoch: 'e1', frame: 1, reset: false, upserts: [], deletes: [], meta: null, ...partial }
}

describe('★ keyed replica: a one-bubble frame re-renders one bubble', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetSessionChatControllersForTest()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    resetSessionChatControllersForTest()
  })

  it('keeps unchanged bubbles by identity and by DOM node, and updates a changed EARLIER bubble', () => {
    const sendData = vi.fn().mockReturnValue(true)
    const controller = getOrCreateSessionChatController({
      sendData,
      daemonId: DAEMON,
      sessionId: SESSION,
    })
    controller.retain()
    const mirror = new TranscriptViewMirror()
    const deliver = (f: TranscriptBridgeFrameMessage) => {
      const update = mirror.apply(f)
      if (update) applyTranscriptViewToControllers(DAEMON, SESSION, update.view)
    }
    const render = () => act(() => {
      root.render(createElement(MemoizedChatMessageList as any, {
        messages: controller.getSnapshot().liveMessages,
        actionLogs: [],
        agentName: 'Claude',
        userName: 'You',
        contextKey: 'keyed',
      }))
    })
    const nodeWith = (text: string): Element => {
      const hit = [...container.querySelectorAll('*')].reverse().find((el) => el.textContent === text)
      if (!hit) throw new Error(`no node renders ${text}`)
      return hit
    }

    deliver(frame({
      reset: true,
      meta: META,
      upserts: [bubble('m1', 'a1', 1, 'question', 'user'), bubble('m2', 'a2', 1, 'tool result pending'), bubble('m3', 'a3', 1, 'streaming answer')],
    }))
    render()
    const before = controller.getSnapshot().liveMessages
    expect(before.map((m) => m.content)).toEqual(['question', 'tool result pending', 'streaming answer'])
    const questionNode = nodeWith('question')
    const answerNode = nodeWith('streaming answer')

    // The EARLIER bubble changes; the last one does not.
    deliver(frame({ frame: 2, upserts: [bubble('m2', 'a2', 2, 'tool result landed')] }))
    render()
    const after = controller.getSnapshot().liveMessages
    expect(after.map((m) => m.content)).toEqual(['question', 'tool result landed', 'streaming answer'])
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])

    // ★ Same DOM nodes for the untouched bubbles — nothing remounted.
    expect(nodeWith('question')).toBe(questionNode)
    expect(nodeWith('streaming answer')).toBe(answerNode)
    expect(questionNode.isConnected).toBe(true)
    expect(answerNode.isConnected).toBe(true)

    // A meta-only frame changes no bubble: the rows stay the very same objects.
    deliver(frame({ frame: 3, meta: { ...META, frame: 3, status: 'idle' } }))
    expect(controller.getSnapshot().liveMessages).toBe(after)
  })

  it('requestTranscriptBaseForSession sends request_transcript_base on the controller command lane', () => {
    const sendData = vi.fn().mockReturnValue(true)
    getOrCreateSessionChatController({
      sendData,
      daemonId: DAEMON,
      sessionId: SESSION,
    })
    expect(requestTranscriptBaseForSession(DAEMON, SESSION)).toBe(true)
    expect(sendData).toHaveBeenCalledWith(DAEMON, {
      type: 'command',
      commandType: 'request_transcript_base',
      data: { rawSessionId: SESSION },
    })
    expect(requestTranscriptBaseForSession(DAEMON, 'nobody-is-reading-this')).toBe(false)
  })
})
