/**
 * Release objects on the dashboard (design 2026-11-01-release-objects §7): the allow-list parsers
 * for the hosting daemon's `release_*` answers. Anything unusable is dropped, never thrown on, and
 * an older daemon without the command yields `null` (the card stays hidden).
 */
import { unwrapCommandBody } from '../needs-you/needs-you-model'

export const RELEASE_STATUS_ORDER = ['planned', 'frozen', 'deployed', 'verified'] as const
export type ReleaseStatusValue = typeof RELEASE_STATUS_ORDER[number] | 'superseded' | 'cancelled'
const ALL_STATUSES: readonly string[] = [...RELEASE_STATUS_ORDER, 'superseded', 'cancelled']

export interface ReleaseView {
    id: string
    name: string
    channel: 'preview' | 'stable'
    status: ReleaseStatusValue
    version?: string
    headCommit?: string
    missionCount: number
    note?: string
    targets?: Record<string, { commit?: string; deployedAt?: string }>
}

export interface ReleaseMissionRow {
    missionId: string
    title: string
    outcome?: string
    releaseNote?: string
    openLiveChecks: number
    machines: string[]
    gitState?: string
}

export interface SuggestedMissionView { missionId: string; title: string }

export interface ReleaseListView {
    releases: ReleaseView[]
    membership: Record<string, { releaseId: string; name: string }>
}

export interface ReleaseDetailView {
    release: ReleaseView
    missions: ReleaseMissionRow[]
    verified: { suggested: boolean; openLiveChecks: number }
    suggestedMissions: SuggestedMissionView[]
    draft?: ReleaseDraftView
}

export interface ReleaseDraftView {
    entries: Array<{ missionId: string; section: string; text: string; marker: string; needsWording?: boolean }>
    needsNote: string[]
    excluded: Array<{ missionId: string; reason: string }>
    warnings: Array<{ missionId: string; gitState: string }>
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const rec = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null)

export function parseRelease(raw: unknown): ReleaseView | null {
    const r = rec(raw)
    if (!r || !str(r.id) || !str(r.name)) return null
    if (r.channel !== 'preview' && r.channel !== 'stable') return null
    if (!ALL_STATUSES.includes(r.status)) return null
    const targets: NonNullable<ReleaseView['targets']> = {}
    for (const [k, v] of Object.entries(rec(r.targets) ?? {}).slice(0, 8)) {
        const t = rec(v)
        if (t) targets[k.slice(0, 40)] = { ...(str(t.commit, 80) ? { commit: str(t.commit, 80) } : {}), ...(str(t.deployedAt, 40) ? { deployedAt: str(t.deployedAt, 40) } : {}) }
    }
    return {
        id: str(r.id, 60), name: str(r.name, 80), channel: r.channel, status: r.status,
        ...(str(r.version, 80) ? { version: str(r.version, 80) } : {}),
        ...(str(r.headCommit, 80) ? { headCommit: str(r.headCommit, 80) } : {}),
        missionCount: num(r.missionCount),
        ...(str(r.note, 500) ? { note: str(r.note, 500) } : {}),
        ...(Object.keys(targets).length ? { targets } : {}),
    }
}

export function parseReleaseList(raw: unknown): ReleaseListView | null {
    const body = unwrapCommandBody(raw)
    if (!body || body.success !== true || !Array.isArray(body.releases)) return null
    const releases = body.releases.slice(0, 100).map(parseRelease).filter((r: ReleaseView | null): r is ReleaseView => !!r)
    const membership: ReleaseListView['membership'] = {}
    for (const [missionId, v] of Object.entries(rec(body.membership) ?? {}).slice(0, 2000)) {
        const m = rec(v)
        if (m && str(m.releaseId)) membership[missionId.slice(0, 100)] = { releaseId: str(m.releaseId, 60), name: str(m.name, 80) }
    }
    return { releases, membership }
}

function parseDraft(raw: unknown): ReleaseDraftView | undefined {
    const d = rec(raw)
    if (!d || !Array.isArray(d.entries)) return undefined
    return {
        entries: d.entries.slice(0, 300).map((e: unknown) => rec(e)).filter((e): e is Record<string, any> => !!e && !!str(e.missionId)).map(e => ({
            missionId: str(e.missionId, 100), section: str(e.section, 20), text: str(e.text, 600), marker: str(e.marker, 40),
            ...(e.needsWording === true ? { needsWording: true } : {}),
        })),
        needsNote: (Array.isArray(d.needsNote) ? d.needsNote : []).filter((v: unknown) => typeof v === 'string').slice(0, 300),
        excluded: (Array.isArray(d.excluded) ? d.excluded : []).map((e: unknown) => rec(e)).filter((e): e is Record<string, any> => !!e).slice(0, 100).map(e => ({ missionId: str(e.missionId, 100), reason: str(e.reason, 120) })),
        warnings: (Array.isArray(d.warnings) ? d.warnings : []).map((e: unknown) => rec(e)).filter((e): e is Record<string, any> => !!e).slice(0, 100).map(e => ({ missionId: str(e.missionId, 100), gitState: str(e.gitState, 20) })),
    }
}

export function parseReleaseDetail(raw: unknown): ReleaseDetailView | null {
    const body = unwrapCommandBody(raw)
    if (!body || body.success !== true) return null
    const release = parseRelease({ missionCount: Array.isArray(body.missions) ? body.missions.length : 0, ...(rec(body.release) ?? {}) })
    if (!release) return null
    const missions: ReleaseMissionRow[] = (Array.isArray(body.missions) ? body.missions : []).slice(0, 300)
        .map((m: unknown) => rec(m)).filter((m): m is Record<string, any> => !!m && !!str(m.missionId))
        .map(m => ({
            missionId: str(m.missionId, 100), title: str(m.title, 120),
            ...(str(m.outcome, 30) ? { outcome: str(m.outcome, 30) } : {}),
            ...(str(m.releaseNote, 400) ? { releaseNote: str(m.releaseNote, 400) } : {}),
            openLiveChecks: num(m.openLiveChecks),
            machines: (Array.isArray(m.machines) ? m.machines : []).filter((v: unknown) => typeof v === 'string').slice(0, 8),
            ...(str(m.gitState, 20) ? { gitState: str(m.gitState, 20) } : {}),
        }))
    return {
        release, missions,
        verified: { suggested: rec(body.verified)?.suggested === true, openLiveChecks: num(rec(body.verified)?.openLiveChecks) },
        suggestedMissions: (Array.isArray(body.suggestedMissions) ? body.suggestedMissions : []).slice(0, 20)
            .map((m: unknown) => rec(m)).filter((m): m is Record<string, any> => !!m && !!str(m.missionId))
            .map(m => ({ missionId: str(m.missionId, 100), title: str(m.title, 120) })),
        ...(parseDraft(rec(body.release)?.changelog) ? { draft: parseDraft(rec(body.release)?.changelog) } : {}),
    }
}

/** The plain-text block copied from a draft: grouped by section, one bullet per entry with its idempotency marker. */
export function draftToMarkdown(draft: ReleaseDraftView): string {
    const out: string[] = []
    for (const section of ['Added', 'Fixed', 'Changed']) {
        const rows = draft.entries.filter(e => e.section === section)
        if (rows.length === 0) continue
        out.push(`### ${section}`, ...rows.map(e => `- ${e.text} ${e.marker}`.trimEnd()), '')
    }
    return out.join('\n').trim()
}
