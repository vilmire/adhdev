/**
 * §8 unit 7 — daemon semantic transcript consumers (roster ids 4-5).
 *
 * Covers the routing gate in `mesh/transcript-daemon-consumer-read.ts` and the
 * two cutover sites that consume it.
 *
 * ── The load-bearing parts ─────────────────────────────────────────────────
 * 1. INJECTION (design §8 acceptance: "consumer의 필수 field 하나를 projection
 *    에서 제거하면 test가 red다"). Each injection case deletes/corrupts one
 *    field the consumer actually reads and asserts the SPECIFIC decline, with
 *    the restored positive case adjacent so red-on-delete / green-on-restore
 *    is readable in one place.
 * 2. FAULT INJECTION (§8: "topic/grant/owner/hash/parity/freshness 중 하나를
 *    결함 주입하면 legacy fallback하고 source reason이 관측된다") — the owner,
 *    session and freshness faults each land on their own closed-union reason.
 * 3. The `turnTerminalMarkers` ABSENCE invariant, which is the one place this
 *    unit is deliberately not field-lossless and where a "helpful" future edit
 *    would silently manufacture the terminal-admission veto.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    readTranscriptForDaemonConsumer,
    TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
    TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
} from '../../src/mesh/transcript-daemon-consumer-read.js';
import { TRANSCRIPT_CONSUMER_ROSTER } from '../../src/mesh/transcript-read-model-consumers.js';
import { mapTranscriptSnapshotToReadChatPayload } from '../../src/mesh/transcript-read-chat-adapter.js';
import type { TranscriptReplicaStore } from '../../src/seqscribe/transcript-replica-store.js';
import type { ReplicatedTranscriptSnapshotV1 } from '../../src/seqscribe/transcript-projection.js';

const OWNER = 'daemon_mach_owner';
const SESSION = 'sess-1';
const OBSERVED_AT = '2026-09-02T00:00:00.000Z';
const OBSERVED_AT_MS = Date.parse(OBSERVED_AT);

/** `primary` is the only mode any roster consumer reads under (§5.1). */
const PRIMARY = { ADHDEV_SEQSCRIBE_TRANSCRIPT: 'primary' } as unknown as NodeJS.ProcessEnv;

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,
        sessionId: SESSION,
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: OWNER,
        producerWriterId: 'writer-1',
        producerEpoch: 'epoch-1',
        revision: 7,
        observedAt: OBSERVED_AT,
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

/** A store stub whose `getReplica` answers with whatever the case set up. */
function storeReturning(result: unknown): TranscriptReplicaStore {
    return { getReplica: () => result } as unknown as TranscriptReplicaStore;
}

function availableStore(
    snap: unknown,
    identityOverrides: Record<string, unknown> = {},
): TranscriptReplicaStore {
    return storeReturning({
        available: true,
        snapshot: snap,
        identity: {
            sessionId: SESSION,
            producerDaemonId: OWNER,
            producerWriterId: 'writer-1',
            producerEpoch: 'epoch-1',
            revision: 7,
            ...identityOverrides,
        },
    });
}

function read(overrides: Parameters<typeof readTranscriptForDaemonConsumer>[0] extends infer T
    ? Partial<T>
    : never = {}) {
    return readTranscriptForDaemonConsumer({
        consumerId: 'daemon_worker_status_probe',
        ownerDaemonId: OWNER,
        rawSessionId: SESSION,
        maxAgeMs: TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
        store: availableStore(snapshot()),
        nowMs: OBSERVED_AT_MS,
        env: PRIMARY,
        ...overrides,
    } as Parameters<typeof readTranscriptForDaemonConsumer>[0]);
}

