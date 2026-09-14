/**
 * (A#4) Tool-expansion state is keyed by the tool BLOCK, not by the bubble's
 * rendered text.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * Expansion state was keyed by `getChatMessageStableKey`. On the REPLICA lane a
 * tool bubble carries neither `bubbleId` nor `providerUnitKey` — both are kept
 * off the transcript wire on purpose (`transcript-chat-pane-adapter.ts`: the
 * first would collapse a turn onto one key, the second embeds a content hash) —
 * and `sequence` is `number | null` BY DESIGN. So the stable key can reduce to
 * the turn-grained tier, whose discriminator is a hash of the content.
 *
 * A tool bubble's content is exactly the thing that moves: the summary is
 * rewritten as the result streams and again when it settles. Every rewrite
 * produced a new key, the expansion lookup missed, and an open panel collapsed
 * under the reader with no event and no error.
 *
 * ── Why `recordIndex`/`blockIndex` and NOT `sourceMtimeMs` ─────────────────
 * The ref's three integers are not equally stable. The two indices address a
 * position that does not move while the block exists; `sourceMtimeMs` is a
 * freshness SEAL that bumps on every append to the transcript, including
 * appends unrelated to this block. Keying on it would re-key every open
 * expansion on each write — the same churn, differently sourced. The seal still
 * does its real job on the request itself, where a broken seal is refused as
 * `source_changed`.
 */
import { describe, expect, it } from 'vitest'
import {
    buildChatMessageStableKeys,
    getChatMessageStableKey,
    getToolExpandStateKey,
} from '../../src/components/ChatMessageList/chatMessageHelpers'
import type { ChatMessage } from '../../src/types'

const TURN_KEY = 'turn-7'
const REF = { sourceMtimeMs: 1_700_000_000_000, recordIndex: 4, blockIndex: 1 }

/**
 * A tool bubble as the replica adapter builds it: `_turnKey` only (turn-grained),
 * no `bubbleId`, no `providerUnitKey`, no numeric `sequence`, plus the ref.
 */
function replicaToolBubble(content: string, ref: unknown = REF): ChatMessage {
    return {
        role: 'assistant',
        kind: 'tool',
        content,
        _turnKey: TURN_KEY,
        toolBlockRef: ref,
    } as unknown as ChatMessage
}

