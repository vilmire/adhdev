/**
 * (QUEUED-SEND-LOSS + OPTIMISTIC-USER-BUBBLE) Two halves of one user-visible
 * defect: the owner's message was invisible until the daemon echoed it back.
 *
 * WHY THIS FILE EXISTS: the daemon was fixed to report
 * `{sent:false, queued:true, submitted:false}` when it parks a body in the
 * driver's FIFO instead of writing it to the PTY — but NOTHING on the web side
 * read `queued`. The contract was dead on arrival, so the defect the daemon fix
 * targeted was still live in the product.
 *
 * ★ The duplicate-bubble assertions are the important ones. The daemon ALREADY
 * renders the owner's bubble (`recordAcknowledgedUserInput` → a
 * `runtime_input_ack` user message). An optimistic bubble that failed to retire
 * itself when that echo landed would show every sent message TWICE — strictly
 * worse than the late-render it replaces.
 */
import { describe, expect, it } from 'vitest'
import {
  hasEchoedPendingMessage,
  withPendingLocalMessage,
  PENDING_LOCAL_MESSAGE_MAX_AGE_MS,
  type PendingLocalMessage,
} from '../../src/components/dashboard/conversation-message-snapshot'
import { isQueuedSendResult } from '../../src/hooks/useDashboardConversationCommands'
import type { DashboardMessage } from '../../src/components/dashboard/types'

function userMsg(content: string, extra: Record<string, unknown> = {}): DashboardMessage {
  return { role: 'user', kind: 'standard', content, ...extra } as unknown as DashboardMessage
}
function assistantMsg(content: string): DashboardMessage {
  return { role: 'assistant', kind: 'standard', content } as unknown as DashboardMessage
}

const SENT_AT = 1_000_000
const pending = (content: string, extra: Partial<PendingLocalMessage> = {}): PendingLocalMessage => ({
  content,
  sentAt: SENT_AT,
  ...extra,
})

describe('queued send contract — the consumer that was missing', () => {
  it('★ recognises the daemon\'s parked-send shape', () => {
    // chat-commands-write.ts emits exactly this.
    expect(isQueuedSendResult({ success: true, sent: false, queued: true, submitted: false })).toBe(true)
    // cli-manager.ts mesh path.
    expect(isQueuedSendResult({ success: true, queued: true, queuedReason: 'agent_runtime_busy' })).toBe(true)
  })

  it('does not treat an ordinary submitted send as queued', () => {
    expect(isQueuedSendResult({ success: true, submitted: true })).toBe(false)
    expect(isQueuedSendResult({ success: true, sent: true })).toBe(false)
    // A force-send explicitly un-queues itself.
    expect(isQueuedSendResult({ success: true, forceSent: true, queued: false })).toBe(false)
    expect(isQueuedSendResult(null)).toBe(false)
    expect(isQueuedSendResult(undefined)).toBe(false)
  })
})

describe('optimistic bubble — appears immediately', () => {
  it('★ renders the owner\'s message before any echo exists', () => {
    // This is the whole point: at submit time the tail has no user bubble yet,
    // because the daemon has not answered and may not for tens of seconds.
    const tail = [assistantMsg('previous answer')]
    const out = withPendingLocalMessage(tail, pending('deploy the thing'), SENT_AT)

    expect(out).toHaveLength(2)
    expect(String(out[1].content)).toBe('deploy the thing')
    expect(String(out[1].role)).toBe('user')
  })

  it('marks a queued bubble so the pane can show it as waiting', () => {
    const out = withPendingLocalMessage([], pending('later', { queued: true }), SENT_AT)
    expect((out[0] as any).meta).toMatchObject({ pendingLocal: true, queued: true })
  })

  it('is a no-op for an absent or blank pending message', () => {
    const tail = [assistantMsg('a')]
    // Reference equality preserved so React can short-circuit the common path.
    expect(withPendingLocalMessage(tail, null, SENT_AT)).toBe(tail)
    expect(withPendingLocalMessage(tail, pending('   '), SENT_AT)).toBe(tail)
  })
})

describe('★ DUPLICATE PREVENTION — the echo must retire the optimistic bubble', () => {
  it('★ does NOT double-render once the daemon echoes the same text back', () => {
    // The daemon's runtime_input_ack bubble has landed. If the optimistic
    // bubble also rendered, the owner would see their message twice.
    const tail = [assistantMsg('earlier'), userMsg('deploy the thing')]
    const out = withPendingLocalMessage(tail, pending('deploy the thing'), SENT_AT)

    expect(out).toBe(tail)
    expect(out.filter(m => String(m.content) === 'deploy the thing')).toHaveLength(1)
  })

  it('★ matches the echo despite surrounding whitespace differences', () => {
    // The client trims before sending; the daemon trims before acking. Matching
    // on raw text would miss and duplicate.
    expect(hasEchoedPendingMessage([userMsg('  deploy the thing  ')], pending('deploy the thing'))).toBe(true)
    expect(hasEchoedPendingMessage([userMsg('deploy the thing')], pending('  deploy the thing  '))).toBe(true)
  })

  it('★ survives the realistic sequence: append → echo arrives → still one bubble', () => {
    const p = pending('run the tests')

    // T0: submitted, nothing echoed. One bubble, from us.
    const atSubmit = withPendingLocalMessage([assistantMsg('ok')], p, SENT_AT)
    expect(atSubmit).toHaveLength(2)

    // T1: the daemon's ack lands in the tail (this is the echo).
    const withEcho = [assistantMsg('ok'), userMsg('run the tests')]
    const afterEcho = withPendingLocalMessage(withEcho, p, SENT_AT + 5_000)

    // Exactly one user bubble, and it is the daemon's — not two.
    expect(afterEcho).toHaveLength(2)
    expect(afterEcho.filter(m => String(m.role).toLowerCase() === 'user')).toHaveLength(1)

    // T2: the agent answers. Still no resurrection of the optimistic bubble.
    const later = [...withEcho, assistantMsg('done')]
    const afterAnswer = withPendingLocalMessage(later, p, SENT_AT + 30_000)
    expect(afterAnswer).toBe(later)
    expect(afterAnswer.filter(m => String(m.role).toLowerCase() === 'user')).toHaveLength(1)
  })

  it('does not mistake an ASSISTANT message of identical text for the echo', () => {
    // Only a user bubble can be the echo of a user send.
    const tail = [assistantMsg('deploy the thing')]
    const out = withPendingLocalMessage(tail, pending('deploy the thing'), SENT_AT)
    expect(out).toHaveLength(2)
  })

  it('does not suppress against a DIFFERENT user message', () => {
    const tail = [userMsg('something else entirely')]
    const out = withPendingLocalMessage(tail, pending('deploy the thing'), SENT_AT)
    expect(out).toHaveLength(2)
  })

  it('retires an expired bubble whose echo never arrived', () => {
    // Bounded so a send that died after daemon acceptance cannot pin a bubble
    // to the pane forever.
    const tail = [assistantMsg('a')]
    const stale = SENT_AT + PENDING_LOCAL_MESSAGE_MAX_AGE_MS + 1
    expect(withPendingLocalMessage(tail, pending('lost message'), stale)).toBe(tail)
    // ...but it is still shown well inside the window, including past the 35.5s
    // queue drain that was actually observed in production.
    expect(withPendingLocalMessage(tail, pending('lost message'), SENT_AT + 40_000)).toHaveLength(2)
  })
})
