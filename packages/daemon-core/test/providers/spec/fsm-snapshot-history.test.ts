/**
 * Regression coverage for the FSM transition snapshot history (fsmSnapshotHistory).
 *
 * Drives a real FsmDriver through a fake PTY transport so transitions actually
 * fire, then asserts that:
 *   - each fired transition pushes one FsmSnapshotEntry capturing the full
 *     pre-transition evaluation table (transitions[] with per-condition detail),
 *   - the buffer is capped at 20 (oldest dropped),
 *   - the lightweight stateHistory / DriverHistoryEntry schema is unchanged.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

// A fake PTY: ignores writes, lets the test push raw frames as "PTY data".
// Each pushed frame is written verbatim to the terminal screen the driver reads.
class FakePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    private dataCb: ((d: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* swallow keystrokes */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (d: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    /** Clear screen + home cursor, then paint `text`. */
    paint(text: string): void { this.dataCb?.('\x1b[2J\x1b[H' + text.replace(/\n/g, '\r\n')); }
}

class FakeFactory implements PtyTransportFactory {
    last: FakePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new FakePty();
        return this.last;
    }
}

// Minimal v4 spec: idle ⇄ busy driven purely by screen content (no timing), so
// transitions fire deterministically as soon as the painted frame settles.
const SPEC = {
    $schema: 'adhdev:cli/spec@4',
    id: 'test.snapshot',
    name: 'snapshot test',
    binary: '/bin/true',
    send_message: { submit_key: '\r' },
    sections: {},
    states: [
        { id: 'idle', label: 'Idle', initial: true, status: 'idle' },
        { id: 'busy', label: 'Busy', status: 'generating' },
    ],
    transitions: [
        { from: 'idle', to: 'busy', label: 'idle→busy', when: { matches: 'WORKING' } },
        { from: 'busy', to: 'idle', label: 'busy→idle', when: { matches: 'DONE' } },
    ],
};

function writeSpec(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-snap-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(SPEC));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Paint a frame and wait for the adapter's 80ms screen-change debounce plus a
 *  margin so the driver re-evaluates and (maybe) transitions. */
async function paintAndSettle(pty: FakePty, text: string): Promise<void> {
    pty.paint(text);
    await sleep(160);
}

describe('FsmDriver — fsmSnapshotHistory', () => {
    it('captures one full-evaluation snapshot per transition and exposes it via getFsmSnapshotHistory()', async () => {
        const factory = new FakeFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // idle → busy
            await paintAndSettle(pty, 'WORKING on it');
            // busy → idle
            await paintAndSettle(pty, 'all DONE');

            const snaps = driver.getFsmSnapshotHistory();
            expect(snaps.length).toBe(2);

            const [first, second] = snaps;
            expect(first.stateFrom).toBe('idle');
            expect(first.stateTo).toBe('busy');
            expect(first.firedTo).toBe('busy');
            expect(first.firedLabel).toBe('idle→busy');
            expect(typeof first.at).toBe('number');
            expect(Array.isArray(first.reason)).toBe(true);
            // The whole pre-transition evaluation table is captured: every
            // outgoing transition from `idle` with its per-condition CondResult.
            expect(Array.isArray(first.transitions)).toBe(true);
            expect(first.transitions.length).toBeGreaterThan(0);
            const firedRow = first.transitions.find(t => t.to === 'busy');
            expect(firedRow?.fires).toBe(true);
            expect(firedRow?.cond?.result).toBe(true);

            expect(second.stateFrom).toBe('busy');
            expect(second.stateTo).toBe('idle');
        } finally {
            driver.shutdown();
        }
    });

    it('rings the buffer at 20 entries, dropping the oldest', async () => {
        const factory = new FakeFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Toggle 25 times → 25 transitions; only the last 20 survive.
            for (let i = 0; i < 25; i += 1) {
                await paintAndSettle(pty, i % 2 === 0 ? 'WORKING' : 'DONE');
            }
            const snaps = driver.getFsmSnapshotHistory();
            expect(snaps.length).toBe(20);
            // 25 transitions fired (indices 0..24); the oldest 5 were dropped,
            // so the buffer holds indices 5..24. Even index → idle→busy, odd
            // index → busy→idle. Index 5 (odd) = busy→idle; index 24 (even) =
            // idle→busy. The surviving window must NOT start at the very first
            // transition.
            expect(snaps[0].stateFrom).toBe('busy');
            expect(snaps[0].stateTo).toBe('idle');
            expect(snaps[snaps.length - 1].stateFrom).toBe('idle');
            expect(snaps[snaps.length - 1].stateTo).toBe('busy');
        } finally {
            driver.shutdown();
        }
    });

    it('leaves the lightweight stateHistory / DriverHistoryEntry schema untouched', async () => {
        const factory = new FakeFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            await paintAndSettle(pty, 'WORKING');
            const hist = driver.getStateHistory();
            expect(hist.length).toBeGreaterThan(0);
            const entry = hist[hist.length - 1];
            // DriverHistoryEntry must NOT have grown a `transitions` field; it
            // stays the slim shape the devconsole panel consumes.
            expect('transitions' in entry).toBe(false);
            expect(entry).toHaveProperty('stateId');
            expect(entry).toHaveProperty('label');
            expect(entry).toHaveProperty('at');
            expect(entry).toHaveProperty('durationMs');
            expect(entry).toHaveProperty('reason');
        } finally {
            driver.shutdown();
        }
    });
});
