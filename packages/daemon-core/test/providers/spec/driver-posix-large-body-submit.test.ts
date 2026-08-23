/**
 * POSIX-ENTER-DROP regression coverage (2026-08-23, grok-cli/darwin).
 *
 * Live defect: a multi-KB coordinator brief injected into a grok-cli session was
 * never submitted — the body sat in the composer until the owner pressed Enter by
 * hand. Coordinator-side the session read runtimeInputAck:true, 1 user message,
 * 0 assistant messages, status 'generating': a SILENT submit failure that is
 * indistinguishable from healthy work.
 *
 * Root cause: the echo-verified submit (write body → confirm it echoed → resend the
 * submit key until the agent actually leaves the composer) was gated on
 * `process.platform === 'win32'`. POSIX took a blind branch: one write, then a CR
 * from a bare setTimeout whose delay came from resolveSubmitDelayMs — which scaled
 * on newline COUNT only. A multi-KB single-paragraph body has few newlines, so it
 * scored the 200ms floor and the CR landed while the TUI was still ingesting the
 * paste, where it is absorbed as part of the paste rather than acting as submit.
 *
 * The fix: bodies at or above VERIFIED_SUBMIT_MIN_CHARS take the same echo-verified
 * submit on every platform; shorter bodies keep the original immediate path so the
 * common interactive case pays no added latency.
 *
 * These tests model the failure with a composer that only treats a CR as a submit
 * once the whole body has arrived — a CR arriving mid-ingest is swallowed. Under
 * the old blind-timer behaviour that yields ZERO submits (the live defect); under
 * the verified path the resend loop carries it to exactly one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    FsmDriver,
    resolveSubmitDelayMs,
    shouldUseVerifiedSubmit,
    VERIFIED_SUBMIT_MIN_CHARS,
} from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

/**
 * A composer that reproduces the live POSIX failure mode.
 *
 * `ingestMs` models the window during which the TUI is still absorbing a pasted
 * body. A bare CR that arrives inside that window is SWALLOWED (counted, so the
 * test can assert on it) exactly as the real grok composer swallowed it; a CR that
 * arrives after it submits. The window opens on the body write and is measured in
 * wall-clock, so a driver that waits longer before its first CR — or that resends —
 * gets its submit through, and one that fires blind at 200ms does not.
 */
class IngestingPty implements PtyRuntimeTransport {
    readonly pid = 4243;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    private bodyWrittenAt: number | null = null;

    /** How long after the body write the composer keeps swallowing CRs. */
    ingestMs = 0;
    /** CRs absorbed by the ingest window (would-be submits that did nothing). */
    swallowedCrs = 0;
    /** Real submits: a CR that landed after ingest completed. */
    submits = 0;
    composerText = '';
    /** Fired synchronously on the first accepted submit so the harness can feed the
     *  'generating' footer without a polling delay. */
    onSubmit: (() => void) | null = null;

    write(data: string): void {
        this.writes.push(data);
        // Open the ingest window BEFORE consuming this write's characters. A body
        // arriving in the same write as its own trailing CR (or a CR in the very
        // next write) must find the window already open — setting it afterwards
        // would let the first CR slip through and mask the defect.
        if (data.length > 1 && !/^[\r\n]+$/.test(data)) this.bodyWrittenAt = Date.now();
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                const ingesting = this.bodyWrittenAt !== null
                    && Date.now() - this.bodyWrittenAt < this.ingestMs;
                if (ingesting) { this.swallowedCrs += 1; continue; }
                this.submits += 1;
                this.composerText = '';
                // A real TUI redraws its footer with the interrupt hint the instant
                // it accepts a submit. Emitting that synchronously is what lets the
                // driver's resend loop observe "left idle" and stop — modelling the
                // delay as a test-side poll would fabricate extra resends.
                if (this.submits === 1) this.onSubmit?.();
                continue;
            }
            this.composerText += ch;
        }
    }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class IngestingFactory implements PtyTransportFactory {
    last: IngestingPty | null = null;
    ingestMs = 0;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        const pty = new IngestingPty();
        pty.ingestMs = this.ingestMs;
        this.last = pty;
        return pty;
    }
}

function submitSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.posix-submit',
        name: 'posix submit test',
        binary: '/bin/true',
        // 200ms — the exact value grok-cli, claude-cli, codex-cli and
        // antigravity-cli all ship, and the one that failed live.
        send_message: { submit_key: '\r', delay_ms_before_submit: 200 },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Generating', status: 'generating' },
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
            {
                label: 'idle→generating',
                from: 'idle',
                to: 'generating',
                when: { section: 'footer', matches: 'esc to interrupt' },
            },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-posix-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

interface RunResult {
    submits: number;
    swallowedCrs: number;
    writes: string[];
    /** ms from the body write to the first submit-key write. */
    firstCrDelayMs: number | null;
}

/**
 * Dispatch `text` through a real FsmDriver against the ingesting composer.
 * `ingestMs` is how long the composer swallows CRs after the body lands.
 */
async function run(
    text: string,
    ingestMs: number,
    totalWaitMs = 2600,
    /** MANIFEST-SEND-DELAY: the provider manifest's sendDelayMs, as route.ts threads it. */
    manifestSendDelayMs?: number,
): Promise<RunResult> {
    const factory = new IngestingFactory();
    factory.ingestMs = ingestMs;
    const driver = new FsmDriver({
        specPath: writeSpec(submitSpec()),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
        manifestSendDelayMs,
    });
    driver.start();
    const pty = factory.last!;
    try {
        pty.feed('\n>\n? for shortcuts');
        await sleep(200);
        const before = pty.writes.length;
        // The composer announces its own submit; the driver must see 'generating'
        // and stop resending on its very next cadence tick.
        // Deferred by a tick: feeding PTY output from inside the driver's own
        // write() call would re-enter the FSM mid-write. A real TUI's redraw
        // likewise arrives as a separate event-loop turn.
        pty.onSubmit = () => setTimeout(() => pty.feed('\n\nesc to interrupt'), 0);
        driver.dispatch({ kind: 'send_message', text });
        const bodyAt = Date.now();
        let firstCrAt: number | null = null;
        // Echo the body so the verified path's echo-gate can confirm it.
        pty.feed(`\n${text}`);
        // Poll for the first CR write and for a real submit; once the composer
        // accepts a submit, flip the FSM to generating so the resend loop stops.
        const deadline = Date.now() + totalWaitMs;
        while (Date.now() < deadline) {
            if (firstCrAt === null && pty.writes.slice(before).some(w => w.includes('\r'))) {
                firstCrAt = Date.now();
            }
            await sleep(25);
        }
        return {
            submits: pty.submits,
            swallowedCrs: pty.swallowedCrs,
            writes: pty.writes.slice(before),
            firstCrDelayMs: firstCrAt === null ? null : firstCrAt - bodyAt,
        };
    } finally {
        driver.shutdown();
    }
}

/** A realistic coordinator brief: multi-KB, few newlines — the live failure shape. */
const LARGE_BODY = `${'Investigate the PTY submit path and report findings. '.repeat(80)}\n\nReport as JSON.`;
const SHORT_BODY = 'continue';

