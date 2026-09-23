/**
 * SessionInputService — the one send funnel (wiring-unification D2/D3/D5).
 *
 * What this suite pins, at the service boundary (not per caller):
 *   1. The busy decision: every origin × every policy × every status class
 *      produces the expected SubmitOutcome (the literal table below IS the spec).
 *   2. One dedupe keyed by messageId: the same id from two origins, or twice
 *      concurrently, yields exactly one delivery; a refusal is not remembered.
 *   3. The triple-bubble class: image + queue → send_now / interrupt promotions
 *      deliver the PARKED body exactly once, ack exactly once; a fresh
 *      send_now / interrupt (nothing parked) builds its body from msg.input.
 *   4. interrupt presses the stop key BEFORE it claims the parked body.
 *   5. Refusal shapes — typed, never thrown.
 *   6. The SessionInputPort (turn.deliver) goes through the same dedupe.
 */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage, OutboundMessageOrigin, SendPolicy, SubmitOutcome } from '@adhdev/mesh-shared'
import {
    BUSY_DECISION,
    createSessionInputService,
    type ClaimedSessionInput,
    type SessionInputPort,
    type SessionInputTarget,
} from '../../src/sessions/session-input-service.js'

// ─── A fake session with real FIFO semantics ────────────────────────────────

interface FakeSession {
    target: SessionInputTarget
    state: { status: string; platform: 'posix' | 'win32' }
    fifo: ClaimedSessionInput['entry'][]
    /** Ordinary (turn) writes, in order. */
    writes: string[]
    /** Split writes into the agent's own queue, in order. */
    splitWrites: string[]
    acks: { text: string; id?: string }[]
    events: string[]
    /** Simulate the driver's idle drain. */
    drain(): void
}

function fakeSession(status: string, extras: Partial<SessionInputTarget> = {}): FakeSession {
    const s: FakeSession = {
        state: { status, platform: 'posix' },
        fifo: [],
        writes: [],
        splitWrites: [],
        acks: [],
        events: [],
        drain() {
            while (s.state.status === 'idle' && s.fifo.length > 0) s.writes.push(s.fifo.shift()!.text)
        },
        target: undefined as unknown as SessionInputTarget,
    }
    s.target = {
        label: 'fake-cli',
        getStatus: () => ({ status: s.state.status }),
        buildBody: (input) => {
            const image = input.parts.some((p) => p.type === 'image')
            return image
                ? { text: `/tmp/adhdev-input-media/img.png\n${input.textFallback}`, bracketedPaste: true }
                : { text: input.textFallback }
        },
        async sendMessage(text, options) {
            s.events.push('send')
            if (s.state.status === 'idle') { s.writes.push(text); return { status: 'delivered' } }
            s.fifo.push({ messageId: options?.messageId ?? 'anon', text, ...(options?.bracketedPaste ? { bracketedPaste: true } : {}) })
            return { status: 'queued', position: s.fifo.length }
        },
        sendMessageDuringGeneration(text) {
            if (s.state.platform === 'win32') return { accepted: false, reason: 'platform_unsupported' }
            if (s.state.status !== 'generating') return { accepted: false, reason: 'not_generating' }
            s.splitWrites.push(text)
            return { accepted: true }
        },
        async interruptTurn() {
            s.events.push('stop')
            if (s.state.status !== 'generating') return { ok: false, reason: 'not_busy', message: 'not generating' }
            s.state.status = 'idle'
            return { ok: true, keyName: 'Ctrl-C', bytes: 1, confidence: 'declared' }
        },
        hasQueuedSend: (id) => s.fifo.some((e) => e.messageId === id),
        claimQueuedSend(id) {
            s.events.push('claim')
            const index = s.fifo.findIndex((e) => e.messageId === id)
            if (index < 0) return null
            const [entry] = s.fifo.splice(index, 1)
            return { entry, index }
        },
        restoreQueuedSend(claimed) {
            s.events.push('restore')
            s.fifo.splice(claimed.index, 0, claimed.entry)
        },
        reserveDrain: () => { s.events.push('reserve') },
        releaseDrain: () => { s.events.push('release') },
        recordAcknowledgedUserInput(input, id) { s.acks.push({ text: input.textFallback, ...(id ? { id } : {}) }) },
        ...extras,
    }
    return s
}

