import { describe, expect, it } from 'vitest';
import {
    encodeChatMessageHead,
    encodeChatMeta,
    type ChatMessageCandidate,
    type ChatMessageStamp,
    type ChatMetaCandidate,
    type ChatMetaStamp,
} from '../../src/seqscribe/transcript-keyed-codec.js';

/**
 * Phase G, unit G4 — transcript content-boundary sentinel (design §7e, plan
 * §5/§6a G-4), on the keyed chat wire (design 2026-09-28 message-keyed
 * storage §4.3, §8.1 item 11). `session.<id>.chat` IS a content-class topic
 * (unlike the status path `cloud-status-content-boundary.test.ts` guards):
 * bubble bodies legitimately carry chat text, because this topic never reaches
 * the server (CLAUDE.md's Beacon exception covers only the topic NAME, never a
 * payload) — subscribers are daemon replicas and browser/mesh peers holding the
 * same P2P-level trust as the live `read_chat` result.
 *
 * What this test guards is narrower and different in kind: `encodeChatMessage
 * Head`/`encodeChatMeta` (transcript-keyed-codec.ts) are a CLOSED ALLOW-LIST
 * over loosely-typed candidate objects that carry an index signature
 * (`[extra: string]: unknown`) precisely because the real upstream shapes
 * (`ChatMessage`, `SessionTurnPresentation`) are `Record<string, unknown>`
 * grab-bags. `check:message-projection-parity` is the STATIC guard that the
 * encoder's own source only ever reads fields by name (no spread, no
 * object-walk). This is the RUNTIME complement: seed every field the encoder
 * is NOT supposed to read with a sentinel and assert the sentinel is absent
 * from the actually-encoded, actually-serialized output.
 *
 * Dropped per bubble: the candidate's own `messageId`/`ord` (identity comes
 * from the producer's stamp), `id`, `bubbleId`, `providerUnitKey` (a content
 * hash), `_src` (the ledger's reader address), `fp`, `sequence`, `toolBlockRef`
 * (mtime-sealed — expand resolves by `messageId`), `index`, `toolCalls`,
 * visibility/audience/source flags, `meta` (except `meta.streaming`),
 * `_type`/`_sub`. Dropped from meta: any top-level candidate field not named in
 * `encodeChatMeta` (`workspace`, `sourcePath`, `env`, an API key under an
 * unexpected key, etc.).
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
        bubbleState: 'final',
        senderName: 'Claude',
        toolName: null,
        // ── dropped fields, every one seeded with the sentinel ──
        id: DROPPED,
        messageId: DROPPED,
        ord: DROPPED,
        sequence: DROPPED,
        toolBlockRef: { sourceMtimeMs: DROPPED, recordIndex: DROPPED, blockIndex: DROPPED },
        _src: { cls: 'n', L: DROPPED, addr: DROPPED },
        fp: DROPPED,
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

const STAMP: ChatMessageStamp = {
    id: 'n.deadbeef.1.0',
    ord: 'a0',
    rev: 1,
    epoch: 'epoch-1',
    frame: 1,
    srcId: null,
    body: { text: 'legitimate transcript content — allowed on this wire' },
};

const META_STAMP: ChatMetaStamp = {
    rev: 1,
    epoch: 'epoch-1',
    frame: 1,
    producerDaemonId: 'daemon_test',
    ledgerEpoch: 'ledger-1',
    coverage: { mode: 'full', omittedBefore: false },
};

function sentinelMeta(overrides: Record<string, unknown> = {}): ChatMetaCandidate {
    return {
        sessionId: 'sess-1',
        providerType: 'claude-cli',
        status: 'idle',
        provenance: { messageSource: { selected: 'native-history', sourcePath: DROPPED } },
        activeModal: { message: 'Approve?', buttons: ['Yes'], extra: DROPPED },
        // ── top-level dropped fields (not named in encodeChatMeta) ──
        workspace: DROPPED,
        sourcePath: DROPPED,
        env: { API_KEY: DROPPED },
        apiKey: DROPPED,
        secretToken: DROPPED,
        debugDump: { anything: DROPPED },
        ...overrides,
    } as ChatMetaCandidate;
}

function encodeAll(message: Record<string, unknown> = sentinelMessage(), stamp: ChatMessageStamp = STAMP) {
    return {
        head: encodeChatMessageHead(message as ChatMessageCandidate, stamp),
        meta: encodeChatMeta(sentinelMeta(), META_STAMP),
    };
}

function findSentinel(value: unknown): string[] {
    const seen = new Set<unknown>();
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
        if (node === DROPPED) { found.push(path); return; }
        if (node && typeof node === 'object') {
            if (seen.has(node)) return;
            seen.add(node);
            for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, `${path}.${key}`);
        }
    };
    walk(value, '$');
    return found;
}

describe('keyed chat encoders — transcript wire content boundary', () => {
    it('never copies a dropped field into the encoded head or meta object graph', () => {
        // Structural walk: the sentinel must not appear as a VALUE anywhere (not
        // merely "at the expected key" — a bug that renamed a dropped field into
        // an allow-listed slot would still be caught here).
        const found = findSentinel(encodeAll());
        expect(found, `sentinel leaked at: ${found.join(', ')}`).toEqual([]);
    });

    it('never serializes the sentinel anywhere in the encoded bytes', () => {
        expect(JSON.stringify(encodeAll())).not.toContain(DROPPED);
    });

    it('control: a sentinel in the body the stamp carries IS visible — the checks are not vacuous', () => {
        const encoded = encodeAll(sentinelMessage(), { ...STAMP, body: { text: DROPPED } });
        expect(JSON.stringify(encoded)).toContain(DROPPED);
    });

    it('meta.streaming is the only meta field that survives', () => {
        expect(encodeAll().head.streaming).toBe(true);
    });

    it('identity comes from the producer stamp, never the candidate', () => {
        const { head } = encodeAll();
        expect(head.id).toBe(STAMP.id);
        expect(head.ord).toBe(STAMP.ord);
    });
});
