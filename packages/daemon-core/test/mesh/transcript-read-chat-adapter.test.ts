/**
 * §8 unit 6 — `mesh_read_chat_display` roster adapter.
 *
 * ── The load-bearing part of this file is the INJECTION suite ──────────────
 * Design §8's acceptance checklist: "consumer의 필수 field 하나를 projection
 * 에서 제거하면 test가 red다". A positive-path assertion alone is not evidence
 * of that: unit 5 shipped a `receivedAt` test that stayed GREEN under
 * injection because the two tails it compared carried different `turnKey`s
 * and short-circuited before the field ever mattered.
 *
 * So the injection cases below delete a field from the SNAPSHOT (the
 * projection's output) and assert the specific downstream consequence, with
 * the positive case sitting immediately next to it so "red on delete, green on
 * restore" is readable in one place.
 */

import { describe, expect, it } from 'vitest';
import { mapTranscriptViewToReadChatPayload } from '../../src/mesh/transcript-read-chat-adapter.js';
import type {
    ReplicatedTranscriptMessageV2,
    ReplicatedTranscriptViewV2,
} from '../../src/seqscribe/transcript-keyed-codec.js';

let nextId = 0;
function message(overrides: Partial<ReplicatedTranscriptMessageV2> = {}): ReplicatedTranscriptMessageV2 {
    nextId += 1;
    return {
        messageId: `d.adapt.${nextId}`,
        ord: `a${nextId.toString(36).padStart(4, '0')}`,
        rev: 1,
        role: 'user',
        kind: 'standard',
        content: 'hi',
        receivedAt: 10,
        timestamp: 10,
        turnKey: 'turn-1',
        bubbleState: 'final',
        senderName: null,
        toolName: null,
        streaming: null,
        expandable: false,
        srcId: null,
        ...overrides,
    };
}

function snapshot(overrides: Partial<ReplicatedTranscriptViewV2> = {}): ReplicatedTranscriptViewV2 {
    return {
        schemaVersion: 2,
        sessionId: 'sess-1',
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: 'daemon-owner',
        producerWriterId: 'writer-1',
        epoch: 'epoch-1',
        frame: 7,
        observedAt: '2026-09-02T00:00:00.000Z',
        status: 'idle',
        providerObservedStatus: 'idle',
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: null, transcriptProvenance: null },
        messages: [],
        terminalMarkers: [],
        coverage: { mode: 'full', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
        ...overrides,
    };
}

const TURN = {
    authority: 'turn_reducer',
    status: 'idle',
    stage: 'completed',
    terminalOutcome: 'completed',
    terminalReason: 'provider_event',
    meshId: 'mesh-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    attemptSeq: 2,
    sessionId: 'sess-1',
    nodeId: 'node-1',
    providerType: 'claude-cli',
    acceptedAt: '2026-09-02T00:00:00.000Z',
    deliveredAt: '2026-09-02T00:00:01.000Z',
    consumedAt: '2026-09-02T00:00:02.000Z',
    terminalAt: '2026-09-02T00:00:03.000Z',
    updatedAt: '2026-09-02T00:00:03.000Z',
} as const;

