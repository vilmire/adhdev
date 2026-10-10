/**
 * win32 "win32-input-mode" encoding of non-ASCII body text (opt-in per spec via
 * `send_message.win32_input_mode_non_ascii`).
 *
 * WHY (live, preview fleet, 2026-10-09, MainPC win32 + agy 1.3.x): antigravity
 * CLI (a Go/bubbletea TUI that reads console INPUT_RECORDs) silently drops every
 * non-ASCII character that is not a letter when it arrives as plain UTF-8 through
 * ConPTY — `— – ‘ ’ “ ” … € ★ → ✓ · ×` and emoji vanished, while `é ñ ü ß Ω я 中
 * あ 한글` survived. Bracketed paste vs plain write made no difference, and
 * claude-cli on the same node received every character, so the loss is in agy's
 * console-input decoding, not in the daemon's write. Writing the same characters
 * as win32-input-mode key records (`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, which
 * ConPTY turns straight into a KEY_EVENT carrying `Uc`) delivered all of them,
 * inside and outside a bracketed paste, and agy stored them intact.
 *
 * Record shape, measured live:
 *  - Vk = VK_PACKET (0xE7): "this key event carries a Unicode character".
 *  - One record per UTF-16 code unit. An astral character (emoji) is its high and
 *    low surrogate. All key-DOWN records of a code point are written first, then
 *    the key-UP records in reverse: interleaving down/up per surrogate
 *    (hi-down, hi-up, lo-down, lo-up) made agy insert the emoji TWICE.
 *  - ASCII (incl. ESC, CR, LF, and the bracketed-paste / soft-newline sequences
 *    the caller adds) passes through untouched.
 */
'use strict';

/** VK_PACKET — the virtual-key code Windows uses for a Unicode-character key event. */
export const WIN32_VK_PACKET = 0xe7;

function keyRecord(unit: number, down: boolean): string {
    return `\x1b[${WIN32_VK_PACKET};0;${unit};${down ? 1 : 0};0;1_`;
}

/** The win32-input-mode key records for ONE code point (down records, then up records reversed). */
export function win32InputModeRecordsForCodePoint(char: string): string {
    const units: number[] = [];
    for (let i = 0; i < char.length; i += 1) units.push(char.charCodeAt(i));
    return units.map(u => keyRecord(u, true)).join('') + units.slice().reverse().map(u => keyRecord(u, false)).join('');
}

interface Win32InputToken { text: string; /** a code point's record group — never split */ atomic: boolean }

/**
 * Split `text` into tokens: each run of ASCII is one splittable token, and every
 * non-ASCII code point is one ATOMIC token of key records. The chunker never cuts
 * an atomic token, so a record (or a surrogate pair's records) can never straddle
 * two PTY writes.
 */