function msg(overrides: Partial<OutboundMessage> & { text?: string; image?: boolean } = {}): OutboundMessage {
    const text = overrides.text ?? 'hello agent'
    const parts: OutboundMessage['input']['parts'] = overrides.image
        ? [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'text', text }]
        : [{ type: 'text', text }]
    const { text: _t, image: _i, ...rest } = overrides
    return {
        messageId: 'msg_1',
        sessionId: 's1',
        input: { parts, textFallback: text },
        origin: 'dashboard',
        policy: { mode: 'queue' },
        createdAt: 1,
        ...rest,
    }
}

function serviceOver(session: FakeSession) {
    return createSessionInputService({ resolveSession: (id) => (id === 's1' ? session.target : null), interrupt: { timeoutMs: 500, pollMs: 5 } })
}

// ─── 1. The busy decision matrix ────────────────────────────────────────────

const ORIGINS: OutboundMessageOrigin[] = ['dashboard', 'mcp', 'mesh', 'api', 'cli']
const MODES: SendPolicy['mode'][] = ['queue', 'send_now', 'interrupt']
const CLASS_SAMPLES = { ready: 'idle', working: 'generating', blocked: 'waiting_approval', dead: 'stopped' } as const

/** THE SPEC — expected `SubmitOutcome` per policy × class (origin must not matter). */
const EXPECTED: Record<SendPolicy['mode'], Record<keyof typeof CLASS_SAMPLES, Partial<SubmitOutcome>>> = {
    queue: {
        ready: { kind: 'delivered', route: 'pty' },
        working: { kind: 'queued', position: 1, route: 'pty' },
        blocked: { kind: 'queued', position: 1, route: 'pty' },
        dead: { kind: 'refused', reason: 'session_exited' },
    },
    send_now: {
        ready: { kind: 'delivered', route: 'pty' },
        working: { kind: 'delivered', route: 'agent_queue' },
        blocked: { kind: 'refused', reason: 'modal_parked' },
        dead: { kind: 'refused', reason: 'session_exited' },
    },
    interrupt: {
        ready: { kind: 'delivered', route: 'pty' },
        working: { kind: 'delivered', route: 'interrupt' },
        blocked: { kind: 'refused', reason: 'modal_parked' },
        dead: { kind: 'refused', reason: 'session_exited' },
    },
}

describe('SessionInputService — busy decision: origin × policy × status class', () => {
    const cells: [OutboundMessageOrigin, SendPolicy['mode'], keyof typeof CLASS_SAMPLES][] = []
    for (const origin of ORIGINS) for (const mode of MODES) for (const cls of Object.keys(CLASS_SAMPLES) as (keyof typeof CLASS_SAMPLES)[]) cells.push([origin, mode, cls])

    it('covers 5 origins × 3 policies × 4 classes = 60 cells', () => {
        expect(cells).toHaveLength(60)
    })

    it.each(cells)('%s / %s / %s', async (origin, mode, cls) => {
        const session = fakeSession(CLASS_SAMPLES[cls])
        const outcome = await serviceOver(session).submit(msg({ origin, policy: { mode } as SendPolicy }))
        const expected = EXPECTED[mode][cls]
        expect(outcome).toMatchObject(expected)
        const succeeded = outcome.kind === 'delivered' || outcome.kind === 'queued'
        // The ack is stamped exactly once on a successful fresh submit, never on a refusal.
        expect(session.acks).toEqual(succeeded ? [{ text: 'hello agent', id: 'msg_1' }] : [])
        // Exactly one body reached the session on success; none on refusal.
        const bodies = session.writes.length + session.splitWrites.length + session.fifo.length
        expect(bodies).toBe(succeeded ? 1 : 0)
        // A refusal carries a human message and is never a throw.
        if (outcome.kind === 'refused') expect(typeof outcome.message).toBe('string')
    })

    it('the decision table covers the unknown class (fails safe to the driver primitives)', () => {
        expect(BUSY_DECISION.queue.unknown).toBe('write')
        expect(BUSY_DECISION.send_now.unknown).toBe('split_write')
        expect(BUSY_DECISION.interrupt.unknown).toBe('interrupt')
    })

    it('unknown status + send_now: the driver refuses, nothing written', async () => {
        const session = fakeSession('some_new_status')
        const outcome = await serviceOver(session).submit(msg({ policy: { mode: 'send_now' } }))
        expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_generating' })
        expect(session.splitWrites).toEqual([])
    })
})

// ─── 2. One dedupe, keyed by messageId ──────────────────────────────────────