describe('mapTranscriptViewToReadChatPayload', () => {
    it('re-applies read_chat\'s prose-only default: activity kinds are dropped from the display payload', () => {
        // The observation is caller-independent and always carries activity
        // rows (read-chat-presentation.ts). mesh_read_chat's legacy hop calls
        // read_chat WITHOUT includeActivity, so the replica-served answer must
        // drop the same rows or the two sources would render differently.
        const payload = mapTranscriptViewToReadChatPayload(
            snapshot({
                messages: [
                    message({ role: 'user', content: 'do it' }),
                    message({ role: 'assistant', kind: 'tool', content: 'Read(x)', turnKey: 'turn-2' }),
                    message({ role: 'assistant', kind: 'thought', content: 'hm', turnKey: 'turn-2' }),
                    message({ role: 'assistant', kind: 'terminal', content: '$ ls', turnKey: 'turn-2' }),
                    message({ role: 'assistant', content: 'done', turnKey: 'turn-2' }),
                ],
                coverage: { mode: 'full', totalMessageCount: 5, returnedMessageCount: 5, omittedBefore: false },
            }),
            { omittedBefore: false, stale: false },
        );

        expect(payload.messages.map((m) => m.content)).toEqual(['do it', 'done']);
    });

    it('maps identity/messages/status into the read_chat payload shape', () => {
        const payload = mapTranscriptViewToReadChatPayload(
            snapshot({
                sessionId: 'sess-9',
                historySessionId: 'hist-9',
                providerSessionId: 'psid-9',
                title: 'Title',
                status: 'generating',
                providerObservedStatus: 'idle',
                messages: [message(), message({ role: 'assistant', content: 'hello', turnKey: 'turn-2' })],
                coverage: { mode: 'full', totalMessageCount: 5, returnedMessageCount: 2, omittedBefore: true },
            }),
            { omittedBefore: true, stale: false },
        );

        expect(payload.success).toBe(true);
        expect(payload.status).toBe('generating');
        expect(payload.providerObservedStatus).toBe('idle');
        expect(payload.providerSessionId).toBe('psid-9');
        expect(payload.historySessionId).toBe('hist-9');
        expect(payload.title).toBe('Title');
        // `totalMessages` is the FULL observed count, not the returned tail length.
        expect(payload.totalMessages).toBe(5);
        expect(payload.messages).toHaveLength(2);
        // `_turnKey` only — `bubbleId` is deliberately not populated from the
        // turn-grained `turnKey` (it would make every bubble of one turn share
        // an identity). See transcript-adapter-bubble-identity.test.ts in
        // web-core for the invariant this protects.
        expect(payload.messages[0]).toMatchObject({ role: 'user', content: 'hi', _turnKey: 'turn-1' });
        expect(payload.messages[0]).not.toHaveProperty('bubbleId');
        // Per-bubble identity is the ledger's messageId — mapped onto `id` too,
        // matching the live read_chat choke point.
        expect(payload.messages[0]!.id).toBe(payload.messages[0]!.messageId);
        expect(payload.messages[1]!.messageId).not.toBe(payload.messages[0]!.messageId);
        expect(payload.messages[0]).toMatchObject({ ord: expect.any(String), rev: 1 });
        expect(payload.transcriptReadSource).toBe('replica');
        expect(payload.replicaFrame).toBe(7);
        expect(payload.replicaEpoch).toBe('epoch-1');
        expect(payload.omittedBefore).toBe(true);
        expect(payload.stale).toBe(false);
    });

    it('carries the turn projection through verbatim, and omits the key when absent', () => {
        const withTurn = mapTranscriptViewToReadChatPayload(snapshot({ turn: TURN }), { omittedBefore: false, stale: false });
        expect(withTurn.turn).toEqual({ ...TURN });

        // Provider-FSM fallback contract: NO `turn` key at all, never an empty object.
        const withoutTurn = mapTranscriptViewToReadChatPayload(snapshot({ turn: null }), { omittedBefore: false, stale: false });
        expect('turn' in withoutTurn).toBe(false);
    });

    it('does not derive status — it copies the producer-side effectiveStatus', () => {
        // A snapshot whose turn projection disagrees with `status` must NOT be
        // "corrected" here: read-chat-presentation.ts already resolved authority
        // (`effectiveStatus`, :202-215) before the observation was built (:278).
        // A second derivation here would be a parallel authority.
        const payload = mapTranscriptViewToReadChatPayload(
            snapshot({ status: 'generating', turn: { ...TURN, status: 'idle', stage: 'completed' } }),
            { omittedBefore: false, stale: false },
        );
        expect(payload.status).toBe('generating');
        expect(payload.turn?.status).toBe('idle');
    });

    it('reconstructs meta.streaming only when the scalar is non-null', () => {
        const streaming = mapTranscriptViewToReadChatPayload(
            snapshot({ messages: [message({ streaming: true })] }),
            { omittedBefore: false, stale: false },
        );
        expect(streaming.messages[0].meta).toEqual({ streaming: true });

        // An always-present empty `meta` would be a new object the live path
        // never had — and `isCoordinatorVisibleMessage` inspects `meta`.
        const plain = mapTranscriptViewToReadChatPayload(
            snapshot({ messages: [message({ streaming: null })] }),
            { omittedBefore: false, stale: false },
        );
        expect('meta' in plain.messages[0]).toBe(false);
    });

    it('carries the `expandable` affordance (expand is addressed by messageId), and omits it when false', () => {
        // `kind:'standard'` isolates the field copy from the activity-kind filter
        // above (a `kind:'tool'` fixture would be dropped before mapping).
        const expandable = mapTranscriptViewToReadChatPayload(
            snapshot({ messages: [message({ expandable: true })] }),
            { omittedBefore: false, stale: false },
        );
        expect(expandable.messages[0].expandable).toBe(true);
        expect('toolBlockRef' in expandable.messages[0]).toBe(false);

        const plain = mapTranscriptViewToReadChatPayload(
            snapshot({ messages: [message({ expandable: false })] }),
            { omittedBefore: false, stale: false },
        );
        expect('expandable' in plain.messages[0]).toBe(false);
    });

    it('narrows provenance scalars to {selected}, and omits them when null', () => {
        const withProvenance = mapTranscriptViewToReadChatPayload(
            snapshot({ provenance: { messageSource: 'native_history', transcriptProvenance: 'jsonl' } }),
            { omittedBefore: false, stale: false },
        );
        expect(withProvenance.messageSource).toEqual({ selected: 'native_history' });
        expect(withProvenance.transcriptProvenance).toEqual({ selected: 'jsonl' });

        const bare = mapTranscriptViewToReadChatPayload(snapshot(), { omittedBefore: false, stale: false });
        expect('messageSource' in bare).toBe(false);
        expect('transcriptProvenance' in bare).toBe(false);
    });

    it('maps the modal/prompt allow-list and copies their arrays defensively', () => {
        const buttons = ['Yes', 'No'];
        const options = ['a', 'b'];
        const payload = mapTranscriptViewToReadChatPayload(
            snapshot({
                activeModal: { message: 'Approve?', buttons },
                activeInteractivePrompt: { message: 'Pick', options },
            }),
            { omittedBefore: false, stale: false },
        );
        expect(payload.activeModal).toEqual({ message: 'Approve?', buttons: ['Yes', 'No'] });
        expect(payload.activeModal!.buttons).not.toBe(buttons);
        expect(payload.activeInteractivePrompt).toEqual({ message: 'Pick', options: ['a', 'b'] });
        expect(payload.activeInteractivePrompt!.options).not.toBe(options);
    });
});

