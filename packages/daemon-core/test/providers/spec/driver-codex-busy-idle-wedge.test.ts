/**
 * Timed FsmDriver regression for the CODEX-FSM-BUSY-WEDGE (2026-07-26) and its
 * BUSY-IDLE-BOUNDED-FALLBACK fix in adhdev-providers/cli/codex-cli/specs/4.0.json.
 *
 * Live RCA: a completed codex session (final response + composer `› …`
 * returned) sat in `busy` for 22+ minutes with busy→idle firing 0 times. Debug
 * showed condResult=false with remainingMs≈1342 on the all(3) — only the
 * stable_ms leaf reports nonzero remainingMs, so a benign post-generation
 * repaint inside the cursor_above:4 window kept resetting the stable clock
 * faster than stable_ms=1500 (fsm-driver.ts trackRegionChanges). The FSM was
 * awake the whole time (scheduleWakeForState); the strict arm simply never
 * passed.
 *
 * These tests drive the SHIPPING spec's exact transition structure (regexes
 * loaded from the real 4.0.json, only the timing constants scaled down ~10x so
 * the suite stays fast: stable 1500→800, fallback elapsed 30000→3000,
 * min_hold 500→100) through the real FsmDriver + ghostty screen pipeline:
 *
 *  1. A 400ms benign ticker repaint inside the cursor_above:4 window wedges
 *     the strict arm (still busy at ~2.2s, well past stable_ms) yet the
 *     bounded fallback commits busy→idle at ~3s — the wedge is resolved.
 *  2. A live `Working (⣿ Ns · esc to interrupt)` spinner keeps BOTH arms
 *     vetoed well past the fallback bound — no false idle mid-generation.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4244;
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

// Scaled timing constants (shipping values / ~10). The fallback bound under
// test is 3000ms; 2200ms sits safely between stable_ms (800) and the bound.
const SCALED_FALLBACK_MS = 3000;
const PRE_BOUND_CHECK_MS = 2200;
const POST_BOUND_CHECK_MS = SCALED_FALLBACK_MS + 1500; // bound + wake/debounce slack

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const p = path.join(repoRoot, 'adhdev-providers/cli/codex-cli/specs/4.0.json');
    if (!fs.existsSync(p)) throw new Error('codex-cli 4.0.json spec not found at: ' + p);
    return p;
}

/** Scale every timing constant in the parsed spec tree, keeping every regex,
 *  section, and transition structure byte-identical to the shipping spec. */
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

function writeScaledSpec(): string {
    const spec = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    scaleTimings(spec);
    const fallback = spec.transitions
        .find((t: any) => t.label === 'busy→idle')?.when?.any?.[1]?.all
        ?.find((c: any) => typeof c.elapsed_ms === 'number');
    if (fallback?.elapsed_ms !== SCALED_FALLBACK_MS) {
        throw new Error('shipping spec no longer carries the elapsed 30000 fallback arm — update this test');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-busy-wedge-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForState(driver: FsmDriver, want: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (driver.getFsmDebug().currentState === want) return true;
        await sleep(50);
    }
    return driver.getFsmDebug().currentState === want;
}

// Completed codex turn: final response lines, a benign token-counter ticker
// (row 3 — inside the cursor_above:4 window once the cursor parks on the
// composer row 4), and the composer hint line. NO live spinner, NO modal.
const COMPLETED_FRAME =
    '  Final answer text.\r\n' +
    '  Modified 3 files.\r\n' +
    '  · 124 tokens\r\n' +
    '› Summarize recent commits' +
    '\x1b[4;2H';

async function driveToBusy(driver: FsmDriver, pty: DrivablePty): Promise<void> {
    // Quiet completed screen → startup-grace → idle.
    pty.feed(COMPLETED_FRAME);
    expect(await waitForState(driver, 'idle', 4000)).toBe(true);
    // Live spinner appears just above a fresh composer → idle → busy.
    pty.feed('\x1b[5;1H  Working (⣿ 3s · esc to interrupt)\r\n› \x1b[6;2H');
    expect(await waitForState(driver, 'busy', 4000)).toBe(true);
}

describe('FsmDriver — codex busy→idle bounded fallback (repaint wedge)', () => {
    it('a 400ms benign ticker wedges the strict arm, but the bounded fallback still commits idle', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeScaledSpec(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            await driveToBusy(driver, pty);

            // The turn completes: codex repaints the screen with no spinner.
            pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME);
            await sleep(300);
            expect(driver.getFsmDebug().currentState).toBe('busy');

            // Repaint the benign token ticker every 400ms — each repaint lands
            // inside the cursor_above:4 window and resets the strict arm's
            // stable clock (the live wedge). The ticker NEVER stops, so any
            // idle commit must come from the bounded fallback arm.
            let n = 125;
            const ticker = setInterval(() => {
                pty.feed(`\x1b[3;1H  · ${n++} tokens\x1b[4;2H`);
            }, 400);
            try {
                // Past stable_ms (800) but before the fallback bound (3000):
                // the strict arm is demonstrably wedged by the ticker.
                await sleep(PRE_BOUND_CHECK_MS);
                expect(driver.getFsmDebug().currentState).toBe('busy');

                // Within bound + wake/debounce slack the fallback commits idle.
                expect(await waitForState(driver, 'idle', POST_BOUND_CHECK_MS)).toBe(true);
            } finally {
                clearInterval(ticker);
            }
        } finally {
            driver.shutdown();
        }
    }, 30000);

    it('a live Working spinner vetoes the fallback well past the bound (no false idle)', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeScaledSpec(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            await driveToBusy(driver, pty);

            // Keep the generation alive: refresh the spinner's elapsed seconds
            // every 400ms (row 5, inside the cursor window). The spinner shape
            // matches the busy cue, so BOTH busy→idle arms stay vetoed forever.
            let secs = 4;
            const spinner = setInterval(() => {
                pty.feed(`\x1b[5;1H  Working (⣿ ${secs++}s · esc to interrupt)\x1b[6;2H`);
            }, 400);
            try {
                await sleep(POST_BOUND_CHECK_MS);
                expect(driver.getFsmDebug().currentState).toBe('busy');
            } finally {
                clearInterval(spinner);
            }
        } finally {
            driver.shutdown();
        }
    }, 30000);
});
