import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

// Bracketed-paste + soft-newline sequences, kept in sync with fsm-driver.ts.
export const BP_OPEN = '\x1b[200~';
export const BP_CLOSE = '\x1b[201~';
export const SOFT_NL = '\x1b[27;2;13~';
export const MULTILINE = 'line one\nline two\nline three';

export class DrivablePty implements PtyRuntimeTransport {
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

export class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

// Minimal spec: starting → idle once the prompt footer is drawn, and idle →
// generating once the footer shows the interrupt hint (= the agent submitted and
// is now generating). submit_key is the CR that win32 swallows on multiline.
export function submitSpec(sendMessage: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.win32-submit',
        name: 'win32 submit test',
        binary: '/bin/true',
        send_message: { submit_key: '\r', ...sendMessage },
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

const __tmpDirsToClean: string[] = [];

export function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-win32-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

export const ORIGINAL_PLATFORM = process.platform;
export function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

export function registerWin32SubmitHooks(): void {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        setPlatform(ORIGINAL_PLATFORM);
        vi.useRealTimers();
        while (__tmpDirsToClean.length > 0) {
            const dir = __tmpDirsToClean.pop()!;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

export const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);

export interface CollectOpts {
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
    /** Extra spec `send_message` fields (e.g. win32_input_mode_non_ascii). */
    sendMessage?: Record<string, unknown>;
}

export interface CollectResult {
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

export async function sendAndCollectPty(opts: CollectOpts = {}): Promise<CollectResult> {
    const { text = 'hello world', submitAfterMs, totalWaitMs = 700 } = opts;
    const prevMode = process.env.ADHDEV_WIN32_SUBMIT_MODE;
    if (opts.submitMode) process.env.ADHDEV_WIN32_SUBMIT_MODE = opts.submitMode;
    else delete process.env.ADHDEV_WIN32_SUBMIT_MODE;
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(submitSpec(opts.sendMessage)),
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

export async function sendAndCollect(opts: CollectOpts = {}): Promise<string[]> {
    return (await sendAndCollectPty(opts)).writes;
}
