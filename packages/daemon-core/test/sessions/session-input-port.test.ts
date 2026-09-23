import { describe, expect, it, vi } from 'vitest'
import {
  createLegacySessionInputPort,
  type SessionInputPortDeps,
  type SessionInputTarget,
} from '../../src/sessions/session-input-port.js'
import type { OutboundMessage, SendPolicy } from '@adhdev/mesh-shared'
import { mintMessageId } from '@adhdev/mesh-shared'

// ─── Fakes ──────────────────────────────────────────────────────────────────

function makeTarget(overrides: Partial<SessionInputTarget> = {}): SessionInputTarget & {
  sendMessageCalls: { text: string; options?: { bracketedPaste?: boolean; claimKey?: string } }[]
  ackCalls: unknown[]
} {
  const sendMessageCalls: { text: string; options?: { bracketedPaste?: boolean; claimKey?: string } }[] = []
  const ackCalls: unknown[] = []
  return {
    sendMessageCalls,
    ackCalls,
    getStatus: () => ({ status: 'idle' }),
    async sendMessage(text, options) {
      sendMessageCalls.push({ text, options })
      return { status: 'delivered' }
    },
    recordAcknowledgedUserInput(input) {
      ackCalls.push(input)
    },
    ...overrides,
  }
}

function makeMsg(sessionId: string, policy: SendPolicy, text = 'hello'): OutboundMessage {
  return {
    messageId: mintMessageId(),
    sessionId,
    input: { parts: [{ type: 'text', text }], textFallback: text },
    origin: 'dashboard',
    policy,
    createdAt: Date.now(),
  }
}

function makeDeps(
  overrides: Partial<SessionInputPortDeps> & { target?: ReturnType<typeof makeTarget> } = {},
): SessionInputPortDeps & { target: ReturnType<typeof makeTarget> } {
  const { target: overrideTarget, ...depsOverrides } = overrides
  const target = overrideTarget ?? makeTarget()
  return {
    target,
    resolveSession: vi.fn(async () => target),
    interruptAndDeliver: vi.fn(async () => ({ ok: true as const, delivered: true, queued: false })),
    sendNowIntoAgentQueue: vi.fn(async () => ({ ok: true as const, claimed: 0 })),
    log: () => {},
    ...depsOverrides,
  }
}

// ─── queue policy ───────────────────────────────────────────────────────────

describe('SessionInputPort — policy.mode: queue', () => {
  it('delivers immediately on an idle session', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'delivered' })
    expect(deps.target.sendMessageCalls).toHaveLength(1)
    expect(deps.target.ackCalls).toHaveLength(1)
  })

  it('reports queued when the underlying sendMessage disposition is queued (busy session)', async () => {
    const target = makeTarget({
      getStatus: () => ({ status: 'generating' }),
      async sendMessage(text) {
        return { status: 'queued' }
      },
    })
    const deps = makeDeps({ target, resolveSession: vi.fn(async () => target) })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'queued', position: 1 })
  })

  it('break-once: a queue submit does NOT call interruptAndDeliver or sendNowIntoAgentQueue', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(deps.interruptAndDeliver).not.toHaveBeenCalled()
    expect(deps.sendNowIntoAgentQueue).not.toHaveBeenCalled()
  })
})

// ─── send_now policy ────────────────────────────────────────────────────────

describe('SessionInputPort — policy.mode: send_now', () => {
  it('delivers via sendNowIntoAgentQueue and stamps the ack', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'send_now' }))
    expect(outcome).toEqual({ kind: 'delivered' })
    expect(deps.sendNowIntoAgentQueue).toHaveBeenCalledTimes(1)
    expect(deps.target.ackCalls).toHaveLength(1)
  })

  it('maps a platform_unsupported refusal through', async () => {
    const deps = makeDeps({
      sendNowIntoAgentQueue: vi.fn(async () => ({
        ok: false as const,
        reason: 'platform_unsupported',
        message: 'win32',
        restored: true,
      })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'send_now' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'platform_unsupported' })
  })

  it('maps a not_generating refusal through', async () => {
    const deps = makeDeps({
      sendNowIntoAgentQueue: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_generating',
        message: 'idle',
        restored: true,
      })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'send_now' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_generating' })
  })

  it('break-once: a send_now submit does NOT call interruptAndDeliver, and does not stamp the ack on refusal', async () => {
    const deps = makeDeps({
      sendNowIntoAgentQueue: vi.fn(async () => ({
        ok: false as const,
        reason: 'send_in_flight',
        message: 'busy',
        restored: true,
      })),
    })
    const port = createLegacySessionInputPort(deps)
    await port.submit(makeMsg('s1', { mode: 'send_now' }))
    expect(deps.interruptAndDeliver).not.toHaveBeenCalled()
    expect(deps.target.ackCalls).toHaveLength(0)
  })
})

