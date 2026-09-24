/**
 * REDRAW-NUDGE (live preview defect 2026-09-24, antigravity-cli on MoltBook).
 *
 * A finished agy worker was left showing a torn frame — a frozen
 * `⡿  Running command...` spinner line and a stale `esc to cancel` row above
 * the real `? for shortcuts` footer, cursor parked at (0,0) — and the FSM sat
 * in `busy` for 80+ minutes with zero PTY output. The owner's manual fix was
 * to make the TUI repaint. The driver now does the input-free equivalent: after
 * `silentMs` of PTY silence in a generating state it resize-wiggles the PTY
 * (cols+1, then back), which makes a real TUI repaint its frame.
 *
 * Drives the SHIPPING antigravity-cli 4.0 spec through the real FsmDriver +
 * ghostty screen pipeline. The garbled screen is the live `mesh_read_terminal`
 * capture of session 63387888 (absolute home path shortened to `~`); the
 * redrawn frame is reconstructed from the same capture's rows in agy's idle
 * layout. Nudge timings are shrunk through the env policy knobs.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { LOG } from '../../../src/logging/logger.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function readFixtureLines(name: string): string[] {
    return fs.readFileSync(path.join(TEST_DIR, 'fixtures', name), 'utf8').replace(/\n$/, '').split('\n');
}
const GARBLED = readFixtureLines('antigravity-garbled-false-busy-2026-09-24.txt');
const REDRAWN = readFixtureLines('antigravity-redrawn-idle-2026-09-24.txt');

/** Paint `lines` onto a cleared screen row by row, then park the cursor. */
function frame(lines: string[], cursor: { row: number; col: number }): string {
    let out = '\x1b[2J\x1b[H';
    lines.forEach((l, i) => { out += `\x1b[${i + 1};1H${l}`; });
    return out + `\x1b[${cursor.row + 1};${cursor.col + 1}H`;
}
/** The live torn frame: cursor at (0,0) exactly as captured. */
const GARBLED_FRAME = frame(GARBLED, { row: 0, col: 0 });
/** The clean repaint: cursor on the composer row, after `> `. */
const REDRAWN_FRAME = frame(REDRAWN, { row: REDRAWN.indexOf('> '), col: 2 });

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4246;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    readonly resizes: Array<[number, number]> = [];
    /** What the fake TUI does on SIGWINCH: nothing (a wedged app) or repaint. */
    onResize: ((cols: number, rows: number) => void) | null = null;
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(cols: number, rows: number): void {
        this.resizes.push([cols, rows]);
        this.onResize?.(cols, rows);
    }
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

