import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import { IconHelp, IconX } from '../Icons'

/**
 * MeshHelpPanel — the single, consolidated mesh help surface.
 *
 * Replaces the scattered per-card "?" popovers that used to live on individual
 * Overview cards (Mission, Ledger, Queue, Node, Refinery). Those each held one
 * thin definition; this one panel explains the whole mesh vocabulary in one
 * place, reachable from a single "?" toggle in the dialog's tab bar so it covers
 * both the Overview and Graph tabs.
 *
 * Content is coordinator-verified mesh terminology. Each section stays short
 * (1–3 lines) but complete; together they describe how nodes, sessions, tasks,
 * missions, the refinery, completion delivery, and branch convergence relate.
 */

type HelpSection = {
    term: string
    /** One-line headline shown next to the term. */
    summary: string
    /** Optional supporting detail lines (states, nuances). */
    details?: string[]
}

/**
 * The mesh concept reference, in reading order. Concise but not thin — matches
 * the dashboard's developer-facing English tone. Content is resolved from the
 * i18n catalog (meshGraph.help.sections.*) at render; this list just fixes the
 * reading order.
 */
const MESH_HELP_SECTION_IDS = [
    'node',
    'p2p',
    'session',
    'task',
    'mission',
    'refinery',
    'completion',
    'magi',
    'magiPanel',
    'convergence',
] as const

/**
 * The single "?" toggle button. Mirrors the small round affordance the old
 * per-card help buttons used, so it reads as the same control — just one of it.
 */
export function MeshHelpToggle({ meshTheme, open, onToggle }: {
    meshTheme: MeshGraphTheme
    open: boolean
    onToggle: () => void
}) {
    const { t } = useTranslation()
    const dk = meshTheme.isDark
    const base = 'inline-flex h-7 w-7 items-center justify-center rounded-lg border transition'
    const cls = open
        ? (dk
            ? 'border-sky-400/40 bg-sky-500/15 text-sky-100'
            : 'border-sky-400 bg-sky-100 text-sky-800')
        : (dk
            ? 'border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-slate-100'
            : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50 hover:text-slate-700')
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-label={t('meshGraph.help.toggleAria')}
            aria-expanded={open}
            title={t('meshGraph.help.toggleTitle')}
            className={`${base} ${cls}`}
        >
            <IconHelp size={15} />
        </button>
    )
}

/**
 * The collapsible help panel itself. Rendered inline (above the tab content)
 * rather than as an overlay so it never clips the dialog header — the central
 * card shell had a header-clipping regression history, so we keep this in flow.
 */
export function MeshHelpPanel({ meshTheme, onClose }: {
    meshTheme: MeshGraphTheme
    onClose: () => void
}) {
    const { t } = useTranslation()
    const dk = meshTheme.isDark

    const sections: HelpSection[] = useMemo(
        () => MESH_HELP_SECTION_IDS.map(id => ({
            term: t(`meshGraph.help.sections.${id}.term`),
            summary: t(`meshGraph.help.sections.${id}.summary`),
            details: t(`meshGraph.help.sections.${id}.details`, { returnObjects: true }) as string[],
        })),
        [t],
    )

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose])

    return (
        <div
            className={`shrink-0 rounded-2xl border p-4 ${dk ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200 bg-white/80'}`}
            role="region"
            aria-label={t('meshGraph.help.regionAria')}
        >
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className={`text-3xs font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>{t('meshGraph.help.kicker')}</div>
                    <div className={`mt-0.5 text-sm font-semibold ${meshTheme.textPrimary}`}>{t('meshGraph.help.title')}</div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('meshGraph.help.close')}
                    className={dk
                        ? 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white'
                        : 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900'}
                >
                    <IconX size={14} />
                </button>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
                {sections.map(section => (
                    <div
                        key={section.term}
                        className={`rounded-xl border p-3 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}
                    >
                        <dt className={`text-xs font-semibold ${meshTheme.textPrimary}`}>{section.term}</dt>
                        <dd className={`mt-1 text-2xs leading-5 ${meshTheme.textSecondary}`}>{section.summary}</dd>
                        {section.details && section.details.length > 0 && (
                            <ul className={`mt-1.5 flex flex-col gap-1 text-2xs leading-5 ${meshTheme.textMuted}`}>
                                {section.details.map((line, i) => (
                                    <li key={i} className="flex gap-1.5">
                                        <span aria-hidden className="select-none">·</span>
                                        <span className="min-w-0">{line}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
            </dl>
        </div>
    )
}
