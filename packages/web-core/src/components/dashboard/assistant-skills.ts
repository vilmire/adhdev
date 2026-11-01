/**
 * The assistant's skills as the owner sees them (design
 * 2026-11-01-procedure-skills.md §3, §9): the `assistant_skills_list` answer
 * shaped for display. The verb is owner-only and reads without moving a
 * counter. "Attached" counts how often the skill's body was handed to a
 * coordinator — not that it was followed — and is kept apart from "viewed"
 * (the assistant read it). Defensive about unknown shapes, like assistant-staged.ts.
 */
import { unwrapStagedAnswer } from './assistant-staged'

/** Same string as the daemon's `ASSISTANT_VERB.skillsList`. */
export const ASSISTANT_SKILLS_LIST_COMMAND = 'assistant_skills_list' as const
/** Owner store admin verb (pin / unpin / restore / archive). */
export const ASSISTANT_STORE_ADMIN_COMMAND = 'assistant_store_admin' as const

export type AssistantSkillStatus = 'active' | 'stale' | 'archived'
export type AssistantSkillOrigin = 'agent' | 'owner' | 'imported' | 'starter'

export interface AssistantSkillRow {
    name: string
    description: string
    status: AssistantSkillStatus
    origin: AssistantSkillOrigin | string
    pinned: boolean
    attachCount: number
    viewCount: number
    /** Latest of attach / view, ISO; null when never used. */
    lastUsedAt: string | null
    project?: string
    problem?: string
}

export interface AssistantSkillsSummary {
    days: number
    sends: number
    attaches: number
    reuseRate: number | null
    proposalAcceptRate: number | null
    hintHitRate: number | null
}

export interface AssistantSkillsList {
    skills: AssistantSkillRow[]
    summary: AssistantSkillsSummary | null
}

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const ratio = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function latest(a: string, b: string): string | null {
    const ta = a ? Date.parse(a) : NaN
    const tb = b ? Date.parse(b) : NaN
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null
    return !Number.isFinite(tb) || (Number.isFinite(ta) && ta >= tb) ? a : b
}

/** The list answer → rows, most attached first; null when the daemon has no such verb or refused. */
export function parseSkillsList(raw: unknown): AssistantSkillsList | null {
    const r = unwrapStagedAnswer(raw)
    if (!r || r.success === false || !Array.isArray(r.skills)) return null
    const skills: AssistantSkillRow[] = []
    for (const x of r.skills) {
        const row = rec(x)
        const name = str(row?.name)
        if (!row || !name) continue
        const status = row.status === 'stale' || row.status === 'archived' ? row.status : 'active'
        skills.push({
            name,
            description: str(row.description),
            status,
            origin: str(row.origin) || 'owner',
            pinned: row.pinned === true,
            attachCount: count(row.attachCount),
            viewCount: count(row.viewCount),
            lastUsedAt: latest(str(row.lastAttachedAt), str(row.lastViewedAt)),
            ...(str(row.project) ? { project: str(row.project) } : {}),
            ...(str(row.problem) ? { problem: str(row.problem) } : {}),
        })
    }
    skills.sort((a, b) => b.attachCount - a.attachCount || a.name.localeCompare(b.name))
    const m = rec(r.metrics)
    return {
        skills,
        summary: m
            ? {
                days: count(m.days) || 14, sends: count(m.sends), attaches: count(m.attaches),
                reuseRate: ratio(m.reuseRate), proposalAcceptRate: ratio(m.proposalAcceptRate), hintHitRate: ratio(m.hintHitRate),
            }
            : null,
    }
}
