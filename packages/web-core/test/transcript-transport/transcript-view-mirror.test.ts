// The main-thread half of the incremental bridge (design 2026-09-28
// message-keyed storage §5.4): frames in, views out, with every bubble a frame
// did not touch kept by object identity so React re-renders only what changed.
import type { ReplicatedTranscriptMessageV2 } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import { describe, expect, it } from 'vitest'
import type { TranscriptBridgeFrameMessage, TranscriptViewMeta } from '../../src/transcript-transport/bridge-protocol.js'
import { TranscriptViewMirror, compareTranscriptOrd } from '../../src/transcript-transport/transcript-view-mirror.js'

function bubble(id: string, ord: string, rev = 1, content = id): ReplicatedTranscriptMessageV2 {
    return {
        messageId: id, ord, rev, role: 'assistant', kind: 'standard', content, receivedAt: null, timestamp: null,
        turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null, expandable: false, srcId: null,
    }
}

const META: TranscriptViewMeta = {
    schemaVersion: 2, sessionId: 's1', historySessionId: null, providerType: 'claude-cli', providerSessionId: null,
    producerDaemonId: 'd1', producerWriterId: 'w1', epoch: 'e1', frame: 1, observedAt: 'now', status: 'idle',
    providerObservedStatus: null, title: null, activeModal: null, activeInteractivePrompt: null, turn: null,
    provenance: { messageSource: null, transcriptProvenance: null }, terminalMarkers: [],
    coverage: { mode: 'full', omittedBefore: false, totalMessageCount: 0, returnedMessageCount: 0 },
}

function frame(partial: Partial<TranscriptBridgeFrameMessage>): TranscriptBridgeFrameMessage {
    return { kind: 'transcript-bridge-frame', sessionId: 's1', epoch: 'e1', frame: 1, reset: false, upserts: [], deletes: [], meta: null, ...partial }
}

describe('TranscriptViewMirror', () => {
    it('a reset frame replaces the live set, sorted by ord', () => {
        const mirror = new TranscriptViewMirror()
        const out = mirror.apply(frame({ reset: true, meta: META, upserts: [bubble('b', 'a2'), bubble('a', 'a1')] }))
        expect(out?.reset).toBe(true)
        expect(out?.view.messages.map((m) => m.messageId)).toEqual(['a', 'b'])
        expect(out?.view.coverage.totalMessageCount).toBe(2)
    })

    it('a delta frame swaps only the changed bubbles; untouched ones keep their object identity', () => {
        const mirror = new TranscriptViewMirror()
        const first = mirror.apply(frame({ reset: true, meta: META, upserts: [bubble('a', 'a1'), bubble('b', 'a2'), bubble('c', 'a3')] }))!
        const second = mirror.apply(frame({ frame: 2, upserts: [bubble('b', 'a2', 2, 'b grown')] }))!
        expect(second.view.frame).toBe(2)
        expect(second.view.messages.map((m) => m.content)).toEqual(['a', 'b grown', 'c'])
        expect(second.view.messages[0]).toBe(first.view.messages[0])
        expect(second.view.messages[2]).toBe(first.view.messages[2])
        // A new array, so a consumer comparing by reference sees the change.
        expect(second.view.messages).not.toBe(first.view.messages)
    })

    it('inserts, moves and deletes re-sort by ord', () => {
        const mirror = new TranscriptViewMirror()
        mirror.apply(frame({ reset: true, meta: META, upserts: [bubble('a', 'a1'), bubble('b', 'a3')] }))
        const out = mirror.apply(frame({ frame: 2, upserts: [bubble('c', 'a2'), bubble('a', 'a4', 2)], deletes: ['b'] }))!
        expect(out.view.messages.map((m) => m.messageId)).toEqual(['c', 'a'])
        expect(out.view.coverage.returnedMessageCount).toBe(2)
    })

    it('meta rides only when it changed; the commit identity always advances', () => {
        const mirror = new TranscriptViewMirror()
        mirror.apply(frame({ reset: true, meta: META, upserts: [bubble('a', 'a1')] }))
        const quiet = mirror.apply(frame({ frame: 2, upserts: [bubble('a', 'a1', 2)] }))!
        expect(quiet.view.status).toBe('idle')
        expect(quiet.view.frame).toBe(2)
        const busy = mirror.apply(frame({ frame: 3, meta: { ...META, frame: 3, status: 'generating' } }))!
        expect(busy.view.status).toBe('generating')
    })

    it('a delta frame for a session with no base is not applicable', () => {
        const mirror = new TranscriptViewMirror()
        expect(mirror.apply(frame({ upserts: [bubble('a', 'a1')] }))).toBeNull()
    })

    it('retain() drops deactivated sessions', () => {
        const mirror = new TranscriptViewMirror()
        mirror.apply(frame({ reset: true, meta: META, upserts: [bubble('a', 'a1')] }))
        mirror.retain(['other'])
        expect(mirror.view('s1')).toBeNull()
    })

    it('orders by plain code-unit compare with messageId as the tie-break', () => {
        expect(compareTranscriptOrd({ ord: 'a1', messageId: 'z' }, { ord: 'a2', messageId: 'a' })).toBeLessThan(0)
        expect(compareTranscriptOrd({ ord: 'a1', messageId: 'b' }, { ord: 'a1', messageId: 'a' })).toBeGreaterThan(0)
    })
})
