/**
 * "To do" panel body — everything waiting on the owner (structured-missions design 2026-10-28
 * §6.2): open decisions, agent approvals, held owner approvals (driver activations, assistant
 * writes), live checks and the coordinator's "closed as owner abandoned — correct?" confirmations,
 * most urgent first, with a kind filter and a project filter. Rendered inside the right-side
 * drawer / mobile bottom sheet (`TodoDrawer`), which owns the title, the count and the close button.
 *
 * Deep link: `?todo=1&mesh=<meshId>&decision=<itemId>&choose=<optionId>` (the old
 * `/needs-you` route redirects here) scrolls to that decision's card with the option
 * preselected (one confirm tap answers). Push notifications and chat auto-links land here.
 *
 * Shared by web-standalone and web-cloud; transport policy is unchanged — all commands go
 * through TransportContext (cloud: P2P only).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTransport } from '../../context/TransportContext'
import { useNeedsYou } from '../../context/NeedsYouContext'
import PendingApprovalsInbox, {
    buildApprovalSessionActiveTabTarget,
    type PendingApprovalAction,
    type PendingApprovalExactButton,
    type PendingApprovalItem,
} from '../MeshGraph/PendingApprovalsInbox'
import type { ProviderApprovalTarget } from '@adhdev/mesh-shared'
import Button from '../ui/Button'
import { AssistantStagedWritesList } from '../dashboard/AssistantStagedWrites'
import { getMeshName } from '../../utils/mesh-name-registry'
import DecisionCard, { AnsweredCard, ProjectMissionLine, localizeConfirmation } from './DecisionCard'
import {
    NEEDS_YOU_KINDS,
    clearDecisionFromQuery,
    entryFilterKind,
    entryMeshId,
    filterNeedsYou,
    parseNeedsYouQuery,
    planRecommendedAnswers,
    sortNeedsYou,
    type NeedsYouDecision,
    type NeedsYouEntry,
    type NeedsYouFilter,
    type NeedsYouKind,
    type RecommendedPlanLine,
} from './needs-you-model'

const TICK_MS = 15_000
const TOAST_MS = 6_000

type AnswerAllState =
    | { phase: 'idle' }
    | { phase: 'preview'; lines: RecommendedPlanLine[] }
    | { phase: 'running'; lines: RecommendedPlanLine[] }
    | { phase: 'done'; results: Array<{ line: RecommendedPlanLine; ok: boolean; code?: string }> }

interface Toast { message: string; undo?: () => void }

export default function TodoPanel() {
    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const location = useLocation()
    const { sendCommand } = useTransport()
    const state = useNeedsYou()
    const link = useMemo(() => parseNeedsYouQuery(location.search), [location.search])

    const [filter, setFilter] = useState<NeedsYouFilter>(() => ({ kind: 'all', meshId: link.meshId && !link.decisionId ? link.meshId : 'all' }))
    const [later, setLater] = useState<ReadonlySet<string>>(() => new Set())
    const [answerAll, setAnswerAll] = useState<AnswerAllState>({ phase: 'idle' })
    const [toast, setToast] = useState<Toast | null>(null)
    const [nowMs, setNowMs] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), TICK_MS)
        return () => clearInterval(timer)
    }, [])
    useEffect(() => {
        if (!toast) return
        const timer = setTimeout(() => setToast(null), TOAST_MS)
        return () => clearTimeout(timer)
    }, [toast])
    // A deep link to a mesh (Overview badge) narrows the project filter when the link changes.
    useEffect(() => {
        if (link.meshId && !link.decisionId) setFilter(f => ({ ...f, meshId: link.meshId! }))
    }, [link.meshId, link.decisionId])

    const sorted = useMemo(() => sortNeedsYou(state.entries), [state.entries])
    const filtered = useMemo(() => filterNeedsYou(sorted, filter), [sorted, filter])
    const visible = useMemo(() => filtered.filter(e => !later.has(e.key)), [filtered, later])
    const hiddenCount = filtered.length - visible.length

    const projectOptions = useMemo(() => {
        const ids = new Set<string>()
        for (const e of sorted) { const id = entryMeshId(e); if (id) ids.add(id) }
        return [...ids].map(id => ({ id, name: state.snapshot.meshNames[id] ?? getMeshName(id) ?? id.slice(0, 8) }))
    }, [sorted, state.snapshot.meshNames])
    const nameOf = useCallback((meshId: string) => state.snapshot.meshNames[meshId] ?? getMeshName(meshId) ?? meshId.slice(0, 8), [state.snapshot.meshNames])

    const kindCounts = useMemo(() => {
        const c: Record<NeedsYouKind, number> = { decision: 0, approval: 0, live_check: 0, confirmation: 0 }
        for (const e of sorted) c[entryFilterKind(e)]++
        return c
    }, [sorted])

    // A handled deep link must not re-target an answered/dismissed card on reload: drop decision/choose, keep mesh.
    const clearDeepLink = useCallback((itemId: string) => {
        if (link.decisionId !== itemId) return
        navigate({ pathname: location.pathname, search: clearDecisionFromQuery(location.search) }, { replace: true })
    }, [link.decisionId, location.pathname, location.search, navigate])

    const answerDecision = useCallback(async (d: NeedsYouDecision, input: { optionId?: string; text?: string }, confirmation = false) => {
        const outcome = await state.answer({ daemonId: d.daemonId, meshId: d.meshId, missionId: d.missionId, itemId: d.itemId, ...input })
        if (outcome.ok) {
            clearDeepLink(d.itemId)
            const options = localizeConfirmation(t, d, confirmation).options
            const label = input.optionId ? options.find(o => o.id === input.optionId)?.label ?? input.optionId : input.text ?? ''
            setToast({
                message: t('needsYou.toastAnswered', { answer: label }),
                undo: () => { setToast(null); void state.answer({ daemonId: d.daemonId, meshId: d.meshId, missionId: d.missionId, itemId: d.itemId, undo: true }) },
            })
        }
        return outcome
    }, [state, t, clearDeepLink])

    const startAnswerAll = () => setAnswerAll({ phase: 'preview', lines: planRecommendedAnswers(visible) })
    const applyAnswerAll = async () => {
        if (answerAll.phase !== 'preview') return
        const lines = answerAll.lines
        setAnswerAll({ phase: 'running', lines })
        const results: Array<{ line: RecommendedPlanLine; ok: boolean; code?: string }> = []
        for (const line of lines) {
            const o = await state.answer({
                daemonId: line.decision.daemonId, meshId: line.decision.meshId, missionId: line.decision.missionId,
                itemId: line.decision.itemId, optionId: line.optionId,
            })
            results.push({ line, ok: o.ok, ...(o.ok ? {} : { code: o.code }) })
        }
        setAnswerAll({ phase: 'done', results })
    }

    const resolveApproval = useCallback(
        async (nodeId: string, sessionId: string, action: PendingApprovalAction, approvalTarget?: ProviderApprovalTarget, exact?: PendingApprovalExactButton) => {
            if (!approvalTarget) return
            await sendCommand(nodeId, 'resolve_action', {
                action, sessionId, approvalTarget,
                ...(exact ? { button: exact.button, buttonIndex: exact.buttonIndex } : {}),
            })
        },
        [sendCommand],
    )
    const openSession = useCallback((item: PendingApprovalItem) => {
        navigate(`/dashboard?activeTab=${encodeURIComponent(buildApprovalSessionActiveTabTarget(item))}`)
    }, [navigate])

    const approvalsVisible = visible.filter((e): e is Extract<NeedsYouEntry, { kind: 'approval' }> => e.kind === 'approval').map(e => e.approval)
    const answeredVisible = (filter.kind === 'all' || filter.kind === 'decision' || filter.kind === 'confirmation')
        ? state.snapshot.answered.filter(a => filter.meshId === 'all' || a.meshId === filter.meshId)
        : []
    const recommendedCount = planRecommendedAnswers(visible).length
    const empty = visible.length === 0

    const stagedVisible = visible.filter((e): e is Extract<NeedsYouEntry, { kind: 'staged' }> => e.kind === 'staged').map(e => e.item)

    const renderEntry = (e: Exclude<NeedsYouEntry, { kind: 'approval' | 'staged' }>) => {
        if (e.kind === 'live_check') {
            const c = e.check
            return (
                <div key={e.key} data-testid="needs-you-live-check" className="rounded-lg border border-border-subtle p-3 flex flex-col gap-1.5 bg-bg-panel">
                    <div className="flex items-center gap-1.5">
                        <span className="rounded px-1.5 py-0.5 text-3xs font-semibold bg-bg-secondary text-text-muted">{t('needsYou.kinds.live_check')}</span>
                        {c.machine && <span className="text-3xs text-text-muted">{c.machine}</span>}
                    </div>
                    <ProjectMissionLine meshId={c.meshId} missionTitle={c.missionTitle} carryOver={c.carryOver} projectName={nameOf(c.meshId)} onOpenMission={() => navigate('/mesh')} />
                    <div className="text-sm text-text-primary">{c.text}</div>
                </div>
            )
        }
        const d = e.decision
        const deepLinked = link.decisionId === d.itemId && (!link.meshId || link.meshId === d.meshId)
        const preselect = deepLinked && link.choose && d.options.some(o => o.id === link.choose) ? link.choose : undefined
        return (
            <DecisionCard
                key={e.key}
                decision={d}
                confirmation={e.kind === 'confirmation'}
                busy={state.busyIds.has(d.itemId)}
                outcome={state.outcomes[d.itemId]}
                nowMs={nowMs}
                projectName={nameOf(d.meshId)}
                preselect={preselect}
                highlighted={deepLinked}
                onAnswer={input => { void answerDecision(d, input, e.kind === 'confirmation') }}
                onLater={() => { setLater(prev => new Set(prev).add(e.key)); clearDeepLink(d.itemId) }}
                onOpenMission={() => navigate('/mesh')}
            />
        )
    }

    // Approvals lead (an agent is blocked right now), then decisions → confirmations → live checks, each already sorted.
    const nonApprovals = visible.filter((e): e is Exclude<NeedsYouEntry, { kind: 'approval' | 'staged' }> => e.kind !== 'approval' && e.kind !== 'staged')

    return (
        <div className="flex flex-col gap-3 p-3 md:p-4" data-testid="todo-panel">
            <div className="flex flex-wrap items-center gap-2" data-testid="needs-you-filters">
                <div className="flex flex-wrap gap-1" role="group" aria-label={t('needsYou.filterKind')}>
                    {(['all', ...NEEDS_YOU_KINDS] as const).map(k => (
                        <Button key={k} size="sm" className="min-h-[44px] md:min-h-0" variant={filter.kind === k ? 'primary' : 'ghost'} aria-pressed={filter.kind === k} onClick={() => setFilter(f => ({ ...f, kind: k }))}>
                            {k === 'all' ? t('needsYou.kinds.all') : `${t(`needsYou.kinds.${k}`)} ${kindCounts[k]}`}
                        </Button>
                    ))}
                </div>
                {projectOptions.length > 0 && (
                    <select
                        className="input text-xs min-h-[44px] md:min-h-0"
                        aria-label={t('needsYou.filterProject')}
                        value={filter.meshId}
                        onChange={e => setFilter(f => ({ ...f, meshId: e.target.value }))}
                    >
                        <option value="all">{t('needsYou.allProjects')}</option>
                        {projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                )}
                <div className="flex-1" />
                <Button size="sm" className="min-h-[44px] md:min-h-0" variant="secondary" disabled={recommendedCount === 0 || answerAll.phase === 'running'} onClick={startAnswerAll}>
                    {t('needsYou.answerAllRecommended', { count: recommendedCount })}
                </Button>
            </div>

            {answerAll.phase === 'preview' && (
                <div className="rounded-lg border border-border-subtle p-3 flex flex-col gap-2 bg-bg-panel" data-testid="needs-you-answer-all-preview">
                    <div className="text-xs font-semibold">{t('needsYou.previewTitle', { count: answerAll.lines.length })}</div>
                    {answerAll.lines.length === 0
                        ? <div className="text-xs text-text-muted">{t('needsYou.previewNothing')}</div>
                        : <ul className="flex flex-col gap-1 text-xs">{answerAll.lines.map(l => (
                            <li key={`${l.decision.meshId}:${l.decision.itemId}`}>{l.decision.question} <span className="text-text-muted">→</span> <b>{l.optionLabel}</b></li>
                        ))}</ul>}
                    <div className="flex gap-2">
                        <Button size="sm" variant="primary" disabled={answerAll.lines.length === 0} onClick={() => { void applyAnswerAll() }}>{t('needsYou.apply')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setAnswerAll({ phase: 'idle' })}>{t('needsYou.cancel')}</Button>
                    </div>
                </div>
            )}
            {answerAll.phase === 'running' && <div className="text-xs text-text-muted" role="status">{t('needsYou.applying')}</div>}
            {answerAll.phase === 'done' && (
                <div className="rounded-lg border border-border-subtle p-3 flex flex-col gap-2 bg-bg-panel" data-testid="needs-you-answer-all-result">
                    <div className="text-xs font-semibold">{t('needsYou.resultTitle', { ok: answerAll.results.filter(r => r.ok).length, total: answerAll.results.length })}</div>
                    <ul className="flex flex-col gap-1 text-xs">{answerAll.results.map(r => (
                        <li key={`${r.line.decision.meshId}:${r.line.decision.itemId}`}>
                            {r.ok ? '✓' : '✗'} {r.line.decision.question} <span className="text-text-muted">→</span> <b>{r.line.optionLabel}</b>
                            {!r.ok && <span style={{ color: 'var(--status-error)' }}> ({r.code})</span>}
                        </li>
                    ))}</ul>
                    <div><Button size="sm" variant="ghost" onClick={() => setAnswerAll({ phase: 'idle' })}>{t('needsYou.dismiss')}</Button></div>
                </div>
            )}

            {!state.loaded ? (
                <div className="text-xs opacity-60 py-6 text-center">{t('needsYou.loading')}</div>
            ) : (
                <>
                    {approvalsVisible.length > 0 && (
                        <PendingApprovalsInbox approvals={approvalsVisible} onResolve={resolveApproval} onOpenSession={openSession} hideWhenEmpty nowMs={nowMs} />
                    )}
                    {stagedVisible.length > 0 && (
                        <section className="flex flex-col gap-2 text-xs text-text-secondary" data-testid="needs-you-staged" aria-label={t('assistantStaged.title')}>
                            <AssistantStagedWritesList state={state.staged} items={stagedVisible} />
                        </section>
                    )}
                    {nonApprovals.map(renderEntry)}
                    {empty && <div className="text-xs opacity-60 py-6 text-center" data-testid="needs-you-empty">{t('needsYou.empty')}</div>}
                    {hiddenCount > 0 && (
                        <button type="button" className="text-2xs text-text-muted underline decoration-dotted self-start" onClick={() => setLater(new Set())}>
                            {t('needsYou.showLater', { count: hiddenCount })}
                        </button>
                    )}
                    {answeredVisible.length > 0 && (
                        <section className="flex flex-col gap-2" aria-label={t('needsYou.recentlyAnswered')}>
                            <h2 className="text-xs font-bold text-text-muted uppercase">{t('needsYou.recentlyAnswered')}</h2>
                            {answeredVisible.map(a => (
                                <AnsweredCard
                                    key={`${a.meshId}:${a.itemId}`}
                                    item={a}
                                    busy={state.busyIds.has(a.itemId)}
                                    nowMs={nowMs}
                                    projectName={nameOf(a.meshId)}
                                    onUndo={() => { void state.answer({ daemonId: a.daemonId, meshId: a.meshId, missionId: a.missionId, itemId: a.itemId, undo: true }) }}
                                    onChange={input => { void state.answer({ daemonId: a.daemonId, meshId: a.meshId, missionId: a.missionId, itemId: a.itemId, ...input }) }}
                                />
                            ))}
                        </section>
                    )}
                </>
            )}

            {toast && (
                <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] max-w-[92vw] rounded-lg border border-border-subtle bg-bg-panel px-3 py-2 text-xs shadow-lg flex items-center gap-3" role="status" data-testid="needs-you-toast">
                    <span>{toast.message}</span>
                    {toast.undo && <Button size="sm" variant="ghost" onClick={toast.undo}>{t('needsYou.undo')}</Button>}
                </div>
            )}
        </div>
    )
}