function specPath(): string {
    const repoRoot = path.resolve(TEST_DIR, '../../../../../..');
    const p = path.join(repoRoot, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
    if (!fs.existsSync(p)) throw new Error('antigravity-cli 4.0.json spec not found at: ' + p);
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ENV_KEYS = ['ADHDEV_REDRAW_NUDGE_SILENT_MS', 'ADHDEV_REDRAW_NUDGE_MAX', 'ADHDEV_REDRAW_NUDGE_HOLD_MS', 'ADHDEV_REDRAW_NUDGE_SETTLE_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};
function setPolicy(p: { silent: number; max?: number; hold?: number; settle?: number }): void {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.ADHDEV_REDRAW_NUDGE_SILENT_MS = String(p.silent);
    process.env.ADHDEV_REDRAW_NUDGE_MAX = String(p.max ?? 4);
    process.env.ADHDEV_REDRAW_NUDGE_HOLD_MS = String(p.hold ?? 50);
    process.env.ADHDEV_REDRAW_NUDGE_SETTLE_MS = String(p.settle ?? 100);
}

const drivers: FsmDriver[] = [];
afterEach(() => {
    for (const d of drivers.splice(0)) { try { d.shutdown(); } catch { /* already down */ } }
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
});

/** Boot the real spec to `idle`, then land the live torn frame → `busy`. */
async function bootIntoGarbledBusy(): Promise<{ driver: FsmDriver; pty: DrivablePty; infos: string[] }> {
    const infos: string[] = [];
    vi.spyOn(LOG, 'info').mockImplementation((_scope: string, msg: string) => { infos.push(msg); });
    const factory = new DrivableFactory();
    const driver = new FsmDriver({ specPath: specPath(), workingDir: os.tmpdir(), hotReload: false, transportFactory: factory, sessionId: 'redraw-nudge-test' });
    drivers.push(driver);
    driver.start();
    const pty = factory.last!;
    pty.feed(REDRAWN_FRAME);
    await sleep(900); // starting→idle-ready min_hold 500 + wake
    expect(driver.getFsmDebug().currentState).toBe('idle');
    pty.feed(GARBLED_FRAME);
    await sleep(200);
    expect(driver.getFsmDebug().currentState).toBe('busy');
    expect(driver.getCursorPosition()).toEqual({ row: 0, col: 0 });
    return { driver, pty, infos };
}

describe('FsmDriver redraw nudge — false busy on a torn agy frame', () => {
    it('busy + silent ≥ N → resize wiggle, TUI repaint, FSM re-evaluates to idle, INFO lines', async () => {
        // N (2s) must exceed the spec's own busy→idle stable window (1.5s): the
        // repaint itself changes the screen, and a shorter N would re-nudge
        // before the stable clock completes. Production N is 45s.
        setPolicy({ silent: 2000 });
        const { driver, pty, infos } = await bootIntoGarbledBusy();
        // A real TUI repaints its whole frame on a width change.
        pty.onResize = (cols) => { if (cols === 80) setTimeout(() => pty.feed(REDRAWN_FRAME), 20); };
        const writesBefore = pty.writes.filter(w => w !== '\x1b[I').length;

        await sleep(1500);
        expect(pty.resizes).toEqual([]); // still inside the silence window
        expect(driver.getFsmDebug().currentState).toBe('busy');
        await sleep(3000);

        expect(pty.resizes).toEqual([[81, 32], [80, 32]]);
        expect(driver.getFsmDebug().currentState).toBe('idle');
        expect(driver.getRedrawNudgeCount()).toBe(1);
        // No keystroke was sent — only the spec's own focus-in re-primes may appear.
        expect(pty.writes.filter(w => w !== '\x1b[I').length).toBe(writesBefore);
        expect(infos.filter(m => /redraw nudge 1\/4: generating with no PTY output/.test(m))).toHaveLength(1);
        expect(infos.some(m => /false busy: screen redraw revealed idle \(busy→idle\) after 1 redraw nudge/.test(m))).toBe(true);
    }, 15_000);

    it('control: with the nudge disabled the same torn frame stays busy (the live wedge)', async () => {
        setPolicy({ silent: 0 });
        const { driver, pty } = await bootIntoGarbledBusy();
        pty.onResize = () => setTimeout(() => pty.feed(REDRAWN_FRAME), 20);
        await sleep(3500);
        expect(pty.resizes).toEqual([]);
        expect(driver.getFsmDebug().currentState).toBe('busy');
        expect(driver.getRedrawNudgeCount()).toBe(0);
    }, 10_000);

    it('busy + PTY output flowing → no nudge', async () => {
        setPolicy({ silent: 400 });
        const { driver, pty } = await bootIntoGarbledBusy();
        const glyphs = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
        for (let i = 0; i < 16; i += 1) {
            // A live spinner: the activity row repaints every 100ms.
            pty.feed(`\x1b[14;1H${glyphs[i % glyphs.length]}  Running command...\x1b[1;1H`);
            await sleep(100);
        }
        expect(pty.resizes).toEqual([]);
        expect(driver.getRedrawNudgeCount()).toBe(0);
        expect(driver.getFsmDebug().currentState).toBe('busy');
    }, 10_000);

    it('a TUI that never repaints gets at most maxPerEpisode nudges, spaced by N', async () => {
        setPolicy({ silent: 300, max: 2, hold: 20, settle: 30 });
        const { driver, pty, infos } = await bootIntoGarbledBusy();
        await sleep(2500);
        expect(pty.resizes).toEqual([[81, 32], [80, 32], [81, 32], [80, 32]]);
        expect(driver.getRedrawNudgeCount()).toBe(2);
        expect(infos.filter(m => /redraw nudge \d\/2:/.test(m))).toHaveLength(2);
        expect(driver.getFsmDebug().currentState).toBe('busy');
    }, 10_000);
});
