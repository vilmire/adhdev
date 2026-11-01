/**
 * Releases card on the mesh Overview (design 2026-11-01-release-objects §7): the releases of this
 * mesh with a status stepper (planned -> frozen -> deployed -> verified), the member missions
 * (git state badge, outcome, open live checks and the machines they need), missions the daemon
 * only SUGGESTS (each with its own Add button), the deploy facts and the CHANGELOG draft.
 *
 * Hidden entirely when the hosting daemon predates release objects. Nothing here adds a mission on
 * its own, and "verified" is a button the person presses — the daemon only says it may be time.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, EmptyHint, StatusBadge, type Tone } from './meshOverviewPrimitives'
import type { MeshGraphTheme } from './meshGraphTheme'
import { useReleasesContext } from './useReleases'
import { RELEASE_STATUS_ORDER, draftToMarkdown, type ReleaseDetailView, type ReleaseStatusValue, type ReleaseView } from './releases-model'

const STATUS_TONE: Record<ReleaseStatusValue, Tone> = {
    planned: 'muted', frozen: 'sky', deployed: 'amber', verified: 'emerald', superseded: 'muted', cancelled: 'muted',
}
const GIT_TONE: Record<string, Tone> = { landed: 'emerald', partial: 'amber', not_landed: 'rose', unknown: 'muted', no_refs: 'muted' }
const GIT_LABEL: Record<string, string> = {
    landed: 'needsYou.gitLanded', partial: 'needsYou.gitPartial', not_landed: 'needsYou.gitNotLanded', unknown: 'needsYou.gitUnknown',
}

function Stepper({ status, label }: { status: ReleaseStatusValue; label: (s: string) => string }) {
    const at = (RELEASE_STATUS_ORDER as readonly string[]).indexOf(status)
    return (
        <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-3xs" data-testid="release-stepper">
            {RELEASE_STATUS_ORDER.map((s, i) => (
                <li key={s} data-step={s} data-done={at >= i ? 'true' : 'false'} className="flex items-center gap-1" aria-current={s === status ? 'step' : undefined}>
                    <span className={at >= i ? 'font-bold' : 'opacity-60'}>{label(s)}</span>
                    {i < RELEASE_STATUS_ORDER.length - 1 && <span aria-hidden className="opacity-40">›</span>}
                </li>
            ))}
        </ol>
    )
}

function ReleaseDetail({ meshTheme, release, others }: { meshTheme: MeshGraphTheme; release: ReleaseView; others: ReleaseView[] }) {
    const { t } = useTranslation('common')
    const releases = useReleasesContext()!
    const [detail, setDetail] = useState<ReleaseDetailView | null>(null)
    const refetch = useCallback(async () => { setDetail(await releases.loadDetail(release.id)) }, [releases, release.id])
    // The list reloads after every write (new `list` identity) and the detail follows it.
    useEffect(() => { void refetch() }, [refetch, releases.list])
    const stLabel = (s: string) => t(`mesh.overview.releases.status.${s}`)
    const open = release.status !== 'superseded' && release.status !== 'cancelled'
    const needsNote = detail ? detail.missions.filter(m => !m.releaseNote).length : 0
    const deployedAt = release.targets ? Object.values(release.targets).map(x => x.deployedAt).filter(Boolean).sort().pop() : undefined
    return (
        <div className="mt-2 flex min-w-0 flex-col gap-2 border-t border-border-subtle pt-2" data-testid="release-detail">
            <Stepper status={release.status} label={stLabel} />
            <div className={`text-3xs ${meshTheme.textMuted}`}>
                {release.headCommit
                    ? t('mesh.overview.releases.deployFacts', { commit: release.headCommit.slice(0, 10) }) + (release.version ? ` · ${release.version}` : '') + (deployedAt ? ` · ${new Date(deployedAt).toLocaleString()}` : '')
                    : t('mesh.overview.releases.notDeployed')}
            </div>
            {open && (
                <div className="flex flex-wrap items-center gap-2">
                    {release.status === 'planned' && (
                        <button type="button" data-testid="release-freeze" className="rounded border border-border-subtle px-2 py-0.5 text-3xs" disabled={releases.busy} onClick={() => { void releases.setStatus(release.id, 'frozen') }}>
                            {t('mesh.overview.releases.freeze')}
                        </button>
                    )}
                    {release.status === 'deployed' && (
                        <>
                            <button type="button" data-testid="release-verify" className="rounded border border-border-subtle px-2 py-0.5 text-3xs" disabled={releases.busy} onClick={() => { void releases.setStatus(release.id, 'verified') }}>
                                {t('mesh.overview.releases.markVerified')}
                            </button>
                            {detail && <span data-testid="release-verify-hint" className={`text-3xs ${meshTheme.textMuted}`}>
                                {detail.verified.suggested ? t('mesh.overview.releases.verifiedSuggested') : t('mesh.overview.releases.verifyWaiting', { count: detail.verified.openLiveChecks })}
                            </span>}
                        </>
                    )}
                </div>
            )}
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="release-missions">
                {detail && detail.missions.length === 0 && <li><EmptyHint meshTheme={meshTheme}>{t('mesh.overview.releases.noMissions')}</EmptyHint></li>}
                {detail?.missions.map(m => (
                    <li key={m.missionId} data-testid="release-mission" data-mission-id={m.missionId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs">
                        <span className={`min-w-0 flex-1 truncate ${meshTheme.textPrimary}`} title={m.releaseNote ?? m.title}>{m.title}</span>
                        {m.gitState && GIT_LABEL[m.gitState] && <StatusBadge meshTheme={meshTheme} label={t(GIT_LABEL[m.gitState])} tone={GIT_TONE[m.gitState] ?? 'muted'} />}
                        {m.outcome && <span className={`text-3xs ${meshTheme.textMuted}`}>{m.outcome}</span>}
                        {m.openLiveChecks > 0 && <span className="text-3xs tabular-nums" title={m.machines.join(', ')}>{t('mesh.overview.releases.liveChecksOpen', { count: m.openLiveChecks })}{m.machines.length ? ` (${m.machines.join(', ')})` : ''}</span>}
                        {open && (
                            <>
                                <select
                                    aria-label={t('mesh.overview.releases.moveTo')}
                                    data-testid="release-mission-move"
                                    className="max-w-[9rem] rounded border border-border-subtle bg-bg-card px-1 py-0.5 text-3xs"
                                    value="" disabled={releases.busy || others.length === 0}
                                    onChange={e => { if (e.target.value) void releases.scope(release.id, { move: [{ missionId: m.missionId, toReleaseId: e.target.value }] }) }}
                                >
                                    <option value="">{t('mesh.overview.releases.moveTo')}</option>
                                    {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                                </select>
                                <button type="button" data-testid="release-mission-remove" className="rounded border border-border-subtle px-1.5 py-0.5 text-3xs" disabled={releases.busy} onClick={() => { void releases.scope(release.id, { remove: [m.missionId] }) }}>
                                    {t('mesh.overview.releases.remove')}
                                </button>
                            </>
                        )}
                    </li>
                ))}
            </ul>
            {open && detail && detail.suggestedMissions.length > 0 && (
                <div className="flex flex-col gap-1" data-testid="release-suggestions">
                    <div className="text-3xs font-bold">{t('mesh.overview.releases.suggested')}</div>
                    <div className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.releases.suggestedHint')}</div>
                    {detail.suggestedMissions.map(s => (
                        <div key={s.missionId} data-testid="release-suggestion" className="flex min-w-0 items-center gap-2 text-2xs">
                            <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`}>{s.title}</span>
                            <button type="button" data-testid="release-suggestion-add" className="rounded border border-border-subtle px-1.5 py-0.5 text-3xs" disabled={releases.busy} onClick={() => { void releases.scope(release.id, { add: [s.missionId] }) }}>
                                {t('mesh.overview.releases.add')}
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex flex-col gap-1" data-testid="release-draft">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-3xs font-bold">{t('mesh.overview.releases.draft')}</span>
                    <button type="button" data-testid="release-draft-generate" className="rounded border border-border-subtle px-1.5 py-0.5 text-3xs" disabled={releases.busy} onClick={() => { void releases.draft(release.id).then(d => { if (d) setDetail(d) }) }}>
                        {t('mesh.overview.releases.generateDraft')}
                    </button>
                    {detail?.draft && detail.draft.entries.length > 0 && (
                        <button type="button" data-testid="release-draft-copy" className="rounded border border-border-subtle px-1.5 py-0.5 text-3xs" onClick={() => { try { void navigator.clipboard?.writeText(draftToMarkdown(detail.draft!)) } catch { /* clipboard unavailable */ } }}>
                            {t('mesh.overview.releases.copyDraft')}
                        </button>
                    )}
                    {needsNote > 0 && <span data-testid="release-needs-note" className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.releases.needsNote', { count: needsNote })}</span>}
                </div>
                {detail?.draft && (
                    <pre data-testid="release-draft-text" className={`m-0 max-h-48 overflow-auto whitespace-pre-wrap text-3xs ${meshTheme.textSecondary}`}>{detail.draft.entries.length === 0 ? t('mesh.overview.releases.draftEmpty') : draftToMarkdown(detail.draft)}</pre>
                )}
                {detail?.draft && detail.draft.warnings.length > 0 && (
                    <div data-testid="release-draft-warnings" className="text-3xs" style={{ color: 'var(--status-warning)' }}>
                        {t('mesh.overview.releases.draftWarnings')}: {detail.draft.warnings.map(w => detail.missions.find(m => m.missionId === w.missionId)?.title ?? w.missionId.slice(0, 8)).join(', ')}
                    </div>
                )}
            </div>
        </div>
    )
}

