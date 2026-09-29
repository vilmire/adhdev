/**
 * Projection of a daemon `git_diff_file` answer into the per-file row the MCP
 * `git_diff` tool and the cloud git-diff shortcut both return: the diff text
 * capped at `maxLines` (with a visible truncation marker), plus the file's
 * change metadata from the diff summary.
 */

import { readRecord } from './json'

export interface GitFileDiffRow {
    path: string
    old_path?: string | null
    status?: string
    diff: string
    truncated: boolean
    binary: boolean
    error?: string
}

/** Cap diff text at `maxLines`; a truncated diff ends with a `... (truncated)` marker line. */
function truncateDiffText(text: string, maxLines: number): { diff: string; truncated: boolean } {
    const lines = text.split('\n')
    const truncated = lines.length > maxLines
    return {
        diff: truncated ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)' : text,
        truncated,
    }
}

/** One changed file's row from its `git_diff_file` answer (either `{ diff: {...} }` or the bare diff record). */
export function projectFileDiffRow(
    file: { path: string; oldPath?: string | null; status?: string },
    rawResult: unknown,
    maxLines: number,
): GitFileDiffRow {
    const raw = readRecord(rawResult)
    const d = readRecord(raw.diff ?? rawResult)
    const text = typeof d.diff === 'string' ? d.diff : ''
    const { diff, truncated } = truncateDiffText(text, maxLines)
    return {
        path: file.path,
        old_path: file.oldPath ?? null,
        status: file.status ?? 'M',
        diff,
        truncated,
        binary: typeof d.binary === 'boolean' ? d.binary : false,
    }
}