describe('§8 unit 7 — daemon consumer readiness gate (design §5.5)', () => {
    it('serves the replica when every condition holds', () => {
        const outcome = read();
        expect(outcome.fallbackReason).toBeNull();
        expect(outcome.snapshot?.status).toBe('idle');
    });

    // ── §5.5 condition 1 — mode + roster enablement ────────────────────────
    it.each([
        ['shadow', 'mode_not_primary'],
        ['off', 'mode_not_primary'],
        // Unset resolves to `shadow` (transcript-mode.ts's safe default), so a
        // daemon that never opted in cannot read the replica by accident.
        [undefined, 'mode_not_primary'],
    ])('declines mode=%s with %s', (mode, reason) => {
        const env = (mode === undefined ? {} : { ADHDEV_SEQSCRIBE_TRANSCRIPT: mode }) as NodeJS.ProcessEnv;
        const outcome = read({ env });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe(reason);
    });

    it('both unit-7 roster ids are enabled, and the gate honours that flag', () => {
        // The gate reads the roster rather than a local constant, so flipping
        // an entry back to `enabled: false` disables the cutover with no other
        // edit — the property that makes the roster the single control point.
        expect(TRANSCRIPT_CONSUMER_ROSTER.daemon_worker_status_probe.enabled).toBe(true);
        expect(TRANSCRIPT_CONSUMER_ROSTER.daemon_terminal_evidence.enabled).toBe(true);
        // Ids 6-8 belong to §8 unit 8 (mcp-server) and must still be unwired.
        expect(TRANSCRIPT_CONSUMER_ROSTER.mcp_mesh_status_reconciliation.enabled).toBe(false);
        expect(TRANSCRIPT_CONSUMER_ROSTER.magi_approval_probe.enabled).toBe(false);
        expect(TRANSCRIPT_CONSUMER_ROSTER.magi_result_collect.enabled).toBe(false);
    });

    // ── §5.5 condition 2 — node/key/store ──────────────────────────────────
    it.each([
        ['missing ownerDaemonId', { ownerDaemonId: undefined }],
        ['blank ownerDaemonId', { ownerDaemonId: '   ' }],
        ['missing rawSessionId', { rawSessionId: undefined }],
        ['no store (the production state today — resolveTranscriptPeer unset)', { store: null }],
    ])('declines %s with no_node', (_label, overrides) => {
        const outcome = read(overrides as never);
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('no_node');
    });

    it('declines with no_complete_revision when the store has no usable revision', () => {
        // Both store miss reasons collapse onto the one union member, because
        // `no_subscription` is not in the design's closed union.
        for (const reason of ['no_subscription', 'no_complete_revision']) {
            const outcome = read({ store: storeReturning({ available: false, reason }) });
            expect(outcome.snapshot).toBeNull();
            expect(outcome.fallbackReason).toBe('no_complete_revision');
        }
    });

    it('declines with stats_error rather than throwing into the completion loop', () => {
        const outcome = read({
            store: { getReplica: () => { throw new Error('boom'); } } as unknown as TranscriptReplicaStore,
        });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('stats_error');
    });

    // ── Fault injection: owner / session identity (§5.5 condition 7) ───────
    it('declines owner_mismatch when the assembled identity names another daemon', () => {
        const outcome = read({
            store: availableStore(snapshot(), { producerDaemonId: 'daemon_mach_someone_else' }),
        });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('owner_mismatch');
    });

    it('accepts an equivalent daemon-id FORM, never a raw string compare', () => {
        // The canon-identity defect class: `mach_X` and `daemon_mach_X` are the
        // same daemon. A `===` here would decline every cloud session.
        const outcome = read({
            ownerDaemonId: 'mach_owner',
            store: availableStore(snapshot({ producerDaemonId: 'daemon_mach_owner' })),
        });
        expect(outcome.fallbackReason).toBeNull();
        expect(outcome.snapshot).not.toBeNull();
    });

    it('declines owner_mismatch when the snapshot body names another session', () => {
        const outcome = read({ store: availableStore(snapshot({ sessionId: 'other-session' })) });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('owner_mismatch');
    });

    // ── Fault injection: freshness (§5.5 semantic condition) ───────────────
    it('serves at the freshness boundary and declines one ms past it', () => {
        const atBudget = read({ nowMs: OBSERVED_AT_MS + TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS });
        expect(atBudget.fallbackReason).toBeNull();

        const pastBudget = read({ nowMs: OBSERVED_AT_MS + TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS + 1 });
        expect(pastBudget.snapshot).toBeNull();
        expect(pastBudget.fallbackReason).toBe('stale_active_session');
    });

    it('gives the terminal-evidence consumer the tighter transcript-quiet budget', () => {
        // Aligned with TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS: a snapshot older
        // than the quiet window cannot answer "is the tail still growing".
        expect(TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS).toBe(8_000);
        expect(TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS).toBeLessThan(TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS);

        const outcome = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_terminal_evidence',
            ownerDaemonId: OWNER,
            rawSessionId: SESSION,
            maxAgeMs: TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
            store: availableStore(snapshot()),
            nowMs: OBSERVED_AT_MS + TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS + 1,
            env: PRIMARY,
        });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('stale_active_session');
    });

    it('refuses an unparseable observedAt rather than treating it as fresh', () => {
        const outcome = read({ store: availableStore(snapshot({ observedAt: 'not-a-date' })) });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('revision_invalid');
    });

    // ── INJECTION: required snapshot fields ────────────────────────────────
    // Each case removes ONE field the consumers read and asserts the decline;
    // the positive case above is the green half of the same pair.
    it.each([
        ['schemaVersion', { schemaVersion: 2 }],
        ['sessionId', { sessionId: '' }],
        ['status', { status: '' }],
        ['observedAt', { observedAt: '' }],
        ['revision', { revision: 'seven' }],
        ['messages', { messages: undefined }],
        ['coverage', { coverage: undefined }],
        ['coverage.totalMessageCount', { coverage: { mode: 'full', returnedMessageCount: 0, omittedBefore: false } }],
        ['coverage.omittedBefore', { coverage: { mode: 'full', totalMessageCount: 0, returnedMessageCount: 0 } }],
        ['provenance', { provenance: undefined }],
        // The terminal-evidence consumer WALKS the message array, so a
        // non-object entry must be refused before it reaches the extractors.
        ['a message entry', { messages: [null] }],
    ])('declines revision_invalid when %s is missing or malformed', (_field, overrides) => {
        const outcome = read({
            store: availableStore({ ...snapshot(), ...overrides }),
        });
        expect(outcome.snapshot).toBeNull();
        expect(outcome.fallbackReason).toBe('revision_invalid');
    });
});

