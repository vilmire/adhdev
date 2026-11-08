/**
 * A provider channel activation installs the new version under a NEW path, which the per-path
 * hot-reload watcher never sees, so running sessions kept the spec they launched with (live
 * 2026-11-08). switchSpecPath lets a running FSM pick the activated spec up; it refuses (keeps the
 * old spec) when the new file is invalid, and a same-path call is a no-op.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type { PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions } from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS = path.resolve(HERE, '../../../../../../adhdev-providers');
const NEW_SPEC = path.join(PROVIDERS, 'cli/codex-cli/specs/4.0.json');
const available = fs.existsSync(NEW_SPEC);
const maybe = available ? describe : describe.skip;

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
maybe('FsmDriver.switchSpecPath', () => {
    it('keeps the current spec when the new file is invalid', () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({ specPath: NEW_SPEC, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory });
        driver.start();
        const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bad-spec-')), 'x.json');
        fs.writeFileSync(bad, '{"not":"a spec"}');
        expect(driver.switchSpecPath(bad)).toBe(false);
        expect(driver.switchSpecPath(NEW_SPEC)).toBe(false); // same path: no-op
        driver.stop?.();
    });
});
