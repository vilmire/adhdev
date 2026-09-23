/**
 * SEND-NOW-AGENT-QUEUE regression — `policy: send_now` through SessionInputService
 * (wiring-unification D2) against a REAL SpecCliAdapter driving a REAL FsmDriver
 * over a fake PTY — deliberately not a stubbed adapter, for the same reason
 * session-input-interrupt-real-adapter.test.ts is not: a stub can be made
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
import { createSessionInputService, type SessionInputTarget } from '../../src/sessions/session-input-service.js';
import { buildSessionInputTarget, type SessionInputAdapterLike } from '../../src/sessions/session-input-target.js';
import type { SubmitOutcome } from '@adhdev/mesh-shared';
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

let idCounter = 0;

/** The legacy result shape the assertions below were written against. */
function legacy(outcome: SubmitOutcome) {
    if (outcome.kind === 'refused') return { ok: false as const, reason: outcome.reason as string, restored: outcome.restored };
    if (outcome.kind === 'duplicate') return { ok: false as const, reason: 'duplicate', restored: true };
    return { ok: true as const, route: outcome.kind === 'delivered' ? outcome.route : undefined, kind: outcome.kind };
}

/** Submit `text` with policy send_now (under `messageId`, default fresh) against `target`. */
async function sendNowVia(adapterOrTarget: object, text: string, messageId?: string, raw = false) {
    const target = raw ? adapterOrTarget as SessionInputTarget : buildSessionInputTarget({ adapter: adapterOrTarget as SessionInputAdapterLike });
    const svc = createSessionInputService({ resolveSession: () => target });
    return legacy(await svc.submit({
        messageId: messageId ?? `msg_fresh_${++idCounter}`,
        sessionId: 's1',
        input: { parts: [{ type: 'text', text }], textFallback: text },
        origin: 'dashboard',
        policy: { mode: 'send_now' },
        createdAt: Date.now(),
    }));
}

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

            const result = await sendNowVia(adapter, 'queue this mid turn');
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
            const result = await sendNowVia(adapter, 'must not be written on win32');

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

    // ★D2 (BUSY_DECISION send_now × ready → write): at an IDLE prompt there is
    // no turn to queue behind, so send_now is an ordinary turn — never the
    // split write, and no longer a refusal the owner has to retry.
    it('at an IDLE session send_now is an ordinary turn, not the split write', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            pty.feed('\n>\n? for shortcuts');
            await sleep(400);
            expect(adapter.getStatus().status).toBe('idle');

            const before = pty.writes.length;
            const result = await sendNowVia(adapter, 'answered now');

            expect(result.ok).toBe(true);
            if (result.ok) expect(result.route).toBe('pty');

            await sleep(900);
            expect(pty.writes.slice(before).map(w => w.data).join('')).toContain('answered now');
        } finally {
            adapter.shutdown();
        }
    }, 15_000);
});

