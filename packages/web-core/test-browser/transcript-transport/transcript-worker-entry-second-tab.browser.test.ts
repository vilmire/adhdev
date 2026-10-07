// Regression: a second transcript worker for the SAME OPFS directory (a second
// dashboard tab of the same origin, or a worker started before the previous
// one released its access handles) must still open its node and speak
// seqscribe on the wire port.
//
// The OPFS SAH pool VFS is exclusive per directory. Before the in-memory
// fallback (`transcript-worker-storage.ts`) the second worker's
// `installOpfsSAHPoolVfs` rejected with NoModificationAllowedError, the node
// never attached, no frame (HELLO) ever left the worker, the daemon closed the
// lane with `hello_timeout`, and every chat pane in that tab stayed empty
// until "load earlier messages" pulled a history page.
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY_URL = new URL('../../src/transcript-transport/transcript-worker-entry.ts', import.meta.url);

interface StartedWorker {
    readonly worker: Worker;
    /** Resolves with the first opaque wire frame the worker's node sends. */
    readonly firstWireFrame: Promise<string>;
}

function startEntryWorker(writerId: string): StartedWorker {
    const worker = new Worker(ENTRY_URL, { type: 'module' });
    const wire = new MessageChannel();
    const views = new MessageChannel();
    const firstWireFrame = new Promise<string>((resolve) => {
        wire.port1.onmessage = (ev: MessageEvent): void => {
            if (typeof ev.data === 'string') resolve(ev.data);
        };
    });
    wire.port1.start();
    views.port1.start();
    worker.postMessage({ sessionKey: 'transcript', writerId }, [wire.port2, views.port2]);
    return { worker, firstWireFrame };
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: nothing within ${ms} ms`)), ms)),
    ]);
}

const started: Worker[] = [];
afterEach(() => {
    for (const worker of started.splice(0)) worker.terminate();
});

describe('transcript-worker-entry.ts — second worker on a held OPFS pool', () => {
    it('still attaches and sends its first wire frame while another worker holds the pool', async () => {
        const writerId = `adhdev_second_tab_${Math.random().toString(36).slice(2)}`;

        const first = startEntryWorker(writerId);
        started.push(first.worker);
        // The first worker owns the SAH pool for as long as it lives.
        await within(first.firstWireFrame, 15_000, 'first worker');

        const second = startEntryWorker(writerId);
        started.push(second.worker);
        const frame = await within(second.firstWireFrame, 15_000, 'second worker');
        expect(typeof frame).toBe('string');
        expect(frame.length).toBeGreaterThan(0);
    });
});
