/**
 * Headless xterm wrapper for the cli-spec adapter.
 *
 * The spec evaluator consumes "visible screen text" — the same shape of
 * input as our fixtures. PTY raw bytes are not that: they contain cursor
 * positioning, scroll-region writes, redraws, OSC titles, alternate
 * screen toggles, and column-by-column repaints. We let xterm handle
 * all of that and then read back the visible buffer.
 *
 * The previous round's stripAnsi() was just enough for the captured
 * fixtures (which were already terminal-rendered) but failed on real
 * PTY streams from claude — the modal text rendered correctly on the
 * user's screen but came across the PTY as column-positioning controls
 * around bare letters, which regex stripping cannot reconstruct.
 */
'use strict';

import { Terminal } from '@xterm/headless';

export interface ScreenSink {
    write(chunk: string): void;
    snapshot(): string;
    dispose(): void;
}

export function createScreenSink(opts: { cols?: number; rows?: number } = {}): ScreenSink {
    const term = new Terminal({
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        allowProposedApi: true,
        scrollback: 1000,
    });

    return {
        write(chunk: string): void {
            term.write(chunk);
        },
        snapshot(): string {
            const buf = term.buffer.active;
            const out: string[] = [];
            for (let y = 0; y < buf.length; y += 1) {
                const line = buf.getLine(y);
                if (!line) continue;
                out.push(line.translateToString(true));
            }
            // Trim trailing blank lines — those are just the unused
            // bottom of the scrollback and add noise to pattern matching.
            while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
            return out.join('\n');
        },
        dispose(): void {
            term.dispose();
        },
    };
}
