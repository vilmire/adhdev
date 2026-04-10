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