describe('SessionInputService — messageId dedupe', () => {
    it('the same messageId from two origins → exactly one delivery', async () => {
        const session = fakeSession('idle')
        const svc = serviceOver(session)
        const first = await svc.submit(msg({ origin: 'dashboard' }))
        const second = await svc.submit(msg({ origin: 'mesh' }))
        expect(first).toMatchObject({ kind: 'delivered' })
        expect(second).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.writes).toEqual(['hello agent'])
        expect(session.acks).toHaveLength(1)
    })

    it('two CONCURRENT submits of one messageId → one write; the second awaits and is duplicate', async () => {
        const session = fakeSession('idle')
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        const original = session.target.sendMessage
        session.target.sendMessage = async (text, o) => { await gate; return original(text, o) }
        const svc = serviceOver(session)
        const a = svc.submit(msg({ origin: 'mcp' }))
        const b = svc.submit(msg({ origin: 'api' }))
        release()
        expect(await a).toMatchObject({ kind: 'delivered' })
        expect(await b).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.writes).toHaveLength(1)
    })

    it('a redelivery while the body is still parked is a duplicate (driver FIFO membership)', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        expect(await svc.submit(msg())).toMatchObject({ kind: 'queued', position: 1 })
        expect(await svc.submit(msg({ origin: 'mesh' }))).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.fifo).toHaveLength(1)
        // Busy → queue → delivered on the idle edge, exactly once.
        session.state.status = 'idle'
        session.drain()
        expect(session.writes).toEqual(['hello agent'])
        expect(await svc.submit(msg())).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.writes).toHaveLength(1)
    })

    it('a parked body is caught by FIFO membership even by a fresh service (no settled memory)', async () => {
        const session = fakeSession('generating')
        await serviceOver(session).submit(msg())
        expect(await serviceOver(session).submit(msg())).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.fifo).toHaveLength(1)
    })

    it('a refusal is NOT remembered — a retry of the same messageId goes through', async () => {
        const session = fakeSession('stopped')
        const svc = serviceOver(session)
        expect(await svc.submit(msg())).toMatchObject({ kind: 'refused', reason: 'session_exited' })
        session.state.status = 'idle'
        expect(await svc.submit(msg())).toMatchObject({ kind: 'delivered' })
        expect(session.writes).toEqual(['hello agent'])
    })

    it('different messageIds are independent sends, even with identical text', async () => {
        const session = fakeSession('idle')
        const svc = serviceOver(session)
        await svc.submit(msg({ messageId: 'msg_a', text: 'continue' }))
        await svc.submit(msg({ messageId: 'msg_b', text: 'continue' }))
        expect(session.writes).toEqual(['continue', 'continue'])
    })

    it('withdraw removes the parked body exactly, and frees the id for a fresh send', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        await svc.submit(msg({ messageId: 'msg_keep', text: 'continue' }))
        await svc.submit(msg({ messageId: 'msg_cancel', text: 'continue' }))
        expect(await svc.withdraw('s1', 'msg_cancel')).toEqual({ removed: true })
        expect(await svc.withdraw('s1', 'msg_cancel')).toEqual({ removed: false })
        expect(session.fifo.map((e) => e.messageId)).toEqual(['msg_keep'])
        expect(await svc.findParkedMessageIdByText('s1', 'continue')).toBe('msg_keep')
    })
})

// ─── 3/4. Image + send_now + interrupt (the triple-bubble class) ───────────

