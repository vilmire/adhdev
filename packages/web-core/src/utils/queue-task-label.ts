/**
 * Queue tasks have no title field — the UI renders `task.message` (the dispatch
 * prompt) verbatim. For MAGI cross-verification dispatches that means the internal
 * quorum preamble ("You are one independent member of a multi-agent
 * cross-verification quorum…") shows up as the task title. Derive a readable
 * label instead: surface the actual question, prefixed so the task kind stays
 * recognizable. Non-MAGI messages pass through unchanged.
 */
const MAGI_PREAMBLE = 'You are one independent member of a multi-agent cross-verification quorum'

export function describeQueueTaskMessage(message: string | null | undefined): string {
    const text = (message ?? '').trim()
    if (!text) return ''
    if (!text.startsWith(MAGI_PREAMBLE)) return text
    const question = text.match(/\n## Question\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim().replace(/\s+/g, ' ')
    return question ? `MAGI cross-verify — ${question}` : 'MAGI cross-verification task'
}

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

/** Human-facing text for a queue task: MAGI relabel + markdown-syntax strip. */
export function queueTaskDisplayText(message: string | null | undefined): string {
    return stripMarkdownSyntax(describeQueueTaskMessage(message))
}
