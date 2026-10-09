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
    const size = Math.max(1, Math.floor(maxChars));
    const segments: string[] = [];
    let current = '';
    const flush = () => { if (current) { segments.push(current); current = ''; } };
    for (const token of win32InputModeTokens(text)) {
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