describe('SessionInputService — image × send_now × interrupt', () => {
    it('image queued → send_now with the SAME id: the parked image body is split-written once, acked once', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        expect(await svc.submit(msg({ image: true, text: 'look' }))).toMatchObject({ kind: 'queued' })
        const promoted = await svc.submit(msg({ image: true, text: 'look', policy: { mode: 'send_now' } }))
        expect(promoted).toEqual({ kind: 'delivered', route: 'agent_queue' })
        expect(session.splitWrites).toEqual(['/tmp/adhdev-input-media/img.png\nlook'])
        expect(session.fifo).toEqual([])
        expect(session.acks).toEqual([{ text: 'look', id: 'msg_1' }])
        // The drain has nothing left to deliver a second turn from.
        session.state.status = 'idle'
        session.drain()
        expect(session.writes).toEqual([])
    })

    it('image queued → interrupt with the SAME id: stop key BEFORE claim, the parked image body written once, acked once', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        await svc.submit(msg({ image: true, text: 'look' }))
        session.events.length = 0
        const outcome = await svc.submit(msg({ image: true, text: 'look', policy: { mode: 'interrupt' } }))
        expect(outcome).toMatchObject({ kind: 'delivered', route: 'interrupt', interrupt: { keyName: 'Ctrl-C' } })
        // ★ interrupt-before-claim ordering (an interruptTurn refusal leaves the parked copy untouched).
        expect(session.events.slice(0, 4)).toEqual(['stop', 'claim', 'reserve', 'send'])
        expect(session.events.at(-1)).toBe('release')
        expect(session.writes).toEqual(['/tmp/adhdev-input-media/img.png\nlook'])
        expect(session.acks).toHaveLength(1)
    })

    it('an interrupt refused by the provider leaves the parked copy in place (nothing claimed)', async () => {
        const session = fakeSession('generating', {
            async interruptTurn() { return { ok: false, reason: 'stop_keys_empty', message: 'no stop key' } },
        })
        const svc = serviceOver(session)
        await svc.submit(msg({ image: true }))
        const outcome = await svc.submit(msg({ image: true, policy: { mode: 'interrupt' } }))
        expect(outcome).toMatchObject({ kind: 'refused', reason: 'interrupt_refused', restored: true })
        expect(session.events).not.toContain('claim')
        expect(session.fifo).toHaveLength(1)
    })

    it('fallback (nothing parked): a fresh send_now image builds its body from msg.input, not text-only', async () => {
        const session = fakeSession('generating')
        const outcome = await serviceOver(session).submit(msg({ image: true, text: 'fresh', policy: { mode: 'send_now' } }))
        expect(outcome).toEqual({ kind: 'delivered', route: 'agent_queue' })
        expect(session.splitWrites).toEqual(['/tmp/adhdev-input-media/img.png\nfresh'])
        expect(session.acks).toEqual([{ text: 'fresh', id: 'msg_1' }])
    })

    it('fallback (nothing parked): a fresh interrupt image writes the built body from msg.input', async () => {
        const session = fakeSession('generating')
        const outcome = await serviceOver(session).submit(msg({ image: true, text: 'fresh', policy: { mode: 'interrupt' } }))
        expect(outcome).toMatchObject({ kind: 'delivered', route: 'interrupt' })
        expect(session.writes).toEqual(['/tmp/adhdev-input-media/img.png\nfresh'])
    })

    it('send_now on a body the drain ALREADY wrote → duplicate, no second turn', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        await svc.submit(msg())
        session.state.status = 'idle'
        session.drain()
        session.state.status = 'generating'
        expect(await svc.submit(msg({ policy: { mode: 'send_now' } }))).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(await svc.submit(msg({ policy: { mode: 'interrupt' } }))).toEqual({ kind: 'duplicate', of: 'msg_1' })
        expect(session.events).not.toContain('stop')
        expect(session.writes).toHaveLength(1)
        expect(session.splitWrites).toHaveLength(0)
    })

    it('a refused split write restores the parked body IN PLACE (win32 guard)', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        await svc.submit(msg({ messageId: 'msg_ahead', text: 'ahead' }))
        await svc.submit(msg({ image: true }))
        session.state.platform = 'win32'
        const outcome = await svc.submit(msg({ image: true, policy: { mode: 'send_now' } }))
        expect(outcome).toMatchObject({ kind: 'refused', reason: 'platform_unsupported', restored: true })
        expect(session.fifo.map((e) => e.messageId)).toEqual(['msg_ahead', 'msg_1'])
        expect(session.splitWrites).toEqual([])
    })

    it('send_now on a parked body at an IDLE prompt writes the parked body as a turn (no re-ack)', async () => {
        const session = fakeSession('generating')
        const svc = serviceOver(session)
        await svc.submit(msg({ image: true, text: 'look' }))
        session.state.status = 'idle'
        expect(await svc.submit(msg({ image: true, text: 'look', policy: { mode: 'send_now' } }))).toEqual({ kind: 'delivered', route: 'pty' })
        expect(session.writes).toEqual(['/tmp/adhdev-input-media/img.png\nlook'])
        expect(session.acks).toHaveLength(1)
    })
})

// ─── 5. Refusal shapes ──────────────────────────────────────────────────────

