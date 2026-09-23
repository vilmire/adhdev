/**
 * SEND-NOW-AGENT-QUEUE regression, against a REAL SpecCliAdapter driving a REAL
 * FsmDriver over a fake PTY — deliberately not a stubbed adapter, for the same
 * reason interrupt-and-deliver-real-adapter.test.ts is not: a stub can be made
 * to satisfy whatever ordering the implementation happens to produce, which is
 * how the retired `forceSendMessage` passed its tests for months.
 *
 * What must be proven here are properties of the live wiring:
 *
 *   1. The body IS written while the session is generating — the feature.
 *   2. It is written as a SPLIT write: the body and the submit key are separate
 *      PTY writes, with the body carrying no trailing CR. The atomic
 *      `text + '\r'` shape is the retired force-inject and was measured NOT to
 *      be consumed mid-turn; reintroducing it would silently un-fix this.
 *   3. There is a real GAP between the two writes, not an immediate pair.
 *   4. win32 never reaches this path at all — nothing is written there.
 *   5. The turn in flight is NOT interrupted: no stop key is written.
 *
 * The fake PTY records every byte in order, so assertions are made against the
 * actual write sequence rather than against mock call counts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpecCliAdapter } from '../../src/providers/spec/cli-adapter.js';
import { CTRL_C } from '../../src/providers/spec/interrupt-capability.js';
import { sendNowIntoAgentQueue } from '../../src/commands/send-now-queued-write.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../src/cli-adapters/pty-transport.js';

/** Bracketed-paste markers, spelled literally rather than imported so the test
 *  pins the BYTES the CLI must receive — importing the constant would make the
 *  assertion pass against any value the source happens to hold. */
