/**
 * release — types, limits and pure helpers for release objects
 * (docs/design/2026-11-01-release-objects.md).
 *
 * A release is a mesh-scoped entity that groups MISSIONS (explicit membership) and records
 * deploy facts. It is distinct from the vendor release stamp (a build channel stamp) and
 * from `.adhdev/preview-deploy.json` (the per-checkout deploy record it snapshots).
 * Membership is only ever created by an explicit call; git evaluation and deploy heads
 * produce suggestions, never members. Dependency-free leaf.
 */

export const MESH_RELEASE_CHANNELS = ['preview', 'stable'] as const
export type MeshReleaseChannel = typeof MESH_RELEASE_CHANNELS[number]
export function isMeshReleaseChannel(value: unknown): value is MeshReleaseChannel {
    return typeof value === 'string' && (MESH_RELEASE_CHANNELS as readonly string[]).includes(value)
}

export const MESH_RELEASE_STATUSES = ['planned', 'frozen', 'deployed', 'verified', 'superseded', 'cancelled'] as const
export type ReleaseStatus = typeof MESH_RELEASE_STATUSES[number]
export function isReleaseStatus(value: unknown): value is ReleaseStatus {
    return typeof value === 'string' && (MESH_RELEASE_STATUSES as readonly string[]).includes(value)
}

export const RELEASE_MEMBER_STATES = ['member', 'moved_out', 'removed'] as const
export type ReleaseMemberState = typeof RELEASE_MEMBER_STATES[number]

/** Who may write release membership. The daemon never adds a member on its own. */
export const RELEASE_ACTORS = ['coordinator', 'owner', 'assistant', 'script'] as const
export type ReleaseActor = typeof RELEASE_ACTORS[number]

export const RELEASE_EVENT_TYPES = [
    'created', 'status_changed', 'scope_added', 'scope_moved', 'scope_removed',
    'deploy_recorded', 'changelog_drafted', 'changelog_applied',
] as const
export type ReleaseEventType = typeof RELEASE_EVENT_TYPES[number]

/** Mission-side events recorded when membership changes (so the mission history shows it). */
export const MISSION_RELEASE_EVENT_TYPES = ['release_attached', 'release_moved', 'release_detached'] as const

export const RELEASE_LIMITS = {
    name: 80,
    note: 500,
    /** `mesh_missions.release_note`: one user/operator-visible sentence. */
    releaseNote: 400,
    missionsPerCall: 100,
    changelogEntries: 300,
} as const

/** Deploy targets snapshot (a copy of `.adhdev/preview-deploy.json` `targets`). */
export interface ReleaseDeployTarget {
    commit?: string
    deployedAt?: string
    previewVersion?: string
    [key: string]: unknown
}
export type ReleaseTargets = Partial<Record<'npm' | 'server' | 'web', ReleaseDeployTarget>> & Record<string, ReleaseDeployTarget | undefined>

export const CHANGELOG_SECTIONS = ['Added', 'Fixed', 'Changed'] as const
export type ChangelogSection = typeof CHANGELOG_SECTIONS[number]

export interface ChangelogDraftEntry {
    missionId: string
    /** `<!-- m:<id8> -->` — the idempotency marker `--apply` writes after the line. */
    marker: string
    section: ChangelogSection
    /** The sentence that would be written to CHANGELOG.md. */
    text: string
    source: 'release_note' | 'summary'
    /** True when `text` is not user-facing wording yet (carries the needs-wording marker). */
    needsWording?: boolean
    /** Evidence kept in the draft JSON only; never written to CHANGELOG.md. */
    evidence?: { gitState?: string; outcome?: string; shas?: string[] }
    /** Non-blocking lint warnings (internal ids / wave numbers / forbidden phrases). */
    lint?: string[]
}

export interface ChangelogDraftExcluded {
    missionId: string
    reason: string
}

export interface ChangelogDraft {
    generatedAt: string
    entries: ChangelogDraftEntry[]
    /** Member missions without a `release_note` (target 0 at deploy time). */
    needsNote: string[]
    excluded: ChangelogDraftExcluded[]
    /** Member missions whose refs are not confirmed on the default branch (`not_landed` / `unknown`). */
    warnings: Array<{ missionId: string; gitState: string; message: string }>
    appliedAt?: string
}

export const NEEDS_WORDING_MARKER = '[needs user-facing wording]'

/** Marker that makes `--apply` idempotent: one per mission entry inside CHANGELOG.md. */
export function changelogMissionMarker(missionId: string): string {
    return `<!-- m:${missionId.slice(0, 8)} -->`
}

/** Default section for an entry; `[Fixed]`/`[Added]`/`[Changed]` prefixes on the note pin it. */
export function classifyChangelogSection(text: string, hint?: string): { section: ChangelogSection; text: string } {
    const m = /^\s*\[(added|fixed|changed)\]\s*/i.exec(text)
    if (m) {
        const key = m[1].toLowerCase()
        return { section: key === 'added' ? 'Added' : key === 'fixed' ? 'Fixed' : 'Changed', text: text.slice(m[0].length).trim() }
    }
    const probe = `${hint ?? ''} ${text}`.toLowerCase()
    if (/\b(fix|fixes|fixed|bug|regression|crash|error)\b|오류|결함|버그|수정/.test(probe)) return { section: 'Fixed', text }
    if (/\b(add|adds|added|new|introduc\w*|support\w*)\b|신규|추가/.test(probe)) return { section: 'Added', text }
    return { section: 'Changed', text }
}

/** Phrases that must not reach a public CHANGELOG (internal waves, rc numbering, ids). Warning-only. */
export function lintChangelogText(text: string): string[] {
    const out: string[] = []
    if (/\bwave[\s-]*\d+/i.test(text) || /웨이브\s*\d+/.test(text)) out.push('mentions an internal wave number')
    if (/\brc[.\s-]?\d+\b/i.test(text)) out.push('mentions an internal rc number')
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text) || /\bmi_[0-9a-f]{12}\b/.test(text) || /\brel_[0-9a-f]{12}\b/.test(text)) out.push('contains an internal id')
    if (/\bmission\b/i.test(text)) out.push('mentions "mission" (internal vocabulary)')
    return out
}