describe('SessionInputService — refusals are typed outcomes, never throws', () => {
    it('no_target for an unknown session', async () => {
        expect(await serviceOver(fakeSession('idle')).submit(msg({ sessionId: 'nope' }))).toMatchObject({ kind: 'refused', reason: 'no_target' })
    })

    it('unsupported_input when the provider rejects the input (buildBody throws)', async () => {
        const session = fakeSession('idle', { buildBody: () => { throw new Error('Opencode does not support input type: image') } })
        const outcome = await serviceOver(session).submit(msg({ image: true }))
        expect(outcome).toEqual({ kind: 'refused', reason: 'unsupported_input', message: 'Opencode does not support input type: image' })
        expect(session.writes).toEqual([])
    })

    it('unsupported_input for a non-text part on a text-only target', async () => {
        const session = fakeSession('idle', { buildBody: undefined })
        expect(await serviceOver(session).submit(msg({ image: true }))).toMatchObject({ kind: 'refused', reason: 'unsupported_input' })
    })

    it('unsupported_input for an empty body', async () => {
        expect(await serviceOver(fakeSession('idle')).submit(msg({ text: '   ' }))).toMatchObject({ kind: 'refused', reason: 'unsupported_input' })
    })

    it('interrupt_not_implemented / not_supported for a target without the route', async () => {
        const session = fakeSession('generating', { interruptTurn: undefined, sendMessageDuringGeneration: undefined })
        const svc = serviceOver(session)
        expect(await svc.submit(msg({ messageId: 'msg_i', policy: { mode: 'interrupt' } }))).toMatchObject({ kind: 'refused', reason: 'interrupt_not_implemented' })
        expect(await svc.submit(msg({ messageId: 'msg_s', policy: { mode: 'send_now' } }))).toMatchObject({ kind: 'refused', reason: 'not_supported' })
    })

    it('internal_error (not a throw) when the write throws, and for a missing messageId', async () => {
        const session = fakeSession('idle', { async sendMessage() { throw new Error('pty gone') } })
        const svc = serviceOver(session)
        expect(await svc.submit(msg())).toMatchObject({ kind: 'refused', reason: 'internal_error', message: 'pty gone' })
        expect(await svc.submit(msg({ messageId: '' }))).toMatchObject({ kind: 'refused', reason: 'internal_error' })
    })

    it('session_exited (not a silent success) when the session dies during the interrupt wait', async () => {
        const session = fakeSession('generating', {
            async interruptTurn() { session.state.status = 'stopped'; return { ok: true, keyName: 'Ctrl-C', bytes: 1, confidence: 'declared' } },
        })
        const outcome = await serviceOver(session).submit(msg({ policy: { mode: 'interrupt' } }))
        expect(outcome).toMatchObject({ kind: 'refused', reason: 'session_exited', restored: false })
        expect(session.writes).toEqual([])
    })

    it('ACP: delivered through sendAcp; a refused prompt is a typed refusal; interrupt is not implemented', async () => {
        let accept = true
        const acp: SessionInputTarget = {
            getStatus: () => ({ status: 'idle' }),
            sendMessage: async () => ({ status: 'delivered' }),
            sendAcp: async () => (accept ? { success: true } : { success: false, error: 'prompt already in flight' }),
        }
        const svc = createSessionInputService({ resolveSession: () => acp })
        expect(await svc.submit(msg({ messageId: 'msg_a' }))).toEqual({ kind: 'delivered', route: 'acp' })
        accept = false
        expect(await svc.submit(msg({ messageId: 'msg_b' }))).toMatchObject({ kind: 'refused', message: 'prompt already in flight' })
        expect(await svc.submit(msg({ messageId: 'msg_c', policy: { mode: 'interrupt' } }))).toMatchObject({ kind: 'refused', reason: 'interrupt_not_implemented' })
    })
})

// ─── 6. The turn.deliver port shares the funnel ─────────────────────────────

describe('SessionInputPort — turn.deliver goes through the same funnel', () => {
    it('a mesh notice submitted through the port and the same id from the dashboard → one delivery', async () => {
        const session = fakeSession('idle')
        const svc = serviceOver(session)
        const port: SessionInputPort = svc
        expect(await port.submit(msg({ messageId: 'notify:w1:7', origin: 'mesh' }))).toMatchObject({ kind: 'delivered' })
        expect(await svc.submit(msg({ messageId: 'notify:w1:7', origin: 'dashboard' }))).toEqual({ kind: 'duplicate', of: 'notify:w1:7' })
        expect(session.writes).toHaveLength(1)
    })

})
