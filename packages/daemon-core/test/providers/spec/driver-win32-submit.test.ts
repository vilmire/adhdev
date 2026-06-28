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

// Bracketed-paste + soft-newline sequences, kept in sync with fsm-driver.ts.
const BP_OPEN = '\x1b[200~';
const BP_CLOSE = '\x1b[201~';
const SOFT_NL = '\x1b[27;2;13~';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    // FIX-B-v2 regression model: a real win32 Ink/ConPTY composer SUBMITS its
    // current contents on every BARE '\n'/'\r' that arrives as composer input —
    // UNLESS the newline is inside a bracketed-paste (ESC[200~ … ESC[201~) region or
    // is encoded as a non-submitting soft-newline (ESC[27;2;13~), both of which
    // insert a LITERAL newline into the composer without submitting. We track the
    // running byte stream across writes so a paste region opened in one write and
    // closed in another still suppresses its newlines, count one 'submit' per bare
    // newline outside a paste, and — crucially — CLEAR the composer on each submit
    // (the submitted content leaves the composer). So after a raw multi-line body,
    // only the fragment after the LAST bare newline remains: exactly the observed
    // win32 truncation. `composerText` reflects whatever is STANDING in the composer.
    private inPaste = false;
    private pending = ''; // partial ESC sequence carried across write boundaries
    submits = 0;
    composerText = ''; // content currently standing (un-submitted) in the composer
    // The composer contents captured at the moment of the FIRST submit — i.e. what
    // was actually sent to the agent. With the fix this is the full body; with the
    // bug it is only the tail fragment after the last embedded newline.
    firstSubmittedText: string | null = null;
    write(data: string): void {
        this.writes.push(data);
        this.consumeWin32(data);
    }
    private consumeWin32(data: string): void {
        const s = this.pending + data;
        this.pending = '';
        let i = 0;
        while (i < s.length) {
            const rest = s.slice(i);
            // A possibly-incomplete ESC sequence at the tail: stash and wait for more.
            if (rest[0] === '\x1b' && this.isPartialSeq(rest)) { this.pending = rest; return; }
            if (rest.startsWith(BP_OPEN)) { this.inPaste = true; i += BP_OPEN.length; continue; }
            if (rest.startsWith(BP_CLOSE)) { this.inPaste = false; i += BP_CLOSE.length; continue; }
            if (rest.startsWith(SOFT_NL)) { this.composerText += '\n'; i += SOFT_NL.length; continue; }
            const ch = s[i];
            if (ch === '\r' || ch === '\n') {
                if (this.inPaste) {
                    this.composerText += '\n'; // newline inside paste = literal text
                } else {
                    if (this.firstSubmittedText === null) this.firstSubmittedText = this.composerText;
                    this.submits += 1;        // bare newline outside paste → a submit
                    this.composerText = '';   // submitted content leaves the composer
                }
                i += 1;
                continue;
            }
            this.composerText += ch;
            i += 1;
        }
    }
    // True when `rest` begins an ESC sequence we recognise but only have a prefix of
    // (so it might complete in the next write) — keeps a marker from being misread
    // when it straddles a chunk boundary.
    private isPartialSeq(rest: string): boolean {
        for (const full of [BP_OPEN, BP_CLOSE, SOFT_NL]) {
            if (full.startsWith(rest) && rest.length < full.length) return true;
        }
        return false;
    }
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
    /** Set false to NOT echo the body back into the composer — simulates a body
     *  dropped during boot, exercising the echo-gate's hold/re-write path. */
    echoBody?: boolean;
    /** Override ADHDEV_WIN32_SUBMIT_MODE for this dispatch (FIX-B-v2). Default 'paste'. */
    submitMode?: 'paste' | 'soft_newline';
}

interface CollectResult {
    /** All PTY writes issued AFTER dispatch (markers + body chunks + CRs). */
    writes: string[];
    /** Submits the modelled ConPTY composer counted (bare newlines outside a
     *  bracketed-paste). With the FIX-B-v2 body write this is exactly 1 — the single
     *  trailing CR. Without the fix, a multi-line body yields one per embedded \n. */
    submits: number;
    /** Composer TEXT the modelled composer accumulated — embedded body newlines that
     *  did NOT submit appear as literal '\n'. The trailing submit CR is not text. */
    composerText: string;
    /** The composer contents at the moment of the first submit — what was actually
     *  sent to the agent. The full body with the fix; the tail fragment with the bug. */
    firstSubmittedText: string | null;
}

