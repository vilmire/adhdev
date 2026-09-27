import type { SessionBufferSnapshot } from './types.js';

export interface SessionRingBufferOptions {
  maxBytes?: number;
}

// Manual "Load older terminal output" replays this raw ring buffer into the
// browser terminal. 512KiB was too small for long Claude/Codex conversations:
// by the time the user scrolled to the top and clicked the loader, the output
// they were trying to recover was often already trimmed.
export const DEFAULT_SESSION_RING_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

export class SessionRingBuffer {
  private maxBytes: number;
  private chunks: { seq: number; data: string; bytes: number }[] = [];
  private nextSeq = 1;
  private totalBytes = 0;

  constructor(options: SessionRingBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_SESSION_RING_BUFFER_MAX_BYTES;
  }

  append(data: string): number {
    const normalized = typeof data === 'string' ? data : String(data ?? '');
    const bytes = Buffer.byteLength(normalized, 'utf8');
    const seq = this.nextSeq++;

    this.chunks.push({ seq, data: normalized, bytes });
    this.totalBytes += bytes;
    this.trim();
    return seq;
  }

  snapshot(sinceSeq?: number): SessionBufferSnapshot {
    const relevant = typeof sinceSeq === 'number'
      ? this.chunks.filter(chunk => chunk.seq > sinceSeq)
      : this.chunks;

    const text = relevant.map(chunk => chunk.data).join('');
    const truncated = !!this.chunks[0] && typeof sinceSeq === 'number' && sinceSeq < this.chunks[0].seq - 1;

    return {
      seq: this.nextSeq - 1,
      text,
      truncated,
    };
  }

  getState(): { scrollbackBytes: number; snapshotSeq: number } {
    return {
      scrollbackBytes: this.totalBytes,
      snapshotSeq: this.nextSeq - 1,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.nextSeq = 1;
  }

  restore(snapshot: { seq: number; text: string }): void {
    this.clear();
    const text = String(snapshot.text || '');
    if (!text) {
      this.nextSeq = Math.max(1, Number(snapshot.seq || 0) + 1);
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const seq = Math.max(1, Number(snapshot.seq || 1));
    this.chunks = [{ seq, data: text, bytes }];
    this.totalBytes = bytes;
    this.nextSeq = seq + 1;
    this.trim();
  }

  private trim(): void {
    let evicted = false;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.totalBytes -= removed.bytes;
      evicted = true;
    }
    if (evicted) this.healHead();
  }

  /**
   * TRIM-BOUNDARY repair. Eviction drops whole chunks, and a chunk boundary is
   * a PTY read boundary — an arbitrary byte offset with no relationship to the
   * structure of the stream. So the chunk that becomes the new oldest can begin
   * partway through something the sender wrote atomically, and `snapshot()`
   * joins from exactly there.
   *
   * The consumer is the browser terminal: "Load older terminal output" asks
   * with `sinceSeq: 0`, which makes the daemon skip the emulator viewport and
   * hand this raw text straight to xterm (see `mergeRuntimeSnapshot`). xterm
   * then parses a stream that starts mid-token, which is how the reported
   * screenshot got orphaned `.` and `5` glyphs floating above the output and a
   * large blank band at the top:
   *
   *   drop 5 chars  -> "[HClaude Code v2.1.220…"   the CSI introducer is gone,
   *                                                so `[H` prints literally
   *   drop 12 chars -> "2mClaude Code v2.1.220…"   half an SGR prints literally
   *   drop 46 chars -> the leading `\x1b[2J\x1b[H` never arrives, so the screen
   *                    is never cleared/homed and row placement collapses
   *   byte cut      -> a torn 3-byte Hangul sequence decodes to U+FFFD
   *
   * So walk the head of the new oldest chunk forward to the first offset that
   * is safe to start parsing at, and drop the partial prefix. Losing a few
   * bytes of already-evicted context is strictly better than injecting literal
   * garbage into the viewport.
   *
   * Two independent boundary classes have to be handled, and neither subsumes
   * the other:
   *
   *  1. Character encoding. Chunks are JS strings, so a torn multi-byte UTF-8
   *     sequence has already decayed into U+FFFD (or, for astral characters, a
   *     lone surrogate) by the time it gets here. This mirrors the protection
   *     `createLineParser` grew for the IPC socket path in
   *     `ipc-line-parser-utf8.test.ts`; that layer can hold bytes back and
   *     re-join them because it owns both sides of the split, whereas here the
   *     other half is already gone, so dropping is the only repair available.
   *  2. Escape sequences. A CSI/OSC/SS3 can be cut anywhere, and unlike the
   *     encoding case the leftover bytes are all perfectly printable — which is
   *     precisely why the corruption is visible rather than silent.
   */
  private healHead(): void {
    const head = this.chunks[0];
    if (!head) return;

    const repaired = stripDanglingPrefix(head.data);
    if (repaired === head.data) return;

    const bytes = Buffer.byteLength(repaired, 'utf8');
    this.totalBytes -= head.bytes - bytes;
    head.data = repaired;
    head.bytes = bytes;
  }
}

/** Final byte of a CSI (`ESC [ … X`) or SS3 sequence. */
const CSI_FINAL = /[\x40-\x7e]/;

/**
 * The subset of CSI final bytes terminals actually emit: cursor movement
 * (ABCDEFGHfd), erase (JK), scroll (STLM), insert/delete (PX@), SGR (m),
 * device status (nc), mode set/reset (hl), save/restore cursor (su) and
 * scroll region (r). Used only when the `[` introducer was itself evicted, so
 * that a digit run followed by an arbitrary letter is not mistaken for a
 * sequence — the whole CSI final range \x40-\x7e includes most of the
 * alphabet and would swallow ordinary prose.
 */
const CSI_COMMON_FINAL = /[ABCDEFGHJKSTLMPX@mnchlsurdfgqit]/;

/**
 * Returns `text` with any leading fragment of a torn character or escape
 * sequence removed. Returns `text` unchanged when the head is already a safe
 * place to start parsing.
 */
function stripDanglingPrefix(text: string): string {
  let i = 0;

  // 1. Encoding damage. A torn multi-byte sequence survives as U+FFFD or as an
  //    unpaired surrogate; both are meaningless on their own.
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) { i += 1; continue; }
    // High surrogate followed by a low surrogate is a complete astral
    // character — keep it. Either half alone is debris.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) break;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { i += 1; continue; }
    break;
  }

  // 2. Escape-sequence damage. Only a *leading* fragment can be torn: anything
  //    at or after the first ESC still has its introducer, so it will parse.
  //    Scan to the first ESC (or to a control character that resynchronises the
  //    parser anyway) and drop everything before it — but only if what precedes
  //    it actually looks like the tail of a sequence rather than ordinary text,
  //    so a buffer that legitimately starts mid-line is left alone.
  const rest = text.slice(i);
  const danglingLength = danglingEscapeTailLength(rest);
  return danglingLength > 0 ? rest.slice(danglingLength) : rest;
}

