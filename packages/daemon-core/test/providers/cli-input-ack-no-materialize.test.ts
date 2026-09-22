/**
 * (IMAGE-TRIPLE-BUBBLE ③) The transcript ack must DESCRIBE a structured send,
 * never re-perform it.
 *
 * Live defect (2026-09-23): `recordAcknowledgedUserInput` re-ran the delivery
 * prompt builder on the envelope, which re-materialized every base64 image
 * into a SECOND temp file (1ms twin files per send: `…822`/`…823`) and stamped
 * that never-delivered temp path into the ledger ack — so read paths
 * (read_chat / mesh_read_chat) exposed a local path that was not even the one
 * sent.
 *
 * Pinned here:
 *   - a data-carrying image part acks as the content-free `[image: <mime>]`
 *     marker, no filesystem write, no temp path;
 *   - a caller-supplied URI image keeps its path (that is the caller's own
 *     reference — the delivered prompt shows the same);
 *   - the ack is DETERMINISTIC, which is what makes the TASKBUBBLE-DUP
 *     content-keyed dedup actually collapse a redelivered image dispatch;
 *   - the b6c2444d contract (record only after acknowledged success) is
 *     asserted end-to-end by test/commands/send-chat-image-ledger.test.ts,
 *     which this change must keep green.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The shared materialize dir the DELIVERY builder writes twin files into.
 *  The ack builder must never add anything here. */
const MATERIALIZE_DIR = path.join(os.tmpdir(), 'adhdev-input-media');
function listMaterialized(): string[] {
    try { return fs.readdirSync(MATERIALIZE_DIR).filter((f) => f.startsWith('adhdev-input-image-')); } catch { return []; }
}
import { buildCliInputAckText } from '../../src/providers/cli-provider-input-prompt.js';
import { recordAcknowledgedUserInput, type RuntimeMessagesHost } from '../../src/providers/cli-provider-runtime-messages.js';
import type { InputEnvelope } from '../../src/providers/contracts.js';

const PNG_DATA = Buffer.from('fake-png-bytes').toString('base64');

function imageEnvelope(text = '이 스크린샷 봐줘'): InputEnvelope {
    return {
        parts: [
            { type: 'image', mimeType: 'image/png', data: PNG_DATA, alt: 'shot.png' },
            { type: 'text', text },
        ],
        textFallback: text,
    } as InputEnvelope;
}

function fakeHost(): RuntimeMessagesHost & { appended: unknown[][] } {
    const appended: unknown[][] = [];
    return {
        appended,
        type: 'claude-cli',
        workingDir: '/tmp/ack-test',
        instanceId: 'ack-test-1',
        historyWriter: { appendNewMessages: (...args: unknown[]) => { appended.push(args); } } as never,
        adapter: { getScriptParsedStatus: () => null },
        runtimeMessages: [],
        parsedIngestTimestamps: { stamp: (m: never) => m } as never,
        recentUserInputAcks: new Map(),
        lastAcknowledgedUserInputAt: 0,
    };
}

describe('buildCliInputAckText — content-free, no materialization', () => {
    it('★ renders a base64 data image as [image: <mime>] and materializes nothing', () => {
        const before = listMaterialized();

        const ack = buildCliInputAckText(imageEnvelope());

        expect(ack).toBe('[image: image/png]\nshot.png\n이 스크린샷 봐줘');
        expect(ack).not.toContain(os.tmpdir());
        expect(ack).not.toContain('adhdev-input-image-');
        // Nothing new landed in the shared materialize dir. (Exact-set compare
        // rather than a count so an unrelated worker's cleanup can only shrink
        // it, never fail this.)
        const after = listMaterialized();
        expect(after.filter((f) => !before.includes(f))).toEqual([]);
    });

    it('keeps a caller-supplied file URI — that path is the caller\'s own reference', () => {
        const ack = buildCliInputAckText({
            parts: [{ type: 'image', mimeType: 'image/png', uri: 'file:///home/user/shot.png' }],
            textFallback: '',
        } as InputEnvelope);
        expect(ack).toBe('/home/user/shot.png');
    });

    it('★ is deterministic — two acks of the same envelope are byte-identical (dedup prerequisite)', () => {
        expect(buildCliInputAckText(imageEnvelope())).toBe(buildCliInputAckText(imageEnvelope()));
    });
});

describe('recordAcknowledgedUserInput — ledger never carries a materialized temp path', () => {
    it('★ records the marker form and creates no temp file', () => {
        const before = listMaterialized();
        const host = fakeHost();

        recordAcknowledgedUserInput(host, imageEnvelope());

        expect(host.runtimeMessages).toHaveLength(1);
        const content = String(host.runtimeMessages[0].message.content);
        expect(content).toContain('[image: image/png]');
        expect(content).toContain('이 스크린샷 봐줘');
        expect(content).not.toContain('adhdev-input-image-');
        expect(content).not.toContain(os.tmpdir());
        const after = listMaterialized();
        expect(after.filter((f) => !before.includes(f))).toEqual([]);
        expect(host.appended).toHaveLength(1);
    });

    it('★ TASKBUBBLE-DUP now collapses a redelivered IMAGE dispatch — the twin temp paths used to defeat it', () => {
        const host = fakeHost();
        recordAcknowledgedUserInput(host, imageEnvelope());
        recordAcknowledgedUserInput(host, imageEnvelope());
        // Same envelope inside the dedup window → ONE bubble. With the old
        // re-materializing ack the two contents differed by temp path and both
        // bubbled.
        expect(host.runtimeMessages).toHaveLength(1);
    });
});
