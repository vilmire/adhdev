/**
 * Live 2026-11-08: a codex-cli command approval whose option 2 ("Yes, and don't ask again for commands
 * that start with `<cmd>`") wrapped over eight rows was never seen as a live modal — the choice-block
 * grouping allowed at most three continuation rows, so 1./2./3. fell apart, the approval transition read
 * an empty modal section, and the worker sat "idle" at the prompt for 40+ minutes (mesh_approve refused:
 * not in approval state). Uses the captured screen (paths anonymized).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { resolveLiveModalSlice } from '../../../src/providers/spec/fsm-driver-modal.js';
import type { PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions } from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(HERE, '../../../../../../adhdev-providers/cli/codex-cli/specs/4.0.json');
const maybe = fs.existsSync(SPEC) ? describe : describe.skip;

const SCREEN: string[] = [
    "• Running python3 -c 'import subprocess; commands=[[\"/Users/dev/Work/p…",
    "    + Show details",
    "",
    "",
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  Reason: rerun the same build's runtime tests 4 threads at a time, five times, to",
    "  check the env race does not come back?",
    "",
    "  $ python3 -c 'import subprocess;",
    "  commands=[[\"/Users/dev/Work/project/target/debug/deps/proj_co",
    "  re-e105fc9541f163c9\",\"runtime::tests::\",\"--test-threads=4\"]]*5;",
    "  results=[subprocess.run(c, capture_output=True, text=True) for c in",
    "  commands]; [print(\"repeat\",i+1,\"exit\",r.returncode,r.stdout.split(\"test",
    "  result:\")[-1].strip()) for i,r in enumerate(results)]; raise",
    "  SystemExit(any(r.returncode for r in results))'",
    "",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `python3 -c 'import",
    "     subprocess; commands=[[\"/Users/dev/Work/project/target/debug/",
    "     deps/proj_core-e105fc9541f163c9\",\"runtime::tests::\",\"--test-",
    "     threads=4\"]]*5; results=[subprocess.run(c, capture_output=True, text=True)",
    "     for c in commands];",
    "     [print(\"repeat\",i+1,\"exit\",r.returncode,r.stdout.split(\"test result:\")",
    "     [-1].strip()) for i,r in enumerate(results)]; raise",
    "     SystemExit(any(r.returncode for r in results))'` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel"
];

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4711;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { /* no-op */ }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(): void { /* no-op */ }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}
class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport { this.last = new DrivablePty(); return this.last; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('resolveLiveModalSlice — wrapped long option', () => {
    it('keeps 1./2./3. in one live modal when option 2 wraps over many indented rows', () => {
        const slice = resolveLiveModalSlice(SCREEN, { row: SCREEN.length - 1, col: 0 });
        expect(slice.hasLiveModal).toBe(true);
        expect(slice.screen).toContain('1. Yes, proceed (y)');
        expect(slice.screen).toContain('3. No, and tell Codex what to do differently');
    });
});

maybe('FsmDriver — codex approval with a wrapped long option', () => {
    it('enters approval from a reattach-style first paint of the prompt', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({ specPath: SPEC, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory, cols: 80, rows: 32 } as any);
        driver.start();
        factory.last!.feed(`\x1b[2J\x1b[H${SCREEN.join('\r\n')}\x1b[${SCREEN.length};1H`);
        await sleep(2500);
        expect((driver as any).currentStateId).toBe('approval');
        driver.stop?.();
    }, 15000);
});
