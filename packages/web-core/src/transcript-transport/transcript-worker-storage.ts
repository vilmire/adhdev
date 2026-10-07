/**
 * Storage for the transcript worker's seqscribe node: the OPFS SAH pool when
 * this worker can own it, an in-memory database when it cannot.
 *
 * ── Why a fallback is required, not optional ───────────────────────────────
 * The OPFS SyncAccessHandle pool VFS is EXCLUSIVE: it takes a sync access
 * handle on every file in its directory, and the browser refuses a second one
 * (`NoModificationAllowedError: Access Handles cannot be created if there is
 * another open Access Handle…`). The directory is keyed per origin (standalone:
 * one fixed writer id) or per daemon (cloud), so a SECOND TAB of the same
 * dashboard — or a fresh worker started while a previous one has not released
 * its handles yet — cannot install the pool. Before this module the entry
 * awaited the install inside `node.open()` with no fallback: the rejection was
 * unhandled, the node never attached, no seqscribe HELLO reached the daemon
 * (`standalone replica lane closed … reason=hello_timeout`), the lane
 * reconnect-looped forever and every chat pane in that tab stayed empty — the
 * keyed lane is the dashboard's only live chat path.
 *
 * ── Why in-memory is a correct replica, not a degraded one ──────────────────
 * The worker never resumes from what it persisted: every host is a fresh
 * attach, and every session subscription is a `view:'tail'` SUB with no
 * `fromCursor`, answered by a reset SNAP carrying the whole committed live set
 * (see `transcript-session-subscription.ts`). OPFS only spares a re-download
 * of bookkeeping; the view the pane renders is identical either way.
 *
 * Kept out of `transcript-worker-entry.ts` (a real worker global, untestable
 * under node) so the fallback runs under `npm run test:web-core` against the
 * real sqlite-wasm engine.
 */
import { sqliteWasmHandle, type SqliteWasmDbLike } from 'seqscribe';
import type { TranscriptWorkerStorage } from './transcript-worker-node.js';

interface ClosableDb {
    close(): void;
}

/** The slice of the `@sqlite.org/sqlite-wasm` module this needs. */
export interface TranscriptSqliteModuleLike {
    installOpfsSAHPoolVfs(options: { directory: string; clearOnInit: boolean }): Promise<{
        OpfsSAHPoolDb: new (filename: string) => ClosableDb;
    }>;
    readonly oo1: { DB: new (filename: string) => ClosableDb };
}

export interface OpenedTranscriptWorkerStorage extends TranscriptWorkerStorage {
    /** `opfs` = persisted in the SAH pool; `memory` = the pool was unavailable. */
    readonly kind: 'opfs' | 'memory';
    /** Why the pool could not be used (only when `kind === 'memory'`). */
    readonly opfsError?: unknown;
}

function wrap(db: ClosableDb, kind: OpenedTranscriptWorkerStorage['kind'], opfsError?: unknown): OpenedTranscriptWorkerStorage {
    return {
        kind,
        ...(opfsError !== undefined ? { opfsError } : {}),
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose(): void {
            db.close();
        },
    };
}

export async function openTranscriptWorkerStorage(
    sqlite3: TranscriptSqliteModuleLike,
    options: { readonly directory: string; readonly filename: string },
): Promise<OpenedTranscriptWorkerStorage> {
    let pooled: ClosableDb;
    try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: options.directory, clearOnInit: false });
        pooled = new pool.OpfsSAHPoolDb(options.filename);
    } catch (error) {
        return wrap(new sqlite3.oo1.DB(':memory:'), 'memory', error);
    }
    return wrap(pooled, 'opfs');
}
