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
import { mapTranscriptSnapshotToReadChatPayload } from '../../src/mesh/transcript-read-chat-adapter.js';
import type {
    ReplicatedTranscriptMessageV1,
    ReplicatedTranscriptSnapshotV1,
} from '../../src/seqscribe/transcript-projection.js';

function message(overrides: Partial<ReplicatedTranscriptMessageV1> = {}): ReplicatedTranscriptMessageV1 {
    return {
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
        ...overrides,
    };
}

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,
        sessionId: 'sess-1',
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: 'daemon-owner',
        producerWriterId: 'writer-1',
        producerEpoch: 'epoch-1',
        revision: 7,
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

describe('mapTranscriptSnapshotToReadChatPayload', () => {
    it('maps identity/messages/status into the read_chat payload shape', () => {
        const payload = mapTranscriptSnapshotToReadChatPayload(
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
        expect(payload.transcriptReadSource).toBe('replica');
        expect(payload.replicaRevision).toBe(7);
        expect(payload.omittedBefore).toBe(true);
        expect(payload.stale).toBe(false);
    });

    it('carries the turn projection through verbatim, and omits the key when absent', () => {
        const withTurn = mapTranscriptSnapshotToReadChatPayload(snapshot({ turn: TURN }), { omittedBefore: false, stale: false });
        expect(withTurn.turn).toEqual({ ...TURN });

        // Provider-FSM fallback contract: NO `turn` key at all, never an empty object.
        const withoutTurn = mapTranscriptSnapshotToReadChatPayload(snapshot({ turn: null }), { omittedBefore: false, stale: false });
        expect('turn' in withoutTurn).toBe(false);
    });

    it('does not derive status — it copies the producer-side effectiveStatus', () => {
        // A snapshot whose turn projection disagrees with `status` must NOT be
        // "corrected" here: read-chat-presentation.ts already resolved authority
        // (`effectiveStatus`, :202-215) before the observation was built (:278).
        // A second derivation here would be a parallel authority.
        const payload = mapTranscriptSnapshotToReadChatPayload(
            snapshot({ status: 'generating', turn: { ...TURN, status: 'idle', stage: 'completed' } }),
            { omittedBefore: false, stale: false },
        );
        expect(payload.status).toBe('generating');
        expect(payload.turn?.status).toBe('idle');
    });

    it('reconstructs meta.streaming only when the scalar is non-null', () => {
        const streaming = mapTranscriptSnapshotToReadChatPayload(
            snapshot({ messages: [message({ streaming: true })] }),
            { omittedBefore: false, stale: false },
        );
        expect(streaming.messages[0].meta).toEqual({ streaming: true });

        // An always-present empty `meta` would be a new object the live path
        // never had — and `isCoordinatorVisibleMessage` inspects `meta`.
        const plain = mapTranscriptSnapshotToReadChatPayload(
            snapshot({ messages: [message({ streaming: null })] }),
            { omittedBefore: false, stale: false },
        );
        expect('meta' in plain.messages[0]).toBe(false);
    });

    it('narrows provenance scalars to {selected}, and omits them when null', () => {
        const withProvenance = mapTranscriptSnapshotToReadChatPayload(
            snapshot({ provenance: { messageSource: 'native_history', transcriptProvenance: 'jsonl' } }),
            { omittedBefore: false, stale: false },
        );
        expect(withProvenance.messageSource).toEqual({ selected: 'native_history' });
        expect(withProvenance.transcriptProvenance).toEqual({ selected: 'jsonl' });

        const bare = mapTranscriptSnapshotToReadChatPayload(snapshot(), { omittedBefore: false, stale: false });
        expect('messageSource' in bare).toBe(false);
        expect('transcriptProvenance' in bare).toBe(false);
    });

    it('maps the modal/prompt allow-list and copies their arrays defensively', () => {
        const buttons = ['Yes', 'No'];
        const options = ['a', 'b'];
        const payload = mapTranscriptSnapshotToReadChatPayload(
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
describe('mapTranscriptSnapshotToReadChatPayload — required-field injection', () => {
    function inject(field: string, base: ReplicatedTranscriptSnapshotV1): ReplicatedTranscriptSnapshotV1 {
        const mutated = { ...base } as Record<string, unknown>;
        delete mutated[field];
        return mutated as ReplicatedTranscriptSnapshotV1;
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
        expect(mapTranscriptSnapshotToReadChatPayload(base, opts).status).toBe('waiting_approval');
        expect(mapTranscriptSnapshotToReadChatPayload(inject('status', base), opts).status).toBeUndefined();
    });

    it('messages: present → mapped; removed → the mapper throws instead of silently emitting an empty transcript', () => {
        expect(mapTranscriptSnapshotToReadChatPayload(base, opts).messages).toHaveLength(1);
        // A silently-empty transcript is the worst failure mode for a display
        // consumer (it reads as "the agent said nothing"), so the absence must
        // surface — the mcp-server hop's `isUsableSnapshot` gate turns this into
        // a `revision_invalid` fallback rather than a thrown read.
        expect(() => mapTranscriptSnapshotToReadChatPayload(inject('messages', base), opts)).toThrow();
    });

    it('coverage: present → totalMessages is the untailed count; removed → the mapper throws', () => {
        expect(mapTranscriptSnapshotToReadChatPayload(base, opts).totalMessages).toBe(4);
        expect(() => mapTranscriptSnapshotToReadChatPayload(inject('coverage', base), opts)).toThrow();
    });

    it('provenance: present → {selected}; removed → the mapper throws', () => {
        const withSource = snapshot({ provenance: { messageSource: 'native_history', transcriptProvenance: null } });
        expect(mapTranscriptSnapshotToReadChatPayload(withSource, opts).messageSource).toEqual({ selected: 'native_history' });
        expect(() => mapTranscriptSnapshotToReadChatPayload(inject('provenance', withSource), opts)).toThrow();
    });

    it('providerObservedStatus: present → carried; removed → undefined, breaking the completion poll\'s independent input', () => {
        // read-chat-presentation.ts emits this SEPARATELY from `status` to break
        // the turn-completion deadlock (PROJECTION-SELF-REFERENCE). Losing it is
        // silent, so it is pinned explicitly.
        expect(mapTranscriptSnapshotToReadChatPayload(base, opts).providerObservedStatus).toBe('generating');
        expect(
            mapTranscriptSnapshotToReadChatPayload(inject('providerObservedStatus', base), opts).providerObservedStatus,
        ).toBeUndefined();
    });

    it('revision: present → replicaRevision; removed → undefined', () => {
        expect(mapTranscriptSnapshotToReadChatPayload(base, opts).replicaRevision).toBe(7);
        expect(mapTranscriptSnapshotToReadChatPayload(inject('revision', base), opts).replicaRevision).toBeUndefined();
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
        expect(mapTranscriptSnapshotToReadChatPayload(inject('terminalMarkers', withMarkers), opts))
            .toEqual(mapTranscriptSnapshotToReadChatPayload(withMarkers, opts));
    });
});
