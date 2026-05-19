import type { Theme } from '../../hooks/useTheme'

export type MeshGraphBadgeTone = 'default' | 'good' | 'warn' | 'danger' | 'info'
export type MeshGraphActionTone = 'default' | 'info' | 'success'

export interface MeshGraphTheme {
    theme: Theme
    isDark: boolean
    flowColorMode: Theme
    textPrimary: string
    textSecondary: string
    textMuted: string
    graphShellClass: string
    graphStatChipClass: string
    graphHintChipClass: string
    graphMiniMapClass: string
    graphControlsClass: string
    graphBackgroundDotColor: string
    edgeLabelTextColor: string
    edgeLabelBackgroundColor: string
    edgeLabelBorderColor: string
    dialogOverlayClass: string
    dialogShellClass: string
    dialogHeaderClass: string
    dialogTitleClass: string
    dialogKickerClass: string
    dialogSubtitleClass: string
    dialogRefreshedChipClass: string
    dialogCloseButtonClass: string
    dialogBodyClass: string
    dialogEmptyClass: string
    cardClass: string
    cardHeaderClass: string
    cardTitleClass: string
    cardSubtitleClass: string
    rowClass: string
    rowLabelClass: string
    rowValueClass: string
    panelShellClass: string
    panelEmptyClass: string
    panelTitleClass: string
    panelCloseButtonClass: string
    panelFieldRowClass: string
    panelFieldLabelClass: string
    panelFieldValueClass: string
    infoCalloutClass: string
    badge(tone: MeshGraphBadgeTone): string
    actionButton(tone: MeshGraphActionTone): string
}

const darkBadgeTones: Record<MeshGraphBadgeTone, string> = {
    default: 'border-white/10 bg-white/[0.04] text-slate-200',
    good: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
    warn: 'border-amber-400/20 bg-amber-500/10 text-amber-100',
    danger: 'border-rose-400/20 bg-rose-500/10 text-rose-100',
    info: 'border-sky-400/20 bg-sky-500/10 text-sky-100',
}

const lightBadgeTones: Record<MeshGraphBadgeTone, string> = {
    default: 'border-slate-300 bg-white/95 text-slate-700',
    good: 'border-emerald-300 bg-emerald-50 text-emerald-700',
    warn: 'border-amber-300 bg-amber-50 text-amber-700',
    danger: 'border-rose-300 bg-rose-50 text-rose-700',
    info: 'border-sky-300 bg-sky-50 text-sky-700',
}

const darkActionTones: Record<MeshGraphActionTone, string> = {
    default: 'border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]',
    info: 'border-sky-400/25 bg-sky-500/10 text-sky-100 hover:bg-sky-500/16',
    success: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/16',
}

const lightActionTones: Record<MeshGraphActionTone, string> = {
    default: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    info: 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
}

