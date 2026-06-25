/**
 * Regression coverage for the legacy ProviderCliAdapter on win32:
 *
 *  FIX A — win32 ConPTY paced write. A single unbounded write beyond ~1KB drops
 *  LEADING bytes (long task message arrives truncated, head lost). writeToPty must
 *  split a large payload into bounded, surrogate-safe chunks; the trailing submit
 *  key (when the caller fused `body + sendKey`) must ride in the SAME final write
 *  as the body's tail and never be emitted before the whole body is written.
 *
 *  FIX B — queue-until-ready. A task dispatched before the freshly-spawned PTY is
 *  interactive (this.ready=false) must be BUFFERED in the pending-outbound queue,
 *  not thrown away — so the very first big message is not silently lost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';
import { WIN32_PTY_WRITE_CHUNK_CHARS } from '../../src/cli-adapters/pty-write-chunking.js';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function buildAdapter() {
    const adapter = new ProviderCliAdapter({
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        binary: 'claude',
        spawn: { command: 'claude', args: [], shell: true, env: {} },
        scripts: { detectStatus: () => 'idle', parseApproval: () => null },
    } as any, '/tmp/project') as any;
    adapter.waitForInteractivePrompt = vi.fn().mockResolvedValue(undefined);
    adapter.terminalScreen = { getText: () => '❯\n' };
    adapter.recentOutputBuffer = '❯\n';
    adapter.runDetectStatus = vi.fn(() => 'idle');
    adapter.startupParseGate = false;
    adapter.submitStrategy = 'immediate';
    return adapter;
}

describe('ProviderCliAdapter win32 paced write (FIX A)', () => {
    beforeEach(() => { setPlatform('win32'); });
    afterEach(() => { setPlatform(ORIGINAL_PLATFORM); vi.useRealTimers(); });

    it('splits a >1024-char body into multiple surrogate-safe chunks that reassemble exactly', async () => {
        const adapter = buildAdapter();
        const writes: string[] = [];
        adapter.ptyProcess = { write: vi.fn((d: string) => { writes.push(d); return Promise.resolve(); }) };
        adapter.ready = true;
        adapter.currentStatus = 'idle';
        adapter.isWaitingForResponse = false;

        const body = Array.from({ length: 60 }, (_, i) => `step ${i}: do the thing carefully and report back in detail`).join('\n');
        expect(body.length).toBeGreaterThan(WIN32_PTY_WRITE_CHUNK_CHARS);

        // submitStrategy 'immediate' writes `body + sendKey` through writeToPty.
        await adapter.sendMessage(body);

        expect(writes.length).toBeGreaterThanOrEqual(2);
        // Reassembles to EXACTLY body + the submit key — nothing dropped, head present.
        expect(writes.join('')).toBe(body + '\r');
        for (const c of writes) expect(c.length).toBeLessThanOrEqual(WIN32_PTY_WRITE_CHUNK_CHARS);
        // The submit key rides in the FINAL write (atomic-submit invariant preserved).
        expect(writes[writes.length - 1].endsWith('\r')).toBe(true);
        // No earlier chunk carried a CR (no partial-body submit).
        expect(writes.slice(0, -1).some(c => c.includes('\r'))).toBe(false);
    });

    it('never splits a surrogate pair across win32 chunks', async () => {
        const adapter = buildAdapter();
        const writes: string[] = [];
        adapter.ptyProcess = { write: vi.fn((d: string) => { writes.push(d); return Promise.resolve(); }) };
        adapter.ready = true;
        adapter.currentStatus = 'idle';
        adapter.isWaitingForResponse = false;

        const body = '😀'.repeat(WIN32_PTY_WRITE_CHUNK_CHARS); // 2 units each → ~2x threshold
        await adapter.sendMessage(body);

        expect(writes.length).toBeGreaterThanOrEqual(2);
        expect(writes.join('')).toBe(body + '\r');
        // Each body chunk ends on a whole code point (no trailing high surrogate).
        for (const c of writes) {
            const stripped = c.endsWith('\r') ? c.slice(0, -1) : c;
            if (!stripped) continue;
            const last = stripped.charCodeAt(stripped.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
    });

    it('writes a small body in a single PTY write (no chunking below the threshold)', async () => {
        const adapter = buildAdapter();
        const writes: string[] = [];
        adapter.ptyProcess = { write: vi.fn((d: string) => { writes.push(d); return Promise.resolve(); }) };
        adapter.ready = true;
        adapter.currentStatus = 'idle';
        adapter.isWaitingForResponse = false;

        await adapter.sendMessage('short prompt');
        expect(writes).toEqual(['short prompt\r']);
    });
});

describe('ProviderCliAdapter posix write (unchanged single write)', () => {
    beforeEach(() => { setPlatform('darwin'); });
    afterEach(() => { setPlatform(ORIGINAL_PLATFORM); });

    it('writes a long body in a SINGLE write on posix (no chunking)', async () => {
        const adapter = buildAdapter();
        const writes: string[] = [];
        adapter.ptyProcess = { write: vi.fn((d: string) => { writes.push(d); return Promise.resolve(); }) };
        adapter.ready = true;
        adapter.currentStatus = 'idle';
        adapter.isWaitingForResponse = false;

        const body = 'p'.repeat(WIN32_PTY_WRITE_CHUNK_CHARS * 3);
        await adapter.sendMessage(body);
        // immediate strategy → exactly one atomic write of body + sendKey.
        expect(writes).toEqual([body + '\r']);
    });
});

describe('ProviderCliAdapter queue-until-ready (FIX B)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('queues a send that arrives before the PTY is interactive instead of throwing/dropping', async () => {
        const adapter = buildAdapter();
        adapter.ptyProcess = { write: vi.fn().mockResolvedValue(undefined) };
        // Not ready: PTY spawned but interactive prompt not yet printed.
        adapter.ready = false;
        adapter.startupParseGate = false;
        adapter.currentStatus = 'starting';
        adapter.isWaitingForResponse = false;
        // The not-ready recovery probe should NOT see idle, so readiness stays false.
        adapter.runDetectStatus = vi.fn(() => 'generating');
        adapter.resolveStartupState = vi.fn();

        await expect(adapter.sendMessage('first big task message')).resolves.toBeUndefined();

        // Buffered, not dropped, not thrown — and nothing written to the PTY yet.
        expect(adapter.pendingOutboundQueue.map((m: any) => m.content)).toEqual(['first big task message']);
        expect(adapter.ptyProcess.write).not.toHaveBeenCalled();
    });

    it('flushes the not-ready-queued message once startup settles to an idle prompt', async () => {
        const adapter = buildAdapter();
        adapter.ptyProcess = { write: vi.fn().mockResolvedValue(undefined) };
        adapter.ready = false;
        adapter.startupParseGate = false;
        adapter.currentStatus = 'starting';
        adapter.isWaitingForResponse = false;
        adapter.runDetectStatus = vi.fn(() => 'generating');
        adapter.resolveStartupState = vi.fn();

        await adapter.sendMessage('queued-before-ready');
        expect(adapter.pendingOutboundQueue).toHaveLength(1);

        // Simulate startup settling to an interactive idle prompt and flush.
        adapter.runDetectStatus = vi.fn(() => 'idle');
        adapter.ready = true;
        adapter.currentStatus = 'idle';
        adapter.startupParseGate = false;
        adapter.terminalScreen = { getText: () => '❯\n' };
        adapter.recentOutputBuffer = '❯\n';

        await adapter.flushPendingOutboundQueue();

        expect(adapter.pendingOutboundQueue).toHaveLength(0);
        expect(adapter.ptyProcess.write).toHaveBeenCalledWith('queued-before-ready\r');
    });

    it('a non-queueable (internal flush) send still throws when not ready (not silently swallowed)', async () => {
        const adapter = buildAdapter();
        adapter.ptyProcess = { write: vi.fn().mockResolvedValue(undefined) };
        adapter.ready = false;
        adapter.startupParseGate = false;
        adapter.currentStatus = 'starting';
        adapter.isWaitingForResponse = false;
        adapter.runDetectStatus = vi.fn(() => 'generating');
        adapter.resolveStartupState = vi.fn();

        // sendMessageNow(text, allowQueue=false) is the flush path.
        await expect(adapter.sendMessageNow('flush path', false)).rejects.toThrow('not ready');
    });
});
