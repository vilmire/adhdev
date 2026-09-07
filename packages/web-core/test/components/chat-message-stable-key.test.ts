import { describe, expect, it } from 'vitest'
import {
    buildChatMessageStableKeys,
    getChatMessageStableKey,
} from '../../src/components/ChatMessageList/chatMessageHelpers'
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

/**
 * ★ Turn-grained-only identity must not collapse a turn's bubbles.
 *
 * `ReplicatedTranscriptMessageV1.sequence` is `number | null` BY DESIGN ("null
 * means UNKNOWN, never 0"), and `transcript-chat-pane-adapter.ts` maps only
 * `turnKey` → `_turnKey`, deliberately leaving `bubbleId` (would itself collapse
 * the turn) and `providerUnitKey` (content hash, off the wire allow-list) unset.
 * So when a producer emits `turnKey` without a numeric `sequence`, the identity
 * composite reduces to `turn:<turnKey>` — shared by every bubble of the turn.
 *
 * Measured before the fix: 4 bubbles → 1 distinct key. React reconciles
 * duplicate-keyed siblings into each other, so the turn renders fewer rows than
 * it has and a surviving row can show another bubble's content ("중간 메시지 안
 * 보임 / 버블 뒤섞임").
 *
 * Injection check: reverting the turn-grained-only branch in
 * `getChatMessageStableKey` turns the first test red (distinct 1 ≠ 4).
 */
describe('getChatMessageStableKey — turn-grained-only identity (nullable sequence)', () => {
    const TURN_KEY = 'claude-code:native-turn:sess-1:7'

    /** One turn, four bubbles, shared `_turnKey`, NO per-message identity. */
    const turnBubbles = (): ChatMessage[] => ([
        { role: 'user', content: 'run the build', _turnKey: TURN_KEY },
        { role: 'assistant', content: 'Bash(npm run build)', _turnKey: TURN_KEY },
        { role: 'assistant', content: 'build output line', _turnKey: TURN_KEY },
        { role: 'assistant', content: 'The build passed.', _turnKey: TURN_KEY },
    ] as unknown as ChatMessage[])

    it('gives every bubble of one turn a DISTINCT key when sequence is absent', () => {
        const keys = turnBubbles().map((message, index) => getChatMessageStableKey(message, index))
        expect(
            new Set(keys).size,
            `all bubbles of one turn collapsed onto a shared React key: ${JSON.stringify(keys)}`,
        ).toBe(keys.length)
    })

    it('still carries the turn axis in the key', () => {
        for (const key of turnBubbles().map((m, i) => getChatMessageStableKey(m, i))) {
            expect(key).toContain(`turn:${TURN_KEY}`)
        }
    })

    // ── Negative control: the fallback fires ONLY when identity is turn-only ──
    it('does NOT change the key when a per-message field is present', () => {
        // The exact pre-fix format for a `_turnKey` + `sequence` bubble. A drift
        // here would remount every replica bubble (CHAT-FLAP-LONG-CONVO).
        const withSequence = { role: 'assistant', content: 'x', _turnKey: TURN_KEY, sequence: 3 }
        expect(getChatMessageStableKey(withSequence as unknown as ChatMessage, 0))
            .toBe(`turn:${TURN_KEY}|seq:3`)

        const withBubbleId = { role: 'assistant', content: 'x', _turnKey: TURN_KEY, bubbleId: 'b1' }
        expect(getChatMessageStableKey(withBubbleId as unknown as ChatMessage, 0))
            .toBe(`turn:${TURN_KEY}|bubble:b1`)
    })

    it('is position-independent and seam-stable across the live/history stores', () => {
        const bubble = {
            role: 'assistant',
            content: 'The build passed.',
            _turnKey: TURN_KEY,
            receivedAt: 1003,
        } as unknown as ChatMessage

        // Same bubble, different array positions (window shift / re-sort) and
        // read from either store — the key material is intrinsic, so it holds.
        expect(getChatMessageStableKey(bubble, 9)).toBe(getChatMessageStableKey(bubble, 0))
        expect(getChatMessageStableKey({ ...bubble } as ChatMessage, 4))
            .toBe(getChatMessageStableKey(bubble, 0))
    })
})

/**
 * ★ Same-content siblings: the residual collision the per-message key CANNOT
 * close, and which `buildChatMessageStableKeys` exists for.
 *
 * `getChatMessageStableKey`'s derived tiers discriminate on role + content-hash
 * + timestamp. Two bubbles of one turn that match on ALL of those still collapse
 * onto one key. Measured before the fix:
 *   { role:'assistant', content:'same', _turnKey:'_turn' } × 2
 *   → both `turn:_turn|role:assistant|chash:yjccrj`.
 *
 * Reachable, not theoretical: daemon-core's
 * `collapseAdjacentDuplicateChatMessages` collapses only ADJACENT duplicates —
 * its own suite pins that `A, B, A` within one turn survives as three messages
 * ("only collapses *adjacent* duplicates"). With no numeric `sequence`, bubbles
 * 1 and 3 then render under one React key and React reconciles them together.
 *
 * Injection check: deleting the `|dup:N` suffixing in
 * `buildChatMessageStableKeys` (i.e. `return baseKeys`) turns the first two
 * tests here red, while every test above stays green.
 */