const BP_OPEN = '\x1b[200~';
const BP_CLOSE = '\x1b[201~';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 5150;
    readonly ready = Promise.resolve();
    /** Every write, with the wall clock it happened, so the GAP between the body
     *  and its submit key is assertable rather than assumed. */
    readonly writes: { data: string; at: number }[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void {
        this.writes.push({ data, at: Date.now() });
        // A real terminal echoes written input back into the rendered screen.
        this.dataCb?.(data);
    }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
    get data(): string[] { return this.writes.map(w => w.data); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

/** Claude-shaped spec whose idle ⇄ generating is driven by a footer marker the
 *  test feeds, standing in for the "esc to interrupt" spinner a real CLI draws.
 *  A `stop` control exists so the "no interrupt happened" assertion is
 *  meaningful — the capability is available and simply not used. */
function queueableSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'claude-cli',
        name: 'agent queue test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        control_bar: [
            { id: 'stop', label: 'Stop', visible_when_state: ['generating'], action: { type: 'send_keys', keys: CTRL_C } },
        ],
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→generating', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'esc to interrupt' } },
            { label: 'generating→idle', from: 'generating', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-now-queue-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function makeGeneratingAdapter() {
    const factory = new DrivableFactory();
    const adapter = new SpecCliAdapter(writeSpec(queueableSpec()), os.tmpdir(), [], {}, factory);
    await adapter.spawn();
    const pty = factory.last!;
    // Reach readiness, then go busy — the state a Send now press acts on.
    pty.feed('\n>\n? for shortcuts');
    await sleep(300);
    pty.feed('\n>\nesc to interrupt');
    await sleep(300);
    return { adapter, pty };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SEND-NOW-AGENT-QUEUE: split write into a generating session', () => {
    it('★ writes the body WHILE generating, as body and submit key in SEPARATE writes with a gap', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            expect(adapter.getStatus().status).toBe('generating');
            const before = pty.writes.length;

            const result = await sendNowIntoAgentQueue(adapter as never, 'queue this mid turn');
            expect(result.ok).toBe(true);

            // The submit key is scheduled after MID_GENERATION_SUBMIT_MIN_GAP_MS
            // (400) — wait past it.
            await sleep(900);

            const after = pty.writes.slice(before);
            const bodyIdx = after.findIndex(w => w.data.includes('queue this mid turn'));
            expect(bodyIdx).toBeGreaterThanOrEqual(0);

            // ── Property 2: the body write carries NO trailing CR. ───────────
            // This is the whole distinction from the retired force-inject: an
            // atomic `text + '\r'` is not consumed by the CLI mid-turn.
            const bodyWrite = after[bodyIdx].data;
            expect(bodyWrite).toBe('queue this mid turn');
            expect(bodyWrite.endsWith('\r')).toBe(false);

            // ── Property 2 (cont.): the CR is its own later write. ───────────
            const crIdx = after.findIndex((w, i) => i > bodyIdx && w.data === '\r');
            expect(crIdx).toBeGreaterThan(bodyIdx);

            // ── Property 3: a real gap separates them. ───────────────────────
            // Asserted below the 400ms floor to stay robust against timer
            // scheduling jitter on a loaded CI box, while still being far above
            // anything an atomic or back-to-back pair could produce.
            const gapMs = after[crIdx].at - after[bodyIdx].at;
            expect(gapMs).toBeGreaterThanOrEqual(300);

            // ── Property 5: the turn was NOT interrupted. ────────────────────
            expect(after.map(w => w.data).join('')).not.toContain(CTRL_C);

            // And the session is still generating — the turn in flight survived.
            expect(adapter.getStatus().status).toBe('generating');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ win32: writes NOTHING and refuses with platform_unsupported', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            expect(adapter.getStatus().status).toBe('generating');
            // The platform gate is read at call time from process.platform, so
            // stubbing it here exercises the real branch rather than a parallel
            // test-only path.
            vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

            const before = pty.writes.length;
            const result = await sendNowIntoAgentQueue(adapter as never, 'must not be written on win32');

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('platform_unsupported');

            // Wait long enough that a scheduled CR would have fired.
            await sleep(900);
            const after = pty.writes.slice(before).map(w => w.data).join('');
            expect(after).not.toContain('must not be written on win32');
            expect(after).toBe('');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('refuses at an IDLE session — the ordinary send path is strictly better there', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            pty.feed('\n>\n? for shortcuts');
            await sleep(400);
            expect(adapter.getStatus().status).toBe('idle');

            const before = pty.writes.length;
            const result = await sendNowIntoAgentQueue(adapter as never, 'not while idle');

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('not_generating');

            await sleep(900);
            expect(pty.writes.slice(before).map(w => w.data).join('')).not.toContain('not while idle');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);
});

describe('SEND-NOW-DOUBLE-SEND: image bodies claim by claimKey and deliver the PARKED body (IMAGE-TRIPLE-BUBBLE ④)', () => {
    /**
     * Live defect (2026-09-23): an image send parks the BUILT prompt
     * ("<path>\n<text>") while the dashboard presses Send now with only the raw
     * text. The text-keyed claim found nothing → the split write delivered the
     * raw text AND the idle drain later delivered the parked prompt: one press,
     * two agent turns (17:24:08 text-only + 17:24:21 image turn, separate
     * assistant responses each).
     */
    it('★ one press → exactly ONE delivery, of the parked image body', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            const builtBody = '/tmp/adhdev-input-media/img-abc.png\ncheck this shot';
            // The structured send parked earlier, while generating — with its
            // claimKey (the raw dashboard text), as cli-provider-instance now sends.
            const parked = await adapter.sendMessage(builtBody, { bracketedPaste: true, claimKey: 'check this shot' });
            expect(parked).toEqual({ status: 'queued' });

            // Send now arrives with ONLY the raw text.
            const result = await sendNowIntoAgentQueue(adapter as never, 'check this shot');
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.claimed).toBe(1);

            await sleep(900);
            // The split write delivered the PARKED body — attachment path intact —
            // not the bare text.
            const bodyWrites = pty.writes.filter(w => w.data === builtBody);
            expect(bodyWrites).toHaveLength(1);
            expect(pty.writes.some(w => w.data === 'check this shot')).toBe(false);

            // Regression: the turn ends → the idle drain must have NOTHING left to
            // redeliver. Under the broken claim this is where the second turn came from.
            pty.feed('\n>\n? for shortcuts');
            await sleep(600);
            expect(pty.writes.filter(w => w.data === builtBody)).toHaveLength(1);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ a refused write re-parks the body WITH its claimKey, so it stays claimable and drains once', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            const builtBody = '/tmp/adhdev-input-media/img-def.png\nlook';
            await adapter.sendMessage(builtBody, { bracketedPaste: true, claimKey: 'look' });

            // Force the refusal AFTER the claim: platform gate reads at call time.
            vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
            const refused = await sendNowIntoAgentQueue(adapter as never, 'look');
            expect(refused.ok).toBe(false);
            if (!refused.ok) expect(refused.restored).toBe(true);
            vi.restoreAllMocks();

            // Still claimable by the raw text — the restore preserved the claimKey.
            const entries = adapter.claimQueuedSendEntries('look');
            expect(entries).toHaveLength(1);
            expect(entries[0].text).toBe(builtBody);
            expect(entries[0].claimKey).toBe('look');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('cancel-by-raw-text now finds a parked image body too (same claim primitive)', async () => {
        const { adapter } = await makeGeneratingAdapter();
        try {
            await adapter.sendMessage('/tmp/img.png\nnever mind', { bracketedPaste: true, claimKey: 'never mind' });
            expect(adapter.claimQueuedSends('never mind')).toBe(1);
            expect(adapter.claimQueuedSends('never mind')).toBe(0);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);
});

describe('SEND-NOW-PASTE-LOSS: the mid-generation write honours bracketedPaste (live 2026-09-23, darwin)', () => {
    /**
     * The mid-generation branch of actuallySendMessage RECEIVED `bracketedPaste`
     * and returned before ever reaching the wrapInPaste block, so a send-now'd
     * image body reached claude-cli as literal text and was never converted into
     * an attachment — the owner's picture arrived as a filename. The idle drain
     * was unaffected (it calls beginSend → the wrapInPaste branch), which is the
     * asymmetry that identified the defect.
     *
     * These assertions pin the four properties the fix must have: the wrap
     * happens, the raw body is NOT also written, the non-image path is preserved
     * byte-for-byte, and the split structure (body and submit key as separate
     * writes) survives the wrapping.
     */
    const IMG_BODY = '/tmp/adhdev-input-media/adhdev-input-image-1-0-aaaa.png\nwhat is this?';

    /** claude-shaped spec with the POSIX image-paste opt-in the real claude-cli
     *  provider carries. Without the opt-in the wrap must not happen at all. */
    function pasteOptInSpec(optIn: boolean): Record<string, unknown> {
        const spec = queueableSpec();
        spec.send_message = optIn
            ? { submit_key: '\r', posix_bracketed_paste_for_images: true }
            : { submit_key: '\r' };
        return spec;
    }

    async function generatingAdapterWithSpec(optIn: boolean) {
        const factory = new DrivableFactory();
        const adapter = new SpecCliAdapter(writeSpec(pasteOptInSpec(optIn)), os.tmpdir(), [], {}, factory);
        await adapter.spawn();
        const pty = factory.last!;
        pty.feed('\n>\n? for shortcuts');
        await sleep(300);
        pty.feed('\n>\nesc to interrupt');
        await sleep(300);
        return { adapter, pty };
    }

    it('★ wraps the body in bracketed-paste markers, and does NOT also write it raw', async () => {
        const { adapter, pty } = await generatingAdapterWithSpec(true);
        try {
            expect(adapter.getStatus().status).toBe('generating');
            const before = pty.writes.length;

            const outcome = adapter.sendMessageDuringGeneration(IMG_BODY, true);
            expect(outcome.accepted).toBe(true);
            await sleep(900);

            const after = pty.writes.slice(before).map(w => w.data);
            // The body write is the WRAPPED body, exactly — same markers the idle
            // drain uses, no second paste concept.
            expect(after).toContain(`${BP_OPEN}${IMG_BODY}${BP_CLOSE}`);
            // ★ The unwrapped body must not ALSO land: that would be the defect
            // surviving alongside the fix, and claude-cli would see it twice.
            expect(after).not.toContain(IMG_BODY);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ keeps the split structure: the wrapped body and the submit key are SEPARATE writes with a gap', async () => {
        const { adapter, pty } = await generatingAdapterWithSpec(true);
        try {
            const before = pty.writes.length;
            expect(adapter.sendMessageDuringGeneration(IMG_BODY, true).accepted).toBe(true);
            await sleep(900);

            const after = pty.writes.slice(before);
            const bodyIdx = after.findIndex(w => w.data === `${BP_OPEN}${IMG_BODY}${BP_CLOSE}`);
            expect(bodyIdx).toBeGreaterThanOrEqual(0);
            // No trailing CR fused onto the wrapped body — the atomic shape stays
            // forbidden here exactly as it is for a plain text body.
            expect(after[bodyIdx].data.endsWith('\r')).toBe(false);

            const crIdx = after.findIndex((w, i) => i > bodyIdx && w.data === '\r');
            expect(crIdx).toBeGreaterThan(bodyIdx);
            expect(after[crIdx].at - after[bodyIdx].at).toBeGreaterThanOrEqual(300);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ bracketedPaste: false keeps the legacy RAW write, byte for byte', async () => {
        const { adapter, pty } = await generatingAdapterWithSpec(true);
        try {
            const before = pty.writes.length;
            expect(adapter.sendMessageDuringGeneration('plain text body', false).accepted).toBe(true);
            await sleep(900);

            const after = pty.writes.slice(before).map(w => w.data);
            expect(after).toContain('plain text body');
            expect(after.join('')).not.toContain(BP_OPEN);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ a spec that does NOT opt in keeps the raw write even with bracketedPaste: true', async () => {
        const { adapter, pty } = await generatingAdapterWithSpec(false);
        try {
            const before = pty.writes.length;
            expect(adapter.sendMessageDuringGeneration(IMG_BODY, true).accepted).toBe(true);
            await sleep(900);

            const after = pty.writes.slice(before).map(w => w.data);
            expect(after).toContain(IMG_BODY);
            expect(after.join('')).not.toContain(BP_OPEN);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ the IDLE drain path is unchanged — a parked image body still drains wrapped, exactly once', async () => {
        const { adapter, pty } = await generatingAdapterWithSpec(true);
        try {
            // Parked while generating → delivered by drainPendingSends at idle.
            expect(await adapter.sendMessage(IMG_BODY, { bracketedPaste: true })).toEqual({ status: 'queued' });
            const before = pty.writes.length;

            pty.feed('\n>\n? for shortcuts');
            await sleep(900);

            const after = pty.writes.slice(before).map(w => w.data);
            expect(after.filter(w => w === `${BP_OPEN}${IMG_BODY}${BP_CLOSE}`)).toHaveLength(1);
            expect(after).not.toContain(IMG_BODY);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);
});

describe('SEND-NOW-AGENT-QUEUE: claim / restore bookkeeping', () => {
    /** Adapter double for the bookkeeping properties, which are about what this
     *  module does AROUND the write and are not observable at the PTY. */
    function fakeAdapter(outcome: { accepted: true } | { accepted: false; reason: string }) {
        const calls: string[] = [];
        return {
            calls,
            cliType: 'claude-cli',
            claimQueuedSends(_text: string): number { calls.push('claim'); return 2; },
            sendMessageDuringGeneration(_text: string) { calls.push('write'); return outcome as never; },
            async sendMessage(_text: string) { calls.push('restore'); return { status: 'queued' as const }; },
        };
    }

    it('★ claims the parked copies BEFORE writing, so the body is delivered exactly once', async () => {
        const adapter = fakeAdapter({ accepted: true });
        const result = await sendNowIntoAgentQueue(adapter as never, 'body');

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.claimed).toBe(2);
        // Order matters: claiming AFTER the write would leave a window in which
        // the driver's idle drain could also deliver the same body.
        expect(adapter.calls).toEqual(['claim', 'write']);
    });

    it('★ restores the claimed body when the write is refused, so nothing is silently lost', async () => {
        const adapter = fakeAdapter({ accepted: false, reason: 'send_in_flight' });
        const result = await sendNowIntoAgentQueue(adapter as never, 'body');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('send_in_flight');
            expect(result.restored).toBe(true);
        }
        expect(adapter.calls).toEqual(['claim', 'write', 'restore']);
    });

    it('★ delivers the claimed ENTRY body and restores it with claimKey on refusal (entry-returning claim)', async () => {
        const written: string[] = [];
        const restored: Array<{ text: string; opts?: Record<string, unknown> }> = [];
        const adapter = {
            cliType: 'claude-cli',
            claimQueuedSendEntries(_text: string) {
                return [{ text: 'BUILT-IMG-BODY', bracketedPaste: true, claimKey: 'raw text' }];
            },
            sendMessageDuringGeneration(text: string) { written.push(text); return { accepted: false, reason: 'send_in_flight' } as never; },
            async sendMessage(text: string, opts?: Record<string, unknown>) { restored.push({ text, opts }); return { status: 'queued' as const }; },
        };
        const result = await sendNowIntoAgentQueue(adapter as never, 'raw text');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.restored).toBe(true);
        // The write attempt used the PARKED body, not the raw text…
        expect(written).toEqual(['BUILT-IMG-BODY']);
        // …and the restore re-parked that same body with its claimKey intact.
        expect(restored).toEqual([{ text: 'BUILT-IMG-BODY', opts: { bracketedPaste: true, claimKey: 'raw text' } }]);
    });

    it('reports not_supported (and writes nothing) for a driver without the split write', async () => {
        const calls: string[] = [];
        const adapter = {
            cliType: 'legacy-cli',
            claimQueuedSends(_t: string) { calls.push('claim'); return 1; },
            async sendMessage(_t: string) { calls.push('restore'); return { status: 'queued' as const }; },
        };
        const result = await sendNowIntoAgentQueue(adapter as never, 'body');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_supported');
        // Nothing was claimed, so there is nothing to put back.
        expect(calls).toEqual([]);
    });
});
