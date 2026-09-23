import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    mintMessageId,
    isMessageId,
    isOutboundMessage,
    isOutboundMessageOrigin,
    isSendPolicy,
    isSendPolicyMode,
    isSendRefusal,
    isSubmitOutcome,
    isInputEnvelopeWire,
    OUTBOUND_MESSAGE_ORIGINS,
    SEND_POLICY_MODES,
    SEND_REFUSAL_REASONS,
    type OutboundMessage,
    type OutboundMessageOrigin,
    type SendPolicy,
} from '../src/outbound-message'

function envelope(text: string) {
    return { parts: [{ type: 'text' as const, text }], textFallback: text }
}

function baseMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
        messageId: mintMessageId(),
        sessionId: 'sess_1',
        input: envelope('hello'),
        origin: 'dashboard',
        policy: { mode: 'queue' },
        createdAt: Date.now(),
        ...overrides,
    }
}

describe('mintMessageId', () => {
    it('mints unique, prefixed ids', () => {
        const a = mintMessageId()
        const b = mintMessageId()
        expect(a).not.toBe(b)
        expect(isMessageId(a)).toBe(true)
        expect(isMessageId(b)).toBe(true)
        expect(a.startsWith('msg_')).toBe(true)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('falls back to a counter when crypto.randomUUID is unavailable', () => {
        // `globalThis.crypto` is a getter-only accessor in this runtime, so a
        // plain assignment throws — stub it instead of reassigning directly.
        vi.stubGlobal('crypto', undefined)
        const id = mintMessageId(1_700_000_000_000)
        expect(isMessageId(id)).toBe(true)
        expect(id.startsWith('msg_1700000000000_')).toBe(true)
    })

    it('isMessageId rejects non-conforming values', () => {
        expect(isMessageId('')).toBe(false)
        expect(isMessageId('msg_')).toBe(false)
        expect(isMessageId('not-prefixed')).toBe(false)
        expect(isMessageId(undefined)).toBe(false)
        expect(isMessageId(42)).toBe(false)
    })
})

describe('origin/policy/refusal guards — closed unions stay closed', () => {
    it('every declared origin round-trips through the guard', () => {
        for (const origin of OUTBOUND_MESSAGE_ORIGINS) {
            expect(isOutboundMessageOrigin(origin)).toBe(true)
        }
        expect(isOutboundMessageOrigin('unknown-origin')).toBe(false)
        expect(isOutboundMessageOrigin(undefined)).toBe(false)
    })

    it('every declared policy mode round-trips through the guard', () => {
        for (const mode of SEND_POLICY_MODES) {
            const policy: SendPolicy = { mode }
            expect(isSendPolicyMode(mode)).toBe(true)
            expect(isSendPolicy(policy)).toBe(true)
        }
        expect(isSendPolicyMode('force')).toBe(false)
        expect(isSendPolicy({ mode: 'force' })).toBe(false)
        expect(isSendPolicy(null)).toBe(false)
        expect(isSendPolicy({})).toBe(false)
    })

    it('every declared refusal reason round-trips through the guard', () => {
        for (const reason of SEND_REFUSAL_REASONS) {
            expect(isSendRefusal(reason)).toBe(true)
        }
        expect(isSendRefusal('made_up_reason')).toBe(false)
        expect(isSendRefusal(undefined)).toBe(false)
    })

    it('rejects an origin nothing declares (closed-union drift guard)', () => {
        const bogus: unknown = 'websocket'
        expect(isOutboundMessageOrigin(bogus)).toBe(false)
    })
})

describe('isSubmitOutcome', () => {
    it('accepts every SubmitOutcome member shape', () => {
        expect(isSubmitOutcome({ kind: 'delivered' })).toBe(true)
        expect(isSubmitOutcome({ kind: 'queued', position: 0 })).toBe(true)
        expect(isSubmitOutcome({ kind: 'duplicate', of: 'msg_abc' })).toBe(true)
        expect(isSubmitOutcome({ kind: 'refused', reason: 'not_ready' })).toBe(true)
    })

    it('rejects a member missing its required field', () => {
        expect(isSubmitOutcome({ kind: 'queued' })).toBe(false)
        expect(isSubmitOutcome({ kind: 'duplicate' })).toBe(false)
        expect(isSubmitOutcome({ kind: 'refused' })).toBe(false)
        expect(isSubmitOutcome({ kind: 'refused', reason: 'not_a_real_reason' })).toBe(false)
    })

    it('rejects non-outcome values', () => {
        expect(isSubmitOutcome(null)).toBe(false)
        expect(isSubmitOutcome(undefined)).toBe(false)
        expect(isSubmitOutcome({ kind: 'success' })).toBe(false)
        expect(isSubmitOutcome('delivered')).toBe(false)
    })
})

describe('isInputEnvelopeWire', () => {
    it('accepts a text-only envelope', () => {
        expect(isInputEnvelopeWire(envelope('hi'))).toBe(true)
    })

    it('accepts an envelope with an image part (attachment case)', () => {
        expect(isInputEnvelopeWire({
            parts: [
                { type: 'image', mimeType: 'image/png', data: 'YWJj' },
                { type: 'text', text: 'caption' },
            ],
            textFallback: 'caption',
        })).toBe(true)
    })

    it('rejects a malformed envelope', () => {
        expect(isInputEnvelopeWire({ parts: [{ type: 'bogus' }], textFallback: '' })).toBe(false)
        expect(isInputEnvelopeWire({ parts: [], textFallback: 5 })).toBe(false)
        expect(isInputEnvelopeWire({ textFallback: 'no parts array' })).toBe(false)
        expect(isInputEnvelopeWire(null)).toBe(false)
    })
})

describe('isOutboundMessage', () => {
    it('accepts a fully-formed message for every origin', () => {
        for (const origin of OUTBOUND_MESSAGE_ORIGINS as readonly OutboundMessageOrigin[]) {
            expect(isOutboundMessage(baseMessage({ origin }))).toBe(true)
        }
    })

    it('accepts the optional meshAttemptRef when present, and without it', () => {
        expect(isOutboundMessage(baseMessage())).toBe(true)
        expect(isOutboundMessage(baseMessage({ meshAttemptRef: 'task_123' }))).toBe(true)
    })

    it('rejects a message with a non-minted messageId', () => {
        const bad = { ...baseMessage(), messageId: 'not-minted-by-this-module' }
        expect(isOutboundMessage(bad)).toBe(false)
    })

    it('rejects a message missing sessionId', () => {
        const bad = { ...baseMessage(), sessionId: '' }
        expect(isOutboundMessage(bad)).toBe(false)
    })

    it('rejects a message with an invalid input envelope', () => {
        const bad = { ...baseMessage(), input: { parts: 'not-an-array', textFallback: '' } }
        expect(isOutboundMessage(bad)).toBe(false)
    })

    it('rejects a message with an unrecognized origin', () => {
        const bad = { ...baseMessage(), origin: 'websocket' }
        expect(isOutboundMessage(bad)).toBe(false)
    })

    it('rejects a message with a malformed policy', () => {
        const bad = { ...baseMessage(), policy: { mode: 'force' } }
        expect(isOutboundMessage(bad)).toBe(false)
    })

    it('rejects non-object values', () => {
        expect(isOutboundMessage(null)).toBe(false)
        expect(isOutboundMessage(undefined)).toBe(false)
        expect(isOutboundMessage('message')).toBe(false)
    })
})