function NewRelease({ meshTheme }: { meshTheme: MeshGraphTheme }) {
    const { t } = useTranslation('common')
    const releases = useReleasesContext()!
    const [name, setName] = useState('')
    const [channel, setChannel] = useState<'preview' | 'stable'>('preview')
    return (
        <form
            className="mt-2 flex flex-wrap items-center gap-2" data-testid="release-new"
            onSubmit={e => { e.preventDefault(); if (name.trim()) void releases.create(name.trim(), channel).then(ok => { if (ok) setName('') }) }}
        >
            <input
                data-testid="release-new-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('mesh.overview.releases.namePlaceholder')}
                aria-label={t('mesh.overview.releases.newRelease')} maxLength={80}
                className={`min-w-0 flex-1 rounded border border-border-subtle bg-bg-card px-2 py-1 text-2xs ${meshTheme.textPrimary}`}
            />
            <select data-testid="release-new-channel" value={channel} onChange={e => setChannel(e.target.value === 'stable' ? 'stable' : 'preview')} className="rounded border border-border-subtle bg-bg-card px-1 py-1 text-2xs">
                <option value="preview">{t('mesh.overview.releases.channelPreview')}</option>
                <option value="stable">{t('mesh.overview.releases.channelStable')}</option>
            </select>
            <button type="submit" data-testid="release-new-submit" disabled={releases.busy || !name.trim()} className="rounded border border-border-subtle px-2 py-1 text-2xs">
                {t('mesh.overview.releases.create')}
            </button>
        </form>
    )
}

