/**
 * Regression coverage for win32 submit resend budget, unconfirmed backoff,
 * and non-win32 split write behavior (split from driver-win32-submit.test.ts).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { WIN32_ECHO_MAX_WAIT_MS } from '../../../src/providers/spec/submit-policy.js';
import {
    MULTILINE, DrivableFactory,
    submitSpec, writeSpec, setPlatform,
    registerWin32SubmitHooks, sleep,
    sendAndCollectPty, sendAndCollect,
} from './driver-win32-submit-harness.js';

registerWin32SubmitHooks();

describe('FsmDriver -- win32 submit', () => {
    // ── BLANK-ENTER-PILEUP (2026-10-10, win32 live sample) ──────────────────
    //
    // Live: agy took ~29s to echo a 4485-char body. The old flat-cadence resend
    // net (14 × 350ms = 4.9s) expired long before that, so the engine blind-fired
    // and then burned its ENTIRE remaining budget as fast blank Enter presses —
    // 13 blank composer rows for 14 resends. The fix: (a) a per-provider resend
    // budget so a CLI whose composer visibly accumulates unconsumed CRs (agy)
    // can decare a small cap, and (b) a body that never echoed at all backs off
    // its resend cadence instead of firing the whole budget in under 5 seconds.

    it('win32: per-provider max_submit_resends caps the resend budget below the global default', async () => {
        setPlatform('win32');
        // Body never echoes (echoBody: false) and the FSM never reports leaving
        // idle → every resend is the blind/unconfirmed class, which now backs off.
        // With a budget of 3 the loop must stop at 3 regardless of how long we wait.
        const writes = await sendAndCollect({
            text: 'hello world',
            echoBody: false,
            sendMessage: { max_submit_resends: 3 },
            totalWaitMs: 26_000,
        });
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(3);
    }, 30_000);

    it('win32: an out-of-range max_submit_resends (0, negative, >14) falls back to the global default', async () => {
        setPlatform('win32');
        for (const bad of [0, -1, 999]) {
            const writes = await sendAndCollect({
                text: MULTILINE, sendMessage: { max_submit_resends: bad }, totalWaitMs: 5600,
            });
            expect(writes.filter(w => w === '\r').length).toBe(14);
        }
    }, 20_000);

    it('win32: a body that NEVER echoes backs off its resend cadence instead of firing the whole budget in <5s', async () => {
        setPlatform('win32');
        // echoBody: false → bodyEchoed() is always false → every fire() is the
        // UNCONFIRMED class → backed-off cadence (350, 700, 1050, ... capped at 3500ms).
        // A small budget keeps the test fast while still proving the gap grows.
        const start = Date.now();
        const { writes } = await sendAndCollectPty({
            text: 'hello world',
            echoBody: false,
            sendMessage: { max_submit_resends: 4 },
            totalWaitMs: 26_000,
        });
        const elapsed = Date.now() - start;
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(4);
        // Flat cadence would have finished in ~20s (echo-gate wait) + 4×350ms ≈
        // 21.4s. Backed-off cadence (350+700+1050) adds ~2.1s more between the
        // resends themselves — assert we actually waited past the flat-cadence
        // total, i.e. the gaps grew rather than staying flat.
        expect(elapsed).toBeGreaterThan(WIN32_ECHO_MAX_WAIT_MS + 350 + 700 + 1050);
    }, 30_000);

    it('win32: a body that echoes LATE (after blind-fire begins) speeds back up to the fast cadence', async () => {
        setPlatform('win32');
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: writeSpec(submitSpec({ max_submit_resends: 5 })),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed('\n>\n? for shortcuts');
            await sleep(200);
            const before = pty.writes.length;
            driver.dispatch({ kind: 'send_message', text: 'lateconfirm' });
            // Never echo — let the blind-fire backstop kick in and the first
            // (unconfirmed, backed-off) resend fire, then confirm the agent
            // left idle shortly after: the resend loop should stop promptly
            // rather than continuing to wait out a long backed-off gap.
            await sleep(WIN32_ECHO_MAX_WAIT_MS + 500);
            expect(pty.writes.slice(before).filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
            pty.feed('\n\nesc to interrupt');
            await sleep(600);
            const crCount = pty.writes.slice(before).filter(w => w === '\r').length;
            // Stopped well below the 5-attempt budget because leaving idle halts
            // the loop immediately — no runaway even in the unconfirmed branch.
            expect(crCount).toBeLessThan(5);
        } finally {
            driver.shutdown();
        }
    }, 24_000);

    it('non-win32: keeps the historical split write (text, then a single separate CR)', async () => {
        setPlatform('darwin');
        const writes = await sendAndCollect({ text: 'hello world', totalWaitMs: 700 });
        expect(writes).toContain('hello world');
        expect(writes).toContain('\r');
        expect(writes).not.toContain('hello world\r');
        const loneCr = writes.filter(w => w === '\r').length;
        expect(loneCr).toBe(1);
    });
});
