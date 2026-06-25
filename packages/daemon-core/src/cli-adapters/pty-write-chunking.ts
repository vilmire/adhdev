/**
 * Shared win32 ConPTY paced-write chunking.
 *
 * A single unbounded ConPTY `write()` can overflow the console input pipe and
 * drop LEADING bytes once the payload exceeds ~1KB — the "long task message gets
 * truncated (head lost, tail kept)" failure. The fix is to split a large body
 * into bounded chunks written with a short inter-chunk gap so the console input
 * buffer keeps up. Small bodies still go out in a single write.
 *
 * This module is the SINGLE source of truth for the chunk size / gap / surrogate-
 * safe split so the two write paths that need it — the spec FsmDriver
 * (writeWin32Body) and the legacy ProviderCliAdapter (writeToPty / submit paths)
 * — cannot drift apart and regress on one side (the original bug: "one branch
 * patched, the other not").
 */
'use strict';

// Defensive paced PTY write tuning. 1024 chars per chunk stays comfortably under
// the ConPTY input-pipe threshold; an 8ms gap lets the console reader drain
// between chunks without adding meaningful latency to a normal-sized prompt.
export const WIN32_PTY_WRITE_CHUNK_CHARS = 1024;
export const WIN32_PTY_WRITE_CHUNK_GAP_MS = 8;

/** Split `text` into chunks of at most `size` UTF-16 units without ever cutting
 *  between a high and low surrogate (which would corrupt an astral char — emoji,
 *  etc. — on the UTF-8 PTY write). */
export function chunkPreservingSurrogates(text: string, size: number): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(text.length, offset + size);
        if (end < text.length) {
            const code = text.charCodeAt(end - 1);
            // Boundary lands on a high surrogate → pull back one so the pair stays
            // together in the next chunk.
            if (code >= 0xd800 && code <= 0xdbff) end -= 1;
        }
        if (end <= offset) end = Math.min(text.length, offset + size); // size 1 on a lone surrogate
        chunks.push(text.slice(offset, end));
        offset = end;
    }
    return chunks;
}

/** True when a body of `length` UTF-16 units should be paced into multiple
 *  chunks on win32 rather than written in a single PTY write. */
export function shouldChunkWin32Write(length: number): boolean {
    return length > WIN32_PTY_WRITE_CHUNK_CHARS;
}

/**
 * Drive a paced, surrogate-safe chunked write of `text` over a `write(chunk)`
 * sink, calling `onChunkWritten` after each chunk (e.g. to advance an input-
 * activity timestamp) and `onDone` once the final chunk is out. The optional
 * `setTimer` lets the caller own the timer handle (so it can be cleared on
 * shutdown) and supply a custom scheduler in tests; it defaults to setTimeout.
 *
 * Bodies at or below the chunk threshold are written in a SINGLE write — the
 * common case — so this is a no-op pacing wrapper for normal-sized prompts.
 *
 * Returns the chunks that will be written (useful for assertions/logging).
 */
export interface PacedWin32WriteOptions {
    write: (chunk: string) => void;
    onChunkWritten?: () => void;
    onDone?: () => void;
    /** Schedule the next chunk; must return a handle the caller can clear.
     *  Defaults to setTimeout. */
    setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    /** Store the pending timer handle so the caller can clear it on shutdown. */
    onTimer?: (handle: ReturnType<typeof setTimeout> | null) => void;
    chunkChars?: number;
    gapMs?: number;
}

export function writeWin32Paced(text: string, opts: PacedWin32WriteOptions): string[] {
    const chunkChars = opts.chunkChars ?? WIN32_PTY_WRITE_CHUNK_CHARS;
    const gapMs = opts.gapMs ?? WIN32_PTY_WRITE_CHUNK_GAP_MS;
    const setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));

    if (text.length <= chunkChars) {
        opts.onTimer?.(null);
        opts.write(text);
        opts.onChunkWritten?.();
        opts.onDone?.();
        return [text];
    }

    const chunks = chunkPreservingSurrogates(text, chunkChars);
    let idx = 0;
    const writeNext = (): void => {
        opts.onTimer?.(null);
        if (idx >= chunks.length) { opts.onDone?.(); return; }
        opts.write(chunks[idx]);
        opts.onChunkWritten?.();
        idx += 1;
        if (idx < chunks.length) {
            const handle = setTimer(writeNext, gapMs);
            opts.onTimer?.(handle);
        } else {
            opts.onDone?.();
        }
    };
    writeNext();
    return chunks;
}
