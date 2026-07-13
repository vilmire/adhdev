import { describe, expect, it } from 'vitest'
import { getChatMessageStableKey } from '../../src/components/ChatMessageList/chatMessageHelpers'
import type { ChatMessage } from '../../src/types'

/**
 * CHAT-FLAP-LONG-CONVO regression: the React key for a chat bubble must be
 * position-independent. In a long chat, sending a user message windows and
 * re-sorts the message list (buildVisibleConversationMessages), renumbering
 * array positions. If the key depended on the array index, a legacy (no-id)
 * assistant bubble would change keys across a send → unmount+remount flash.
 */
describe('getChatMessageStableKey', () => {
    it('keeps the same key for a legacy assistant bubble when the array position shifts', () => {
        const legacyAssistant: ChatMessage = {
            role: 'assistant',
            content: 'Here is a long rescued transcript answer that carries no id.',
        }
        // Same message, different array positions (simulating a window shift /
        // re-sort after a user-send append).
        const keyBefore = getChatMessageStableKey(legacyAssistant, 3)
        const keyAfter = getChatMessageStableKey(legacyAssistant, 7)
        expect(keyAfter).toBe(keyBefore)
    })

    it('does not embed the array index anywhere in the returned key', () => {
        const legacyAssistant: ChatMessage = {
            role: 'assistant',
            content: 'no-identity legacy bubble',
        }
        const key = getChatMessageStableKey(legacyAssistant, 42)
        expect(key).not.toContain('42')
        expect(key).not.toContain('fallback:')
    })

    it('produces distinct keys for distinct legacy content', () => {
        const a: ChatMessage = { role: 'assistant', content: 'first answer' }
        const b: ChatMessage = { role: 'assistant', content: 'second answer' }
        expect(getChatMessageStableKey(a, 0)).not.toBe(getChatMessageStableKey(b, 1))
    })

    it('distinguishes same-content messages by role', () => {
        const asUser: ChatMessage = { role: 'user', content: 'echo' }
        const asAssistant: ChatMessage = { role: 'assistant', content: 'echo' }
        expect(getChatMessageStableKey(asUser, 0)).not.toBe(getChatMessageStableKey(asAssistant, 1))
    })

    it('disambiguates identical-content bubbles by timestamp when present', () => {
        const a: ChatMessage = { role: 'assistant', content: 'same text', receivedAt: 1000 }
        const b: ChatMessage = { role: 'assistant', content: 'same text', receivedAt: 2000 }
        expect(getChatMessageStableKey(a, 0)).not.toBe(getChatMessageStableKey(b, 1))
    })

    it('prefers intrinsic identity (id) over the content fallback and stays position-stable', () => {
        const withId: ChatMessage = { role: 'assistant', content: 'x', id: 'bubble-42' }
        const keyBefore = getChatMessageStableKey(withId, 1)
        const keyAfter = getChatMessageStableKey(withId, 99)
        expect(keyBefore).toBe(keyAfter)
        expect(keyBefore).toContain('id:bubble-42')
    })

    it('uses bubbleId / providerUnitKey / sequence identity when present', () => {
        expect(getChatMessageStableKey({ role: 'assistant', content: 'x', bubbleId: 'b1' }, 0))
            .toContain('bubble:b1')
        expect(getChatMessageStableKey({ role: 'assistant', content: 'x', providerUnitKey: 'u1' }, 0))
            .toContain('unit:u1')
        expect(getChatMessageStableKey({ role: 'assistant', content: 'x', sequence: 5 }, 0))
            .toContain('seq:5')
    })

    it('simulated user-send append: preceding legacy bubble keeps its key across window+re-sort', () => {
        const assistant: ChatMessage = { role: 'assistant', content: 'legacy rescued reply', receivedAt: 1500 }

        // Before the send: assistant sits at some windowed index.
        const listBefore: ChatMessage[] = [
            { role: 'user', content: 'q1', receivedAt: 1000 },
            assistant,
        ]
        // After the send: window shifted (older message dropped) + new user
        // message appended + chronological re-sort → assistant now at index 0.
        const listAfter: ChatMessage[] = [
            assistant,
            { role: 'user', content: 'q2', receivedAt: 2000 },
        ]

        const keyBefore = getChatMessageStableKey(listBefore[1], listBefore.indexOf(assistant))
        const keyAfter = getChatMessageStableKey(listAfter[0], listAfter.indexOf(assistant))
        expect(keyAfter).toBe(keyBefore)
    })
})
