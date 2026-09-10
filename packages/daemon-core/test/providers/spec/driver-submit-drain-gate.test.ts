/**
 * ENTER-LOSS layer ① — driver-level in-flight submit tracking (2026-09-10).
 *
 * Live incident: a 10,937-char completion notification was written to the
 * coordinator PTY; its CR was scheduled ≥1800ms out (large-body verified
 * submit) and the daemon shut down 1.4s later — every submit timer lived in
 * process memory, so the CR never fired and the body sat in the composer for
 * 1h42m. The fix gives FsmDriver an observable in-flight-submit surface
 * (hasInFlightSubmit / whenSubmitDrained) that the shutdown path awaits.
 *
 * Covered here:
 *  - a written-but-unsubmitted body reports in-flight, and the drain resolves
 *    true once the submit actually lands;
 *  - the drain times out (resolves false) when the submit cannot complete;
 *  - with nothing in flight the drain passes immediately (no added latency);
 *  - the short-body path's previously-untracked CR timer is now tracked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class RecordingPty implements PtyRuntimeTransport {
    readonly pid = 4321;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    submits = 0;
    onSubmit: (() => void) | null = null;
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;

    write(data: string): void {
        this.writes.push(data);
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                this.submits += 1;
                if (this.submits === 1) this.onSubmit?.();
            }
        }
    }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class RecordingFactory implements PtyTransportFactory {
    last: RecordingPty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new RecordingPty();
        return this.last;
    }
}

function submitSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.submit-drain',
        name: 'submit drain test',
        binary: '/bin/true',
        send_message: { submit_key: '\r', delay_ms_before_submit: 200 },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Generating', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→generating', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'esc to interrupt' } },
        ],
    };
}

const __tmpDirsToClean: string[] = [];
function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-drain-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}
afterEach(() => {
    while (__tmpDirsToClean.length > 0) {
        fs.rmSync(__tmpDirsToClean.pop()!, { recursive: true, force: true });
    }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => setPlatform(ORIGINAL_PLATFORM));

/** ≥ VERIFIED_SUBMIT_MIN_CHARS, few newlines — the incident shape. */
const LARGE_BODY = 'Delegated worker completion notification body. '.repeat(60);

async function makeReadyDriver(): Promise<{ driver: FsmDriver; pty: RecordingPty }> {
    const factory = new RecordingFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(submitSpec()),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    const pty = factory.last!;
    pty.feed('\n>\n? for shortcuts');
    await sleep(200);
    return { driver, pty };
}

describe('ENTER-LOSS ① — in-flight submit drain gate (driver level)', () => {
    it('nothing in flight → immediate pass (no added shutdown latency)', async () => {
        const { driver } = await makeReadyDriver();
        try {
            expect(driver.hasInFlightSubmit()).toBe(false);
            const before = Date.now();
            await expect(driver.whenSubmitDrained(5_000)).resolves.toBe(true);
            expect(Date.now() - before).toBeLessThan(100);
        } finally { driver.shutdown(); }
    });

    it('large body: reports in-flight after the write, drains true once the CR lands', async () => {
        setPlatform('darwin');
        const { driver, pty } = await makeReadyDriver();
        try {
            pty.onSubmit = () => setTimeout(() => pty.feed('\n\nesc to interrupt'), 0);
            driver.dispatch({ kind: 'send_message', text: LARGE_BODY });
            // Body written (or about to be), CR scheduled behind the echo-gate:
            // this is exactly the window the incident's shutdown landed in.
            expect(driver.hasInFlightSubmit()).toBe(true);
            expect(pty.submits).toBe(0);
            // Echo the body so the verified path can confirm and fire the CR.
            pty.feed(`\n${LARGE_BODY}`);
            const drained = await driver.whenSubmitDrained(10_000);
            expect(drained).toBe(true);
            expect(pty.submits).toBeGreaterThanOrEqual(1);
            expect(driver.hasInFlightSubmit()).toBe(false);
        } finally { driver.shutdown(); }
    });

    it('drain ceiling: resolves false when the submit cannot complete in time', async () => {
        setPlatform('darwin');
        const { driver, pty } = await makeReadyDriver();
        try {
            driver.dispatch({ kind: 'send_message', text: LARGE_BODY });
            expect(driver.hasInFlightSubmit()).toBe(true);
            // NO echo is fed: the echo-gate holds the CR (up to its 20s blind-fire
            // backstop), so a short drain budget must time out rather than hang.
            const before = Date.now();
            const drained = await driver.whenSubmitDrained(500);
            expect(drained).toBe(false);
            expect(Date.now() - before).toBeLessThan(2_000);
            // Still in flight — the caller (shutdown gate) logs and proceeds.
            expect(driver.hasInFlightSubmit()).toBe(true);
            expect(pty.submits).toBe(0);
        } finally { driver.shutdown(); }
    });

    it('short body: the delayed CR timer is tracked (was a bare setTimeout)', async () => {
        setPlatform('darwin');
        const { driver, pty } = await makeReadyDriver();
        try {
            driver.dispatch({ kind: 'send_message', text: 'continue' });
            // delay_ms_before_submit=200 → the CR is pending on plainSubmitTimer.
            expect(driver.hasInFlightSubmit()).toBe(true);
            const drained = await driver.whenSubmitDrained(3_000);
            expect(drained).toBe(true);
            expect(pty.submits).toBeGreaterThanOrEqual(1);
        } finally { driver.shutdown(); }
    });

    it('shutdown() cancels a pending short-body CR instead of firing into a dead PTY', async () => {
        setPlatform('darwin');
        const { driver, pty } = await makeReadyDriver();
        driver.dispatch({ kind: 'send_message', text: 'continue' });
        expect(driver.hasInFlightSubmit()).toBe(true);
        const submitsAtShutdown = pty.submits;
        driver.shutdown();
        await sleep(400);
        expect(pty.submits).toBe(submitsAtShutdown);
        expect(driver.hasInFlightSubmit()).toBe(false);
    });
});