async function sendAndCollectPty(opts: CollectOpts = {}): Promise<CollectResult> {
    const { text = 'hello world', submitAfterMs, totalWaitMs = 700 } = opts;
    const prevMode = process.env.ADHDEV_WIN32_SUBMIT_MODE;
    if (opts.submitMode) process.env.ADHDEV_WIN32_SUBMIT_MODE = opts.submitMode;
    else delete process.env.ADHDEV_WIN32_SUBMIT_MODE;
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
        const submitsBefore = pty.submits;
        const textBefore = pty.composerText;
        driver.dispatch({ kind: 'send_message', text });
        const start = Date.now();
        // Echo the body into the composer: the win32 submit echo-gate holds the first
        // CR until the body text is confirmed on screen (real claude renders typed
        // input back). A fake PTY must mirror that echo or the gate would (correctly)
        // never fire. Tests that want to simulate a DROPPED body omit this.
        if (opts.echoBody !== false) pty.feed(`\n${text}`);
        if (submitAfterMs != null) {
            await sleep(submitAfterMs);
            // Simulate the agent having submitted: footer now shows the interrupt
            // hint → FSM transitions idle→generating → resend loop stops.
            pty.feed('\n\nesc to interrupt');
        }
        await sleep(Math.max(0, totalWaitMs - (Date.now() - start)));
        return {
            writes: pty.writes.slice(before),
            submits: pty.submits - submitsBefore,
            composerText: pty.composerText.slice(textBefore.length),
            firstSubmittedText: pty.firstSubmittedText,
        };
    } finally {
        driver.shutdown();
        if (prevMode === undefined) delete process.env.ADHDEV_WIN32_SUBMIT_MODE;
        else process.env.ADHDEV_WIN32_SUBMIT_MODE = prevMode;
    }
}

