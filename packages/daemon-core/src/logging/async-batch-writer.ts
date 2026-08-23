import * as fs from 'fs';

/**
 * Batches log lines and appends them per file path.
 *
 * The batch flush runs on a `setTimeout`, which lives in the event loop's timers
 * phase. That is fine while the loop turns, but it is NOT a guarantee that lines
 * reach disk: a handler that blocks the loop synchronously (a recursive
 * `readdirSync` walk, a long regex pass) starves the timer for as long as it
 * runs, and every queued line sits in memory until the loop is free again.
 *
 * That is not hypothetical. A daemon burning 100% CPU on a synchronous status
 * tick wrote ZERO log lines for 4h56m while the process was otherwise healthy —
 * so the one signal that would have identified the stall was itself suppressed
 * by the stall. Observability that disappears exactly when you need it is worse
 * than no observability, because the empty log reads as "nothing happened".
 *
 * So the timer is kept as the throughput path, and two synchronous escape
 * hatches guarantee forward progress regardless of loop health:
 *
 *  1. `MAX_PENDING_LINES` / `MAX_PENDING_BYTES` — a write that pushes a buffer
 *     past either bound flushes synchronously on the spot, so a blocked loop
 *     bounds the loss at the threshold instead of growing without limit.
 *  2. `flushSync()` — an explicit drain for shutdown paths and for callers that
 *     must not lose the line they just wrote (a crash handler, a lag warning).
 *
 * Sync flushing is deliberately the exception: it is `appendFileSync`, and doing
 * it per line would put a syscall in front of every log call. The thresholds
 * keep the common case on the async path.
 */
export class AsyncBatchWriter {
    // Maps filePath -> string buffer
    private static buffers: Map<string, string[]> = new Map();
    private static writePromises: Map<string, Promise<void>> = new Map();
    private static flushTimer: NodeJS.Timeout | null = null;
    private static pendingBytes: Map<string, number> = new Map();

    /**
     * Line/byte ceilings that force a synchronous flush. Sized so an idle daemon
     * never reaches them (the 50ms timer wins) while a loop-blocking handler
     * still gets its lines out: the status tick emits on the order of tens of
     * lines, so 64 lines bounds a stalled window to roughly one tick's worth.
     */
    private static readonly MAX_PENDING_LINES = 64;
    private static readonly MAX_PENDING_BYTES = 64 * 1024;

    /**
     * Queues data to be written to a file asynchronously in a batch.
     *
     * Crossing either pending threshold flushes synchronously before returning,
     * so a caller on a blocked event loop still lands its line on disk.
     */
    public static write(filePath: string, data: string) {
        let buf = this.buffers.get(filePath);
        if (!buf) {
            buf = [];
            this.buffers.set(filePath, buf);
        }
        buf.push(data);
        const bytes = (this.pendingBytes.get(filePath) ?? 0) + Buffer.byteLength(data);
        this.pendingBytes.set(filePath, bytes);

        if (buf.length >= this.MAX_PENDING_LINES || bytes >= this.MAX_PENDING_BYTES) {
            // The loop may never give us a timer tick; take the syscall now.
            this.flushPathSync(filePath);
            return;
        }

        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flushAll();
            }, 50);
        }
    }

    /**
     * Synchronously drain every buffered path. Safe to call from shutdown
     * handlers and from code that has just blocked (or is about to block) the
     * event loop. Best-effort: never throws.
     */
    public static flushSync(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        for (const filePath of Array.from(this.buffers.keys())) {
            this.flushPathSync(filePath);
        }
    }

    /** Append one path's pending buffer with a blocking write. Never throws. */
    private static flushPathSync(filePath: string): void {
        const buffer = this.buffers.get(filePath);
        this.buffers.delete(filePath);
        this.pendingBytes.delete(filePath);
        if (!buffer || buffer.length === 0) return;
        try {
            fs.appendFileSync(filePath, buffer.join(''), { encoding: 'utf-8', mode: 0o600 });
        } catch {
            // Logging must never create secondary failures or late console noise.
        }
    }

    private static async flushAll() {
        const entries = Array.from(this.buffers.entries());
        this.buffers.clear();
        this.pendingBytes.clear();

        for (const [filePath, buffer] of entries) {
            const dataToWrite = buffer.join('');

            const doWrite = async () => {
                try {
                    const prevPromise = this.writePromises.get(filePath);
                    if (prevPromise) await prevPromise;
                    await fs.promises.appendFile(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
                } catch {
                    // Logging must never create secondary failures or late console noise.
                }
            };

            const writePromise = doWrite();
            this.writePromises.set(filePath, writePromise);

            writePromise.finally(() => {
                if (this.writePromises.get(filePath) === writePromise) {
                    this.writePromises.delete(filePath);
                }
            });
        }
    }
}
