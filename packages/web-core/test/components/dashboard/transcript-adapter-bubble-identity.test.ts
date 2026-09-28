/**
 * Replica-path bubble identity — one React key PER BUBBLE, not per turn.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * `turnKey` is TURN-grained: the producer increments it once per user message
 * (`chat-commands-read.ts` `turnIndex`), so every bubble of a multi-bubble turn
 * (user prompt → tool call → tool result → assistant answer) carries the SAME
 * `turnKey`. Both replica adapters used to map it onto `bubbleId` as a
 * stand-in for the richer identity the wire allow-list drops.
 *
 * That is not merely lossy — it is a correctness bug. `getChatMessageStableKey`
 * ranks `_turnKey` ABOVE `bubbleId` and both then held the same turn-grained
 * value, so all N bubbles of one turn collapsed onto ONE React key. React
 * treats duplicate sibling keys as the same element: bubbles get reconciled
 * into each other, so a turn renders fewer rows than it has, and the surviving
 * row can show another bubble's content after a re-render.
 *
 * On the keyed chat wire (design 2026-09-28 message-keyed storage) every
 * bubble carries the daemon ledger's opaque `messageId`, which the adapter
 * maps onto `id`/`messageId` — so the key is `mid:<messageId>`: per bubble,
 * and stable while the bubble's content grows (no content-hash fallback).
 *
 * The first test asserts the SET property (all keys distinct within a turn),
 * not a specific key format — an adapter is free to change how it derives
 * identity, but never free to make two distinct bubbles indistinguishable.
 */
import { describe, expect, it } from 'vitest'
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import { mapTranscriptViewToChatTailUpdate } from '../../../src/components/dashboard/transcript-chat-pane-adapter'
import { getChatMessageStableKey } from '../../../src/components/ChatMessageList/chatMessageHelpers'
import type { ChatMessage } from '../../../src/types'

const MAP_OPTIONS = { subscriptionKey: 'sub-1', stale: false }

const SHARED_TURN_KEY = 'claude-code:native-turn:sess-1:7'

/**
 * One turn, four bubbles, ONE shared `turnKey` — the exact shape the producer
 * emits and the shape that made every bubble collide. Contents differ so the
 * content-hash fallback in `getChatMessageStableKey` could distinguish them if
 * (and only if) the adapter stops forcing a turn-grained identity field.
 */
function snapshotWithMultiBubbleTurn(): ReplicatedTranscriptViewV2 {
    const message = (
        role: string,
        kind: string,
        content: string,
        receivedAt: number,
        n: number,
    ) => ({
        messageId: `n.0000beef.${n}.0`,
        ord: `a${n}`,
        rev: 1,
        role,
        kind,
        content,
        receivedAt,
        timestamp: null,
        turnKey: SHARED_TURN_KEY,
        bubbleState: 'final' as const,
        senderName: null,
        toolName: null,
        streaming: null,
        expandable: false,
        srcId: null,
    })

    return {
        schemaVersion: 2,
        historySessionId: null,
        providerSessionId: null,
        sessionId: 'sess-1',
        providerType: 'claude-code',
        producerDaemonId: 'daemon-a',
        producerWriterId: 'adhdev-writer-1',
        epoch: 'epoch-1',
        frame: 1,
        observedAt: '2026-09-05T00:00:00.000Z',
        status: 'idle',
        providerObservedStatus: null,
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: 'native-history', transcriptProvenance: null },
        messages: [
            message('user', 'standard', 'run the build', 1000, 1),
            message('assistant', 'tool', 'Bash(npm run build)', 1001, 2),
            message('assistant', 'terminal', 'build output line', 1002, 3),
            message('assistant', 'standard', 'The build passed.', 1003, 4),
        ],
        terminalMarkers: [],
        coverage: {
            mode: 'full',
            totalMessageCount: 4,
            returnedMessageCount: 4,
            omittedBefore: false,
        },
    } as unknown as ReplicatedTranscriptViewV2
}

describe('replica adapter — per-bubble React key identity', () => {
    it('gives every bubble of one multi-bubble turn a DISTINCT stable key', () => {
        const update = mapTranscriptViewToChatTailUpdate(snapshotWithMultiBubbleTurn(), MAP_OPTIONS)
        expect(update).not.toBeNull()

        const messages = (update?.messages ?? []) as unknown as ChatMessage[]
        expect(messages).toHaveLength(4)

        const keys = messages.map((message, index) => getChatMessageStableKey(message, index))
        const distinct = new Set(keys)

        // The failure this guards: 4 bubbles → 1 key, because `_turnKey`
        // (turn-grained) outranks every per-bubble field in the key composite.
        expect(
            distinct.size,
            `all bubbles of one turn collapsed onto a shared React key: ${JSON.stringify(keys)}`,
        ).toBe(keys.length)
    })

    /**
     * ★ The key is the bubble's `messageId`, so it does NOT move while the
     * bubble's content streams. A content-derived fallback would re-key (and
     * remount) a growing bubble on every frame.
     */
    it('keys each bubble by its messageId, stable across content growth', () => {
        const snapshot = snapshotWithMultiBubbleTurn()
        const grown = {
            ...snapshot,
            messages: snapshot.messages.map(message => ({ ...message, content: `${message.content} …more`, rev: 2 })),
        } as unknown as ReplicatedTranscriptViewV2

        const before = (mapTranscriptViewToChatTailUpdate(snapshot, MAP_OPTIONS).messages as unknown as ChatMessage[])
            .map((message, index) => getChatMessageStableKey(message, index))
        const after = (mapTranscriptViewToChatTailUpdate(grown, MAP_OPTIONS).messages as unknown as ChatMessage[])
            .map((message, index) => getChatMessageStableKey(message, index))

        expect(before).toEqual(snapshot.messages.map(message => `mid:${message.messageId}`))
        expect(after).toEqual(before)
    })

    it('does not let a turn-grained value masquerade as per-bubble identity', () => {
        const update = mapTranscriptViewToChatTailUpdate(snapshotWithMultiBubbleTurn(), MAP_OPTIONS)
        const messages = (update?.messages ?? []) as unknown as (ChatMessage & {
            _turnKey?: string
        })[]

        // `_turnKey` legitimately stays turn-grained and shared — it is the turn
        // axis. The invariant is that no PER-BUBBLE identity field is populated
        // from it, since those outrank content in the key composite and would
        // make distinct bubbles indistinguishable.
        const bubbleIds = messages.map(message => message.bubbleId).filter(Boolean)
        expect(
            new Set(bubbleIds).size,
            `bubbleId must be per-bubble, got a shared value: ${JSON.stringify(bubbleIds)}`,
        ).toBe(bubbleIds.length)
    })
})
