/**
 * AGY-COMPOSER-SCROLL — the SHIPPING antigravity-cli spec must confirm a long
 * send on the composer TAIL, because agy scrolls a tall body inside its own
 * composer box.
 *
 * Live defect (preview fleet, 1.0.79-rc.5, MainPC win32 + MoltBook darwin):
 * every agy dispatch logged `body never confirmed in composer after ~20070ms
 * (len≈1680) — firing submit key blind`, i.e. each task prompt sat out the
 * WIN32_ECHO_MAX_WAIT_MS blind-fire backstop before its submit key.
 *
 * Measured 2026-10-09 against agy 1.3.2 (80x32, node-pty + ghostty-vt): a
 * 23-line body renders as
 *
 *     > ↑ 8 more lines
 *       Line 07: ...
 *       ...
 *       END-OF-BODY-TAILPROBE-XYZ
 *
 * so the body's head is in neither the viewport nor the scrollback, and the
 * default head_and_tail echo check can never pass. The spec now declares
 * `send_message.echo_confirm: "tail"` (same shape and fix as kimi).
 *
 * Reads adhdev-providers/cli/antigravity-cli/specs/4.0.json directly, like
 * driver-antigravity-busy-idle-wedge.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4246;
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

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const p = path.join(repoRoot, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
    if (!fs.existsSync(p)) throw new Error('antigravity-cli 4.0.json spec not found at: ' + p);
    return p;
}

/** Shorten the state-machine settle clocks so the test reaches idle quickly.
 *  send_message is left untouched — it is the subject under test. */
function scaleTimings(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(scaleTimings); return; }
    if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (typeof o.stable_ms === 'number') o.stable_ms = 800;
        if (typeof o.elapsed_ms === 'number') o.elapsed_ms = Math.max(600, Math.round(o.elapsed_ms / 10));
        if (typeof o.min_hold_ms === 'number') o.min_hold_ms = 100;
        Object.values(o).forEach(scaleTimings);
    }
}

const __tmpDirsToClean: string[] = [];

function writeSpec(mutate?: (spec: any) => void): string {
    const spec = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    scaleTimings(spec);
    mutate?.(spec);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-agy-composer-scroll-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    while (__tmpDirsToClean.length > 0) {
        const dir = __tmpDirsToClean.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForState(driver: FsmDriver, want: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (driver.getFsmDebug().currentState === want) return true;
        await sleep(50);
    }
    return driver.getFsmDebug().currentState === want;
}

const RULE = '─'.repeat(80);
const READY_FRAME =
    `${RULE}\r\n> \r\n${RULE}\r\n? for shortcuts                                         Claude Opus 5.5 · medium\x1b[2;3H`;

// The task-prompt shape: a head line plus many short lines (len ≈ 1.5 KB).
const LINES = Array.from({ length: 22 }, (_, i) =>
    `Line ${String(i).padStart(2, '0')}: harmless capture probe text — do not act on this content.`);
const BODY = ['HEADPROBE-ABCDEFGHIJ start of body.', ...LINES, 'END-OF-BODY-TAILPROBE-XYZ'].join('\n');

/** What agy actually draws for BODY: the composer keeps its last 15 rows and
 *  replaces the rest with an overflow marker (measured, agy 1.3.2). */
const SCROLLED_COMPOSER_FRAME =
    '\x1b[2J\x1b[H' +
    `${RULE}\r\n` +
    '> ↑ 8 more lines\r\n' +
    LINES.slice(7).map(l => `  ${l}`).join('\r\n') + '\r\n' +
    '  END-OF-BODY-TAILPROBE-XYZ\r\n' +
    `${RULE}\r\n` +
    '                                                        Claude Opus 5.5 · medium';

/** Dispatch BODY from idle, echo agy's scrolled composer, and report how long
 *  the first submit key took. */
async function firstSubmitDelayMs(specPath: string, waitMs: number): Promise<number | null> {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath,
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    const pty = factory.last!;
    try {
        pty.feed(READY_FRAME);
        expect(await waitForState(driver, 'idle', 5000)).toBe(true);
        const before = pty.writes.length;
        driver.dispatch({ kind: 'send_message', text: BODY });
        const bodyAt = Date.now();
        // Deferred a tick, like a real TUI repaint arriving on its own turn.
        setTimeout(() => pty.feed(SCROLLED_COMPOSER_FRAME), 0);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            if (pty.writes.slice(before).some(w => w === '\r')) return Date.now() - bodyAt;
            await sleep(25);
        }
        return null;
    } finally {
        driver.shutdown();
    }
}

describe('antigravity-cli spec — long sends confirm on the composer tail', () => {
    it('the shipping spec declares echo_confirm "tail"', () => {
        const spec = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
        expect(spec.send_message?.echo_confirm).toBe('tail');
    });

    it('a body agy scrolls inside its composer submits without the 20 s blind wait', async () => {
        setPlatform('darwin');
        expect(BODY.length).toBeGreaterThanOrEqual(512); // verified-submit path, as live
        const delay = await firstSubmitDelayMs(writeSpec(), 4000);
        expect(delay).not.toBeNull();
        expect(delay!).toBeLessThan(4000);
    }, 15_000);

    it('control: with the default head+tail check the same screen never confirms', async () => {
        setPlatform('darwin');
        const delay = await firstSubmitDelayMs(
            writeSpec(spec => { delete spec.send_message.echo_confirm; }),
            3000,
        );
        expect(delay).toBeNull();
    }, 15_000);
});
