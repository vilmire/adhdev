/**
 * Codex native-turn hold: the live 2026-11-01 sequence (one open rollout turn, ~12 screen-quiet
 * busy<->idle flaps, coordinator paged with a `flapping` advisory). Drives the real FsmDriver with the
 * shipping codex spec (timings scaled) and a real rollout file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { createCodexNativeTurnHold, codexTurnStateFromRecords, NATIVE_TURN_STALE_MS } from '../../../src/providers/spec/native-turn-hold.js';
import { nativeTurnStateFor } from '../../../src/shared/native-turn-registry.js';
import { createWorkerSessionHealthMonitor } from '../../../src/mesh/turn-ledger/worker-session-health.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';


const mocked = vi.hoisted(() => ({ rollout: '', owned: true }));
vi.mock('../../../src/providers/spec/native-history-executor.js', async (orig) => ({
    ...(await orig<typeof import('../../../src/providers/spec/native-history-executor.js')>()),
    resolveJsonlSourcePathDetailed: () => ({ path: mocked.rollout, outcome: { attribution: 'claimed', ownerConfirmed: mocked.owned } }),
}));

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

const __tmpDirsToClean: string[] = [];

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
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

afterEach(() => {
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


const ev = (type: string, ts: string) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type } });
function newRollout(...types: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-turn-hold-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'rollout-test.jsonl');
    fs.writeFileSync(p, types.map(t => ev(t, new Date().toISOString())).join('\n') + '\n');
    return p;
}
const holdFor = (sessionId = 'sess-hold-1') => createCodexNativeTurnHold({
    sessionId, getConfig: () => ({ source: { kind: 'jsonl', path: 'unused' } }) as any, getInput: () => ({ agentType: 'codex-cli' }),
});

function makeDriver(hold?: ReturnType<typeof holdFor>) {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({ specPath: writeScaledSpec(), workingDir: os.tmpdir(), hotReload: false, transportFactory: factory, nativeTurnHold: hold });
    driver.start();
    const edges: string[] = [];
    let last = '';
    const watch = setInterval(() => { const s = driver.getFsmDebug().currentState; if (s !== last) { if (last) edges.push(`${last}>${s}`); last = s; } }, 40);
    return { driver, pty: factory.last!, edges, stop: () => { clearInterval(watch); driver.shutdown(); } };
}

describe('codexTurnStateFromRecords', () => {
    it('reads the last lifecycle marker', () => {
        const r = (t: string) => ({ type: 'event_msg', payload: { type: t } });
        expect(codexTurnStateFromRecords([])).toBe('none');
        expect(codexTurnStateFromRecords([r('task_started'), r('item_completed')])).toBe('open');
        expect(codexTurnStateFromRecords([r('task_started'), r('task_complete')])).toBe('closed');
        expect(codexTurnStateFromRecords([r('task_started'), r('turn_aborted'), r('task_started')])).toBe('open');
        expect(codexTurnStateFromRecords([r('task_started'), r('turn_aborted')])).toBe('closed');
    });
});

describe('FsmDriver + native turn hold — live flapping sequence (open rollout turn, quiet screen gaps)', () => {
    it('CONTROL: without a hold the quiet composing gaps flap busy/idle (the live defect)', async () => {
        const { driver, pty, edges, stop } = makeDriver();
        try {
            await driveToBusy(driver, pty);
            pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME);
            expect(await waitForState(driver, 'idle', 4000)).toBe(true);
            await sleep(120);
            expect(edges).toContain('busy>idle');
        } finally { stop(); }
    }, 30000);

    it('holds busy through several quiet gaps while the rollout turn is open, then idles right after task_complete', async () => {
        mocked.rollout = newRollout('task_started', 'item_completed'); mocked.owned = true;
        const hold = holdFor();
        const { driver, pty, edges, stop } = makeDriver(hold);
        try {
            await driveToBusy(driver, pty);
            for (let gap = 0; gap < 3; gap++) {
                pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME); // quiet, composer drawn, no spinner: screen says idle
                await sleep(PRE_BOUND_CHECK_MS + 300);          // well past stable_ms and the 1.5 s hold-block
                expect(driver.getFsmDebug().currentState).toBe('busy');
                expect(nativeTurnStateFor('sess-hold-1')).toBe('open');
                pty.feed('\x1b[5;1H  Working (⣿ 3s · esc to interrupt)\r\n› \x1b[6;2H'); // model resumes
                await sleep(200);
            }
            expect(edges.filter(e => e === 'busy>idle')).toEqual([]);

            // The turn ends: codex writes task_complete. No further screen frame is needed.
            pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME);
            fs.appendFileSync(mocked.rollout, ev('task_complete', new Date().toISOString()) + '\n');
            expect(await waitForState(driver, 'idle', 6000)).toBe(true);
            expect(nativeTurnStateFor('sess-hold-1')).toBe('closed');
        } finally { stop(); }
    }, 60000);

    it('falls back to the screen when the rollout is unmapped or stale (bounded hold)', async () => {
        mocked.rollout = newRollout('task_started'); mocked.owned = false;
        const unmapped = makeDriver(holdFor('sess-unmapped'));
        try {
            await driveToBusy(unmapped.driver, unmapped.pty);
            unmapped.pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME);
            expect(await waitForState(unmapped.driver, 'idle', 4000)).toBe(true);
        } finally { unmapped.stop(); }

        mocked.owned = true;
        const old = new Date(Date.now() - NATIVE_TURN_STALE_MS - 5_000);
        fs.utimesSync(mocked.rollout, old, old);
        const stale = makeDriver(holdFor('sess-stale'));
        try {
            await driveToBusy(stale.driver, stale.pty);
            stale.pty.feed('\x1b[2J\x1b[H' + COMPLETED_FRAME);
            expect(await waitForState(stale.driver, 'idle', 4000)).toBe(true);
            expect(nativeTurnStateFor('sess-stale')).toBe('unknown');
        } finally { stale.stop(); }
    }, 60000);
});

describe('worker session health with native turn evidence', () => {
    const owner = { meshId: 'm', taskId: 't', nodeId: 'n', attemptId: 'a', generation: 0, sessionId: 's' };
    const run = (native?: 'open' | 'closed' | 'unknown') => {
        const emit = vi.fn();
        const monitor = createWorkerSessionHealthMonitor(emit);
        const T = 1_800_000_000_000;
        for (let i = 0; i < 12; i++) monitor.transition(owner, i % 2 ? 'idle' : 'generating', i % 2 ? 'generating' : 'idle', T + i * 20_000, i % 2 ? undefined : native);
        return emit;
    };
    it('screen-only idle pulses inside one open native turn raise no flapping advisory', () => {
        expect(run('open')).not.toHaveBeenCalled();
    });
    it('keeps the screen-derived behaviour without native evidence or when the turn is closed', () => {
        for (const n of [undefined, 'unknown', 'closed'] as const) {
            expect(run(n).mock.calls[0]?.[1]).toMatchObject({ signal: 'flapping' });
        }
    });
});
