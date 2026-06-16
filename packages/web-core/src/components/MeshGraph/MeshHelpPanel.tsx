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
 * The mesh concept reference, in reading order. Korean copy to match the
 * dashboard tone — concise but not thin.
 */
const MESH_HELP_SECTIONS: HelpSection[] = [
    {
        term: '노드 (Node)',
        summary: '메시에 참여하는 워크스페이스. 저장소 체크아웃 또는 격리된 git 워크트리.',
        details: [
            '베이스 노드 vs 워크트리 clone 노드 — clone은 충돌 없이 병렬 작업을 격리하기 위한 것.',
            'health(online/offline)와 git 상태(branch · ahead/behind · dirty)를 함께 표시.',
            '여러 노드가 같은 daemon을 공유할 수 있음.',
        ],
    },
    {
        term: '세션 (Session)',
        summary: '노드 위에서 도는 에이전트 CLI 세션.',
        details: [
            'status = idle / generating / waiting_approval.',
            '코디네이터 세션(작업을 분배·취합)과 위임 워커 세션(실제 작업 수행)을 구분.',
        ],
    },
    {
        term: '태스크 (Task)',
        summary: '큐 기반 풀 모델로 처리되는 한 단위의 작업.',
        details: [
            '상태: pending → assigned → completed / failed / cancelled.',
            'idle 노드가 큐에서 자동으로 claim. direct dispatch는 특정 세션을 타겟으로 직접 보냄.',
        ],
    },
    {
        term: '미션 (Mission)',
        summary: '하나의 목표를 향한 다중 태스크 묶음이자 그 노력의 영속 기록.',
        details: [
            '상태: active / paused / completed / abandoned.',
            '진행도는 소속 태스크들의 상태에서 파생됨.',
        ],
    },
    {
        term: 'Refinery (refine)',
        summary: '워크트리 브랜치를 베이스로 안전하게 수렴·병합하는 과정.',
        details: [
            'config 기반(.adhdev/refine.*) — patch-equivalence preflight와 no-op guard로 보호.',
            'ff-only 원칙, force-push 금지.',
            '서브모듈 commit이 origin에서 도달 불가하면 publish 필요 → blocked_review로 분류.',
        ],
    },
    {
        term: '완료 인지 모델',
        summary: '위임 작업의 완료는 큐(pending-events)에 영속됨.',
        details: [
            '코디네이터는 주기 폴링/이벤트로 완료를 인지.',
            '큐에 영속되므로 완료 신호는 유실되지 않음.',
        ],
    },
    {
        term: '브랜치 수렴 상태',
        summary: '워크트리 작업 후 각 브랜치는 정확히 하나의 최종 상태로 분류됨.',
        details: [
            'merged_to_main — 베이스에 병합 완료.',
            'pushed_feature_branch_needs_merge — 푸시됨, 병합 대기.',
            'blocked_review — 리뷰/도달성 문제로 보류.',
            'cleanup_candidate — 정리 대상.',
            'not_mergeable — 병합 불가.',
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
            aria-label="Mesh 도움말"
            aria-expanded={open}
            title="Mesh 개념 도움말"
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
            aria-label="Mesh 개념 도움말"
        >
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Help</div>
                    <div className={`mt-0.5 text-sm font-semibold ${meshTheme.textPrimary}`}>Mesh 개념 한눈에</div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="도움말 닫기"
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
