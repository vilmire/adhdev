/**
 * Live 2026-11-11: a codex-cli command approval was on screen, the FSM was already in `approval`,
 * but codex had left the terminal cursor up in the transcript (row 2 of a 32-row screen, the dialog
 * at rows 8-31). The live-modal slice requires the cursor on/next to the dialog, so no modal was
 * derived, the session was projected `generating`, and the worker sat at the prompt for 40+ minutes
 * with nobody told. Uses the captured screen (content anonymized, shape kept).
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
    "› Owner approved the incremental cache cleanup; free space is now about 4.6GiB, continue…",
    "  └ (no output)",
    "    + Show details",
    "",
    "• Running python3 -c 'import subprocess; s=subprocess.check_output([\"ps\",\"-axo\"…",
    "    + Show details",
    "",
    "",
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  Reason: after the normal instance stop, check the exact PID of this shell guard",
    "  — allow it?",
    "",
    "  $ python3 -c 'import subprocess;",
    "  s=subprocess.check_output([\"ps\",\"-axo\",\"pid=,ppid=,pgid=,args=\"],text=True);",
    "  print(\"\\n\".join(l for l in s.splitlines() if \"validation-guard.py -- python3",
    "  .validation/run-1/live.py shell\" in l and \"python3",
    "  -c\" not in l))'",
    "",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `python3 -c \"import",
    "     subprocess; s=subprocess.check_output([\\\"ps\\\",\\\"-axo\\\",",
    "     \\\"pid=,ppid=,pgid=,args=\\\"],text=True); print(\\\"\\\\n\\\".join(l for l in",
    "     s.splitlines() if \\\"validation-guard.py -- python3 .validation/run-1/",
    "     live.py shell\\\" in l and \\\"python3 -c\\\" not in",
    "     l))\"` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
];
const PARKED_CURSOR = { row: 2, col: 29 };

describe('resolveLiveModalSlice — codex cursor parked above the dialog', () => {
    it('treats the dialog as live although the cursor sits rows above it', () => {
        const slice = resolveLiveModalSlice(SCREEN, PARKED_CURSOR);
        expect(slice.hasLiveModal).toBe(true);
        expect(slice.screen).toContain('Would you like to run the following command?');
        expect(slice.screen).toContain('3. No, and tell Codex what to do differently');
        expect(slice.screen).toContain('Press enter to confirm or esc to cancel');
    });

    it('still rejects the same dialog when the composer is below it (quoted in the transcript)', () => {
        const quoted = [...SCREEN, '', '› ', '  tab to queue message  ·  ⏎ send'];
        expect(resolveLiveModalSlice(quoted, PARKED_CURSOR).hasLiveModal).toBe(false);
    });

    it('still rejects a footer-ended numbered list with no codex dialog header', () => {
        const headerless = SCREEN.map(l => (l.includes('Would you like to run') ? '  Here is the plan:' : l));
        expect(resolveLiveModalSlice(headerless, PARKED_CURSOR).hasLiveModal).toBe(false);
    });

    it('still rejects when an assistant bullet sits between the header and the choices', () => {
        const withBullet = [...SCREEN];
        withBullet.splice(14, 0, '• Explored the workspace');
        expect(resolveLiveModalSlice(withBullet, PARKED_CURSOR).hasLiveModal).toBe(false);
    });
});

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4712;
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

maybe('FsmDriver — codex approval with the cursor parked above it', () => {
    it('surfaces the approval modal with its three buttons', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({ specPath: SPEC, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory, cols: 80, rows: 32 } as any);
        driver.start();
        // Paint the dialog, then park the cursor on row 3 (1-based) — inside the transcript.
        factory.last!.feed(`\x1b[2J\x1b[H${SCREEN.join('\r\n')}\x1b[${PARKED_CURSOR.row + 1};${PARKED_CURSOR.col + 1}H`);
        await sleep(2500);
        expect((driver as any).currentStateId).toBe('approval');
        const modal = (driver as any).currentEval?.modal;
        expect(modal?.buttons?.map((b: any) => b.label ?? b)).toHaveLength(3);
        driver.stop?.();
    });
});
