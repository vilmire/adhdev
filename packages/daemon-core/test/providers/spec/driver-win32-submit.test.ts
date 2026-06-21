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
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
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
        const writes = await sendAndCollect({ text: MULTILINE, submitAfterMs: 480, totalWaitMs: 1100 });
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
        const writes = await sendAndCollect({ text: 'hello world', submitAfterMs: 320, totalWaitMs: 900 });
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
});
