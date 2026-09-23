import { describe, expect, it } from 'vitest';
import { encodeTranscriptSnapshot } from '../../src/seqscribe/transcript-projection.js';
import type { TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';

/**
 * Phase G, unit G4 — transcript content-boundary sentinel (design §7e, plan
 * §5/§6a G-4). `session.<id>.transcript` IS a content-class topic (unlike the
 * status path `cloud-status-content-boundary.test.ts` guards): `messages[].
 * content` legitimately carries chat text, because this topic never reaches
 * the server (CLAUDE.md's Beacon exception covers only the topic NAME, never
 * a payload) — subscribers are daemon replicas and browser/mesh peers holding
 * the same P2P-level trust as the live `read_chat` result.
 *
 * What this test guards is narrower and different in kind: `encodeTranscript
 * Snapshot`/`encodeTranscriptMessage` (transcript-projection.ts) are a CLOSED
 * ALLOW-LIST over loosely-typed candidate objects that carry an index
 * signature (`[extra: string]: unknown`) precisely because the real upstream
 * shapes (`ChatMessage`, `SessionTurnPresentation`) are `Record<string,
 * unknown>` grab-bags. `check:message-projection-parity` is the STATIC guard
 * that the encoder's own source only ever reads fields by name (no spread, no
 * object-walk). This is the RUNTIME complement: seed every field the encoder
 * is NOT supposed to read with a sentinel and assert the sentinel is absent
 * from the actually-encoded, actually-serialized output — the same recipe
 * `cloud-status-content-boundary.test.ts` and C8 use for the status/mesh-event
 * path, applied here for the first time to the transcript wire.
 *
 * Dropped-field list is `encodeTranscriptMessage`'s doc comment / plan §1c:
 * `id`, `bubbleId`, `providerUnitKey` (a content hash — deliberately excluded),
 * `index`, `toolCalls`, `visibility`, `transcriptVisibility`, `audience`,
 * `source`, `userFacing`, `internal`/`isInternal`, `debug`, `meta` (except
 * `meta.streaming`), `_type`/`_sub`, and any top-level candidate field not
 * named in `encodeTranscriptSnapshot` (`workspace`, `sourcePath`, `env`, an
 * API key under an unexpected key, etc.).
 */

const DROPPED = 'SENTINEL_MUST_NEVER_REACH_THE_WIRE_9f3c7ab1';

function sentinelMessage(overrides: Record<string, unknown> = {}) {
    return {
        role: 'assistant',
        kind: 'standard',
        content: 'legitimate transcript content — allowed on this wire',
        receivedAt: 1_700_000_000_000,
        timestamp: 1_700_000_000_000,
        turnKey: 'turn-1',
        sequence: 3,
        bubbleState: 'final',
        senderName: 'Claude',
        toolName: null,
        // ── dropped fields, every one seeded with the sentinel ──
        id: DROPPED,
        bubbleId: DROPPED,
        providerUnitKey: DROPPED,
        index: DROPPED,
        toolCalls: [{ name: DROPPED, args: DROPPED }],
        visibility: DROPPED,
        transcriptVisibility: DROPPED,
        audience: DROPPED,
        source: DROPPED,
        userFacing: DROPPED,
        internal: DROPPED,
        isInternal: DROPPED,
        debug: DROPPED,
        _type: DROPPED,
        _sub: DROPPED,
        // `meta.streaming` is the ONE meta field that travels; every sibling
        // key must not.
        meta: { streaming: true, label: DROPPED, isRunning: DROPPED, extra: DROPPED },
        ...overrides,
    };
}

function sentinelCandidate(overrides: Partial<TranscriptSnapshotCandidate> = {}): TranscriptSnapshotCandidate {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-cli',
        producerDaemonId: 'daemon_test',
        producerWriterId: 'writer-1',
        producerEpoch: 'epoch-1',
        revision: 1,
        observedAt: '2026-09-23T00:00:00.000Z',
        status: 'idle',
        messages: [sentinelMessage() as any],
        coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false } as any,
        // ── top-level dropped fields (not named in encodeTranscriptSnapshot) ──
        workspace: DROPPED,
        sourcePath: DROPPED,
        env: { API_KEY: DROPPED },
        apiKey: DROPPED,
        secretToken: DROPPED,
        debugDump: { anything: DROPPED },
        ...overrides,
    } as TranscriptSnapshotCandidate;
}

describe('encodeTranscriptSnapshot — transcript wire content boundary', () => {
    it('never copies a dropped field into the encoded snapshot object graph', () => {
        const encoded = encodeTranscriptSnapshot(sentinelCandidate());

        // Structural walk: the sentinel must not appear as a VALUE anywhere in
        // the encoded object graph (not merely "at the expected key" — a bug
        // that renamed a dropped field into an allow-listed slot would still
        // be caught here).
        const seen = new Set<unknown>();
        const found: string[] = [];
        const walk = (value: unknown, path: string) => {
            if (value === DROPPED) { found.push(path); return; }
            if (value && typeof value === 'object') {
                if (seen.has(value)) return;
                seen.add(value);
                for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                    walk(child, `${path}.${key}`);
                }
            }
        };
        walk(encoded, '$');

        expect(found, `sentinel leaked at: ${found.join(', ')}`).toEqual([]);
    });

    it('never serializes the sentinel anywhere in the JCS/JSON-canonical bytes', () => {
        const encoded = encodeTranscriptSnapshot(sentinelCandidate());
        expect(JSON.stringify(encoded)).not.toContain(DROPPED);
    });

    it('control: the sentinel WOULD be caught if content legitimately carried it — content itself is allowed through', () => {
        // Belt-and-braces on the test itself: prove the walk/serialize checks
        // are not vacuously passing (e.g. because DROPPED never appears
        // anywhere). `content` is the one field that is SUPPOSED to carry
        // arbitrary chat text on this content-class topic, so seeding the
        // sentinel there must be visible in the output — otherwise the two
        // assertions above would pass even if the encoder secretly dropped
        // every field, including the ones that should travel.
        const encoded = encodeTranscriptSnapshot(sentinelCandidate({
            messages: [sentinelMessage({ content: DROPPED }) as any],
        }));
        expect(encoded.messages[0]?.content).toBe(DROPPED);
        expect(JSON.stringify(encoded)).toContain(DROPPED);
    });

    it('meta.streaming is the only meta field that survives', () => {
        const encoded = encodeTranscriptSnapshot(sentinelCandidate());
        expect(encoded.messages[0]?.streaming).toBe(true);
    });

    it('sequence — the one per-message identity field — is preserved (not itself a leak)', () => {
        const encoded = encodeTranscriptSnapshot(sentinelCandidate());
        expect(encoded.messages[0]?.sequence).toBe(3);
    });
});
