/**
 * Task messages are worker dispatch prompts, usually authored in markdown.
 * Rendering them verbatim fills the dashboard with syntax noise (`#`, `**`,
 * backticks). This strips the SYNTAX only — the wording is untouched, no
 * title extraction — so cards and detail panels read as plain sentences.
 */
export function stripMarkdownSyntax(text: string | null | undefined): string {
    let s = (text ?? '')
    if (!s) return ''
    s = s.replace(/^```[^\n]*\n?/gm, '')               // code fence delimiters
    s = s.replace(/^#{1,6}\s+/gm, '')                  // ATX headings
    s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')    // list markers
    s = s.replace(/^>\s?/gm, '')                       // blockquotes
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')    // links / images → label
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    s = s.replace(/(^|\W)[*_](?=\S)([^*_\n]*\S)[*_](?=\W|$)/g, '$1$2') // italics
    s = s.replace(/`([^`\n]*)`/g, '$1')                // inline code
    s = s.replace(/[ \t]{2,}/g, ' ')
    s = s.replace(/\n{3,}/g, '\n\n')
    return s.trim()
}

/**
 * Human-facing text for a queue task. Queue tasks have no title field, so the UI
 * renders `task.message` (the dispatch prompt) with its markdown syntax stripped.
 */
export function queueTaskDisplayText(message: string | null | undefined): string {
    return stripMarkdownSyntax((message ?? '').trim())
}
