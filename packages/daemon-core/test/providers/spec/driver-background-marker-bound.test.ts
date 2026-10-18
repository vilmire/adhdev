/**
 * Marker-only bound on a background-job generating hold — FsmDriver level, on a
 * FAKE clock, against the SHIPPING agy / claude / codex specs and the real
 * background-job screen captures (test/providers/spec/fixtures/*-background-*).
 *
 * The specs keep the session `generating` while a background job's marker is on
 * screen. A worker that leaves a dev server up would therefore never reach an
 * idle edge, no turn end would ever be observed, and the mesh turn-end backstop
 * would never engage. The bound (background-marker-bound.ts) must:
 *
 *   marker-only for 120 s  ⇒ exactly ONE coordinator notice (`signal_detected`
 *                            kind background_hold), still generating
 *   marker-only for 10 min ⇒ the screen is treated as idle
 *   any real activity      ⇒ resets the clock (fresh output) / wins (approval)
 *   marker gone            ⇒ idle exactly as before, no notice
 *
 * Revert-proof: drop the `trackBackgroundMarker` calls from FsmDriver.reevaluate
 * (or the `background_marker` block from a spec) and the first test of each
 * provider stays `busy` at 11 minutes with no notice.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type { DashboardEvent } from '../../../src/providers/spec/fsm-driver-types.js';
import type { SignalDetection } from '../../../src/providers/spec/signal-rules.js';
import {
    BACKGROUND_MARKER_NOTICE_MS, BACKGROUND_MARKER_RELEASE_MS,
} from '../../../src/providers/spec/background-marker-bound.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 6161;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').replace(/\n$/, '');

interface Cli {
    name: string;
    spec: string;
    running: string;
    finished: string;
    approval: string;
    /** Matches the composer row, where the cursor parks. */
    composer: RegExp;
    /** Fresh assistant output is painted just above the first line matching this. */
    outputAbove: RegExp;
}

const CLIS: Cli[] = [
    {
        name: 'antigravity-cli',
        spec: 'antigravity-cli',
        running: 'antigravity-background-task-running-2026-10-18.txt',
        finished: 'antigravity-background-task-finished-2026-10-18.txt',
        approval: 'antigravity-background-task-with-approval-2026-10-18.txt',
        composer: /^> ?$/,
        outputAbove: /^─/,
    },
    {
        name: 'claude-cli',
        spec: 'claude-cli',
        running: 'claude-background-shell-running-2026-10-18.txt',
        finished: 'claude-background-shell-finished-2026-10-18.txt',
        approval: 'claude-background-shell-with-approval-2026-10-18.txt',
        composer: /^❯ ?$/,
        outputAbove: /^✻ /,
    },
    {
        name: 'codex-cli',
        spec: 'codex-cli',
        running: 'codex-background-terminal-running-2026-10-18.txt',
        finished: 'codex-background-terminal-finished-2026-10-18.txt',
        approval: 'codex-background-terminal-with-approval-2026-10-18.txt',
        composer: /^› /,
        outputAbove: /^• Background started/,
    },
];

/** Paint a captured screen and park the cursor on its composer row. */
function paint(cli: Cli, screen: string, output?: string): string {
    const lines = screen.split('\n');
    if (output !== undefined) lines.splice(Math.max(0, lines.findIndex(l => cli.outputAbove.test(l))), 0, output);
    let row = lines.length - 1;
    for (let i = lines.length - 1; i >= 0; i--) { if (cli.composer.test(lines[i])) { row = i; break; } }
    return '\x1b[2J\x1b[H' + lines.join('\r\n') + `\x1b[${row + 1};3H`;
}

const MIN = 60_000;

describe.each(CLIS)('background marker bound — $name (shipping spec, real captures, fake clock)', (cli) => {
    let driver: FsmDriver;
    let pty: DrivablePty;
    let signals: SignalDetection[];

    beforeEach(async () => {
        vi.useFakeTimers();
        signals = [];
        const factory = new DrivableFactory();
        driver = new FsmDriver({
            specPath: path.join(repoRoot, 'adhdev-providers/cli', cli.spec, 'specs/4.0.json'),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
            cols: 120,
            rows: 40,
        });
        driver.subscribe((ev: DashboardEvent) => { if (ev.kind === 'signal_detected') signals.push(ev.signal); });
        driver.start();
        pty = factory.last!;
        // Quiet finished screen → startup grace → idle.
        pty.feed(paint(cli, fixture(cli.finished)));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(driver.getFsmDebug().currentState).toBe('idle');
    });

    afterEach(() => {
        driver.shutdown();
        vi.useRealTimers();
    });

    const state = () => driver.getFsmDebug().currentState;
    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    it('marker-only: still generating at 119 s with no notice, ONE notice at 120 s, idle after 10 min', async () => {
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(15_000);
        expect(state()).toBe('busy');

        // The marker alone must have held it busy long past every idle guard.
        await advance(BACKGROUND_MARKER_NOTICE_MS - 15_000 - 20_000);
        expect(state()).toBe('busy');
        expect(signals).toHaveLength(0);

        await advance(40_000);
        expect(state()).toBe('busy');
        expect(signals).toHaveLength(1);
        expect(signals[0].ruleId).toBe('background_marker_only');
        expect(signals[0].kind).toBe('background_hold');
        expect(signals[0].params.release_s).toBe(String(BACKGROUND_MARKER_RELEASE_MS / 1000));
        expect(Number(signals[0].params.held_s)).toBeGreaterThanOrEqual(BACKGROUND_MARKER_NOTICE_MS / 1000);

        await advance(5 * MIN);
        expect(state()).toBe('busy');
        expect(signals).toHaveLength(1);

        // 10 min (+ the 8-20 s the idle guards needed to count as "marker-only") ⇒ released.
        await advance(5 * MIN + 30_000);
        expect(state()).toBe('idle');
        expect(signals).toHaveLength(1);

        // Latched: the marker is still drawn but a repaint does not re-hold the session.
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(30_000);
        expect(state()).toBe('idle');
        expect(signals).toHaveLength(1);
    }, 60_000);

    it('marker with fresh output stays generating and never notices or releases', async () => {
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(15_000);
        expect(state()).toBe('busy');

        // 15 minutes of the worker still producing output beside the marker
        // (the line above the status area changes every 30 s; the marker stays).
        for (let i = 1; i <= 30; i++) {
            pty.feed(paint(cli, fixture(cli.running), `  streamed output, chunk ${i}`));
            await advance(30_000);
            expect(state()).toBe('busy');
        }
        expect(signals).toHaveLength(0);
    }, 60_000);

    it('marker gone ⇒ idle as before, with no notice', async () => {
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(15_000);
        expect(state()).toBe('busy');

        await advance(40_000);
        pty.feed(paint(cli, fixture(cli.finished)));
        await advance(30_000);
        expect(state()).toBe('idle');
        expect(signals).toHaveLength(0);
    }, 60_000);

    it('an approval modal wins over the marker, before and after the release', async () => {
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(15_000);
        expect(state()).toBe('busy');

        pty.feed(paint(cli, fixture(cli.approval)));
        await advance(15_000);
        expect(state()).toBe('approval');

        // Dismiss it, let the bound run out, then raise the approval again.
        pty.feed(paint(cli, fixture(cli.running)));
        await advance(11 * MIN);
        expect(state()).toBe('idle');
        pty.feed(paint(cli, fixture(cli.approval)));
        await advance(15_000);
        expect(state()).toBe('approval');
    }, 60_000);
});