// ─── interrupt policy ───────────────────────────────────────────────────────

describe('SessionInputPort — policy.mode: interrupt', () => {
  it('delivers via interruptAndDeliver and stamps the ack', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'delivered' })
    expect(deps.interruptAndDeliver).toHaveBeenCalledTimes(1)
    expect(deps.target.ackCalls).toHaveLength(1)
  })

  it('reports queued when interruptAndDeliver re-parks the body (SEND-NOW-WRONG-ITEM race)', async () => {
    const deps = makeDeps({
      interruptAndDeliver: vi.fn(async () => ({ ok: true as const, delivered: false, queued: true })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'queued', position: 1 })
  })

  it('maps session_exited refusal through', async () => {
    const deps = makeDeps({
      interruptAndDeliver: vi.fn(async () => ({
        ok: false as const,
        reason: 'session_exited',
        message: 'gone',
      })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'session_exited' })
  })

  it('maps idle_timeout refusal through', async () => {
    const deps = makeDeps({
      interruptAndDeliver: vi.fn(async () => ({
        ok: false as const,
        reason: 'idle_timeout',
        message: 'never went idle',
      })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'idle_timeout' })
  })

  it('maps interrupt_not_implemented refusal through', async () => {
    const deps = makeDeps({
      interruptAndDeliver: vi.fn(async () => ({
        ok: false as const,
        reason: 'interrupt_not_implemented',
        message: 'no stop key',
      })),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'interrupt_not_implemented' })
  })

  it('break-once: an interrupt submit does NOT call sendNowIntoAgentQueue or plain sendMessage, and does not stamp the ack on refusal', async () => {
    const deps = makeDeps({
      interruptAndDeliver: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_busy',
        message: 'nothing to interrupt',
      })),
    })
    const port = createLegacySessionInputPort(deps)
    await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(deps.sendNowIntoAgentQueue).not.toHaveBeenCalled()
    expect(deps.target.sendMessageCalls).toHaveLength(0)
    expect(deps.target.ackCalls).toHaveLength(0)
  })
})

// ─── refusals not tied to a specific policy ───────────────────────────────

describe('SessionInputPort — refusals', () => {
  it('no_target when resolveSession returns null', async () => {
    const deps = makeDeps({ resolveSession: vi.fn(async () => null) })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('ghost', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'no_target' })
  })

  it('session_exited when the resolved target reports a dead status', async () => {
    const target = makeTarget({ getStatus: () => ({ status: 'exited' }) })
    const deps = makeDeps({ target, resolveSession: vi.fn(async () => target) })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'session_exited' })
    expect(target.sendMessageCalls).toHaveLength(0)
  })

  it('unsupported_input when the envelope has no usable text', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const msg = makeMsg('s1', { mode: 'queue' }, '')
    const outcome = await port.submit(msg)
    expect(outcome).toEqual({ kind: 'refused', reason: 'unsupported_input' })
  })

  it('unsupported_input when the envelope carries only a non-text part', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const msg: OutboundMessage = {
      messageId: mintMessageId(),
      sessionId: 's1',
      input: { parts: [{ type: 'image', mimeType: 'image/png', data: 'x' }], textFallback: '' },
      origin: 'dashboard',
      policy: { mode: 'queue' },
      createdAt: Date.now(),
    }
    const outcome = await port.submit(msg)
    expect(outcome).toEqual({ kind: 'refused', reason: 'unsupported_input' })
  })

  it('internal_error when resolveSession throws', async () => {
    const deps = makeDeps({
      resolveSession: vi.fn(async () => { throw new Error('registry boom') }),
    })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'internal_error' })
  })

  it('internal_error when the underlying send throws', async () => {
    const target = makeTarget({
      async sendMessage() { throw new Error('pty write failed') },
    })
    const deps = makeDeps({ target, resolveSession: vi.fn(async () => target) })
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'queue' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'internal_error' })
  })

  it('not_supported for send_now when deps.sendNowIntoAgentQueue is absent', async () => {
    const deps = makeDeps()
    // @ts-expect-error — deliberately simulate an embedder that omits it
    deps.sendNowIntoAgentQueue = undefined
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'send_now' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_supported' })
  })

  it('not_supported for interrupt when deps.interruptAndDeliver is absent', async () => {
    const deps = makeDeps()
    // @ts-expect-error — deliberately simulate an embedder that omits it
    deps.interruptAndDeliver = undefined
    const port = createLegacySessionInputPort(deps)
    const outcome = await port.submit(makeMsg('s1', { mode: 'interrupt' }))
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_supported' })
  })
})

