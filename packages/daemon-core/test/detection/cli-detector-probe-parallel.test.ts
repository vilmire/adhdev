import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * P0 (2026-08-28 RCA): plan_mesh_onboarding false-timed-out at 15s because
 * detectCLIs(includeVersion:true)'s per-provider version probe
 * (--version -> -V -> -v -> custom) ran SEQUENTIALLY, up to 4 x 3s = 12s worst
 * case for one slow/hanging provider (observed 17.9s including the which/where
 * lookup). Cross-provider fan-out was already parallel, so the fix is entirely
 * inside the per-provider fallback chain (now parallel, priority-ordered) plus
 * a tightened per-probe timeout (3s -> 1.5s) and a concurrency cap on the
 * cross-provider spawn fan-out.
 *
 * This suite mocks child_process.exec so every version-probe command "hangs"
 * past the real spawn timeout (simulated via a controllable delay instead of
 * actually blocking for seconds), and asserts:
 *   1. all candidate commands for ONE provider are invoked essentially at once
 *      (parallel, not one-after-another with a wait between each), and
 *   2. detectCLIs' wall-clock for N slow providers stays close to ONE probe
 *      window, not N (or N x 4) probe windows — the worst-case bound this fix
 *      exists to guarantee.
 *   3. concurrent in-flight exec calls never exceed the documented cap.
 */

const mocks = vi.hoisted(() => ({
    execCalls: [] as { cmd: string; startedAt: number }[],
    inFlight: 0,
    maxInFlight: 0,
    execImpl: null as null | ((cmd: string, opts: any, cb: any) => any),
}));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        default: actual,
        exec: (cmd: string, opts: any, cb: any) => {
            mocks.execCalls.push({ cmd, startedAt: Date.now() });
            mocks.inFlight += 1;
            mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
            return mocks.execImpl
                ? mocks.execImpl(cmd, opts, (...args: any[]) => { mocks.inFlight -= 1; cb(...args); })
                : (() => { mocks.inFlight -= 1; cb(null, 'v1.0.0\n'); })();
        },
    };
});

const { detectCLIs } = await import('../../src/detection/cli-detector.js');

function makeStubLoader(entries: Array<{ id: string; command: string }>): ProviderLoader {
    return {
        getCliDetectionList() {
            return entries.map((e) => ({
                id: e.id,
                displayName: e.id,
                icon: '🔧',
                command: e.command,
                category: 'cli' as const,
                enabled: true,
            }));
        },
    } as unknown as ProviderLoader;
}

// Fake, always-"installed" absolute-path commands so resolveDetectionPath's
// isExplicitCommandPath short-circuit fires and existsSync must also pass —
// point at this test file itself (guaranteed to exist) as the "binary".
//
// MUST go through fileURLToPath, not raw `.pathname`: on win32 a file URL's
// `.pathname` keeps the leading slash before the drive letter
// ("/C:/Users/..."), which `path.isAbsolute` happily accepts but
// `fs.existsSync` never resolves — the explicit-path short-circuit in
// resolveCommandPath (src/detection/cli-detector.ts) then silently returns
// null, detectCLIs falls through to a `where` lookup for that literal
// (nonexistent) path, and the per-provider version-probe fan-out this suite
// exists to verify never fires at all (observed: 1 exec call instead of 3+ —
// the `where` fallback, not a version probe). fileURLToPath is the correct,
// platform-safe URL->path conversion and is a no-op on POSIX.
const FAKE_BIN = fileURLToPath(import.meta.url);

describe('detectCLIs intra-provider version-probe parallelism', () => {
    beforeEach(() => {
        mocks.execCalls = [];
        mocks.inFlight = 0;
        mocks.maxInFlight = 0;
        mocks.execImpl = null;
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fires all 3 built-in version-command candidates for one provider in parallel, not sequentially', async () => {
        // Simulate every version probe taking ~200ms (well above instant, but far
        // below the 1.5s per-probe timeout) so we can observe start-time skew.
        mocks.execImpl = (cmd, _opts, cb) => {
            const timer = setTimeout(() => cb(new Error('nonzero exit'), ''), 200);
            return { on: () => { }, unref: () => { }, kill: () => clearTimeout(timer) };
        };

        const loader = makeStubLoader([{ id: 'slow-cli', command: FAKE_BIN }]);
        await detectCLIs(loader, { includeVersion: true });

        // which/where resolution short-circuits via the explicit-path branch (no
        // exec call), so every recorded call here is a version-probe candidate.
        const versionCalls = mocks.execCalls.filter((c) => c.cmd.includes(FAKE_BIN));
        expect(versionCalls.length).toBeGreaterThanOrEqual(3); // --version, -V, -v

        // All candidates for the SAME provider must start within a tight window
        // of each other (parallel dispatch), not staggered by the 200ms probe
        // delay each (which would prove a sequential await-then-fire pattern).
        const starts = versionCalls.map((c) => c.startedAt);
        const skew = Math.max(...starts) - Math.min(...starts);
        expect(skew).toBeLessThan(150); // well under one 200ms probe window
    });

    it('bounds detectCLIs wall-clock for many slow providers to ~one probe window, not N x probe windows', async () => {
        const PROBE_DELAY_MS = 200;
        mocks.execImpl = (cmd, _opts, cb) => {
            const timer = setTimeout(() => cb(new Error('nonzero exit'), ''), PROBE_DELAY_MS);
            return { on: () => { }, unref: () => { }, kill: () => clearTimeout(timer) };
        };

        // 6 slow providers, each with 4 candidate version commands = 24 total
        // probes. The old sequential-per-provider code would take up to
        // 4 x PROBE_DELAY_MS per provider; even with providers run in parallel,
        // a regression to sequential-within-provider would show up as ~4x this
        // bound. The concurrency cap (8) does not bind here since 6 providers x
        // 4 candidates = 24 concurrent execs already exceeds it, so this also
        // exercises the queueing path.
        const entries = Array.from({ length: 6 }, (_, i) => ({
            id: `slow-cli-${i}`,
            command: FAKE_BIN,
        }));
        const loader = makeStubLoader(entries);

        const startedAt = Date.now();
        const results = await detectCLIs(loader, { includeVersion: true });
        const elapsedMs = Date.now() - startedAt;

        expect(results).toHaveLength(6);
        // Generous bound: well under N x 4 x PROBE_DELAY_MS (4800ms for the old
        // fully-sequential worst case), proving parallelism collapsed the total.
        expect(elapsedMs).toBeLessThan(PROBE_DELAY_MS * 4);
    });

    it('never exceeds the documented concurrency cap on simultaneously in-flight execs', async () => {
        mocks.execImpl = (cmd, _opts, cb) => {
            const timer = setTimeout(() => cb(new Error('nonzero exit'), ''), 50);
            return { on: () => { }, unref: () => { }, kill: () => clearTimeout(timer) };
        };

        const entries = Array.from({ length: 20 }, (_, i) => ({
            id: `cli-${i}`,
            command: FAKE_BIN,
        }));
        const loader = makeStubLoader(entries);
        await detectCLIs(loader, { includeVersion: true });

        // DETECT_CLIS_CONCURRENCY caps providers in flight, and each provider can
        // fire up to 4 version-probe execs concurrently, so the true ceiling on
        // simultaneous execs is concurrency x candidates-per-provider — assert it
        // stays bounded rather than growing with the full 20-provider x 4-probe
        // fan-out (80), which is what an unbounded Promise.all would allow.
        expect(mocks.maxInFlight).toBeLessThanOrEqual(8 * 4);
    });
});
