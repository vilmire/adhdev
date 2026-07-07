/**
 * terminal-key-encoding — pure helpers that turn a logical key + sticky modifier
 * state into the raw PTY byte sequence to send over `sendPtyInput`.
 *
 * Used by the on-screen "Keys" popover in CliTerminalPane so users can compose
 * arbitrary Ctrl/Alt/Shift + key combinations without a physical keyboard. The
 * physical keyboard path is untouched — xterm already encodes modifiers there,
 * so this popover is the *only* place we hand-encode (no double encoding).
 *
 * KNOWN LIMITATION — cursor mode: the CSI form emitted for arrow/function keys
 * (`ESC [ ... A`) is the DECCKM "normal" cursor mode form. When the remote app
 * puts the terminal into application cursor mode (DECCKM set), unmodified arrows
 * are `ESC O A` instead of `ESC [ A`. We always emit the normal-mode form; the
 * modified variants (`ESC [ 1 ; n A`) are identical in both modes, so only the
 * unmodified arrows differ. This matches the legacy fixed buttons' behavior.
 */

export interface TerminalKeyMods {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

const ESC = ''

/**
 * Named function keys understood by encodeTerminalKey. Anything not in this set
 * is treated as a literal single character (letters, digits, punctuation).
 */
export type TerminalFunctionKey =
  | 'Enter'
  | 'Tab'
  | 'Escape'
  | 'Backspace'
  | 'Space'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'

// Final byte of the CSI sequence for each arrow key (normal cursor mode).
const ARROW_FINAL: Record<'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowLeft: 'D',
  ArrowRight: 'C',
}

/**
 * xterm modifier parameter: 1 + bitmask(shift=1, alt=2, ctrl=4).
 * Returns 1 when no modifiers are active (the "no modifier" sentinel).
 */
function modifierParam(mods: TerminalKeyMods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

/**
 * Encode a single printable character with Ctrl/Shift applied (no Alt here —
 * Alt is layered on top by the caller as an ESC prefix).
 */
function encodeCharByte(char: string, mods: TerminalKeyMods): string {
  let ch = char
  // Shift uppercases letters; for non-letters the caller is expected to pass the
  // already-shifted glyph, so we only transform alphabetic input here.
  if (mods.shift && ch.length === 1) {
    ch = ch.toUpperCase()
  }
  if (mods.ctrl) {
    const code = ch.toUpperCase().charCodeAt(0)
    // Ctrl masks the low 5 bits: @ A..Z [ \ ] ^ _ → 0x00..0x1f.
    return String.fromCharCode(code & 0x1f)
  }
  return ch
}

/**
 * Turn a logical key + sticky modifier state into the raw bytes to send to the PTY.
 *
 * @param mods  active sticky modifiers (Ctrl/Alt/Shift)
 * @param key   a single character (e.g. 'a', '5', '/') or a TerminalFunctionKey token
 */
export function encodeTerminalKey(mods: TerminalKeyMods, key: string): string {
  // Arrow keys: modifier-aware CSI, falling back to the legacy fixed sequence.
  if (key in ARROW_FINAL) {
    const final = ARROW_FINAL[key as keyof typeof ARROW_FINAL]
    const param = modifierParam(mods)
    return param === 1 ? `${ESC}[${final}` : `${ESC}[1;${param}${final}`
  }

  switch (key as TerminalFunctionKey) {
    case 'Enter':
      // Ctrl-Enter/Alt-Enter are rarely distinct at the byte level; keep CR,
      // prefixing ESC for Alt.
      return mods.alt ? `${ESC}\r` : '\r'
    case 'Escape':
      return mods.alt ? `${ESC}${ESC}` : ESC
    case 'Backspace': {
      // DEL (0x7f) is the conventional backspace byte; Ctrl-Backspace → 0x08.
      const base = mods.ctrl ? '' : ''
      return mods.alt ? `${ESC}${base}` : base
    }
    case 'Tab': {
      // Shift-Tab is CBT (ESC [ Z); plain Tab is HT.
      const base = mods.shift ? `${ESC}[Z` : '\t'
      return mods.alt && !mods.shift ? `${ESC}\t` : base
    }
    case 'Space': {
      const base = encodeCharByte(' ', mods)
      return mods.alt ? `${ESC}${base}` : base
    }
    default:
      break
  }

  // Single literal character (letter, digit, punctuation).
  const base = encodeCharByte(key, mods)
  return mods.alt ? `${ESC}${base}` : base
}