export default function ReleasesPanel({ meshTheme }: { meshTheme: MeshGraphTheme }) {
    const { t } = useTranslation('common')
    const releases = useReleasesContext()
    const [selected, setSelected] = useState<string | null>(null)
    if (!releases?.list) return null
    const list = releases.list.releases
    const current = list.find(r => r.id === selected) ?? null
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.releases.card')} count={list.length || undefined}>
            {list.length === 0 && <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.releases.empty')}</EmptyHint>}
            <div className="flex flex-col gap-0.5" data-testid="release-list">
                {list.map(r => (
                    <button
                        key={r.id} type="button" data-testid="release-row" data-release-id={r.id} aria-expanded={r.id === selected}
                        className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-xs"
                        onClick={() => setSelected(v => (v === r.id ? null : r.id))}
                    >
                        <StatusBadge meshTheme={meshTheme} label={t(`mesh.overview.releases.status.${r.status}`)} tone={STATUS_TONE[r.status]} />
                        <span className={`min-w-0 flex-1 truncate font-medium ${meshTheme.textPrimary}`}>{r.name}</span>
                        <span className={`shrink-0 text-3xs tabular-nums ${meshTheme.textMuted}`}>{t('mesh.overview.releases.missionCount', { count: r.missionCount })}</span>
                    </button>
                ))}
            </div>
            {current && <ReleaseDetail meshTheme={meshTheme} release={current} others={list.filter(r => r.id !== current.id && r.status !== 'superseded' && r.status !== 'cancelled')} />}
            <NewRelease meshTheme={meshTheme} />
            {releases.error && <div role="alert" data-testid="release-error" className="mt-2 text-3xs" style={{ color: 'var(--status-error)' }}>{t('mesh.overview.releases.error', { error: releases.error })}</div>}
        </Card>
    )
}
