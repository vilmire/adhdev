import * as fs from 'node:fs';
import { TextDecoder } from 'node:util';

// Metadata includes provider instructions (observed headers exceed 22 KiB).
// Allow ample headroom while bounding synchronous work/memory per candidate.
// The cap excludes LF; one extra byte distinguishes an exact-cap record from
// an incomplete prefix. Never parse a prefix or scan subsequent history records.
export const FIRST_JSONL_RECORD_MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 8192;

export function readFirstJsonlRecord(filePath: string): Record<string, unknown> | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const chunks: Buffer[] = [];
            const buffer = Buffer.alloc(CHUNK_BYTES);
            let size = 0;
            while (true) {
                const lengthToRead = Math.min(buffer.length, FIRST_JSONL_RECORD_MAX_BYTES + 1 - size);
                const bytes = fs.readSync(fd, buffer, 0, lengthToRead, size);
                const data = buffer.subarray(0, bytes);
                const newline = data.indexOf(0x0a);
                const length = newline < 0 ? bytes : newline;
                if (size + length > FIRST_JSONL_RECORD_MAX_BYTES) return null;
                chunks.push(Buffer.from(data.subarray(0, length)));
                size += length;
                if (newline >= 0 || bytes === 0) break;
            }
            if (!size) return null;
            // Decode once, after joining bytes: multi-byte characters may straddle
            // reads. Invalid UTF-8 and malformed/incomplete JSON fail closed.
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
            const parsed: unknown = JSON.parse(text);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown> : null;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}
