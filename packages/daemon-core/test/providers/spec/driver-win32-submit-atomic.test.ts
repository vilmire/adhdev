/**
 * Regression coverage for the win32 ConPTY lone-CR submit swallow.
 *
 * claude-cli (and other spec CLIs: codex, gemini, …) route through
 * FsmDriver.actuallySendMessage. Its default path writes the prompt text, then
 * — after the submit delay floor (>=200ms) — writes the submit key (`\r`) as a
 * SEPARATE, delayed PTY write. On win32, ConPTY does not treat a lone CR that
 * arrives in its own chunk after a delay as a submit key: it swallows the CR and
 * the prompt sits typed-but-unsent until the user presses Enter manually. This
 * is the same lone-CR swallow the legacy ProviderCliAdapter.forceSendMessage fix
 * addressed for the legacy code path, but the FSM/spec path was left uncovered.
 *
 * The fix: on win32 only, honour the settle delay but write `text + submit_key`
 * as ONE PTY write so the CR can never be separated from the text it submits.
 * mac/linux keep the historical split write (those PTYs recognise it fine), so
 * the asymmetry is contained to win32.
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
        // submit delay floor is 200ms; wait past it.
        await sleep(450);
        return pty.writes.slice(before);
    } finally {
        driver.shutdown();
    }
}

describe('FsmDriver -- win32 atomic submit', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('win32: writes text and submit key as ONE PTY write (no lone delayed CR)', async () => {
        setPlatform('win32');
        const writes = await sendAndCollect();
        // The atomic write contains the text immediately followed by the CR.
        expect(writes).toContain('hello world\r');
        // And there must be NO standalone CR write — that is exactly the chunk
        // ConPTY swallows.
        expect(writes).not.toContain('\r');
        // Text must never be written without its trailing CR either.
        expect(writes).not.toContain('hello world');
    });

    it('non-win32: keeps the historical split write (text, then a separate CR)', async () => {
        setPlatform('darwin');
        const writes = await sendAndCollect();
        // Historical behavior: text and submit key arrive as separate writes.
        expect(writes).toContain('hello world');
        expect(writes).toContain('\r');
        // It must NOT use the combined win32 form on mac/linux.
        expect(writes).not.toContain('hello world\r');
    });
});