describe('§8 unit 7 — roster id 5 turnTerminalMarkers absence invariant', () => {
    /**
     * ★ The single most important assertion in this file.
     *
     * `evaluateTerminalAdmission` uses the PRESENCE of `turnTerminalMarkers` as
     * a version-skew discriminator: present-even-as-`[]` is the authoritative
     * "this turn has NOT ended" for a native-signal provider. The transcript
     * wire carries no native markers (the observation builder hard-codes
     * `terminalMarkers: []`, and the projection's outcome enum differs from
     * `NativeTurnTerminalMarker`'s), so emitting the key would FABRICATE that
     * veto from silence.
     */
    it('never puts turnTerminalMarkers on a replica-sourced payload', () => {
        const payload = mapTranscriptSnapshotToReadChatPayload(
            snapshot({
                terminalMarkers: [
                    { receivedAt: 1, outcome: 'completed', turnId: 't1', summary: 'done' },
                ],
            }),
            { omittedBefore: false, stale: false },
        );
        // `in` — not `!== undefined` — because the discriminator is `'turnTerminal
        // Markers' in payload`, which an explicit `undefined` value would satisfy.
        expect('turnTerminalMarkers' in payload).toBe(false);
    });

    it('carries the fields the terminal-evidence extractors actually read', () => {
        const payload = mapTranscriptSnapshotToReadChatPayload(
            snapshot({
                status: 'idle',
                providerObservedStatus: 'idle',
                providerSessionId: 'psid-9',
                activeModal: { message: 'Approve?', buttons: ['Yes', 'No'] },
                messages: [{
                    role: 'assistant',
                    kind: 'standard',
                    content: 'all done',
                    receivedAt: 1_700_000_000_000,
                    timestamp: 1_700_000_000_000,
                    turnKey: 'turn-1',
                    bubbleState: 'final',
                    senderName: 'claude',
                    toolName: null,
                    streaming: null,
                }],
                coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
            }),
            { omittedBefore: false, stale: false },
        );
        expect(payload.status).toBe('idle');
        expect(payload.providerObservedStatus).toBe('idle');
        expect(payload.providerSessionId).toBe('psid-9');
        expect(payload.activeModal).toEqual({ message: 'Approve?', buttons: ['Yes', 'No'] });
        const [message] = payload.messages;
        expect(message.role).toBe('assistant');
        expect(message.kind).toBe('standard');
        expect(message.content).toBe('all done');
        expect(message.senderName).toBe('claude');
        expect(message.receivedAt).toBe(1_700_000_000_000);
        expect(message.timestamp).toBe(1_700_000_000_000);
    });

    it('omits meta entirely when streaming is null, so visibility checks are unchanged', () => {
        // `isCoordinatorVisibleMessage` inspects meta.internal/debug/userVisible;
        // an always-present empty `meta` would be a new object the live path
        // never had.
        const payload = mapTranscriptSnapshotToReadChatPayload(
            snapshot({
                messages: [{
                    role: 'assistant', kind: 'standard', content: 'x',
                    receivedAt: 1, timestamp: 1, turnKey: null, bubbleState: null,
                    senderName: null, toolName: null, streaming: null,
                }],
            }),
            { omittedBefore: false, stale: false },
        );
        expect('meta' in payload.messages[0]).toBe(false);
    });
});

