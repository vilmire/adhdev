/**
 * Timed FsmDriver regression for the AGY-SPEC-BUSY-WEDGE (2026-07-26) and its
 * BUSY-IDLE-BOUNDED-FALLBACK fix in
 * adhdev-providers/cli/antigravity-cli/specs/4.0.json.
 *
 * Same wedge family as the codex-cli fix: after a completed turn, a benign
 * repaint inside the cursor_above:4 window keeps resetting the stable clock
 * faster than stable_ms=1500, so the strict all(4) never passes and the
 * session wedges in `busy`. The exact benign ticker string is not yet
 * captured, so the fix is a bounded fallback arm (elapsed 60000 with modal /
 * esc-to-cancel / shortcuts / braille-activity vetoes), not ignore_lines.
 *
 * These tests drive the SHIPPING spec's exact transition structure (regexes
 * loaded from the real 4.0.json, only the timing constants scaled down ~10x so
 * the suite stays fast: stable 1500→800, fallback elapsed 60000→6000,
 * min_hold 500→100, startup grace 15000→1500) through the real FsmDriver +
 * ghostty screen pipeline:
 *
 *  1. A 400ms benign ticker repaint inside the cursor_above:4 window wedges
 *     the strict arm (still busy at ~4.5s, far past stable_ms) yet the
 *     bounded fallback commits busy→idle at ~6s — the wedge is resolved.
 *  2. A live braille `Generating...` activity marker keeps the fallback
 *     vetoed well past the bound — no false idle mid-generation.
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
    readonly pid = 4245;
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
// test is 6000ms; 4500ms sits safely between stable_ms (800) and the bound.
const SCALED_FALLBACK_MS = 6000;
const PRE_BOUND_CHECK_MS = 4500;
const POST_BOUND_WAIT_MS = SCALED_FALLBACK_MS + 2000; // bound + wake/debounce slack

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const p = path.join(repoRoot, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
    if (!fs.existsSync(p)) throw new Error('antigravity-cli 4.0.json spec not found at: ' + p);
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
        throw new Error('shipping spec no longer carries the elapsed 60000 fallback arm — update this test');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-agy-busy-wedge-'));
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

// Completed agy turn: result lines, a benign token-counter ticker (row 3 —
// inside the cursor_above:4 window once the cursor parks on row 4), and the
// `? for shortcuts` footer as the LAST line. NO esc to cancel, NO modal, NO
// braille activity marker.
const COMPLETED_FRAME =
    '  Refactoring complete!\r\n' +
    '  Modified: Button.tsx, Input.tsx\r\n' +
    '  · 124 tokens\r\n' +
    '  ? for shortcuts' +
    '\x1b[4;2H';

async function driveToIdle(driver: FsmDriver, pty: DrivablePty): Promise<void> {
    // Quiet completed screen → starting→idle-ready (footer shortcuts anchor).
    pty.feed(COMPLETED_FRAME);
    expect(await waitForState(driver, 'idle', 4000)).toBe(true);
}

describe('FsmDriver — antigravity busy→idle bounded fallback (repaint wedge)', () => {
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
            await driveToIdle(driver, pty);
            // A braille activity marker appears in the body → idle → busy.
            pty.feed('\x1b[5;1H  ⠹ Generating...\x1b[6;1H  esc to cancel  ·  ? for shortcuts\x1b[6;2H');
            expect(await waitForState(driver, 'busy', 4000)).toBe(true);

            // The turn completes: agy repaints with no marker, no esc to cancel.
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
                // Past stable_ms (800) but before the fallback bound (6000):
                // the strict arm is demonstrably wedged by the ticker.
                await sleep(PRE_BOUND_CHECK_MS);
                expect(driver.getFsmDebug().currentState).toBe('busy');

                // Within bound + wake/debounce slack the fallback commits idle.
                expect(await waitForState(driver, 'idle', POST_BOUND_WAIT_MS)).toBe(true);
            } finally {
                clearInterval(ticker);
            }
        } finally {
            driver.shutdown();
        }
    }, 30000);

    it('a live braille Generating marker vetoes the fallback well past the bound (no false idle)', async () => {
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
            await driveToIdle(driver, pty);
            // Braille activity marker in body, shortcuts-ONLY footer (no esc to
            // cancel) → idle → busy via the braille arm, and the fallback's
            // ONLY remaining veto is the braille marker itself.
            pty.feed('\x1b[5;1H  ⠹ Generating...\x1b[6;1H  ? for shortcuts\x1b[6;2H');
            expect(await waitForState(driver, 'busy', 4000)).toBe(true);

            // Keep the generation alive: refresh the braille glyph + elapsed
            // seconds every 400ms (row 5, inside the cursor window). The
            // marker matches the activity regex, so the fallback stays vetoed.
            const glyphs = ['⠹', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋'];
            let i = 0;
            const spinner = setInterval(() => {
                pty.feed(`\x1b[5;1H  ${glyphs[i++ % glyphs.length]} Generating... ${i}s\x1b[6;2H`);
            }, 400);
            try {
                await sleep(POST_BOUND_WAIT_MS);
                expect(driver.getFsmDebug().currentState).toBe('busy');
            } finally {
                clearInterval(spinner);
            }
        } finally {
            driver.shutdown();
        }
    }, 30000);
});
