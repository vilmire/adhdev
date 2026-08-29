/**
 * Real browser Worker global-scope entry point (design §3.6). Intentionally
 * thin: it wires the browser's actual sqlite-wasm/OPFS engine and the real
 * dedicated-worker global to `TranscriptWorkerNode` + `workerPortChannel`,
 * both of which are unit-tested elsewhere against the SAME `sqliteWasmHandle`
 * adapter over an in-memory `oo1.DB` (`test/transcript-transport/
 * transcript-worker-node.test.ts`).
 *
 * This file itself is NOT unit-testable: OPFS and a real dedicated-worker
 * global scope require a browser, and this repo has no Chromium test harness
 * yet — design §6.6 calls that out as separate, later infrastructure, not a
 * gate on this foundation commit. It is typechecked (`tsc -b`) but not
 * exercised by `npm test`.
 *
 * `self` is typed loosely and cast rather than switching this package's
 * `tsconfig` `lib` to `webworker` — that option is project-wide, and every
 * other web-core file needs the `dom` lib (Window-typed globals); `dom` and
 * `webworker` declare incompatible globals and cannot coexist in one
 * tsconfig.
 *
 * Loaded via `new Worker(new URL('./transcript-worker-entry.js', import.meta.url), { type: 'module' })`
 * by the (not-yet-built, consumer-cutover) code that owns the real transport.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { sqliteWasmHandle, type SqliteWasmDbLike } from 'seqscribe';
import { workerPortChannel } from './message-port-channel.js';
import { TranscriptWorkerNode, type TranscriptWorkerStorage } from './transcript-worker-node.js';

interface DedicatedWorkerScope {
    onmessage: ((ev: { data: unknown; ports?: readonly MessagePort[] }) => void) | null;
    postMessage(data: unknown): void;
}

const scope = sqliteWorkerScope();

function sqliteWorkerScope(): DedicatedWorkerScope {
    // the one sanctioned cast; see file header
    return self as unknown as DedicatedWorkerScope;
}

/** Directory root under OPFS for transcript replica databases (per-session file below it). */
const OPFS_DIRECTORY = '.adhdev-transcript';

async function openOpfsStorage(sessionKey: string, writerId: string): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule();
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
        directory: `${OPFS_DIRECTORY}/${writerId}`,
        clearOnInit: false,
    });
    const db = new poolUtil.OpfsSAHPoolDb(`${sessionKey}.sqlite3`);
    return {
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose(): void {
            db.close();
        },
    };
}

/**
 * One worker instance handles one session's transcript node for its whole
 * lifetime — `open()` is called once, in response to the first port the main
 * thread transfers in. Re-attaching after a real-transport reset (§3.6
 * criterion 4) reuses this same node/port; it does not reopen storage.
 */
let activeNode: TranscriptWorkerNode | null = null;

scope.onmessage = (ev) => {
    const port = ev.ports?.[0];
    if (!port) return;
    const init = ev.data as { sessionKey?: unknown; writerId?: unknown } | null;
    const sessionKey = typeof init?.sessionKey === 'string' ? init.sessionKey : null;
    const writerId = typeof init?.writerId === 'string' ? init.writerId : null;
    if (!sessionKey || !writerId || activeNode) return;

    const node = new TranscriptWorkerNode({
        writerId,
        openStorage: () => openOpfsStorage(sessionKey, writerId),
    });
    activeNode = node;

    void node.open().then(() => {
        const { onControl } = workerPortChannel(port);
        onControl((event) => {
            // A reset control event already closed the channel
            // (`message-port-channel.ts`); this worker's job for the
            // transport foundation is just to observe that transition —
            // topic activation / re-attach on reset is consumer-cutover
            // territory (§8 units 5+).
            void event;
        });
    });
};
