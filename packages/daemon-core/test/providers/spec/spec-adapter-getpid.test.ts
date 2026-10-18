/**
 * The worker background-work guard walks the OS process tree from the session's
 * PTY PID. `CliProviderInstance.adapter` is a SpecCliAdapter, which owns a
 * FsmDriver, which owns the TerminalAdapter, which owns the PTY transport — and
 * `getPid()` used to exist only on the innermost TerminalAdapter, so
 * `extractSessionPtyPid(instance)` found nothing in production and the whole
 * guard silently never saw a process (its unit tests stubbed `adapter.getPid`).
 * This pins the real chain end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    PtyRuntimeExitInfo,
    PtyRuntimeTransport,
    PtySpawnOptions,
    PtyTransportFactory,
} from '../../../src/cli-adapters/pty-transport.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { extractSessionPtyPid } from '../../../src/process/session-process-tree.js';

class FakePty implements PtyRuntimeTransport {
    readonly ready = Promise.resolve();
    private exitCb: ((info: PtyRuntimeExitInfo) => void) | null = null;
    constructor(public pid: number) {}
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 } as PtyRuntimeExitInfo); }
    onData(): void { /* no-op */ }
    onExit(cb: (info: PtyRuntimeExitInfo) => void): void { this.exitCb = cb; }
}

class FakeFactory implements PtyTransportFactory {
    readonly attachesExistingRuntime = false;
    last: FakePty | null = null;
    constructor(private readonly pid: number) {}
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new FakePty(this.pid);
        return this.last;
    }
}

const SPEC = {
    $schema: 'adhdev:cli/spec@4',
    id: 'test.getpid',
    name: 'getpid test',
    binary: '/bin/true',
    send_message: { submit_key: '\r' },
    sections: { footer: { from_bottom: 1 } },
    states: [{ id: 'idle', label: 'Ready', initial: true, status: 'idle' }],
    transitions: [],
};

const tmpDirs: string[] = [];
const adapters: SpecCliAdapter[] = [];
afterEach(() => {
    while (adapters.length) { try { adapters.pop()!.shutdown(); } catch { /* ignore */ } }
    while (tmpDirs.length) { try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function spawnWithPid(pid: number): { adapter: SpecCliAdapter; pty: FakePty } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getpid-'));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(SPEC));
    const factory = new FakeFactory(pid);
    const adapter = new SpecCliAdapter(specPath, '/tmp/project', [], {}, factory, `sess_getpid_${pid}`);
    adapters.push(adapter);
    void adapter.spawn();
    return { adapter, pty: factory.last! };
}

describe('PTY PID reaches the instance through the real adapter chain', () => {
    it('SpecCliAdapter.getPid() returns the transport PID, and extractSessionPtyPid finds it on an instance-shaped object', () => {
        const { adapter } = spawnWithPid(4242);
        expect(adapter.getPid()).toBe(4242);
        // CliProviderInstance exposes the adapter as `.adapter`; the guard's callers hand the instance.
        expect(extractSessionPtyPid({ adapter })).toBe(4242);
    });

    it('a session-host transport reports pid 0 until `session_started` arrives: that is UNKNOWN, not a PID to walk', () => {
        const { adapter } = spawnWithPid(0);
        expect(adapter.getPid()).toBeUndefined();
        expect(extractSessionPtyPid({ adapter })).toBeUndefined();
    });

    it('the PID follows the transport (a session-host re-attach / resume updates it) and disappears when the PTY ends', () => {
        const { adapter, pty } = spawnWithPid(5000);
        expect(adapter.getPid()).toBe(5000);
        pty.pid = 5001; // SessionHostRuntimeTransport.currentPid is replaced by session_resumed
        expect(adapter.getPid()).toBe(5001);
        pty.kill();
        expect(adapter.getPid()).toBeUndefined();
    });
});
