// Real-browser counterpart to `test/transcript-transport/transcript-worker-node.test.ts`
// (design §3.6, §8 unit 4). That suite exercises `TranscriptWorkerNode` against
// an in-memory `oo1.DB`, deliberately bypassing OPFS — its own header calls out
// OPFS persistence as "browser-only and untestable" without a Chromium harness.
// This file is that harness: it instantiates the REAL `transcript-worker-entry.ts`
// as a dedicated Worker (the same `new Worker(new URL(...))` construction the
// eventual consumer-cutover code uses), hands it a real transferred MessagePort,
// and confirms `installOpfsSAHPoolVfs()` actually persists to OPFS — not a mock,
// not an in-memory stand-in.
import { describe, expect, it } from 'vitest';

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
    const start = performance.now();
    for (;;) {
        if (await cond()) return;
        if (performance.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('transcript-worker-entry.ts (real dedicated Worker + OPFS)', () => {
    it('opens a real dedicated worker, wires a transferred MessagePort, and persists to OPFS', async () => {
        const writerId = `adhdev_browser_test_${Math.random().toString(36).slice(2)}`;
        const sessionKey = 'browser-smoke-session';

        const worker = new Worker(new URL('../../src/transcript-transport/transcript-worker-entry.ts', import.meta.url), {
            type: 'module',
        });

        // TWO ports, in the order the entry reads them positionally: the wire
        // port and the snapshot port (§8 unit 4b — see the two-ports note in
        // `transcript-worker-host.ts`). The entry refuses to open storage
        // unless both are present, so transferring only one would leave this
        // worker inert.
        const wire = new MessageChannel();
        const snapshots = new MessageChannel();
        worker.postMessage({ sessionKey, writerId }, [wire.port2, snapshots.port2]);
        wire.port1.start();
        snapshots.port1.start();

        // The entry point's storage directory is `${OPFS_DIRECTORY}/${writerId}`,
        // `${sessionKey}.sqlite3` inside it (transcript-worker-entry.ts:42,47,50).
        // The directory appearing only proves `installOpfsSAHPoolVfs` ran, not
        // that `node.open()` (which creates seqscribe's bookkeeping tables) has
        // finished — that happens asynchronously after it, inside
        // `scope.onmessage` — so this gives it a moment before tearing the
        // worker down.
        const opfsRoot = await navigator.storage.getDirectory();
        await waitFor(async () => {
            try {
                const adhdevDir = await opfsRoot.getDirectoryHandle('.adhdev-transcript');
                await adhdevDir.getDirectoryHandle(writerId);
                return true;
            } catch {
                return false;
            }
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        // The SAH pool VFS holds an exclusive lock on its directory for as long
        // as the entry-point worker keeps it open, so the entry worker must be
        // torn down — and its OS-level file handles actually released, which
        // outlives the synchronous `terminate()` call returning — before
        // anything else can reopen the same directory.
        worker.terminate();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Independently reopen the very OPFS SAH pool directory the worker just
        // wrote to and confirm real content, not just a file's existence.
        // `createSyncAccessHandle` (which the SAH pool VFS needs) only exists
        // inside a worker global scope, so this verification runs in its own
        // helper worker rather than the main thread. One VFS install per
        // verify worker, polled from inside that single worker instance
        // (rather than reinstalling the VFS on every retry from fresh workers,
        // which repeatedly races the same OS-level lock-release timing this
        // test is already working around above).
        const verifyWorker = new Worker(new URL('./verify-opfs-content.worker.ts', import.meta.url), {
            type: 'module',
        });
        let last: { tables?: unknown[]; error?: string } = {};
        try {
            last = await new Promise((resolve, reject) => {
                verifyWorker.onmessage = (ev) => resolve(ev.data);
                verifyWorker.onerror = (ev) => reject(ev.error ?? ev.message);
                verifyWorker.postMessage({
                    directory: `.adhdev-transcript/${writerId}`,
                    dbFilename: `${sessionKey}.sqlite3`,
                });
            });
        } finally {
            verifyWorker.terminate();
        }
        expect(last.error).toBeUndefined();
        expect(last.tables).toEqual(expect.arrayContaining(['sq_log', 'sq_meta']));
    });
});
