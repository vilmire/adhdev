import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { RawTail } from '../../../src/providers/spec/raw-tail.js';

function adapter(): any {
    const a = Object.create(SpecCliAdapter.prototype);
    Object.assign(a, {
        cliType: 'kimi', spawned: true, exited: false,
        spec: { id: 'kimi', name: 'Kimi' },
        latestState: { id: 'busy', status: 'generating' },
        statusCallback: vi.fn(),
        detectInteractivePromptFromPtyChunk: vi.fn(),
        maybeClearResolvedClaudeTuiPrompt: vi.fn(),
        maybeCaptureClaudeTuiPrompt: vi.fn(),
        maybeUpgradeClaudeTuiMultiSelect: vi.fn(),
    });
    return a;
}
const output = (a: any, chunk: string) => a.handleEvent({ kind: 'pty_data', chunk });
afterEach(() => vi.restoreAllMocks());

describe('bounded PTY failure-classification work', () => {
    it('charges scans to output volume across four synthetic streams, independent of tiny chunk count', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        let scannedRaw = 0;
        const originalRead = RawTail.prototype.strippedTail;
        const read = vi.spyOn(RawTail.prototype, 'strippedTail').mockImplementation(function (this: RawTail, maxBytes) {
            scannedRaw += this.snapshot().length;
            return originalRead.call(this, maxBytes);
        });
        const streams = Array.from({ length: 4 }, adapter);
        // 4 x 64KiB, delivered one character at a time (262144 PTY events).
        // Before throttling: one whole-tail strip/classification per event.
        for (let n = 0; n < 64 * 1024; n++) {
            for (const a of streams) output(a, 'x');
        }
        expect(read).toHaveBeenCalledTimes(32); // 8 scans per stream
        expect(scannedRaw).toBe(917_536); // whole-tail input characters actually charged
        // The previous per-chunk reader stripped 1+2+...+65536 per stream.
        expect(4 * (65536 * 65537 / 2) / scannedRaw).toBeGreaterThan(9_000);
        for (const a of streams) a.getStatus(); // trailing bytes flushed once
        expect(read).toHaveBeenCalledTimes(36);
        for (let n = 0; n < 100; n++) for (const a of streams) a.getStatus();
        expect(read).toHaveBeenCalledTimes(36); // unchanged status: zero scans
    });

    it('scans low-volume output again after the time budget', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const a = adapter();
        const read = vi.spyOn(a.rawTail, 'strippedTail');
        output(a, 'working');
        output(a, '\nAuthentication failed: token expired');
        expect(read).toHaveBeenCalledTimes(1);
        expect(a.liveAuth?.suspect).toBeUndefined();
        now.mockReturnValue(10_250);
        output(a, '\n');
        expect(read).toHaveBeenCalledTimes(2);
        expect(a.liveAuth.suspect.failure.errorReason).toBe('auth_failed');
        expect(a.providerFailure).toBeUndefined(); // live suspicion only
    });

    it('flushes split ANSI and banner boundaries at status and unexpected exit', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const a = adapter();
        for (const chunk of ['\x1b[3', '1mAuthentica', 'tion failed: invalid API key', '\x1b[0', 'm\r', '\n']) output(a, chunk);
        a.getStatus();
        expect(a.liveAuth.suspect.failure.errorReason).toBe('auth_failed');
        expect(a.providerFailure).toBeUndefined();
        a.handleEvent({ kind: 'exit', exit_code: 1 });
        expect(a.providerFailure.errorReason).toBe('auth_failed');
    });

    it('retains code/tool filtering and requested-stop exit attribution', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const a = adapter();
        for (const chunk of ['```text\n', 'Authentication failed: token expired\n', '```\n']) output(a, chunk);
        a.getStatus();
        expect(a.liveAuth?.suspect).toBeUndefined();
        a.handleEvent({ kind: 'exit', exit_code: 1 });
        expect(a.providerFailure).toBeUndefined();
        const b = adapter();
        output(b, 'hello\n');
        output(b, 'Authentication failed: token expired\n');
        b.handleEvent({ kind: 'exit', exit_code: 129, termination: { requestedStop: 'user' } });
        expect(b.providerFailure).toBeUndefined();
    });
});
