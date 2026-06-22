/**
 * Regression coverage for win32 ConPTY submit on the FSM/spec path.
 *
 * claude-cli (and other spec CLIs: codex, gemini, …) route through
 * FsmDriver.actuallySendMessage. The text and the submit key (`\r`) must NEVER
 * be fused into one PTY write on win32: Ink-based TUIs treat a single write
 * carrying text + a trailing CR as a bracketed/multi-line paste and absorb the
 * CR as a literal newline, so the prompt sits typed-but-unsent.
 *
 * Beyond that, A/B PTY testing on real win32 ConPTY established that a MULTILINE
 * message opens a nondeterministic Ink paste/newline-accumulation window during
 * which a lone CR is absorbed as a newline rather than a submit. Single-line
 * messages submit on the first CR; multiline needs a *variable* number of CRs as
 * the window expires — a fixed double-CR fails, and bracketed-paste wrapping does
 * not help. So the driver VERIFIES: it writes the text, then resends the submit
 * key on a fixed cadence until the FSM observes the agent has left the idle
 * composer (status flips away from 'idle'), bounded by a retry budget, and stops
 * the instant submission is observed. mac/linux keep the historical single CR.
 *
 * These tests drive the FSM to readiness, dispatch a message, optionally simulate
 * the agent transitioning to 'generating' (= it submitted), and assert the PTY
 * write shape under each simulated platform.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver, chunkPreservingSurrogates } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

// Minimal spec: starting → idle once the prompt footer is drawn, and idle →
// generating once the footer shows the interrupt hint (= the agent submitted and
// is now generating). submit_key is the CR that win32 swallows on multiline.
function submitSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.win32-submit',
        name: 'win32 submit test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Generating', status: 'generating' },
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
            {
                label: 'idle→generating',
                from: 'idle',
                to: 'generating',
                when: { section: 'footer', matches: 'esc to interrupt' },
            },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-win32-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

interface CollectOpts {
    text?: string;
    /** ms after dispatch to feed a 'generating' screen (simulating submission). */
    submitAfterMs?: number;
    /** ms after dispatch to stop collecting. */
    totalWaitMs?: number;
}

async function sendAndCollect(opts: CollectOpts = {}): Promise<string[]> {
    const { text = 'hello world', submitAfterMs, totalWaitMs = 700 } = opts;
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(submitSpec()),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    const pty = factory.last!;
    try {
        // Reach readiness so the message is sent immediately (not queued).
        pty.feed('\n>\n? for shortcuts');
        await sleep(200);
        const before = pty.writes.length;
        driver.dispatch({ kind: 'send_message', text });
        const start = Date.now();
        if (submitAfterMs != null) {
            await sleep(submitAfterMs);
            // Simulate the agent having submitted: footer now shows the interrupt
            // hint → FSM transitions idle→generating → resend loop stops.
            pty.feed('\n\nesc to interrupt');
        }
        await sleep(Math.max(0, totalWaitMs - (Date.now() - start)));
        return pty.writes.slice(before);
    } finally {
        driver.shutdown();
    }
}

const MULTILINE = 'line one\nline two\nline three';

