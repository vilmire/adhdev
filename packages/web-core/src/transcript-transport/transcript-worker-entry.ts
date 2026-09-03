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
import { sqliteWasmHandle, type PeerHandle, type SqliteWasmDbLike } from 'seqscribe';
import { browserRejectAuthority } from './browser-reject-authority.js';
import { workerPortChannel } from './message-port-channel.js';
import { TranscriptWorkerNode, type TranscriptWorkerStorage } from './transcript-worker-node.js';
import { runTranscriptWorkerSession, type TranscriptWorkerSessionPort } from './transcript-worker-session.js';

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

/**
 * Local label for the single peer on this channel — the daemon that dialed it.
 * Peer ids are per-node bookkeeping, not a wire identity, so a fixed label is
 * correct here: this channel is 1:1 with one daemon for its whole lifetime.
 */
const DAEMON_PEER_ID = 'daemon';

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
    const snapshotPort = ev.ports?.[1];
    if (!port || !snapshotPort) return;
    const init = ev.data as { sessionKey?: unknown; writerId?: unknown } | null;
    const sessionKey = typeof init?.sessionKey === 'string' ? init.sessionKey : null;
    const writerId = typeof init?.writerId === 'string' ? init.writerId : null;
    if (!sessionKey || !writerId || activeNode) return;

    const node = new TranscriptWorkerNode({
        writerId,
        openStorage: () => openOpfsStorage(sessionKey, writerId),
        // Satisfies seqscribe's `finalityAuthority` presence gate without any
        // key material, and arms the ring-only interlock. See
        // `browser-reject-authority.ts` — this is what lets a browser define a
        // content-class transcript topic with no fleet secret.
        authority: browserRejectAuthority,
    });
    activeNode = node;

    void node.open().then(() => {
        const { channel, onControl } = workerPortChannel(port);

        // The daemon is the only peer on this channel, and it SERVES the
        // transcript topics; this node only subscribes, so it grants nothing
        // back. Grants are per-topic and the daemon's own grant map (narrowed
        // by `declareSessionInterest`) is what actually authorizes the read.
        let peer: PeerHandle | null = node.attach(channel, {
            peerId: DAEMON_PEER_ID,
            peerClass: 'content',
            grants: {},
        });

        const session = runTranscriptWorkerSession({
            node,
            port: snapshotPort as unknown as TranscriptWorkerSessionPort,
            currentPeer: () => peer,
        });

        onControl((event) => {
            // `transport_closed`/`queue_overflow` already closed the channel
            // (`message-port-channel.ts`), so the peer and every subscription
            // on it are dead. Drop them and let the next attach rebuild from
            // the retained activation set — never resume across a gap that may
            // have dropped bytes (§3.6 criterion 4).
            if (event.event === 'transport_open') return;
            peer = null;
            session.detach();
        });
    });
};