describe('buildChatMessageStableKeys — same-content sibling collision', () => {
    const TURN_KEY = 'claude-code:native-turn:sess-1:7'

    it('gives unique keys to two siblings identical in turn, role, content AND timestamp', () => {
        const siblings = [
            { role: 'assistant', content: 'same', _turnKey: TURN_KEY, receivedAt: 5 },
            { role: 'assistant', content: 'same', _turnKey: TURN_KEY, receivedAt: 5 },
        ] as unknown as ChatMessage[]

        // Pre-condition: the per-message key genuinely cannot tell them apart.
        expect(getChatMessageStableKey(siblings[0], 0))
            .toBe(getChatMessageStableKey(siblings[1], 1))

        const keys = buildChatMessageStableKeys(siblings)
        expect(new Set(keys).size, `siblings collided: ${JSON.stringify(keys)}`).toBe(2)
    })

    it('separates the surviving A,B,A duplicates that adjacent-collapse leaves behind', () => {
        // The exact shape daemon-core's collapse test pins as surviving.
        const turn = [
            { role: 'assistant', content: 'A', _turnKey: TURN_KEY },
            { role: 'assistant', content: 'B', _turnKey: TURN_KEY },
            { role: 'assistant', content: 'A', _turnKey: TURN_KEY },
        ] as unknown as ChatMessage[]

        const keys = buildChatMessageStableKeys(turn)
        expect(new Set(keys).size, `A,B,A collapsed: ${JSON.stringify(keys)}`).toBe(3)
    })

    it('also separates same-content siblings that carry NO identity at all', () => {
        const legacy = [
            { role: 'assistant', content: 'same' },
            { role: 'assistant', content: 'same' },
        ] as ChatMessage[]
        expect(new Set(buildChatMessageStableKeys(legacy)).size).toBe(2)
    })

    // ── Negative control: non-colliding keys must be returned UNCHANGED ──────
    it('leaves every already-unique key byte-identical (no remount)', () => {
        const messages = [
            { role: 'user', content: 'q', _turnKey: TURN_KEY, sequence: 1 },
            { role: 'assistant', content: 'a', _turnKey: TURN_KEY, sequence: 2 },
            { role: 'assistant', content: 'legacy tail' },
            { role: 'assistant', content: 'x', id: 'bubble-42' },
        ] as unknown as ChatMessage[]

        expect(buildChatMessageStableKeys(messages))
            .toEqual(messages.map((m, i) => getChatMessageStableKey(m, i)))
        // And specifically: no ordinal suffix leaked onto a unique key.
        for (const key of buildChatMessageStableKeys(messages)) {
            expect(key).not.toContain('|dup:')
        }
    })

    it('keeps `sequence`-bearing bubbles on their exact pre-fix key format', () => {
        const withSequence = [
            { role: 'assistant', content: 'x', _turnKey: TURN_KEY, sequence: 3 },
        ] as unknown as ChatMessage[]
        expect(buildChatMessageStableKeys(withSequence)).toEqual([`turn:${TURN_KEY}|seq:3`])
    })

    /**
     * Seam stability: the same bubble must key identically whether it arrives
     * from the live store or the history store. Both feed ONE merged array here,
     * and the ordinal is derived within the duplicate group — whose members never
     * reorder, because the chronological sort is stable on original index and
     * windowing only drops from the head.
     */
    it('is seam-stable: the same bubble keys identically from either store', () => {
        const fromHistory = { role: 'assistant', content: 'The build passed.', _turnKey: TURN_KEY, receivedAt: 1003 }
        const fromLive = { ...fromHistory }

        const historyRender = buildChatMessageStableKeys([
            { role: 'user', content: 'run the build', _turnKey: TURN_KEY, receivedAt: 1000 },
            fromHistory,
        ] as unknown as ChatMessage[])
        const liveRender = buildChatMessageStableKeys([
            { role: 'user', content: 'run the build', _turnKey: TURN_KEY, receivedAt: 1000 },
            fromLive,
        ] as unknown as ChatMessage[])

        expect(liveRender[1]).toBe(historyRender[1])
    })

    it('is stable under a head-windowing shift that keeps the duplicate group intact', () => {
        const dupA = { role: 'assistant', content: 'same', _turnKey: TURN_KEY }
        const dupB = { role: 'assistant', content: 'same', _turnKey: TURN_KEY }

        // Before: an older message precedes the pair. After: it is windowed out.
        const before = buildChatMessageStableKeys([
            { role: 'user', content: 'older', _turnKey: 'turn-0' },
            dupA,
            dupB,
        ] as unknown as ChatMessage[])
        const after = buildChatMessageStableKeys([dupA, dupB] as unknown as ChatMessage[])

        // Dropping a NON-member of the duplicate group does not renumber it —
        // the ordinal is group-relative, not list-relative.
        expect(after).toEqual(before.slice(1))
    })
})