export function getMeshGraphTheme(theme: Theme): MeshGraphTheme {
    if (theme === 'light') {
        return {
            theme,
            isDark: false,
            flowColorMode: 'light',
            textPrimary: 'text-slate-900',
            textSecondary: 'text-slate-700',
            textMuted: 'text-slate-500',
            graphShellClass: 'relative w-full min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.16),_rgba(248,250,252,0.98)_42%,_rgba(255,255,255,1))]',
            graphStatChipClass: 'rounded-full border border-slate-300 bg-white/95 px-3 py-1 text-slate-700 shadow-sm',
            graphHintChipClass: 'rounded-full border border-slate-300 bg-white/95 px-3 py-1 text-[10px] text-slate-500 shadow-sm',
            graphMiniMapClass: '!bottom-4 !right-4 !bg-white/95 !border !border-slate-200 !rounded-xl !shadow-md',
            graphControlsClass: '!bottom-4 !left-4 !shadow-md',
            graphBackgroundDotColor: 'rgba(148, 163, 184, 0.34)',
            edgeLabelTextColor: '#334155',
            edgeLabelBackgroundColor: 'rgba(255, 255, 255, 0.96)',
            edgeLabelBorderColor: 'rgba(148, 163, 184, 0.45)',
            dialogOverlayClass: 'fixed inset-0 z-[1200] flex items-center justify-center bg-[rgba(148,163,184,0.22)] p-0 md:p-4 backdrop-blur-md',
            dialogShellClass: 'flex h-[100dvh] w-full flex-col overflow-hidden bg-white md:h-[min(90vh,960px)] md:max-w-[min(1480px,calc(100vw-32px))] md:rounded-[24px] md:border md:border-slate-200 md:bg-white/98 md:shadow-[0_28px_120px_rgba(148,163,184,0.28)]',
            dialogHeaderClass: 'flex shrink-0 flex-col gap-3 border-b border-slate-200 bg-white/96 px-4 pb-4 pt-[calc(16px+env(safe-area-inset-top,0px))] backdrop-blur md:flex-row md:items-center md:justify-between md:px-5',
            dialogTitleClass: 'truncate text-lg font-semibold text-slate-900 md:text-xl',
            dialogKickerClass: 'rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-600',
            dialogSubtitleClass: 'mt-1 truncate text-sm text-slate-500',
            dialogRefreshedChipClass: 'rounded-full border border-slate-300 bg-white/95 px-3 py-1.5 text-xs text-slate-600',
            dialogCloseButtonClass: 'inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900',
            dialogBodyClass: 'min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,rgba(248,250,252,0.98),rgba(241,245,249,0.96))] px-4 py-4 md:px-5 md:py-5',
            dialogEmptyClass: 'flex h-full min-h-[320px] items-center justify-center rounded-[28px] border border-dashed border-slate-300 bg-white/90 px-6 text-center text-sm text-slate-500',
            cardClass: 'rounded-2xl border border-slate-200 bg-white/95 shadow-sm',
            cardHeaderClass: 'border-b border-slate-200 px-4 py-3',
            cardTitleClass: 'text-sm font-semibold text-slate-900',
            cardSubtitleClass: 'mt-1 text-xs text-slate-500',
            rowClass: 'flex items-start justify-between gap-3 border-b border-slate-200/80 py-1.5 text-xs last:border-b-0 last:pb-0 first:pt-0',
            rowLabelClass: 'text-slate-500',
            rowValueClass: 'max-w-[65%] break-all text-right text-slate-800',
            panelShellClass: 'flex w-full max-w-full flex-col gap-2 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-md md:w-64',
            panelEmptyClass: 'w-full max-w-full rounded-xl border border-slate-200 bg-white/95 p-4 text-xs text-slate-500 shadow-sm md:w-64',
            panelTitleClass: 'truncate text-xs font-semibold text-slate-900',
            panelCloseButtonClass: 'text-xs text-slate-500 hover:text-slate-900',
            panelFieldRowClass: 'flex justify-between gap-3 border-b border-slate-200/80 py-0.5 text-[11px]',
            panelFieldLabelClass: 'text-slate-500',
            panelFieldValueClass: 'break-all text-right font-medium text-slate-700',
            infoCalloutClass: 'mt-1 rounded border border-sky-300 bg-sky-50 px-2 py-1.5 text-[10px] text-sky-700',
            badge: tone => darkless(lightBadgeTones[tone]),
            actionButton: tone => darkless(lightActionTones[tone]),
        }
    }

    return {
        theme,
        isDark: true,
        flowColorMode: 'dark',
        textPrimary: 'text-slate-100',
        textSecondary: 'text-slate-300',
        textMuted: 'text-slate-400',
        graphShellClass: 'relative w-full min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_rgba(15,23,42,0.98)_42%,_rgba(2,6,23,1))]',
        graphStatChipClass: 'rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-slate-200',
        graphHintChipClass: 'rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-[10px] text-slate-300',
        graphMiniMapClass: '!bottom-4 !right-4 !bg-slate-950/85 !border !border-white/10 !rounded-xl',
        graphControlsClass: '!bottom-4 !left-4 !shadow-lg',
        graphBackgroundDotColor: 'rgba(148, 163, 184, 0.22)',
        edgeLabelTextColor: '#cbd5e1',
        edgeLabelBackgroundColor: 'rgba(2, 6, 23, 0.86)',
        edgeLabelBorderColor: 'rgba(148, 163, 184, 0.2)',
        dialogOverlayClass: 'fixed inset-0 z-[1200] flex items-center justify-center bg-[#030617]/[0.58] p-0 md:p-4 backdrop-blur-md',
        dialogShellClass: 'flex h-[100dvh] w-full flex-col overflow-hidden bg-slate-950 md:h-[min(90vh,960px)] md:max-w-[min(1480px,calc(100vw-32px))] md:rounded-[24px] md:border md:border-white/10 md:bg-slate-950/96 md:shadow-[0_28px_120px_rgba(2,6,23,0.46)]',
        dialogHeaderClass: 'flex shrink-0 flex-col gap-3 border-b border-white/10 bg-slate-950/92 px-4 pb-4 pt-[calc(16px+env(safe-area-inset-top,0px))] backdrop-blur md:flex-row md:items-center md:justify-between md:px-5',
        dialogTitleClass: 'truncate text-lg font-semibold text-white md:text-xl',
        dialogKickerClass: 'rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300',
        dialogSubtitleClass: 'mt-1 truncate text-sm text-slate-400',
        dialogRefreshedChipClass: 'rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-slate-300',
        dialogCloseButtonClass: 'inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/6 text-slate-300 transition hover:bg-white/10 hover:text-white',
        dialogBodyClass: 'min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,rgba(2,6,23,0.95),rgba(15,23,42,0.98))] px-4 py-4 md:px-5 md:py-5',
        dialogEmptyClass: 'flex h-full min-h-[320px] items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] px-6 text-center text-sm text-slate-400',
        cardClass: 'rounded-2xl border border-white/10 bg-white/[0.04]',
        cardHeaderClass: 'border-b border-white/10 px-4 py-3',
        cardTitleClass: 'text-sm font-semibold text-white',
        cardSubtitleClass: 'mt-1 text-xs text-slate-400',
        rowClass: 'flex items-start justify-between gap-3 border-b border-white/5 py-1.5 text-xs last:border-b-0 last:pb-0 first:pt-0',
        rowLabelClass: 'text-slate-400',
        rowValueClass: 'max-w-[65%] break-all text-right text-slate-100',
        panelShellClass: 'flex w-full max-w-full flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-4 shadow-lg md:w-64',
        panelEmptyClass: 'w-full max-w-full rounded-xl border border-white/10 bg-white/[0.04] p-4 text-xs text-slate-400 md:w-64',
        panelTitleClass: 'truncate text-xs font-semibold text-slate-100',
        panelCloseButtonClass: 'text-xs text-slate-400 hover:text-slate-100',
        panelFieldRowClass: 'flex justify-between gap-3 border-b border-white/6 py-0.5 text-[11px]',
        panelFieldLabelClass: 'text-slate-400',
        panelFieldValueClass: 'break-all text-right font-medium text-slate-200',
        infoCalloutClass: 'mt-1 rounded bg-blue-500/10 border border-blue-500/20 px-2 py-1.5 text-[10px] text-blue-300',
        badge: tone => darkless(darkBadgeTones[tone]),
        actionButton: tone => darkless(darkActionTones[tone]),
    }
}

function darkless(value: string): string {
    return value
}
