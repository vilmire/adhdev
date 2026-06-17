import { useEffect } from 'react'
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
 * the dashboard's developer-facing English tone.
 */
const MESH_HELP_SECTIONS: HelpSection[] = [
    {
        term: 'Node',
        summary: 'A workspace participating in the mesh — a repo checkout or an isolated git worktree.',
        details: [
            'Base node vs worktree clone node — a clone isolates parallel work without conflicts.',
            'Shows health (online/offline) alongside git state (branch · ahead/behind · dirty).',
            'Multiple nodes can share the same daemon.',
        ],
    },
    {
        term: 'P2P connection',
        summary: 'How the selected coordinator reaches each remote node over WebRTC.',
        details: [
            'direct (green) — a direct host/STUN path; lowest latency.',
            'relay (amber, dashed link) — TURN-relayed; works through restrictive networks but is slower.',
            'disconnected / failed (red) — no live P2P link from the coordinator right now.',
            'The coordinator→node link edge and the node chip both carry the transport (and RTT when measured).',
        ],
    },
    {
        term: 'Session',
        summary: 'An agent CLI session running on a node.',
        details: [
            'status = idle / generating / waiting_approval.',
            'Distinguishes coordinator sessions (which dispatch and collect work) from delegated worker sessions (which do the work).',
        ],
    },
    {
        term: 'Task',
        summary: 'A single unit of work handled by the queue-based pull model.',
        details: [
            'States: pending → assigned → completed / failed / cancelled.',
            'Idle nodes claim from the queue automatically; direct dispatch targets a specific session.',
        ],
    },
    {
        term: 'Mission',
        summary: 'A multi-task batch aimed at one goal, and the durable record of that effort.',
        details: [
            'States: active / paused / completed / abandoned.',
            'Progress is derived from the states of its member tasks.',
        ],
    },
    {
        term: 'Refinery (refine)',
        summary: 'The process of safely converging and merging a worktree branch into the base.',
        details: [
            'Config-driven (.adhdev/refine.*) — guarded by a patch-equivalence preflight and a no-op guard.',
            'ff-only by principle; no force-push.',
            'If a submodule commit is unreachable from origin it must be published → classified as blocked_review.',
        ],
    },
    {
        term: 'Completion model',
        summary: 'Completion of delegated work is persisted to the queue (pending-events).',
        details: [
            'The coordinator learns of completion via periodic polling or events.',
            'Because it is persisted to the queue, completion signals are never lost.',
        ],
    },
    {
        term: 'Branch convergence states',
        summary: 'After worktree work, each branch is classified into exactly one final state.',
        details: [
            'merged_to_main — merged into the base.',
            'pushed_feature_branch_needs_merge — pushed, awaiting merge.',
            'blocked_review — held back by review/reachability issues.',
            'cleanup_candidate — ready to clean up.',
            'not_mergeable — cannot be merged.',
        ],
    },
]

/**
 * The single "?" toggle button. Mirrors the small round affordance the old
 * per-card help buttons used, so it reads as the same control — just one of it.
 */
export function MeshHelpToggle({ meshTheme, open, onToggle }: {
    meshTheme: MeshGraphTheme
    open: boolean
    onToggle: () => void
}) {
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
            aria-label="Mesh help"
            aria-expanded={open}
            title="Mesh concept help"
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
    const dk = meshTheme.isDark

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
            aria-label="Mesh concept help"
        >
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Help</div>
                    <div className={`mt-0.5 text-sm font-semibold ${meshTheme.textPrimary}`}>Mesh concepts at a glance</div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close help"
                    className={dk
                        ? 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white'
                        : 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900'}
                >
                    <IconX size={14} />
                </button>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
                {MESH_HELP_SECTIONS.map(section => (
                    <div
                        key={section.term}
                        className={`rounded-xl border p-3 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}
                    >
                        <dt className={`text-xs font-semibold ${meshTheme.textPrimary}`}>{section.term}</dt>
                        <dd className={`mt-1 text-[11px] leading-5 ${meshTheme.textSecondary}`}>{section.summary}</dd>
                        {section.details && section.details.length > 0 && (
                            <ul className={`mt-1.5 flex flex-col gap-1 text-[11px] leading-5 ${meshTheme.textMuted}`}>
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
