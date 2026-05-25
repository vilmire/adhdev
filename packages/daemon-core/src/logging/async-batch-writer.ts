import * as fs from 'fs';

export class AsyncBatchWriter {
    // Maps filePath -> string buffer
    private static buffers: Map<string, string[]> = new Map();
    private static writePromises: Map<string, Promise<void>> = new Map();
    private static flushTimer: NodeJS.Timeout | null = null;

    /**
     * Queues data to be written to a file asynchronously in a batch.
     */
    public static write(filePath: string, data: string) {
        let buf = this.buffers.get(filePath);
        if (!buf) {
            buf = [];
            this.buffers.set(filePath, buf);
        }
        buf.push(data);

        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flushAll();
            }, 50);
        }
    }

    private static async flushAll() {
        const entries = Array.from(this.buffers.entries());
        this.buffers.clear();

        for (const [filePath, buffer] of entries) {
            const dataToWrite = buffer.join('');
            
            const doWrite = async () => {
                try {
                    const prevPromise = this.writePromises.get(filePath);
                    if (prevPromise) await prevPromise;
                    await fs.promises.appendFile(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
                } catch (e) {
                    console.error(`[AsyncBatchWriter] Failed to write to ${filePath}:`, e);
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
