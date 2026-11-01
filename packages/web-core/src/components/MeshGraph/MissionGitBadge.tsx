/**
 * Git evidence badge on the Overview mission cards (design 2026-11-01-mission-git-refs §6):
 * whether the commits/branches a mission's items reference are already on the default branch,
 * judged by the hosting daemon from git objects. Four states, each with a LABEL (colour is
 * never the only signal): landed / partly landed / not landed / git unknown.
 *
 * `landed` is evidence, not completion — the popover says so, and nothing here closes a
 * mission. The data is read with `mesh_mission_git_eval` over the normal dashboard command
 * path (P2P in cloud); an older daemon without the command simply shows no badge.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransport } from '../../context/TransportContext'
import { unwrapCommandBody } from '../needs-you/needs-you-model'
import type { MeshGraphTheme } from './meshGraphTheme'

export type MissionGitStateValue = 'no_refs' | 'landed' | 'partial' | 'not_landed' | 'unknown'
export interface MissionGitRefView {
    refKey: string
    status: 'contained_ancestor' | 'contained_patch_equivalent' | 'not_contained' | 'unknown'
    method?: string
    evaluatedAt?: string
    unknownReason?: string
    note?: string
}
export interface MissionGitView {
    state: MissionGitStateValue
    partialUnknown?: boolean
    baseRef?: string
    baseSha?: string
    evaluatedAt?: string
    refs: MissionGitRefView[]
}

const STATES: readonly MissionGitStateValue[] = ['no_refs', 'landed', 'partial', 'not_landed', 'unknown']
const REF_STATUSES = ['contained_ancestor', 'contained_patch_equivalent', 'not_contained', 'unknown'] as const

/** Re-project a daemon answer by allow-list; anything unusable is dropped (never thrown on). */
export function parseMissionGit(raw: unknown): MissionGitView | null {
    const body = unwrapCommandBody(raw)
    if (!body || body.success === false) return null
    const g = body.gitState
    if (!g || typeof g !== 'object') return null
    if (!STATES.includes(g.state)) return null
    const refs: MissionGitRefView[] = []
    for (const r of Array.isArray(g.refs) ? g.refs.slice(0, 24) : []) {
        if (!r || typeof r.refKey !== 'string' || !(REF_STATUSES as readonly string[]).includes(r.status)) continue
        refs.push({
            refKey: r.refKey.slice(0, 200), status: r.status,
            ...(typeof r.method === 'string' ? { method: r.method } : {}),
            ...(typeof r.evaluatedAt === 'string' ? { evaluatedAt: r.evaluatedAt } : {}),
            ...(typeof r.unknownReason === 'string' ? { unknownReason: r.unknownReason } : {}),
            ...(typeof r.note === 'string' ? { note: r.note } : {}),
        })
    }
    return {
        state: g.state,
        ...(g.partialUnknown === true ? { partialUnknown: true } : {}),
        ...(typeof g.baseRef === 'string' ? { baseRef: g.baseRef } : {}),
        ...(typeof g.baseSha === 'string' ? { baseSha: g.baseSha } : {}),
        ...(typeof g.evaluatedAt === 'string' ? { evaluatedAt: g.evaluatedAt } : {}),
        refs,
    }
}

/**
 * Reads a mission's git state. Open (active/paused) missions are evaluated by the daemon when
 * its cache is stale; closed ones are only read from the cache (design §5: no automatic
 * re-evaluation of finished missions). `refresh()` forces a fetch + re-evaluation.
 */
export function useMissionGit(target: { daemonId?: string; meshId?: string; missionId: string; open: boolean }): {
    git: MissionGitView | null
    loading: boolean
    refresh: () => Promise<void>
} {
    const { sendCommand } = useTransport()
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const [git, setGit] = useState<MissionGitView | null>(null)
    const [loading, setLoading] = useState(false)
    const seq = useRef(0)
    const { daemonId, meshId, missionId, open } = target

    const load = useCallback(async (force: boolean) => {
        if (!daemonId || !meshId) return
        const mine = ++seq.current
        setLoading(true)
        try {
            const raw = await sendRef.current(daemonId, 'mesh_mission_git_eval', {
                meshId, missionId, verbose: true,
                ...(force ? { refresh: true } : {}),
                ...(!force && !open ? { cachedOnly: true } : {}),
            })
            if (mine === seq.current) setGit(parseMissionGit(raw))
        } catch {
            if (mine === seq.current) setGit(null) // older daemon / offline: no badge, no noise
        } finally {
            if (mine === seq.current) setLoading(false)
        }
    }, [daemonId, meshId, missionId, open])

    useEffect(() => { void load(false) }, [load])
    return { git, loading, refresh: useCallback(() => load(true), [load]) }
}