/**
 * Length of the leading run that is the tail of a cut escape sequence, or 0
 * when the text starts cleanly.
 *
 * A cut CSI leaves one of:
 *   `[2J…`  `2J…`  `J…`     (introducer and/or parameters lost)
 * and a cut OSC leaves parameter/payload text terminated by BEL or ST. What
 * they have in common is that the *remaining* prefix is a run of parameter
 * bytes ending at a final byte, all of it before the next ESC. Ordinary output
 * only matches that shape when it happens to consist solely of parameter
 * characters, so the scan stops at the first character that cannot appear in a
 * sequence — a letter mid-word, a space, a newline — and reports 0.
 */
function danglingEscapeTailLength(text: string): number {
  if (!text || text.charCodeAt(0) === 0x1b) return 0;

  let i = 0;
  // An orphaned `[` is the most common shape (the ESC alone was evicted).
  const hasIntroducer = text[0] === '[' || text[0] === ']';
  if (hasIntroducer) i = 1;

  const start = i;
  // Parameter bytes only: digits, `;`, `?`, `:` and the private markers.
  // Deliberately NOT the intermediate bytes (space, `!`, `"`, `$`, `'`):
  // including space made ordinary prose match — "2 files changed" scans `2`,
  // ` `, then treats `f` as a CSI final and eats "2 f". Sequences that use
  // intermediates are rare enough that leaving their tail in place is far
  // cheaper than truncating real output.
  while (i < text.length && /[0-9;?:<=>]/.test(text[i])) i += 1;

  if (i >= text.length) return 0;

  // OSC tail: ends at BEL or ST rather than a CSI final byte.
  if (text[0] === ']') {
    const bel = text.indexOf('\x07');
    if (bel >= 0) return bel + 1;
    return 0;
  }

  if (!CSI_FINAL.test(text[i])) return 0;

  // Require evidence of an actual sequence rather than a coincidence. With the
  // orphaned `[` present the shape is already unambiguous. Without it, demand
  // at least one parameter byte followed by one of the final bytes terminals
  // actually emit — `32m` and `2J` are sequences; "J is a letter" has no
  // parameter byte, and "2 files changed" ends its digit run at a space, which
  // is not in the parameter class at all.
  if (!hasIntroducer) {
    if (i === start) return 0;
    if (!CSI_COMMON_FINAL.test(text[i])) return 0;
  }

  return i + 1;
}