async function sendAndCollect(opts: CollectOpts = {}): Promise<string[]> {
    return (await sendAndCollectPty(opts)).writes;
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

    // ── FIX-B-v2: embedded-newline per-line submit (prompt truncation) ────────
    //
    // RCA: on the real win32 Ink/ConPTY composer each embedded '\n' in the body
    // SUBMITS the preceding line as its own composer entry. Writing the raw
    // multi-line body therefore submitted every line but the last BEFORE the
    // trailing echo-gated CR ever ran — the prompt was truncated to only the tail
    // fragment after the last '\n' (failure_category=per_newline_submit). The fix
    // writes the body so its embedded newlines never submit: bracketed-paste
    // (default) or soft-newline (fallback). The single trailing CR stays the only
    // submit. The DrivablePty mock now models per-newline submit so the regression
    // is observable (the old toContain check could not see it).

    it('REPRO (no fix): a raw multi-line body submits once PER embedded newline', () => {
        // Drive the modelled ConPTY directly with the raw body — what the pre-fix
        // writeWin32Body did (send_keys(text) with intact \n) — then the lone
        // trailing submit CR. The composer submits per bare \n, so the head/middle
        // lines are lost and only the tail survives as standing composer text.
        const pty = new DrivablePty();
        pty.write(MULTILINE); // raw body, embedded newlines intact
        pty.write('\r');      // the single intended submit CR
        // 3 lines → 2 embedded-newline submits + 1 trailing CR = 3 submits (the bug:
        // far more than the intended 1; lines 1 and 2 were each submitted alone).
        expect(pty.submits).toBe(3);
        // The FIRST submit (the first embedded '\n') sent only 'line one' — and the
        // body keeps getting chopped; by the trailing CR only the tail fragment
        // remains. The agent never receives the whole prompt.
        expect(pty.firstSubmittedText).toBe('line one');
        expect(pty.composerText).toBe(''); // composer empty after the trailing submit
    });

    it('paste mode: a multi-line body submits EXACTLY once (trailing CR), full body preserved as composer text', async () => {
        setPlatform('win32');
        const { writes, submits, firstSubmittedText } = await sendAndCollectPty({
            text: MULTILINE, submitMode: 'paste', submitAfterMs: 480, totalWaitMs: 1400,
        });
        // Exactly one submit — the trailing CR. Zero per-line submits.
        expect(submits).toBe(1);
        // The full multi-line body was standing in the composer when that single
        // submit fired (embedded newlines preserved as text, not consumed as submits).
        expect(firstSubmittedText).toBe(MULTILINE);
        // The body went out wrapped in bracketed-paste markers as their own segments,
        // and the markers were never fused with body bytes.
        expect(writes).toContain('\x1b[200~');
        expect(writes).toContain('\x1b[201~');
        expect(writes).toContain(MULTILINE);
        expect(writes.some(w => w.includes('\x1b[200~') && w !== '\x1b[200~')).toBe(false);
    });

    it('soft_newline mode: a multi-line body submits EXACTLY once, full body preserved', async () => {
        setPlatform('win32');
        const { writes, submits, firstSubmittedText } = await sendAndCollectPty({
            text: MULTILINE, submitMode: 'soft_newline', submitAfterMs: 480, totalWaitMs: 1400,
        });
        expect(submits).toBe(1); // only the trailing CR
        // Each embedded newline became a non-submitting soft-newline → the full body
        // is one multi-line composer entry standing when the single submit fires.
        expect(firstSubmittedText).toBe(MULTILINE);
        // No raw bracketed-paste in this mode; soft-newline sequence carried the breaks.
        expect(writes).not.toContain('\x1b[200~');
        expect(writes.join('')).toContain('\x1b[27;2;13~');
    });

    it('single-line win32 body is unchanged by FIX-B-v2 (no paste wrap, one submit)', async () => {
        setPlatform('win32');
        const { writes, submits } = await sendAndCollectPty({
            text: 'hello world', submitAfterMs: 320, totalWaitMs: 1200,
        });
        expect(submits).toBe(1);
        expect(writes).toContain('hello world');
        expect(writes).not.toContain('\x1b[200~'); // no wrap for a body with no newline
    });

    it('paste markers stay intact when a long multi-line body is chunked', async () => {
        setPlatform('win32');
        // > WIN32_PTY_WRITE_CHUNK_CHARS (1024) AND multi-line → chunked AND wrapped.
        const text = Array.from({ length: 60 }, (_, i) => `step ${i}: do the thing carefully`).join('\n');
        expect(text.length).toBeGreaterThan(1024);
        const { writes, submits, firstSubmittedText } = await sendAndCollectPty({
            text, submitMode: 'paste', submitAfterMs: 1100, totalWaitMs: 2100,
        });
        // The open/close markers are present and were each written as a STANDALONE
        // segment (never split across, never merged with a body chunk).
        expect(writes.filter(w => w === '\x1b[200~').length).toBe(1);
        expect(writes.filter(w => w === '\x1b[201~').length).toBe(1);
        // Despite chunking, the composer reassembled the entire body — including its
        // leading lines — and it submitted exactly once.
        expect(firstSubmittedText).toBe(text);
        expect(submits).toBe(1);
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
        // Body segments = everything that isn't a CR or a bracketed-paste marker (the
        // multi-line body is paste-wrapped under FIX-B-v2; the markers are their own
        // standalone segments — see the dedicated marker-integrity test above).
        const bodyWrites = writes.filter(w => w !== '\r' && w !== BP_OPEN && w !== BP_CLOSE);
        // Chunked into ≥2 writes, and the chunks reassemble to EXACTLY the original
        // body — the leading content is fully present, nothing dropped.
        expect(bodyWrites.length).toBeGreaterThanOrEqual(2);
        expect(bodyWrites.join('')).toBe(text);
        // No chunk fused a trailing CR; the body submitted (a lone CR was sent).
        expect(writes.some(w => w === '\r')).toBe(true);
        expect(writes.some(w => w.endsWith('\r'))).toBe(true); // the lone CR itself
        expect(bodyWrites.some(w => w.includes('\r'))).toBe(false);
    });

    it('win32 echo-gate: holds the first CR until the body is confirmed in the composer, then submits', async () => {
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
            driver.dispatch({ kind: 'send_message', text: 'echoprobe' });
            // Body NOT yet echoed into the composer — keep the screen noisy with
            // repaints that do NOT contain the body. The echo-gate must hold the CR:
            // it has no confirmation the body landed, which is exactly the empty-
            // composer submit this gate prevents.
            for (let i = 0; i < 6; i += 1) {
                pty.feed(`repaint ${i}`);
                await sleep(100);
            }
            expect(pty.writes.slice(before).filter(w => w === '\r').length).toBe(0);
            // The body now echoes into the composer + the screen goes quiet → the
            // echo-gate confirms it landed and fires the CR.
            pty.feed('\necho echoprobe');
            await sleep(800);
            expect(pty.writes.slice(before).filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
        } finally {
            driver.shutdown();
        }
    }, 6000);

    // ── Echo-gate late-body path (buffered write lands late, no empty submit) ───
    it('win32 echo-gate: a body that echoes late is NOT submitted blindly — the CR waits for it', async () => {
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
            driver.dispatch({ kind: 'send_message', text: 'lateprobe' });
            // The body has not echoed yet (buffered during a slow boot). The gate must
            // NOT fire a blind CR into the empty composer — it holds.
            await sleep(2500);
            expect(pty.writes.slice(before).filter(w => w === '\r').length).toBe(0);
            // The buffered body finally lands → gate confirms it → CR fires (single line
            // submits on the first CR; the resend loop stops once it leaves idle).
            pty.feed('\nlateprobe');
            await sleep(800);
            expect(pty.writes.slice(before).filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
        } finally {
            driver.shutdown();
        }
    }, 8000);
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
