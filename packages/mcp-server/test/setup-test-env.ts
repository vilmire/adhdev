/**
 * Per-process test-env isolation, --import'ed by the npm test script. node --test
 * spawns each test file in its own child process with the parent's execArgv, so this
 * module runs once per test process BEFORE any test code loads.
 *
 * Why: daemon-core resolves every mesh store path (mesh-ledger JSONL, the
 * mesh-runtime.db SQLite store, pending-events, work queues) under getConfigDir(),
 * which defaults to the REAL ~/.adhdev. Running this suite against that dir
 * (a) littered the live coordinator's ~/.adhdev/mesh-ledger with thousands of
 * test-mesh files, and (b) contended on the live daemon's mesh-runtime.db WAL lock:
 * ~30 parallel test processes plus the running daemon share one busy_timeout=5000ms
 * database, so timing-sensitive tests blew their deadlines and writers threw
 * SQLITE_BUSY (mesh-status-missions-compact).
 *
 * mkdtemp per PROCESS (not one shared fixed dir): a unique dir per test process
 * removes cross-file DB contention entirely. Unconditional on purpose — the parent
 * runner process's value is inherited via env by the children and must not suppress
 * their own per-process isolation.
 *
 * Defense in depth: daemon-core resolveConfigDir() now also refuses (a) an unset
 * pin under NODE_TEST_CONTEXT (`node --test` does not set VITEST) and (b) a pin
 * that resolves to the live ~/.adhdev or ~/.adhdev-preview home. Forgetting this
 * --import used to silently write mesh_adopt_* / sess-coord graphs into the live
 * mesh-runtime.db. That is now a loud throw, not a filter the coordinator has
 * to remember.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedConfigDir = mkdtempSync(join(tmpdir(), 'adhdev-mcp-test-'));
process.env.ADHDEV_CONFIG_DIR = isolatedConfigDir;

process.on('exit', () => {
    try {
        rmSync(isolatedConfigDir, { recursive: true, force: true });
    } catch {
        /* best-effort cleanup */
    }
});

// The suite's fake coordinator daemons answer mesh_status_view / mesh_dispatch_route
// with daemon-core's real composer / routing rule (helpers/fake-coordinator-tool-answers.ts):
// `transport.command = fn` on an IpcTransport / LocalTransport installs `fn` wrapped.
{
    // require (not import): loaded AFTER the config-dir pin above; this file compiles to CJS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { IpcTransport } = require('../src/transports/ipc.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalTransport } = require('../src/transports/local.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withFakeCoordinatorToolAnswers } = require('./helpers/fake-coordinator-tool-answers.js');
    for (const Transport of [IpcTransport, LocalTransport] as any[]) {
        const original = Transport.prototype.command;
        const slot = Symbol('fakeCoordinatorCommand');
        Object.defineProperty(Transport.prototype, 'command', {
            configurable: true,
            get() { return this[slot] ?? original; },
            set(fn: any) { this[slot] = typeof fn === 'function' ? withFakeCoordinatorToolAnswers(fn, this) : fn; },
        });
    }
}
