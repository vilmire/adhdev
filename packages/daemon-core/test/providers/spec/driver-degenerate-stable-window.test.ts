/**
 * Regression coverage for CODEX-FSM-DEGENERATE-STABLE (defect 2).
 *
 * cursor.row is the ghostty backend's RAW row coordinate (un-normalized),
 * while the FSM's currentLines is the viewport snapshot with blank ends
 * trimmed (getText → trimBlankEnds). When the cursor sits in the trimmed
 * trailing-blank region (or the backend counts scrollback rows), cursor.row
 * overshoots the line array and the old slice(start, cursor.row) returned an
 * EMPTY window. Two empty windows compare equal on every frame, so
 * regionLastChangedAt never advanced and stable_ms accumulated forever — the
 * FSM read a generating codex screen as "stable cursor_above=4 353833ms /
 * 1500ms" and committed a false busy→idle (live: generating_completed at
 * duration=402s while the native transcript kept growing).
 *
 * The fix clamps the measured window to the content length and treats a still
 * -empty window as CHANGED: an unmeasurable window must never read as "stable".
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver, stableCursorWindow } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4243;
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

// Generous threshold so both assertions have ≥100ms margin against adapter
// debounce (~80ms) and CI timer jitter (see the timeline comment in the test).
const STABLE_MS = 800;

function stableSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.degenerate-stable',
        name: 'degenerate stable window test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'busy', label: 'Working', status: 'generating' },
            { id: 'idle', label: 'Ready', status: 'idle' },
        ],
        transitions: [
            { label: 'starting→busy', from: 'starting', to: 'busy', when: { matches: 'Working' } },
            { label: 'busy→idle', from: 'busy', to: 'idle', when: { stable_ms: STABLE_MS, cursor_above: 4 } },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-degenerate-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('stableCursorWindow — cursor row vs blank-trimmed viewport reconciliation', () => {
    it('clamps an overshooting cursor row to the content tail (measurable window)', () => {
        // 3 content lines, cursor parked at raw row 31 (trimmed blank region):
        // the old slice(27, 31) was EMPTY; the fix measures the content tail.
        expect(stableCursorWindow(3, 31, 4)).toEqual({ start: 0, end: 3 });
    });
    it('keeps the normal in-bounds window untouched', () => {
        expect(stableCursorWindow(32, 23, 4)).toEqual({ start: 19, end: 23 });
        expect(stableCursorWindow(5, 2, 4)).toEqual({ start: 0, end: 2 });
    });
    it('returns null (unmeasurable → never stable) when no window exists', () => {
        expect(stableCursorWindow(0, 31, 4)).toBeNull(); // no content at all
        expect(stableCursorWindow(5, 0, 4)).toBeNull();  // cursor at row 0
        expect(stableCursorWindow(5, -3, 4)).toBeNull(); // defensive: negative row
    });
});

describe('FsmDriver — degenerate stable window', () => {
    it('does NOT accumulate stable_ms over an unmeasurable window: a content change inside the clamped region resets the clock', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(stableSpec()),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Frame A (t≈0, evaluated ≈80ms after debounce): three content
            // lines at the top, then park the cursor on the LAST terminal row
            // (default 32 rows → raw row 31). The blank-trimmed viewport has 3
            // lines, so the raw cursor row overshoots it — the degenerate
            // window setup. busy entered at ≈80ms.
            pty.feed('line one\nline two\nWorking A\x1b[32;1H');
            await sleep(300);
            expect(driver.getFsmDebug().currentState).toBe('busy');

            // Frame B (t≈300, evaluated ≈380ms): rewrite the Working line IN
            // PLACE (CUP row 3, overwrite, CUP back to the bottom row) — a
            // content change INSIDE the clamped region with the cursor still
            // parked below the content. Under the old code both frames sliced
            // to EMPTY windows, compared equal, and the stable clock kept
            // running from frame A — busy→idle fired at ≈80+800=880ms despite
            // the change at 380ms. Under the fix the change is measured and
            // the clock restarts at ≈380ms → idle at ≈1180ms.
            pty.feed('\x1b[3;1HWorking B\x1b[32;1H');

            // t≈1000ms: past the pre-fix fire time (880ms) but before the
            // fixed fire time (1180ms) — must STILL be busy.
            await sleep(700);
            expect(driver.getFsmDebug().currentState).toBe('busy');

            // t≈1700ms: the clamped window has genuinely been quiet for
            // STABLE_MS — the transition fires. The fix blocks false
            // stability, not real stability.
            await sleep(700);
            expect(driver.getFsmDebug().currentState).toBe('idle');
        } finally {
            driver.shutdown();
        }
    });
});