describe('(A#4) getToolExpandStateKey', () => {
    it('★ survives a content rewrite that DOES change the stable key', () => {
        const streaming = replicaToolBubble('↘ reading src/a.ts…')
        const settled = replicaToolBubble('↘ reading src/a.ts src/b.ts src/c.ts (42 files)')

        // Precondition — without this the test would pass vacuously: the stable
        // key really does move for these two, which is the bug's mechanism.
        expect(getChatMessageStableKey(settled, 0)).not.toBe(getChatMessageStableKey(streaming, 0))

        // The expansion key does not.
        expect(getToolExpandStateKey(settled)).toBe(getToolExpandStateKey(streaming))
    })

    it('★ an open expansion is still found after the bubble content is rewritten', () => {
        // The end-to-end shape of the defect, at the lookup itself.
        const streaming = replicaToolBubble('↘ reading src/a.ts…')
        const toolExpansions: Record<string, { status: string }> = {
            [getToolExpandStateKey(streaming)!]: { status: 'expanded' },
        }

        const settled = replicaToolBubble('↘ reading src/a.ts src/b.ts src/c.ts (42 files)')
        const keyAfter = getToolExpandStateKey(settled) ?? getChatMessageStableKey(settled, 0)
        expect(toolExpansions[keyAfter]).toEqual({ status: 'expanded' })
    })

    it('★ ignores sourceMtimeMs — an unrelated transcript append must not re-key', () => {
        // The daemon appends to the transcript constantly while an agent works.
        // If the seal were part of the identity, every such append would drop
        // every open expansion in the pane.
        const before = replicaToolBubble('same body', REF)
        const after = replicaToolBubble('same body', { ...REF, sourceMtimeMs: REF.sourceMtimeMs + 5_000 })
        expect(getToolExpandStateKey(after)).toBe(getToolExpandStateKey(before))
    })

    it('distinguishes different blocks of the same record, and different records', () => {
        const block1 = replicaToolBubble('x', { ...REF, blockIndex: 1 })
        const block2 = replicaToolBubble('x', { ...REF, blockIndex: 2 })
        const otherRecord = replicaToolBubble('x', { ...REF, recordIndex: 9 })

        expect(getToolExpandStateKey(block1)).not.toBe(getToolExpandStateKey(block2))
        expect(getToolExpandStateKey(block1)).not.toBe(getToolExpandStateKey(otherRecord))
    })

    it('keys a record-level block (blockIndex -1) distinctly from block 0', () => {
        // codex's record-level tool shape addresses the record itself with -1;
        // it is a real address, not a "missing" sentinel.
        const recordLevel = replicaToolBubble('x', { ...REF, blockIndex: -1 })
        const firstBlock = replicaToolBubble('x', { ...REF, blockIndex: 0 })
        expect(getToolExpandStateKey(recordLevel)).toBe('toolblock:4:-1')
        expect(getToolExpandStateKey(recordLevel)).not.toBe(getToolExpandStateKey(firstBlock))
    })

    it('returns null for a bubble with no ref, so the caller keeps the stable key', () => {
        const plain = { role: 'assistant', kind: 'tool', content: '↘ done' } as unknown as ChatMessage
        expect(getToolExpandStateKey(plain)).toBeNull()
    })

    it('returns null for a malformed ref rather than a partial key', () => {
        // A half-resolved address is exactly what the daemon refuses anyway; a
        // key built from `undefined` would alias unrelated bubbles together.
        for (const bad of [
            null,
            {},
            { recordIndex: 4 },
            { recordIndex: 4, blockIndex: 'x' },
            { recordIndex: 1.5, blockIndex: 0 },
            'toolblock:4:1',
        ]) {
            expect(getToolExpandStateKey(replicaToolBubble('x', bad))).toBeNull()
        }
    })
})

/**
 * ★ The React key must not move. `getChatMessageStableKey` is shared with React
 * reconciliation and with the `receivedAt` cache, and the expansion fix must be
 * additive — a changed key remounts bubbles (CHAT-FLAP-LONG-CONVO) and would
 * disturb the `dupKeyPairs` uniqueness guarantee.
 */
describe('(A#4) the React key is untouched by the expansion key', () => {
    it('a tool bubble with a ref keys exactly as it did without one', () => {
        const withRef = replicaToolBubble('↘ reading src/a.ts')
        const withoutRef = {
            role: 'assistant',
            kind: 'tool',
            content: '↘ reading src/a.ts',
            _turnKey: TURN_KEY,
        } as unknown as ChatMessage

        // Byte-identical: the ref is not ranked into the stable key.
        expect(getChatMessageStableKey(withRef, 0)).toBe(getChatMessageStableKey(withoutRef, 0))
    })

    it('★ two sibling bubbles sharing ONE block still get distinct React keys', () => {
        // This is why the expansion key cannot simply become the React key: a
        // tool call and its result can be summarised from the same address, and
        // keying React on the block would reconcile them into each other —
        // reintroducing the exact turn-collapse the stable key was fixed for.
        const call = replicaToolBubble('↗ Read: src/a.ts')
        const result = replicaToolBubble('↘ 42 lines')

        expect(getToolExpandStateKey(call)).toBe(getToolExpandStateKey(result))

        const keys = buildChatMessageStableKeys([call, result])
        expect(keys[0]).not.toBe(keys[1])
    })

    it('keeps duplicate-sibling disambiguation intact for identical tool bubbles', () => {
        const a = replicaToolBubble('same')
        const b = replicaToolBubble('same')
        const keys = buildChatMessageStableKeys([a, b])
        expect(new Set(keys).size).toBe(2)
    })
})