describe('§8 unit 7 — roster id 4 cutover (reprobeWorkerStatus)', () => {
    // These exercise the wired call site rather than the gate, so they assert
    // the two properties the roster note promises: the replica answer is the
    // snapshot's own status, and a decline runs the IDENTICAL legacy read.
    async function loadReprobe() {
        return (await import('../../src/mesh/mesh-remote-event-pull.js')).reprobeWorkerStatus;
    }

    const readArgs = { sessionId: SESSION, targetSessionId: SESSION, tailLimit: 1 };

    it('answers from the replica for a REMOTE worker, without any transport call', async () => {
        const reprobeWorkerStatus = await loadReprobe();
        vi.stubEnv('ADHDEV_SEQSCRIBE_TRANSCRIPT', 'primary');
        const dispatchMeshCommand = vi.fn();
        try {
            const status = await reprobeWorkerStatus({
                transcriptReplicaStore: availableStore(snapshot({
                    status: 'GENERATING',
                    observedAt: new Date().toISOString(),
                })),
                dispatchMeshCommand,
                commandHandler: { handle: vi.fn() },
            } as never, { isLocalNode: false, nodeDaemonId: OWNER, readArgs });

            // Lowercased, exactly as readChatPayloadStatus would have done.
            expect(status).toBe('generating');
            expect(dispatchMeshCommand).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('falls through to the legacy remote read_chat when the replica declines', async () => {
        const reprobeWorkerStatus = await loadReprobe();
        // Default mode (shadow) — the production state today.
        const dispatchMeshCommand = vi.fn().mockResolvedValue({ messages: [], status: 'idle' });
        const status = await reprobeWorkerStatus({
            transcriptReplicaStore: availableStore(snapshot()),
            dispatchMeshCommand,
            commandHandler: { handle: vi.fn() },
        } as never, { isLocalNode: false, nodeDaemonId: OWNER, readArgs });

        expect(status).toBe('idle');
        expect(dispatchMeshCommand).toHaveBeenCalledWith(OWNER, 'read_chat', readArgs);
    });

    it('never takes the replica hop for a LOCAL node', async () => {
        const reprobeWorkerStatus = await loadReprobe();
        vi.stubEnv('ADHDEV_SEQSCRIBE_TRANSCRIPT', 'primary');
        try {
            const handle = vi.fn().mockResolvedValue({ messages: [], status: 'idle' });
            const getReplica = vi.fn();
            const status = await reprobeWorkerStatus({
                transcriptReplicaStore: { getReplica } as unknown as TranscriptReplicaStore,
                commandHandler: { handle },
            } as never, { isLocalNode: true, nodeDaemonId: OWNER, readArgs });

            expect(status).toBe('idle');
            expect(handle).toHaveBeenCalledWith('read_chat', readArgs);
            expect(getReplica).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