describe('SEND-NOW-DOUBLE-SEND: a parked image body is claimed by messageId and delivered as PARKED (IMAGE-TRIPLE-BUBBLE ④)', () => {
    /**
     * Live defect (2026-09-23): an image send parks the BUILT prompt
     * ("<path>\n<text>") while the dashboard presses Send now. The old text-keyed
     * claim found nothing → the split write delivered the raw text AND the idle
     * drain later delivered the parked prompt: one press, two agent turns. With
     * D2 the parked entry is keyed by the messageId the press resubmits.
     */
    it('★ one press → exactly ONE delivery, of the parked image body', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            const builtBody = '/tmp/adhdev-input-media/img-abc.png\ncheck this shot';
            const parked = await adapter.sendMessage(builtBody, { bracketedPaste: true, messageId: 'msg_img_1' });
            expect(parked).toEqual({ status: 'queued', position: 1 });

            // Send now arrives with the SAME messageId (and only the raw text in hand).
            const result = await sendNowVia(adapter, 'check this shot', 'msg_img_1');
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.route).toBe('agent_queue');

            await sleep(900);
            expect(pty.writes.filter(w => w.data === builtBody)).toHaveLength(1);
            expect(pty.writes.some(w => w.data === 'check this shot')).toBe(false);

            pty.feed('\n>\n? for shortcuts');
            await sleep(600);
            expect(pty.writes.filter(w => w.data === builtBody)).toHaveLength(1);
        } finally {
            adapter.shutdown();
        }
    }, 15_000);

    it('★ a refused write restores the body IN PLACE under its messageId, so it stays claimable and drains once', async () => {
        const { adapter, pty } = await makeGeneratingAdapter();
        try {
            const builtBody = '/tmp/adhdev-input-media/img-def.png\nlook';
            await adapter.sendMessage('ahead of it', { messageId: 'msg_ahead' });
            await adapter.sendMessage(builtBody, { bracketedPaste: true, messageId: 'msg_img_2' });

            vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
            const refused = await sendNowVia(adapter, 'look', 'msg_img_2');
            expect(refused.ok).toBe(false);
            if (!refused.ok) {
                expect(refused.reason).toBe('platform_unsupported');
                expect(refused.restored).toBe(true);
            }
            vi.restoreAllMocks();

            // Same position, same body, same paste flag.
            const claimed = adapter.claimQueuedSend('msg_img_2');
            expect(claimed?.index).toBe(1);
            expect(claimed?.entry).toEqual({ messageId: 'msg_img_2', text: builtBody, bracketedPaste: true });
            void pty;
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
            expect(await adapter.sendMessage(IMG_BODY, { bracketedPaste: true })).toEqual({ status: 'queued', position: 1 });
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
    /** Target double for the bookkeeping properties, which are about what the
     *  service does AROUND the write and are not observable at the PTY. */
    function fakeTarget(outcome: { accepted: true } | { accepted: false; reason: string }) {
        const calls: string[] = [];
        const target: SessionInputTarget = {
            getStatus: () => ({ status: 'generating' }),
            hasQueuedSend: () => true,
            claimQueuedSend(messageId) { calls.push('claim'); return { entry: { messageId, text: 'BUILT-IMG-BODY', bracketedPaste: true }, index: 2 }; },
            sendMessageDuringGeneration(text) { calls.push(`write:${text}`); return outcome; },
            restoreQueuedSend(claimed) { calls.push(`restore@${claimed.index}`); },
            async sendMessage() { calls.push('send'); return { status: 'queued' as const }; },
        };
        return { calls, target };
    }

    it('★ claims the parked body BEFORE writing, and writes the PARKED body', async () => {
        const { calls, target } = fakeTarget({ accepted: true });
        const result = await sendNowVia(target, 'raw text', 'msg_parked', true);

        expect(result.ok).toBe(true);
        // Order matters: claiming AFTER the write would leave a window in which
        // the driver's idle drain could also deliver the same body.
        expect(calls).toEqual(['claim', 'write:BUILT-IMG-BODY']);
    });

    it('★ restores the claimed body in place when the write is refused, so nothing is silently lost', async () => {
        const { calls, target } = fakeTarget({ accepted: false, reason: 'send_in_flight' });
        const result = await sendNowVia(target, 'raw text', 'msg_parked', true);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('send_in_flight');
            expect(result.restored).toBe(true);
        }
        expect(calls).toEqual(['claim', 'write:BUILT-IMG-BODY', 'restore@2']);
    });

    it('reports not_supported (and claims nothing) for a target without the split write', async () => {
        const calls: string[] = [];
        const target: SessionInputTarget = {
            getStatus: () => ({ status: 'generating' }),
            hasQueuedSend: () => true,
            claimQueuedSend() { calls.push('claim'); return null; },
            async sendMessage() { calls.push('send'); return { status: 'queued' as const }; },
        };
        const result = await sendNowVia(target, 'body', 'msg_parked', true);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_supported');
        expect(calls).toEqual([]);
    });
});