describe('FsmDriver -- win32 submit', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('win32: writes text on its own — never fused with a trailing CR', async () => {
        setPlatform('win32');
        // The settle-gate holds the first CR until PTY output goes quiet (~500ms
        // after the last echo), so totalWaitMs must clear that window.
        const writes = await sendAndCollect({ text: MULTILINE, submitAfterMs: 480, totalWaitMs: 1300 });
        expect(writes).toContain(MULTILINE);
        expect(writes).not.toContain(`${MULTILINE}\r`);
        expect(writes).not.toContain('line three\r');
    });

    it('win32 multiline: resends CR but STOPS once the agent leaves idle (submitted)', async () => {
        setPlatform('win32');
        const writes = await sendAndCollect({ text: MULTILINE, submitAfterMs: 480, totalWaitMs: 1400 });
        const loneCr = writes.filter(w => w === '\r').length;
        // It submitted (FSM saw generating) within the first cadence tick, so the
        // resend loop halts — far below the budget, not a runaway.
        expect(loneCr).toBeGreaterThanOrEqual(1);
        expect(loneCr).toBeLessThanOrEqual(2);
    });

    it('win32 single-line: first CR submits, loop stops immediately', async () => {
        setPlatform('win32');
        const writes = await sendAndCollect({ text: 'hello world', submitAfterMs: 320, totalWaitMs: 1200 });
        expect(writes).toContain('hello world');
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(1);
    });

    it('win32: if the prompt never submits, resends are bounded by the budget (no runaway)', async () => {
        setPlatform('win32');
        // Never feed a generating screen → status stays idle → loop exhausts its
        // budget (WIN32_SUBMIT_MAX_RESENDS = 14) and then stops.
        const writes = await sendAndCollect({ text: MULTILINE, totalWaitMs: 5600 });
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(14);
    }, 12000);

    it('non-win32: keeps the historical split write (text, then a single separate CR)', async () => {
        setPlatform('darwin');
        const writes = await sendAndCollect({ text: 'hello world', totalWaitMs: 700 });
        expect(writes).toContain('hello world');
        expect(writes).toContain('\r');
        expect(writes).not.toContain('hello world\r');
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(1);
    });

    // ── DISPATCHTRUNC regression: long-message front-truncation ──────────────
    //
    // A long multi-step instruction was arriving front-truncated at remote
    // workers: the win32 path wrote the whole body in one unbounded ConPTY write
    // and fired the submit CR on a blind fixed delay, so for a long body the CR
    // submitted a half-arrived prompt (leading lines lost). The fix paces the body
    // into bounded chunks and holds the first CR until the PTY output settles.

    it('win32 long body: written in bounded chunks that reassemble to the full text (no front loss)', async () => {
        setPlatform('win32');
        // 60 lines, > WIN32_PTY_WRITE_CHUNK_CHARS (1024) → must be chunked.
        const text = Array.from({ length: 60 }, (_, i) => `step ${i}: do the thing carefully and report`).join('\n');
        expect(text.length).toBeGreaterThan(1024);
        const writes = await sendAndCollect({ text, submitAfterMs: 1100, totalWaitMs: 1900 });
        const bodyWrites = writes.filter(w => w !== '\r');
        // Chunked into ≥2 writes, and the chunks reassemble to EXACTLY the original
        // body — the leading content is fully present, nothing dropped.
        expect(bodyWrites.length).toBeGreaterThanOrEqual(2);
        expect(bodyWrites.join('')).toBe(text);
        // No chunk fused a trailing CR; the body submitted (a lone CR was sent).
        expect(writes.some(w => w === '\r')).toBe(true);
        expect(writes.some(w => w.endsWith('\r'))).toBe(true); // the lone CR itself
        expect(bodyWrites.some(w => w.includes('\r'))).toBe(false);
    });

    it('win32: settle-gate holds the first CR while PTY output is still arriving, then submits once quiet', async () => {
        setPlatform('win32');
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(submitSpec()),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed('\n>\n? for shortcuts');
            await sleep(200);
            const before = pty.writes.length;
            driver.dispatch({ kind: 'send_message', text: 'go' });
            // Keep the PTY "noisy" well past the spec's initial submit delay (200ms)
            // with benign repaints that do NOT trigger a state transition (stay
            // idle). The old fixed-delay path would have fired a CR at ~200ms; the
            // settle-gate must hold it while output keeps arriving.
            for (let i = 0; i < 8; i += 1) {
                pty.feed(`repaint ${i}`);
                await sleep(100);
            }
            const midWrites = pty.writes.slice(before);
            expect(midWrites.filter(w => w === '\r').length).toBe(0);
            // Go quiet → the 500ms settle window elapses → the first CR fires.
            await sleep(800);
            const finalWrites = pty.writes.slice(before);
            expect(finalWrites.filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
        } finally {
            driver.shutdown();
        }
    }, 5000);
});

describe('chunkPreservingSurrogates', () => {
    it('reassembles to the original and never exceeds the size', () => {
        const text = 'a'.repeat(2500) + 'b'.repeat(700);
        const chunks = chunkPreservingSurrogates(text, 1024);
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1024);
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('never splits a UTF-16 surrogate pair', () => {
        // Astral chars (😀 = 2 UTF-16 units) packed so a naive boundary would land
        // mid-pair. Every chunk must contain only whole code points.
        const text = '😀'.repeat(100);
        const chunks = chunkPreservingSurrogates(text, 5); // 5 units = 2.5 emoji
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) {
            // A well-formed string round-trips through code-point iteration with no
            // lone surrogate (which would appear as � on re-encode).
            expect([...c].every(cp => cp.codePointAt(0) !== 0xfffd)).toBe(true);
            const last = c.charCodeAt(c.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no trailing high surrogate
        }
    });

    it('passes short text through as a single chunk', () => {
        expect(chunkPreservingSurrogates('hi', 1024)).toEqual(['hi']);
    });
});
