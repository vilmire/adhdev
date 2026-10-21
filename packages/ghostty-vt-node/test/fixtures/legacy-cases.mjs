// Inputs for the legacy formatter byte-identity check. legacy-golden.json holds
// the outputs the pre-viewport binary (API level 1, the darwin-arm64 prebuilt
// at oss 99d55c6a3) produced for these inputs; generate-legacy-golden.mjs
// regenerates it. Adding getViewport/readRow must not change any of them.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export function codexCapture() {
    return JSON.parse(readFileSync(join(fixtureDir, 'codex-trust-modal-2026-09-19.json'), 'utf8'));
}

function codexChunks() {
    const capture = codexCapture();
    return [...capture.phase1_trust, ...capture.phase2_after_approve].map((chunk) => chunk.data);
}

export const LEGACY_CASES = [
    { name: 'codex-trust-modal', cols: 80, rows: 32, scrollback: 2000, chunks: () => codexChunks() },
    { name: 'codex-marker', cols: 80, rows: 32, scrollback: 2000, chunks: () => [...codexChunks(), 'Z'] },
    { name: 'codex-combined-dec-reset', cols: 80, rows: 32, scrollback: 2000, chunks: () => [...codexChunks(), '\x1b[?1049hALT', '\x1b[?1049;2004l'] },
    { name: 'cjk-combining-zwj', cols: 20, rows: 3, scrollback: 0, chunks: () => ['A한é👩‍💻 tail'] },
    { name: 'mode-2027', cols: 20, rows: 3, scrollback: 0, chunks: () => ['\x1b[?2027hA한é👩‍💻 tail'] },
    { name: 'soft-wrap', cols: 4, rows: 4, scrollback: 0, chunks: () => ['abcde'] },
    { name: 'scrollback', cols: 12, rows: 4, scrollback: 100000, chunks: () => ['old\r\n'.repeat(40) + '> FINAL'] },
    { name: 'alt-screen', cols: 12, rows: 4, scrollback: 1000, chunks: () => ['primary\r\n', '\x1b[?1049h\x1b[2;3HALT'] },
    { name: 'ris', cols: 12, rows: 4, scrollback: 1000, chunks: () => ['before\r\nmore', '\x1bc', 'after'] },
    { name: 'scroll-region-decom', cols: 8, rows: 6, scrollback: 0, chunks: () => ['\x1b[1;1HTOP\x1b[6;1HBOTTOM\x1b[2;5r\x1b[?6h\x1b[3;1HY', '\r\n\r\n\r\nW'] },
    { name: 'cuf-gaps-styles', cols: 16, rows: 3, scrollback: 0, chunks: () => ['a\x1b[3Cb  \x1b[1;31mred\x1b[0m\r\n\x1b[5Cx'] },
];

export function runLegacyCase(binding, testCase) {
    const terminal = binding.createTerminal({ cols: testCase.cols, rows: testCase.rows, scrollback: testCase.scrollback });
    try {
        for (const chunk of testCase.chunks()) terminal.write(chunk);
        return {
            plainUntrimmed: terminal.formatPlainText({ trim: false }),
            plainTrimmed: terminal.formatPlainText({ trim: true }),
            plainDefault: terminal.formatPlainText(),
            vt: terminal.formatVT(),
            cursor: terminal.getCursorPosition(),
        };
    } finally {
        terminal.dispose();
    }
}