/**
 * ★ Projection-field injection (design §8 acceptance).
 *
 * Each case removes ONE field the `mesh_read_chat_display` consumer actually
 * reads and asserts the resulting defect. `delete` on the readonly wire type
 * is what a projection regression would look like from this consumer's side —
 * the field simply stops arriving.
 */
describe('mapTranscriptViewToReadChatPayload — required-field injection', () => {
    function inject(field: string, base: ReplicatedTranscriptViewV2): ReplicatedTranscriptViewV2 {
        const mutated = { ...base } as Record<string, unknown>;
        delete mutated[field];
        return mutated as ReplicatedTranscriptViewV2;
    }

    const base = snapshot({
        status: 'waiting_approval',
        providerObservedStatus: 'generating',
        messages: [message({ role: 'assistant', content: 'done', turnKey: 'turn-2' })],
        coverage: { mode: 'full', totalMessageCount: 4, returnedMessageCount: 1, omittedBefore: true },
        turn: TURN,
    });
    const opts = { omittedBefore: true, stale: false };

    it('status: present → mapped; removed → payload.status is undefined', () => {
        expect(mapTranscriptViewToReadChatPayload(base, opts).status).toBe('waiting_approval');
        expect(mapTranscriptViewToReadChatPayload(inject('status', base), opts).status).toBeUndefined();
    });

    it('messages: present → mapped; removed → the mapper throws instead of silently emitting an empty transcript', () => {
        expect(mapTranscriptViewToReadChatPayload(base, opts).messages).toHaveLength(1);
        // A silently-empty transcript is the worst failure mode for a display
        // consumer (it reads as "the agent said nothing"), so the absence must
        // surface — the mcp-server hop's `isUsableSnapshot` gate turns this into
        // a `revision_invalid` fallback rather than a thrown read.
        expect(() => mapTranscriptViewToReadChatPayload(inject('messages', base), opts)).toThrow();
    });

    it('coverage: present → totalMessages is the untailed count; removed → the mapper throws', () => {
        expect(mapTranscriptViewToReadChatPayload(base, opts).totalMessages).toBe(4);
        expect(() => mapTranscriptViewToReadChatPayload(inject('coverage', base), opts)).toThrow();
    });

    it('provenance: present → {selected}; removed → the mapper throws', () => {
        const withSource = snapshot({ provenance: { messageSource: 'native_history', transcriptProvenance: null } });
        expect(mapTranscriptViewToReadChatPayload(withSource, opts).messageSource).toEqual({ selected: 'native_history' });
        expect(() => mapTranscriptViewToReadChatPayload(inject('provenance', withSource), opts)).toThrow();
    });

    it('providerObservedStatus: present → carried; removed → undefined, breaking the completion poll\'s independent input', () => {
        // read-chat-presentation.ts emits this SEPARATELY from `status` to break
        // the turn-completion deadlock (PROJECTION-SELF-REFERENCE). Losing it is
        // silent, so it is pinned explicitly.
        expect(mapTranscriptViewToReadChatPayload(base, opts).providerObservedStatus).toBe('generating');
        expect(
            mapTranscriptViewToReadChatPayload(inject('providerObservedStatus', base), opts).providerObservedStatus,
        ).toBeUndefined();
    });

    it('frame: present → replicaFrame; removed → undefined', () => {
        expect(mapTranscriptViewToReadChatPayload(base, opts).replicaFrame).toBe(7);
        expect(mapTranscriptViewToReadChatPayload(inject('frame', base), opts).replicaFrame).toBeUndefined();
    });

    it('messageId: present on a message → id + messageId; removed → bubbles lose identity', () => {
        const withId = snapshot({ messages: [message({ messageId: 'n.aaaaaaaa.3.0' })] });
        expect(mapTranscriptViewToReadChatPayload(withId, opts).messages[0]).toMatchObject({ id: 'n.aaaaaaaa.3.0', messageId: 'n.aaaaaaaa.3.0' });
        const stripped = {
            ...withId,
            messages: withId.messages.map((m) => {
                const mutated = { ...m } as Record<string, unknown>;
                delete mutated.messageId;
                return mutated as unknown as ReplicatedTranscriptMessageV2;
            }),
        };
        expect(mapTranscriptViewToReadChatPayload(stripped, opts).messages[0].messageId).toBeUndefined();
    });

    /**
     * ★ Honest negative result, in the spirit of unit 5's `bubbleId` note.
     *
     * `terminalMarkers` is on the wire allow-list but this consumer does NOT
     * read it — `mesh_read_chat` is a display surface and terminal evidence is
     * roster id 5 (`daemon_terminal_evidence`, §8 unit 7). Deleting it changes
     * NOTHING in this consumer's output, and pretending otherwise with a
     * contrived assertion would be exactly the fake-green unit 5 hit. When
     * unit 7 lands, its own injection suite is where this field becomes
     * load-bearing.
     */
    it('terminalMarkers is NOT load-bearing for this consumer — deleting it is a no-op here', () => {
        const withMarkers = snapshot({
            messages: [message()],
            terminalMarkers: [{ receivedAt: 1, outcome: 'completed', turnId: 't', summary: 's' }],
        });
        expect(mapTranscriptViewToReadChatPayload(inject('terminalMarkers', withMarkers), opts))
            .toEqual(mapTranscriptViewToReadChatPayload(withMarkers, opts));
    });
});
