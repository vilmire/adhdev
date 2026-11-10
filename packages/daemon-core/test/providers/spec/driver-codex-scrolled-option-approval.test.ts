/**
 * Live 2026-11-09 (codex-cli 1.1.42): a command approval whose option 2 wraps over ~10 rows is rendered
 * SCROLLED — codex shows a lone `↓` indicator row after the visible options (option 3 is below the fold)
 * and then the "Press enter to confirm or esc to cancel" footer. The `↓` row (column 0, not indented) ended
 * the wrapped option and was neither footer nor chrome, so the modal slice ended above the last screen row,
 * the block was never a live modal, and the worker sat "idle" at the prompt (mesh_approve: not in approval
 * state). Uses the captured screen shape (command and reason anonymized).
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
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  Reason: re-check that every remote ref still contains the original commit",
    "  by reading local object ancestry?",
    "",
    "  $ python3 -c 'import subprocess;",
    "  refs=subprocess.check_output([\"git\",\"ls-remote\",\"origin\"],text=True).splitli",
    "  nes(); ids=set(x.split()[0] for x in refs); missing=[x for x in ids if",
    "  subprocess.run([\"git\",\"cat-file\",\"-e\",x+\"^{commit}\"],capture_output=True).re",
    "  turncode]; containing=[x for x in ids if x not in missing and",
    "  subprocess.run([\"git\",\"merge-base\",\"--is-ancestor\",\"0123456789abcdef0123456789abcdef01234567\",x],capture_output=True).returncode==0];",
    "  print({\"remote_unique_tips\":len(ids),\"missing_objects\":missing}); assert not missing'",
    "",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `python3 -c 'import",
    "     subprocess; refs=subprocess.check_output([\"git\",\"ls-",
    "     remote\",\"origin\"],text=True).splitlines(); ids=set(x.split()[0] for x in",
    "     refs); missing=[x for x in ids if subprocess.run([\"git\",\"cat-",
    "     file\",\"-e\",x+\"''^{commit}\"],capture_output=True).returncode]; containing=[x",
    "     for x in ids if x not in missing and subprocess.run([\"git\",\"merge-",
    "     base\",\"--is-",
    "     ancestor\",\"0123456789abcdef0123456789abcdef01234567\",x],capture_output=True",
    "     ).returncode==0];",
    "     print({\"remote_unique_tips\":len(ids),\"missing_objects\":missing,\"containing_",
    "↓",
    "  Press enter to confirm or esc to cancel",
];

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4712;
    readonly ready = Promise.resolve();
    writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    write(d: string): void { this.writes.push(d); }
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

describe('resolveLiveModalSlice — scrolled option list with a `↓` indicator row', () => {
    it('treats the lone scroll indicator as part of the list, keeping the modal live', () => {
        const slice = resolveLiveModalSlice(SCREEN, { row: SCREEN.length - 1, col: 0 });
        expect(slice.hasLiveModal).toBe(true);
        expect(slice.screen).toContain('1. Yes, proceed (y)');
        expect(slice.screen).toContain('Press enter to confirm or esc to cancel');
    });
});

maybe('FsmDriver — codex approval with a scrolled option list', () => {
    it('enters approval, exposes the buttons and presses option 1 on approve', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({ specPath: SPEC, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory, cols: 80, rows: 32 } as any);
        driver.start();
        factory.last!.feed(`\x1b[2J\x1b[H${SCREEN.join('\r\n')}\x1b[${SCREEN.length};1H`);
        await sleep(2500);
        expect((driver as any).currentStateId).toBe('approval');
        const modal = (driver as any).currentEval?.modal;
        const buttons: string[] = (modal?.buttons ?? []).map((b: any) => String(b?.label ?? b));
        expect(buttons.join('|')).toContain('Yes, proceed');
        // Option 1 is the one-time approval; its press must reach the PTY as the choice key / Enter.
        expect(buttons[0]).toContain('Yes, proceed');
        factory.last!.writes.length = 0;
        expect(driver.clickModalButton(1)).toBe(true);
        await sleep(600);
        expect(factory.last!.writes.join('')).toBe('1\r');
        driver.stop?.();
    }, 15000);
});
