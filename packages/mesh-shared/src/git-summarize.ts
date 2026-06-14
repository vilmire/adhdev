/**
 * Canonical compact git-shape summarizer used by debug/log surfaces on both the
 * cloud (daemon-cloud mesh command summarizer) and standalone (daemon-core router
 * RepoMeshStatusDebug) paths. Produces a small, log-safe projection of a git
 * status record — commit SHAs are truncated to 12 chars.
 *
 * Transport-specific envelope unwrapping (result / result.status / top-level)
 * stays in the caller; this takes an already-unwrapped status record.
 */

import { readBoolean, readNumber, readRecord, readString } from './json'

export function summarizeGitShape(status: unknown): Record<string, unknown> | null {
    const record = readRecord(status)
    if (!Object.keys(record).length) return null
    const submodules = Array.isArray(record.submodules)
        ? record.submodules.map((entry: unknown) => {
            const sub = readRecord(entry)
            return {
                path: readString(sub.path) ?? null,
                commit: readString(sub.commit)?.slice(0, 12) ?? null,
                dirty: readBoolean(sub.dirty) ?? false,
                outOfSync: readBoolean(sub.outOfSync, sub.out_of_sync) ?? false,
            }
        })
        : []
    return {
        isGitRepo: readBoolean(record.isGitRepo),
        workspace: readString(record.workspace) ?? null,
        repoRoot: readString(record.repoRoot, record.repo_root) ?? null,
        branch: readString(record.branch) ?? null,
        upstream: readString(record.upstream) ?? null,
        upstreamStatus: readString(record.upstreamStatus, record.upstream_status) ?? null,
        headCommit: readString(record.headCommit, record.head_commit)?.slice(0, 12) ?? null,
        ahead: readNumber(record.ahead) ?? null,
        behind: readNumber(record.behind) ?? null,
        dirtyCounts: {
            staged: readNumber(record.staged) ?? 0,
            modified: readNumber(record.modified) ?? 0,
            untracked: readNumber(record.untracked) ?? 0,
            deleted: readNumber(record.deleted) ?? 0,
            renamed: readNumber(record.renamed) ?? 0,
        },
        lastCheckedAt: readNumber(record.lastCheckedAt, record.last_checked_at) ?? null,
        submoduleCount: submodules.length,
        submodules,
    }
}
