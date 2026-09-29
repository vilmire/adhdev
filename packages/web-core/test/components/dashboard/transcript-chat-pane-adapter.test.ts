import { describe, expect, it } from 'vitest'
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core'
import {
  buildTranscriptPaneAttributes,
  mapTranscriptViewToChatView,
} from '../../../src/components/dashboard/transcript-chat-pane-adapter'

function buildSnapshot(overrides: Partial<ReplicatedTranscriptViewV2> = {}): ReplicatedTranscriptViewV2 {
  return {
    schemaVersion: 2,
    sessionId: 'session-1',
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: 'daemon-1',
    producerWriterId: 'writer-1',
    epoch: 'epoch-1',
    frame: 1,
    observedAt: '2026-08-30T00:00:00.000Z',
    status: 'idle',
    providerObservedStatus: null,
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: null, transcriptProvenance: null },
    messages: [],
    terminalMarkers: [],
    coverage: { mode: 'tail', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
    ...overrides,
  }
}

describe('mapTranscriptViewToChatView', () => {
  it('maps messages/status into the chat view shape', () => {
    const snapshot = buildSnapshot({
      sessionId: 'session-9',
      historySessionId: 'history-9',
      status: 'generating',
      messages: [
        { role: 'user', kind: 'standard', content: 'hi', receivedAt: 10, timestamp: 10, turnKey: 'turn-1', bubbleState: 'final', senderName: null, toolName: null, streaming: null, messageId: 'mid-turn-1-10', ord: '00000010', rev: 1, expandable: false, srcId: null },
        { role: 'assistant', kind: 'standard', content: 'hello', receivedAt: 20, timestamp: 20, turnKey: 'turn-2', bubbleState: 'final', senderName: null, toolName: null, streaming: null, messageId: 'mid-turn-2-20', ord: '00000020', rev: 1, expandable: false, srcId: null },
      ],
    })

    const update = mapTranscriptViewToChatView(snapshot)

    expect(update.status).toBe('generating')
    expect(update.omittedBefore).toBe(false)
    expect(update.messages).toHaveLength(2)
    // `_turnKey` only — `bubbleId` is deliberately NOT populated from turnKey.
    // turnKey is turn-grained, so using it as per-bubble identity collapsed every
    // bubble of one turn onto a single React key (see
    // transcript-adapter-bubble-identity.test.ts).
    expect(update.messages[0]).toMatchObject({ role: 'user', content: 'hi', _turnKey: 'turn-1' })
    expect(update.messages[1]).toMatchObject({ role: 'assistant', content: 'hello', _turnKey: 'turn-2' })
    expect(update.messages[0]).not.toHaveProperty('bubbleId')
  })

  it('maps toolName onto the bubble AND derives meta.label from it — the live lane has no meta.label (TOOL-LABEL)', () => {
    const snapshot = buildSnapshot({
      messages: [
        { role: 'assistant', kind: 'tool', content: '↗ Write: {"path":"x"}', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: 'Tool', toolName: 'Write', streaming: null, messageId: 'mid-t1-1', ord: '00000001', rev: 1, expandable: false, srcId: null },
        { role: 'assistant', kind: 'tool', content: '↘ ok', receivedAt: 2, timestamp: 2, turnKey: 't1', bubbleState: 'final', senderName: 'Tool', toolName: null, streaming: null, messageId: 'mid-t1-2', ord: '00000002', rev: 1, expandable: false, srcId: null },
      ],
    })
    const update = mapTranscriptViewToChatView(snapshot)
    expect(update.messages[0].toolName).toBe('Write')
    expect(update.messages[0].meta?.label).toBe('Write')
    // A result bubble has no tool name of its own: nothing is invented for it.
    expect(update.messages[1].toolName).toBeUndefined()
    expect(update.messages[1].meta?.label).toBeUndefined()
  })

  it('maps messageId onto id/messageId, keeps ord/rev, and marks an expandable bubble for expand-by-messageId', () => {
    const snapshot = buildSnapshot({
      messages: [
        { role: 'assistant', kind: 'tool', content: 'Read(x)…', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null, messageId: 'n.aa.1.0', ord: 'a0', rev: 3, expandable: true, srcId: null },
        { role: 'assistant', kind: 'tool', content: 'Read(y)', receivedAt: 2, timestamp: 2, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null, messageId: 'n.aa.2.0', ord: 'a1', rev: 1, expandable: false, srcId: null },
      ],
    })
    const update = mapTranscriptViewToChatView(snapshot)
    expect(update.messages[0]).toMatchObject({ id: 'n.aa.1.0', messageId: 'n.aa.1.0', _ord: 'a0', _rev: 3, _expandable: true })
    // The keyed wire never carries the mtime-sealed ref (design 2026-09-28 §5.9).
    expect('toolBlockRef' in update.messages[0]).toBe(false)
    expect('_expandable' in update.messages[1]).toBe(false)
  })

  it('reads omittedBefore from the producer coverage', () => {
    const snapshot = buildSnapshot({ coverage: { mode: 'window', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: true } })
    const update = mapTranscriptViewToChatView(snapshot)
    expect(update.omittedBefore).toBe(true)
  })
})

describe('buildTranscriptPaneAttributes', () => {
  it('flags a view that does not reach the start of the conversation', () => {
    expect(buildTranscriptPaneAttributes({ omittedBefore: true })).toEqual({ 'data-transcript-omitted-before': 'true' })
  })

  it('OMITS the flag when the view is complete — absence is meaningful, not "false"', () => {
    expect(buildTranscriptPaneAttributes({ omittedBefore: false })).toEqual({})
    expect(buildTranscriptPaneAttributes({})).toEqual({})
  })

  it('carries no transport-selection readout — there is one chat lane', () => {
    const attrs = buildTranscriptPaneAttributes({ omittedBefore: true })
    expect(Object.keys(attrs)).toEqual(['data-transcript-omitted-before'])
  })
})
