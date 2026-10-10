/**
 * Paced, ordered writer for RAW terminal input (the dashboard terminal's
 * `pty_input`) on a win32 session whose spec opts into
 * `send_message.win32_input_mode_non_ascii`.
 *
 * Non-ASCII characters are rewritten as win32-input-mode key records (see
 * win32-input-mode.ts — agy drops them as plain UTF-8 through ConPTY). Records
 * are ~20× the size of the character they carry, so a pasted paragraph of
 * Korean or emoji turns into many KB; a single unbounded ConPTY write that large
 * loses its LEADING bytes (pty-write-chunking.ts). The encoded input is therefore
 * paced in the same 1024-char / 8 ms segments the chat send path uses, with
 * escape sequences and record groups never cut.
 *
 * Ordering: while a paced write is still draining, every later write — even a
 * single keystroke that would otherwise go out at once — queues behind it, so
 * typed input can never overtake the tail of a paste. The common case (a
 * keystroke with nothing pending) is written synchronously.
 */
'use strict';

import { WIN32_PTY_WRITE_CHUNK_CHARS, WIN32_PTY_WRITE_CHUNK_GAP_MS } from '../../cli-adapters/pty-write-chunking.js';
import { chunkWin32TerminalInput } from './win32-input-mode.js';

export interface Win32RawInputWriterOptions {
    chunkChars?: number;
    gapMs?: number;
}

export class Win32RawInputWriter {
    private queue: string[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly chunkChars: number;
    private readonly gapMs: number;

    constructor(private readonly sink: (segment: string) => void, options: Win32RawInputWriterOptions = {}) {
        this.chunkChars = options.chunkChars ?? WIN32_PTY_WRITE_CHUNK_CHARS;
        this.gapMs = options.gapMs ?? WIN32_PTY_WRITE_CHUNK_GAP_MS;
    }

    write(data: string): void {
        const segments = chunkWin32TerminalInput(data, this.chunkChars);
        if (!segments.length) return;
        if (!this.timer && !this.queue.length && segments.length === 1) {
            this.sink(segments[0]);
            return;
        }
        this.queue.push(...segments);
        if (!this.timer) this.drain();
    }

    /** Drop anything not yet written (session shutdown). */
    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.queue = [];
    }

    private readonly drain = (): void => {
        this.timer = null;
        const next = this.queue.shift();
        if (next !== undefined) this.sink(next);
        if (this.queue.length) this.timer = setTimeout(this.drain, this.gapMs);
    };
}