// ─── messageId dedupe / idempotency ────────────────────────────────────────

describe('SessionInputPort — messageId dedupe', () => {
  it('a second submit with the same messageId returns duplicate and does not re-send', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const msg = makeMsg('s1', { mode: 'queue' })

    const first = await port.submit(msg)
    expect(first).toEqual({ kind: 'delivered' })
    expect(deps.target.sendMessageCalls).toHaveLength(1)

    const second = await port.submit(msg)
    expect(second).toEqual({ kind: 'duplicate', of: msg.messageId })
    expect(deps.target.sendMessageCalls).toHaveLength(1)
  })

  it('two CONCURRENT submits with the same messageId produce exactly one send: the first outcome wins, the second is duplicate', async () => {
    let resolveSend!: (v: { status: 'delivered' }) => void
    const sendPromise = new Promise<{ status: 'delivered' }>((resolve) => { resolveSend = resolve })
    const calls: { text: string }[] = []
    const target: SessionInputTarget = {
      getStatus: () => ({ status: 'idle' }),
      async sendMessage(text) {
        calls.push({ text })
        return sendPromise
      },
      recordAcknowledgedUserInput: () => {},
    }
    const deps = makeDeps({ resolveSession: vi.fn(async () => target) })
    const port = createLegacySessionInputPort(deps)
    const msg = makeMsg('s1', { mode: 'queue' })

    const p1 = port.submit(msg)
    const p2 = port.submit(msg)
    resolveSend({ status: 'delivered' })
    const [o1, o2] = await Promise.all([p1, p2])

    expect(calls).toHaveLength(1)
    expect(o1).toEqual({ kind: 'delivered' })
    expect(o2).toEqual({ kind: 'duplicate', of: msg.messageId })
  })

  it('different messageIds to the same session are independent sends', async () => {
    const deps = makeDeps()
    const port = createLegacySessionInputPort(deps)
    const a = await port.submit(makeMsg('s1', { mode: 'queue' }, 'first'))
    const b = await port.submit(makeMsg('s1', { mode: 'queue' }, 'second'))
    expect(a).toEqual({ kind: 'delivered' })
    expect(b).toEqual({ kind: 'delivered' })
    expect(deps.target.sendMessageCalls).toHaveLength(2)
  })

  it('break-once: a refused submit is remembered too (resubmitting the same messageId still dedupes, not re-attempted)', async () => {
    const deps = makeDeps({ resolveSession: vi.fn(async () => null) })
    const port = createLegacySessionInputPort(deps)
    const msg = makeMsg('ghost', { mode: 'queue' })
    const first = await port.submit(msg)
    expect(first).toEqual({ kind: 'refused', reason: 'no_target' })
    const second = await port.submit(msg)
    expect(second).toEqual({ kind: 'duplicate', of: msg.messageId })
    expect(deps.resolveSession).toHaveBeenCalledTimes(1)
  })
})
