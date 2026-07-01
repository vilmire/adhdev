/**
 * text.ts — Shared text normalization utilities
 *
 * Consolidates duplicated text processing functions from
 * buildConversations.ts and DashboardMobileChatMode.tsx.
 */

interface TextContentBlock {
    text?: unknown
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
    return !!value && typeof value === 'object' && 'text' in value
}

export function stringifyTextContent(
    content: unknown,
    options?: { joiner?: string; normalizeWhitespace?: boolean },
): string {
    const joiner = options?.joiner ?? ' '
    const normalizeWhitespace = options?.normalizeWhitespace ?? false

    let rawText = ''
    if (typeof content === 'string') {
        rawText = content
    } else if (Array.isArray(content)) {
        rawText = content
            .map((block) => {
                if (typeof block === 'string') return block
                if (isTextContentBlock(block)) return String(block.text || '')
                return ''
            })
            .join(joiner)
    } else if (isTextContentBlock(content)) {
        rawText = String(content.text || '')
    } else {
        rawText = String(content || '')
    }

    return normalizeWhitespace
        ? rawText.replace(/\s+/g, ' ').trim()
        : rawText
}

/**
 * Normalize content into a plain-text preview string.
 *
 * Handles: string, content-block arrays, single { text } objects.
 * Previously duplicated as `normalizeMessageContent` and `normalizePreviewText`.
 */
export function normalizeTextContent(content: unknown): string {
    return stringifyTextContent(content, { normalizeWhitespace: true })
}

/**
 * Sanitize text pasted into the composer.
 *
 * When a user copies a rendered transcript bubble (ReactMarkdown tables,
 * status markers, etc.) the resulting `text/plain` can carry rendering
 * artifacts: C0/C1 control chars, zero-width/BOM/directional formatting
 * marks, the replacement character (mojibake '�'), and orphaned
 * variation selectors left behind when a base glyph was stripped.
 *
 * This targets ONLY those artifacts. Normal text — including Korean, code,
 * newlines, tabs, and legitimate emoji (with their attached variation
 * selectors) — is preserved verbatim. It deliberately does NOT blanket-strip
 * emoji (\p{So}).
 */
export function sanitizePastedText(raw: string): string {
    let out = ''
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]
        const code = raw.charCodeAt(i)

        // C0 control chars (0x00–0x1F), except \n (0x0A) and \t (0x09).
        if (code <= 0x1f && ch !== '\n' && ch !== '\t') continue
        // DEL (0x7F) + C1 control chars (0x80–0x9F).
        if (code >= 0x7f && code <= 0x9f) continue

        // Zero-width / BOM / directional formatting marks.
        // ZWSP..RLM (0x200B–0x200F), LRE..RLO/PDF (0x202A–0x202E),
        // WORD JOINER (0x2060), BOM/ZWNBSP (0xFEFF).
        if (
            (code >= 0x200b && code <= 0x200f) ||
            (code >= 0x202a && code <= 0x202e) ||
            code === 0x2060 ||
            code === 0xfeff
        ) {
            continue
        }

        // Replacement character (mojibake '�').
        if (code === 0xfffd) continue

        // Variation selectors VS15/VS16 (0xFE0E/0xFE0F). Keep only when
        // preceded by a real base glyph; drop orphans (no preceding char,
        // or the preceding char was itself stripped/whitespace).
        if (code === 0xfe0e || code === 0xfe0f) {
            const prev = out.length > 0 ? out[out.length - 1] : ''
            if (!prev || prev === '\n' || prev === '\t' || prev === ' ') continue
        }

        out += ch
    }
    return out
}