function win32InputModeTokens(text: string): Win32InputToken[] {
    const tokens: Win32InputToken[] = [];
    let ascii = '';
    const pushAscii = () => {
        if (!ascii) return;
        // A CSI sequence already in the body (the soft-newline ESC[27;2;13~ the
        // soft_newline mode substitutes) is atomic too, so the re-paced chunk
        // boundaries can never cut one in half.
        let last = 0;
        for (const m of ascii.matchAll(/\x1b\[[0-9;]*[\x40-\x7e]/g)) {
            if (m.index! > last) tokens.push({ text: ascii.slice(last, m.index), atomic: false });
            tokens.push({ text: m[0], atomic: true });
            last = m.index! + m[0].length;
        }
        if (last < ascii.length) tokens.push({ text: ascii.slice(last), atomic: false });
        ascii = '';
    };
    for (const ch of text) { // for…of iterates by code point, keeping surrogate pairs whole
        if (ch.charCodeAt(0) < 0x80) { ascii += ch; continue; }
        pushAscii();
        tokens.push({ text: win32InputModeRecordsForCodePoint(ch), atomic: true });
    }
    pushAscii();
    return tokens;
}

/** Encode `text` for a win32-input-mode write (ASCII unchanged, every other code point as key records). */
export function encodeWin32InputMode(text: string): string {
    return win32InputModeTokens(text).map(t => t.text).join('');
}

/**
 * Encode `text` and pace it into PTY write segments of at most `maxChars` UTF-16
 * units. ASCII runs may be cut anywhere (they are plain bytes); a code point's
 * record group is atomic — it moves whole to the next segment. Encoded bodies are
 * larger than the source (≈20 chars per record), so bounding the ENCODED length
 * keeps each ConPTY write under the same input-pipe budget as an unencoded body.
 */
export function chunkWin32InputMode(text: string, maxChars: number): string[] {
    return chunkWin32Tokens(win32InputModeTokens(text), maxChars);
}

function chunkWin32Tokens(tokens: Win32InputToken[], maxChars: number): string[] {
    const size = Math.max(1, Math.floor(maxChars));
    const segments: string[] = [];
    let current = '';
    const flush = () => { if (current) { segments.push(current); current = ''; } };
    for (const token of tokens) {
        if (!token.atomic) {
            // ASCII run: fill the current segment, spill the rest into new ones.
            let rest = token.text;
            while (rest) {
                const room = size - current.length;
                if (room <= 0) { flush(); continue; }
                current += rest.slice(0, room);
                rest = rest.slice(room);
            }
            continue;
        }
        if (current.length + token.text.length > size) flush();
        current += token.text; // a lone token longer than `size` still goes out whole
    }
    flush();
    return segments;
}

// ─── Raw terminal input (dashboard xterm `pty_input`) ─────────────────────────
//
// Keystrokes and pastes typed into the dashboard terminal reach the PTY as raw
// terminal input, which — unlike a chat body — is full of escape sequences the
// terminal emulator generated: arrow keys / Ctrl combos (CSI, SS3), bracketed-
// paste markers, focus events, mouse reports, OSC replies, Alt/Meta-prefixed
// keys (ESC + char). Those must reach the TUI byte-for-byte, so every escape
// sequence is an ATOMIC, UNENCODED token. Two of them can legitimately carry a
// non-ASCII code unit, and re-encoding it would corrupt the sequence:
//  - X10 / UTF-8 (1005) mouse reports `ESC [ M Cb Cx Cy` — each coordinate is a
//    char of value 32+n, i.e. ≥ 0x80 once the column/row passes 95;
//  - Meta-prefixed keys `ESC <char>` (Alt+é, Alt+emoji).
// Everything between escape sequences is ordinary typed/pasted text and is
// encoded exactly like a chat body (ASCII unchanged, other code points as key
// records). The xterm.js client hands over whole strings per onData event and
// the transports carry them as JSON strings, so a surrogate pair is never split
// across two `pty_input` frames (a lone surrogate, if one ever arrived, is still
// encoded as its own record rather than dropped).
// Alternatives, in priority order:
//   X10 / 1005 mouse report (payload chars may be >= 0x80)
//   CSI: arrows, F-keys, Ctrl/Shift combos, SGR mouse, focus, paste markers
//   OSC / DCS / APC / PM / SOS string, BEL- or ST-terminated (e.g. colour-query replies)
//   SS3: application-mode arrows / F1-F4
//   Meta/Alt-prefixed key (ESC + one code point)
const TERMINAL_ESCAPE_RE = /\x1b\[M[\s\S]{3}|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1bO[\s\S]|\x1b[\s\S]/gu;

function win32TerminalInputTokens(data: string): Win32InputToken[] {
    const tokens: Win32InputToken[] = [];
    let last = 0;
    for (const m of data.matchAll(TERMINAL_ESCAPE_RE)) {
        if (m.index! > last) tokens.push(...win32InputModeTokens(data.slice(last, m.index)));
        tokens.push({ text: m[0], atomic: true });
        last = m.index! + m[0].length;
    }
    if (last < data.length) tokens.push(...win32InputModeTokens(data.slice(last)));
    return tokens;
}

/** Encode raw terminal input: escape sequences verbatim, text between them as for a chat body. */
export function encodeWin32TerminalInput(data: string): string {
    return win32TerminalInputTokens(data).map(t => t.text).join('');
}

/** encodeWin32TerminalInput, paced into write segments of at most `maxChars` (escape sequences and record groups never cut). */
export function chunkWin32TerminalInput(data: string, maxChars: number): string[] {
    return chunkWin32Tokens(win32TerminalInputTokens(data), maxChars);
}

/** Inverse of encodeWin32InputMode — test/diagnostic helper. Key-UP records are ignored. */
export function decodeWin32InputMode(encoded: string): string {
    const units: number[] = [];
    let out = '';
    const re = new RegExp(`\\x1b\\[${WIN32_VK_PACKET};0;(\\d+);([01]);0;1_`, 'y');
    let i = 0;
    const flushUnits = () => { if (units.length) { out += String.fromCharCode(...units); units.length = 0; } };
    while (i < encoded.length) {
        re.lastIndex = i;
        const m = re.exec(encoded);
        if (m) {
            if (m[2] === '1') units.push(Number(m[1]));
            i = re.lastIndex;
            continue;
        }
        flushUnits();
        out += encoded[i];
        i += 1;
    }
    flushUnits();
    return out;
}
