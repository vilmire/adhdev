/**
 * text.ts — Shared text normalization utilities
 *
 * Consolidates duplicated text processing functions from
 * buildConversations.ts and DashboardMobileChatMode.tsx.
 */

/**
 * Normalize content into a plain-text preview string.
 *
 * Handles: string, content-block arrays, single { text } objects.
 * Previously duplicated as `normalizeMessageContent` and `normalizePreviewText`.
 */
export function normalizeTextContent(content: unknown): string {
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
    if (Array.isArray(content)) {
        return content
            .map(block => {
                if (typeof block === 'string') return block
                if (block && typeof block === 'object' && 'text' in block) return String((block as any).text || '')
                return ''
            })
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
    }
    if (content && typeof content === 'object' && 'text' in content) {
        return String((content as any).text || '').replace(/\s+/g, ' ').trim()
    }
    return String(content || '').replace(/\s+/g, ' ').trim()
}