const TONE: Record<Exclude<MissionGitStateValue, 'no_refs'>, string> = {
    landed: 'var(--status-online)',
    partial: 'var(--status-warning)',
    not_landed: 'var(--status-error)',
    unknown: 'var(--text-muted, currentColor)',
}
const LABEL_KEY: Record<Exclude<MissionGitStateValue, 'no_refs'>, string> = {
    landed: 'needsYou.gitLanded',
    partial: 'needsYou.gitPartial',
    not_landed: 'needsYou.gitNotLanded',
    unknown: 'needsYou.gitUnknown',
}

function shortRef(refKey: string): string {
    const [kind, repo, ...rest] = refKey.split(':')
    const value = rest.join(':')
    const shown = kind === 'commit' ? value.slice(0, 10) : value
    return `${repo ? `${repo}/` : ''}${shown}`
}

/** Whether the badge has anything to show (no refs / never evaluated → nothing). */
export function hasMissionGit(git: MissionGitView | null): git is MissionGitView {
    return !!git && git.state !== 'no_refs' && git.refs.length > 0
}

export default function MissionGitBadge({ meshTheme, missionId, git, loading, refresh }: {
    meshTheme: MeshGraphTheme
    missionId: string
    git: MissionGitView
    loading: boolean
    refresh: () => Promise<void>
}) {
    const { t } = useTranslation('common')
    const [expanded, setExpanded] = useState(false)
    const state = git.state === 'no_refs' ? 'unknown' : git.state
    const tone = TONE[state]
    const panelId = `mission-git-${missionId}`
    return (
        <span className="inline-flex min-w-0 flex-col" data-testid="mission-git">
            <button
                type="button"
                data-testid="mission-git-badge"
                data-git-state={state}
                className="rounded px-1.5 py-0.5 text-3xs font-bold"
                style={{ background: `color-mix(in srgb, ${tone} 18%, transparent)`, color: tone }}
                title={t('needsYou.gitTooltip')}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setExpanded(v => !v)}
            >
                {t(LABEL_KEY[state])}{git.partialUnknown ? ' ?' : ''}
            </button>
            {expanded && (
                <div id={panelId} data-testid="mission-git-panel" className={`mt-1 flex min-w-0 flex-col gap-0.5 text-3xs ${meshTheme.textMuted}`}>
                    <div className="font-bold">{t('needsYou.gitTitle')}</div>
                    {git.baseRef && <div>{t('needsYou.gitBase', { base: git.baseRef, sha: (git.baseSha ?? '').slice(0, 10) || '—' })}</div>}
                    {git.evaluatedAt && <div>{t('needsYou.gitEvaluated', { time: new Date(git.evaluatedAt).toLocaleString() })}</div>}
                    {git.partialUnknown && <div>{t('needsYou.gitPartialUnknown')}</div>}
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {git.refs.map(r => (
                            <li key={r.refKey} data-testid="mission-git-ref" data-ref-status={r.status} className="min-w-0 truncate" title={r.refKey}>
                                <span className="font-mono">{shortRef(r.refKey)}</span>
                                {' — '}{t(`needsYou.gitRefStatus.${r.status}`)}
                                {r.status === 'unknown' && r.unknownReason ? ` (${t(`needsYou.gitReason.${r.unknownReason}`, { defaultValue: r.unknownReason })})` : ''}
                                {r.note === 'modified_since_landing_possible' ? ` — ${t('needsYou.gitMayBeModified')}` : ''}
                            </li>
                        ))}
                    </ul>
                    {state === 'landed' && <div>{t('needsYou.gitLandedNote')}</div>}
                    {state === 'unknown' && <div>{t('needsYou.gitUnknownNote')}</div>}
                    <button type="button" data-testid="mission-git-refresh" className="self-start underline" disabled={loading} onClick={() => { void refresh() }}>
                        {loading ? t('needsYou.gitRefreshing') : t('needsYou.gitRefresh')}
                    </button>
                </div>
            )}
        </span>
    )
}
