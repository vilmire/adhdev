/**
 * Regression coverage for FSMLOG-SESSION-ATTRIBUTION (D3).
 *
 * FsmDriver logged every line under a spec-path-only tag, so two concurrent
 * sessions of the SAME provider emitted transition lines under an identical
 * prefix. Multi-session logs were therefore unattributable: during the D1 RCA
 * this caused transitions to be credited to the wrong session, producing a
 * "there was no wedge" conclusion that a cross-audit later overturned.
 *
 * FsmDriver.stateHistory is a per-instance private field, so the DRIVER always
 * knew which session it belonged to — only the log line lacked the identifier.
 * The fix threads the owning session id into SpecDriverOpts and appends its
 * short form to specTag.
 *
 * The discriminating assertion is the two-session one: it fails on the pre-fix
 * code precisely because both drivers logged an identical prefix, which is the
 * defect. A test that only asserted "the tag contains the spec path" would pass
 * on both sides and prove nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { getRecentLogs, setLogLevel } from '../../../src/logging/logger.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4711;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* no-op */ }
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

// A minimal spec whose starting→busy transition fires off a single screen
// match, so each driver reliably emits one "from → to" FsmDriver log line.
function transitionSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.session-log-attribution',
        name: 'session log attribution test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'busy', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→busy', from: 'starting', to: 'busy', when: { matches: 'Working' } },
        ],
    };
}

function writeSpec(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-session-log-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(transitionSpec()));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The logger ring buffer is process-global and persists across tests in this
// file, so each test takes a timestamp watermark and reads only lines emitted
// after it. Without this, a later test sees earlier tests' drivers too and the
// distinct-prefix counts below would be meaningless.
let watermark = 0;

/** FsmDriver transition lines emitted since the current test's watermark. */
function driverTransitionLines(): string[] {
    return getRecentLogs(200, 'info')
        .filter(e => e.ts >= watermark && e.category === 'FsmDriver' && e.message.includes('→'))
        .map(e => e.message);
}

async function runDriverToBusy(specPath: string, sessionId?: string): Promise<void> {
    const factory = new DrivableFactory();
    const driver = new FsmDriver({
        specPath,
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
        ...(sessionId ? { sessionId } : {}),
    });
    driver.start();
    try {
        factory.last!.feed('Working now\n');
        await sleep(300);
        expect(driver.getFsmDebug().currentState).toBe('busy');
    } finally {
        driver.shutdown();
    }
}

describe('FsmDriver — session attribution in the log tag (D3)', () => {
    beforeEach(async () => {
        setLogLevel('info');
        // Ring-buffer entries are stamped in ms; wait past the current tick so the
        // watermark strictly separates this test's lines from the previous test's.
        await sleep(5);
        watermark = Date.now();
    });

    it('stamps the owning session id onto the transition log line', async () => {
        const specPath = writeSpec();
        await runDriverToBusy(specPath, 'sess_aaaaaaaa1111');

        const lines = driverTransitionLines().filter(m => m.includes('starting → busy'));
        expect(lines.length).toBeGreaterThan(0);
        // The short (8-char) form is what mesh ledger/trace lines carry, so logs
        // grep-join against them.
        expect(lines.some(m => m.includes('sess_aaa'))).toBe(true);
        // The spec path segment is still present — the identifier is ADDED to the
        // existing line, not swapped in for the spec context.
        expect(lines.every(m => m.includes('spec.json'))).toBe(true);
    });

    it('DISCRIMINATOR: two concurrent sessions of the SAME spec log distinguishable transitions', async () => {
        // Both drivers run the identical spec file — the exact multi-session case
        // that was unattributable before the fix.
        const specPath = writeSpec();
        await runDriverToBusy(specPath, 'sess_11111111aaaa');
        await runDriverToBusy(specPath, 'sess_22222222bbbb');

        const lines = driverTransitionLines().filter(m => m.includes('starting → busy'));
        const fromA = lines.filter(m => m.includes('sess_111'));
        const fromB = lines.filter(m => m.includes('sess_222'));

        // Each session's transition is present AND attributable to it alone.
        expect(fromA.length).toBeGreaterThan(0);
        expect(fromB.length).toBeGreaterThan(0);
        // No line is ambiguous between the two sessions.
        expect(fromA.some(m => m.includes('sess_222'))).toBe(false);
        expect(fromB.some(m => m.includes('sess_111'))).toBe(false);

        // The core defect: pre-fix, both drivers produced an IDENTICAL prefix, so
        // the distinct-prefix count was 1. Post-fix it is 2.
        const prefixes = new Set(lines.map(m => m.slice(0, m.indexOf(']') + 1)));
        expect(prefixes.size).toBe(2);
    });

    it('falls back to a per-driver uid when no session id is supplied (still distinguishable)', async () => {
        // Legacy / session-less callers must not collapse back into one shared prefix.
        const specPath = writeSpec();
        await runDriverToBusy(specPath);
        await runDriverToBusy(specPath);

        const lines = driverTransitionLines().filter(m => m.includes('starting → busy'));
        const prefixes = new Set(lines.map(m => m.slice(0, m.indexOf(']') + 1)));
        expect(prefixes.size).toBe(2);
    });

    it('logs an identifier only — no session content leaks into the tag', async () => {
        const specPath = writeSpec();
        await runDriverToBusy(specPath, 'sess_cccccccc3333');

        const lines = driverTransitionLines().filter(m => m.includes('starting → busy'));
        // The tag carries the truncated id, never the full id or any screen text.
        for (const line of lines) {
            const tag = line.slice(0, line.indexOf(']') + 1);
            expect(tag).not.toContain('Working now');
            expect(tag).not.toContain('sess_cccccccc3333');
        }
    });
});