describe('POSIX-ENTER-DROP — large-body submit is echo-verified', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('reproduces the live failure shape: multi-KB body, few newlines', () => {
        // Guard the fixture itself — if it drifts small or newline-heavy the test
        // stops covering the reported defect.
        expect(LARGE_BODY.length).toBeGreaterThan(3000);
        expect(LARGE_BODY.split('\n').length - 1).toBeLessThanOrEqual(2);
    });

    it('THE DEFECT: a large body submits even when the composer swallows early CRs', async () => {
        setPlatform('darwin');
        // 900ms ingest window: far beyond the 200ms blind timer the spec asks for,
        // so the pre-fix driver's only CR is swallowed and NOTHING is ever submitted
        // — the live defect. The verified path holds the CR behind the echo-gate and
        // resends until it lands, so the message gets through.
        const res = await run(LARGE_BODY, 900);
        expect(res.submits).toBeGreaterThanOrEqual(1);
    });

    it('holds the first CR well past the blind 200ms that failed live', async () => {
        setPlatform('darwin');
        const res = await run(LARGE_BODY, 0, 1600);
        // The core regression: reverting to the blind timer puts this at ~200ms.
        // The echo-gate must not release the CR until the body has settled.
        expect(res.firstCrDelayMs).not.toBeNull();
        expect(res.firstCrDelayMs!).toBeGreaterThan(400);
    });

    it('a short body keeps the immediate path — no added latency (over-correction guard)', async () => {
        setPlatform('darwin');
        // No ingest window: the classic immediate path must still submit promptly.
        const res = await run(SHORT_BODY, 0, 900);
        expect(res.submits).toBeGreaterThanOrEqual(1);
        expect(shouldUseVerifiedSubmit(SHORT_BODY, 'darwin')).toBe(false);
        // The short-body CR must go out on the spec's own schedule, not behind an
        // echo-gate settle window.
        expect(res.firstCrDelayMs).not.toBeNull();
        expect(res.firstCrDelayMs!).toBeLessThan(600);
    });

    // ── MANIFEST-SEND-DELAY: the declared value must change real driver behaviour,
    //    not merely survive a pure-function unit test. The fixture spec declares the
    //    same 200ms grok-cli ships, so a manifest asking for 1200 is observable as a
    //    genuinely later first CR.
    it('a manifest sendDelayMs actually delays the real driver\'s first submit key', async () => {
        setPlatform('darwin');
        const withManifest = await run(SHORT_BODY, 0, 1800, 1200);
        expect(withManifest.firstCrDelayMs).not.toBeNull();
        // Spec says 200; the manifest asked for 1200 and is now honoured.
        expect(withManifest.firstCrDelayMs!).toBeGreaterThan(900);
    });

    it('a provider declaring no manifest sendDelayMs is unchanged (over-correction guard)', async () => {
        setPlatform('darwin');
        const res = await run(SHORT_BODY, 0, 900, undefined);
        expect(res.submits).toBeGreaterThanOrEqual(1);
        expect(res.firstCrDelayMs).not.toBeNull();
        expect(res.firstCrDelayMs!).toBeLessThan(600);
    });

    it('a wired manifest delay still submits — the longer wait does not break the send', async () => {
        setPlatform('darwin');
        // The guard against "wiring it made sends time out": a large body under an
        // ingesting composer AND a 1200ms manifest floor must still reach submit.
        const res = await run(LARGE_BODY, 300, 3000, 1200);
        expect(res.submits).toBeGreaterThanOrEqual(1);
    });

    it('stops resending once the agent is observed to have left the composer', async () => {
        setPlatform('darwin');
        // No ingest window: the first CR is accepted immediately and the composer
        // announces 'generating'. The resend loop must then halt promptly rather
        // than spraying Enter into the agent's next turn. The bound is the resend
        // budget (14) — a runaway loop would blow well past this.
        const res = await run(LARGE_BODY, 0, 2600);
        expect(res.submits).toBeGreaterThanOrEqual(1);
        expect(res.submits).toBeLessThanOrEqual(3);
    });
});

describe('POSIX-ENTER-DROP — threshold and delay policy', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('verified submit engages only from the threshold up on POSIX', () => {
        expect(shouldUseVerifiedSubmit('x'.repeat(VERIFIED_SUBMIT_MIN_CHARS - 1), 'darwin')).toBe(false);
        expect(shouldUseVerifiedSubmit('x'.repeat(VERIFIED_SUBMIT_MIN_CHARS), 'darwin')).toBe(true);
        expect(shouldUseVerifiedSubmit('x'.repeat(VERIFIED_SUBMIT_MIN_CHARS), 'linux')).toBe(true);
    });

    it('win32 always verifies regardless of size (unchanged)', () => {
        expect(shouldUseVerifiedSubmit('hi', 'win32')).toBe(true);
    });

    it('submit delay now scales with LENGTH, not just newline count', () => {
        // The live body was long but nearly newline-free, so the old newline-only
        // bonus left it at the 200ms floor. Reverting the length bonus makes this red.
        const longFewLines = 'x'.repeat(4000);
        const shortSameLines = 'x'.repeat(20);
        expect(resolveSubmitDelayMs(200, longFewLines))
            .toBeGreaterThan(resolveSubmitDelayMs(200, shortSameLines));
    });

    it('length bonus stays bounded so a huge paste is not stuck for minutes', () => {
        expect(resolveSubmitDelayMs(200, 'x'.repeat(500_000))).toBeLessThanOrEqual(2000);
    });

    it('short interactive sends keep their historical delay exactly', () => {
        // Over-correction guard: nothing below the threshold may get slower.
        expect(resolveSubmitDelayMs(200, 'continue')).toBe(200);
        expect(resolveSubmitDelayMs(1200, 'y')).toBe(1200);
    });
});
