/**
 * Daemon shutdown/restart must DETACH hosted CLI runtimes, not stop them.
 *
 * CliManager.detachAll() calls `adapter.detach()` when it exists and falls
 * back to `adapter.shutdown()` — which ends the runtime (session-host
 * `stop_session`). The legacy ProviderCliAdapter had detach(); the spec
 * adapter that replaced it (2026-08-17) did not, so from then on every daemon
 * restart — `adhdev update`, a dev-server rebuild — killed every running CLI,
 * and restoreHostedSessions found nothing to re-attach (2026-10-02, a
 * session-host tombstone with requestedStop:"stop" on a plain restart).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(
    HERE, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json',
);
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip;

class HostedPty implements PtyRuntimeTransport {
    readonly pid = 4712;
    readonly ready = Promise.resolve();
    killed = 0;
    detached = 0;
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { this.killed += 1; }
    detach(): void { this.detached += 1; }
    onData(): void { /* no-op */ }
    onExit(): void { /* no-op */ }
}

class HostedFactory implements PtyTransportFactory {
    last: HostedPty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new HostedPty();
        return this.last;
    }
}

function startDriver() {
    const factory = new HostedFactory();
    const driver = new FsmDriver({
        specPath: SPEC_PATH,
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    return { driver, pty: factory.last! };
}

maybe('FsmDriver.detach — the runtime outlives the daemon', () => {
    it('detach() releases the transport and never stops it', () => {
        const { driver, pty } = startDriver();
        driver.detach();
        expect(pty.detached).toBe(1);
        expect(pty.killed).toBe(0);
    });

    it('shutdown() still stops it (explicit stop / session end)', () => {
        const { driver, pty } = startDriver();
        driver.shutdown();
        expect(pty.killed).toBe(1);
        expect(pty.detached).toBe(0);
    });
});

describe('SpecCliAdapter exposes detach() for CliManager.detachAll()', () => {
    it('has a detach method, so detachAll does not fall back to shutdown()', () => {
        expect(typeof (SpecCliAdapter.prototype as { detach?: unknown }).detach).toBe('function');
    });
});
