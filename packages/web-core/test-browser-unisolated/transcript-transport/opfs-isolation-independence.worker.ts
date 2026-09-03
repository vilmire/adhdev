// Test-only helper worker for `opfs-isolation-independence.browser.test.ts`.
//
// Reports the three facts that decide whether the transcript worker's storage
// engine forces `Cross-Origin-Embedder-Policy: require-corp` onto the whole
// hosting document, and — critically — actually EXERCISES the SAH pool VFS
// rather than just probing feature flags. A capability probe that never opens
// a database would keep passing if the VFS silently stopped working.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

export interface IsolationProbeResult {
    /** True only when the document sent COOP:same-origin + COEP:require-corp. */
    readonly crossOriginIsolated: boolean;
    /** Gated on cross-origin isolation; the SAH pool VFS must NOT depend on it. */
    readonly hasSharedArrayBuffer: boolean;
    /** Worker-scope-only API the SAH pool VFS genuinely needs. */
    readonly hasCreateSyncAccessHandle: boolean;
    /** Did `installOpfsSAHPoolVfs()` + a real write/read round-trip succeed? */
    readonly vfsUsable: boolean;
    readonly roundTrip?: readonly unknown[];
    readonly error?: string;
}

interface ProbeRequest {
    readonly directory: string;
    readonly dbFilename: string;
}

self.onmessage = async (ev: MessageEvent<ProbeRequest>) => {
    const { directory, dbFilename } = ev.data;
    const post = (self as unknown as { postMessage(data: unknown): void }).postMessage;
    const scope = self as unknown as { crossOriginIsolated?: boolean };

    const base = {
        crossOriginIsolated: scope.crossOriginIsolated === true,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        hasCreateSyncAccessHandle:
            typeof (FileSystemFileHandle as unknown as { prototype?: Record<string, unknown> })?.prototype
                ?.createSyncAccessHandle === 'function',
    };

    try {
        const sqlite3 = await sqlite3InitModule();
        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ directory, clearOnInit: true });
        const db = new poolUtil.OpfsSAHPoolDb(dbFilename);
        try {
            db.exec('CREATE TABLE isolation_probe(v INTEGER)');
            db.exec('INSERT INTO isolation_probe VALUES(42)');
            const roundTrip = db.selectValues('SELECT v FROM isolation_probe');
            post({ ...base, vfsUsable: true, roundTrip } satisfies IsolationProbeResult);
        } finally {
            db.close();
            await poolUtil.removeVfs();
        }
    } catch (err) {
        post({
            ...base,
            vfsUsable: false,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        } satisfies IsolationProbeResult);
    }
};
