// Test-only helper worker: independently reopens an OPFS SAH pool directory
// that `transcript-worker-entry.ts` (running in ITS OWN worker) just wrote
// to, and reports back real sqlite content. `createSyncAccessHandle` only
// exists inside a worker global scope, so this verification cannot run on
// the main thread — see the OPFS-mode investigation notes in
// `transcript-worker-entry.browser.test.ts`.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

interface VerifyRequest {
    readonly directory: string;
    readonly dbFilename: string;
}

self.onmessage = async (ev: MessageEvent<VerifyRequest>) => {
    const { directory, dbFilename } = ev.data;
    const post = (self as unknown as { postMessage(data: unknown): void }).postMessage;
    try {
        const sqlite3 = await sqlite3InitModule();
        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ directory, clearOnInit: false });
        const db = new poolUtil.OpfsSAHPoolDb(dbFilename);
        try {
            const tables = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'");
            post({ tables });
        } finally {
            db.close();
            await poolUtil.removeVfs();
        }
    } catch (err) {
        post({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
};
