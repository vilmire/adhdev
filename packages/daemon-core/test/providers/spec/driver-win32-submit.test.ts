/**
 * Regression coverage for win32 ConPTY submit on the FSM/spec path.
 *
 * claude-cli (and other spec CLIs: codex, gemini, …) route through
 * FsmDriver.actuallySendMessage. An earlier "atomic write" attempt combined the
 * prompt text and the submit key (`\r`) into ONE PTY write on win32. That
 * regressed: Ink-based TUIs treat a single write carrying text + a trailing CR
 * as a bracketed/multi-line paste and absorb the CR as a literal newline, so the
 * prompt sat typed-but-unsent until the user hit Enter manually.
 *
 * The correct fix: on win32 write the text first, let it settle, then deliver the
 * CR as its OWN keystroke — twice, with a short gap, because ConPTY can drop or
 * coalesce a lone CR and a second CR on an already-submitted (empty) prompt is a
 * harmless no-op. mac/linux keep the historical single split CR (those PTYs
 * recognise it fine), so the win32 double-CR is contained to win32.
 *
 * These tests drive the FSM to readiness, dispatch a message, and assert the
 * exact PTY write shape under each simulated platform.
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

// Minimal spec: starting → idle once the prompt footer is drawn. submit_key
// is the CR that win32 swallows when sent on its own.
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
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
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

async function sendAndCollect(): Promise<string[]> {
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
        driver.dispatch({ kind: 'send_message', text: 'hello world' });
        // submit delay floor is 200ms, then on win32 a second CR follows after
        // the 300ms repeat gap; wait past both.
        await sleep(700);
        return pty.writes.slice(before);
    } finally {
        driver.shutdown();
    }
}

describe('FsmDriver -- win32 submit', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('win32: writes text first, then the submit key as TWO separate CRs (never combined)', async () => {
        setPlatform('win32');
        const writes = await sendAndCollect();
        // Text is written on its own — never fused with a trailing CR (the fused
        // write is what Ink absorbs as a multi-line paste newline).
        expect(writes).toContain('hello world');
        expect(writes).not.toContain('hello world\r');
        // The submit key arrives as its own keystroke, repeated once.
        const loneCrCount = writes.filter(w => w === '\r').length;
        expect(loneCrCount).toBe(2);
    });

    it('non-win32: keeps the historical split write (text, then a single separate CR)', async () => {
        setPlatform('darwin');
        const writes = await sendAndCollect();
        // Historical behavior: text and submit key arrive as separate writes.
        expect(writes).toContain('hello world');
        expect(writes).toContain('\r');
        // It must NOT use a combined form on mac/linux.
        expect(writes).not.toContain('hello world\r');
        // mac/linux submit only once (no win32 double-CR safety net).
        const loneCrCount = writes.filter(w => w === '\r').length;
        expect(loneCrCount).toBe(1);
    });
});
