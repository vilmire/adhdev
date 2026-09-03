/**
 * Regression: FsmDriver.getSections() must slice the screen the CALLER already
 * holds, not take its own second snapshot.
 *
 * The debug surface (`spec_debug` → SpecCliAdapter.getDebugSnapshot) reports a
 * `screen` and a `sections` map side by side. Both used to call
 * `adapter.snapshot()` independently, so on a live, actively-repainting TUI the
 * two reads landed on DIFFERENT frames and the reported sections did not come
 * from the reported screen.
 *
 * That is what produced the "antigravity screen fragmentation" report: a screen
 * whose first line was wrapped at one terminal width (`⣻  Running comman`, only
 * reachable at cols=17) reported together with a `footer` of `            ommand`
 * (only reachable at cols>=18) — a pair no single VT buffer can hold, because
 * ghostty reflows the whole buffer on resize. The screen was never fragmented;
 * the debug READ was torn across two frames.
 *
 * The guard drives the real FsmDriver + ghostty pipeline and repaints between
 * the two reads. With the fix, sections sliced from the caller's screen still
 * describe that screen. Reverting the fix (dropping the `screenText` argument so
 * getSections re-snapshots) makes the `footer`/`body` assertions fail.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4246;
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
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

function specPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, '../../../../../..', 'adhdev-providers/cli/antigravity-cli/specs/4.0.json');
    if (!fs.existsSync(p)) throw new Error('antigravity-cli 4.0.json not found at ' + p);
    return p;
}

describe('FsmDriver.getSections frame consistency', () => {
    it('slices the caller-supplied screen, not a later repaint', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: specPath(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Frame A — what the caller captures.
            pty.feed('\x1b[2J\x1b[1;1H⣻  Running command FRAME-A\x1b[30;1HFOOTER-A');
            await new Promise(r => setTimeout(r, 50));
            const screen = driver.snapshot();
            expect(screen).toContain('FRAME-A');
            expect(screen).toContain('FOOTER-A');

            // The TUI repaints before the sections are resolved. Without the
            // fix, getSections() would snapshot THIS frame instead.
            pty.feed('\x1b[2J\x1b[1;1H⣾  Running command FRAME-B\x1b[30;1HFOOTER-B');
            await new Promise(r => setTimeout(r, 50));
            expect(driver.snapshot()).toContain('FRAME-B');

            const sections = driver.getSections(screen);
            expect(sections).not.toBeNull();
            const byId = Object.fromEntries(sections!.map(s => [s.id, s.text]));

            // Sections must describe frame A — the screen the caller holds.
            expect(byId.footer).toContain('FOOTER-A');
            expect(byId.footer).not.toContain('FOOTER-B');
            expect(byId.body).toContain('FRAME-A');
            expect(byId.body).not.toContain('FRAME-B');

            // body=from_top:0 is the whole screen: it must not starve on a
            // short screen (the failure the spec's _sections_note fixed).
            expect(byId.body.split('\n').length).toBe(screen.split('\n').length);
        } finally {
            driver.stop?.();
        }
    });

    it('still self-snapshots when no screen is supplied', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: specPath(),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed('\x1b[2J\x1b[1;1HSOLO-FRAME\x1b[30;1HSOLO-FOOTER');
            await new Promise(r => setTimeout(r, 50));
            const sections = driver.getSections();
            expect(sections).not.toBeNull();
            const byId = Object.fromEntries(sections!.map(s => [s.id, s.text]));
            expect(byId.body).toContain('SOLO-FRAME');
            expect(byId.footer).toContain('SOLO-FOOTER');
        } finally {
            driver.stop?.();
        }
    });
});
