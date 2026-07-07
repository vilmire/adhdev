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
