import type { Theme } from '../../hooks/useTheme'

export type MeshGraphBadgeTone = 'default' | 'good' | 'warn' | 'danger' | 'info'
export type MeshGraphActionTone = 'default' | 'info' | 'success'

/**
 * Mesh surface theme.
 *
 * Every colour here resolves through the app's design tokens (index.css
 * `--bg-*`, `--surface-*`, `--border-*`, `--text-*`, `--status-*`,
 * `--accent-primary`), so the mesh surfaces read as the same product as the
 * Machines / Settings / chat pages in both themes. Deliberately absent:
 * gradients, glows/halos, drafting-grid canvases and tinted decorative
 * fills — state is carried by a dot or text colour on a neutral chip, and
 * semantic red/amber only ever colours text, a dot or a thin border.
 *
 * The light/dark split survives only for the few values that are not tokens
 * (React Flow's `colorMode`, overlay scrims, modal elevation).
 */
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
    graphControlsClass: string
    graphBackgroundDotColor: string
    /** Blueprint (Tasks tab) canvas shell — the same plain surface as the Map
     *  canvas; no drafting-paper grid. */
    blueprintShellClass: string
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

/**
 * The one chip geometry for every mesh chip/badge: fixed height, centred
 * content, no wrapping inside the chip. Rows of chips must be a
 * `flex flex-wrap items-center gap-1` container so mixed chips share one
 * centre line (mixing inline-block chips of different font sizes is what put
 * "Stale" and "main" at different heights on the Map cards).
 */
export const MESH_CHIP_BASE = 'inline-flex h-5 min-w-0 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-3xs font-medium leading-none'

/**
 * Toolbar toggle / segmented-control state. Pressed = the app's single accent
 * (the orange used for the active nav item and primary buttons); idle =
 * neutral outline. Same height as MESH_CHIP_BASE so a toolbar row aligns.
 */
export function meshToggleChipClass(active: boolean): string {
    return `inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-3xs font-medium leading-none transition-colors ${active
        ? 'border-accent/50 bg-accent/10 text-accent'
        : 'border-border-default bg-transparent text-text-secondary hover:bg-bg-glass-hover hover:text-text-primary'}`
}

export type MeshChipTone = 'neutral' | 'good' | 'warn' | 'danger'

/** Chip tone → text + thin border only; the chip surface stays transparent. */
export function meshChipTone(tone: MeshChipTone): string {
    switch (tone) {
        case 'good': return 'border-status-online/30 text-status-online'
        case 'warn': return 'border-status-warning/35 text-status-warning'
        case 'danger': return 'border-status-error/35 text-status-error'
        case 'neutral':
        default: return 'border-border-default text-text-secondary'
    }
}

/** Map edge label: a neutral chip on the canvas surface. */
export const MESH_EDGE_LABEL_BASE = 'rounded-md border border-border-default bg-surface-primary px-1.5 py-0.5 text-3xs font-medium'

/** Tone = text + thin border colour only; the chip surface stays neutral. */
const TOKEN_BADGE_TONES: Record<MeshGraphBadgeTone, string> = {
    default: 'border-border-default bg-transparent text-text-secondary',
    good: 'border-status-online/30 bg-transparent text-status-online',
    warn: 'border-status-warning/35 bg-transparent text-status-warning',
    danger: 'border-status-error/35 bg-transparent text-status-error',
    info: 'border-border-default bg-transparent text-text-secondary',
}

const TOKEN_ACTION_TONES: Record<MeshGraphActionTone, string> = {
    default: 'border-border-default bg-bg-glass text-text-primary hover:bg-bg-glass-hover',
    info: 'border-accent/40 bg-transparent text-accent hover:bg-accent/10',
    success: 'border-status-online/35 bg-transparent text-status-online hover:bg-status-online/10',
}

/** Tokenised classes shared by both themes. */
const SHARED = {
    textPrimary: 'text-text-primary',
    textSecondary: 'text-text-secondary',
    textMuted: 'text-text-muted',
    graphShellClass: 'relative flex min-h-0 flex-1 flex-col w-full min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary',
    graphStatChipClass: 'rounded-full border border-border-default bg-surface-primary px-3 py-1 text-text-secondary',
    graphHintChipClass: 'rounded-full border border-border-default bg-surface-primary px-3 py-1 text-3xs text-text-muted',
    graphControlsClass: '!bottom-3 !left-3 !shadow-sm',
    blueprintShellClass: 'relative flex min-h-0 flex-1 flex-col w-full min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary',
    // SVG `fill`/`stroke` in a style object resolve CSS variables.
    edgeLabelTextColor: 'var(--text-secondary)',
    edgeLabelBackgroundColor: 'var(--surface-primary)',
    edgeLabelBorderColor: 'var(--border-default)',
    dialogHeaderClass: 'sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b border-border-subtle bg-bg-primary px-4 pb-0 pt-4 md:px-5',
    dialogTitleClass: 'truncate text-lg font-semibold text-text-primary md:text-xl',
    dialogKickerClass: 'rounded-full border border-border-default px-2.5 py-1 text-2xs text-text-secondary',
    dialogSubtitleClass: 'mt-1 truncate text-sm text-text-muted',
    dialogRefreshedChipClass: 'rounded-full border border-border-default px-3 py-1.5 text-xs text-text-secondary',
    dialogCloseButtonClass: 'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border-default bg-bg-glass text-text-secondary transition hover:bg-bg-glass-hover hover:text-text-primary',
    dialogBodyClass: 'min-h-0 flex-1 flex flex-col overflow-y-auto bg-bg-primary px-4 py-4 md:px-5 md:py-5',
    dialogEmptyClass: 'flex h-full min-h-[320px] items-center justify-center rounded-xl border border-dashed border-border-default px-6 text-center text-sm text-text-muted',
    cardClass: 'rounded-xl border border-border-subtle bg-bg-card',
    cardHeaderClass: 'border-b border-border-subtle px-4 py-3',
    cardTitleClass: 'text-sm font-semibold text-text-primary',
    cardSubtitleClass: 'mt-1 text-xs text-text-muted',
    rowClass: 'flex min-w-0 items-start justify-between gap-3 border-b border-border-subtle py-1.5 text-xs last:border-b-0 last:pb-0 first:pt-0',
    rowLabelClass: 'shrink-0 text-text-muted',
    rowValueClass: 'min-w-0 flex-1 break-all text-right text-text-primary',
    panelShellClass: 'flex w-full max-w-full flex-col gap-2 rounded-xl border border-border-default bg-surface-primary p-4 shadow-md md:w-64',
    panelEmptyClass: 'w-full max-w-full rounded-xl border border-border-subtle bg-surface-primary p-4 text-xs text-text-muted md:w-64',
    panelTitleClass: 'truncate text-xs font-semibold text-text-primary',
    panelCloseButtonClass: 'text-xs text-text-muted hover:text-text-primary',
    panelFieldRowClass: 'flex min-w-0 justify-between gap-3 border-b border-border-subtle py-0.5 text-2xs',
    panelFieldLabelClass: 'shrink-0 text-text-muted',
    panelFieldValueClass: 'min-w-0 flex-1 break-all text-right font-medium text-text-primary',
    infoCalloutClass: 'mt-1 rounded-md border border-border-default bg-bg-glass px-2 py-1.5 text-3xs text-text-secondary',
    badge: (tone: MeshGraphBadgeTone) => darkless(TOKEN_BADGE_TONES[tone]),
    actionButton: (tone: MeshGraphActionTone) => darkless(TOKEN_ACTION_TONES[tone]),
} as const

export function getMeshGraphTheme(theme: Theme): MeshGraphTheme {
    if (theme === 'light') {
        return {
            ...SHARED,
            theme,
            isDark: false,
            flowColorMode: 'light',
            graphBackgroundDotColor: 'rgba(15, 23, 42, 0.10)',
            dialogOverlayClass: 'fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[rgba(15,23,42,0.55)] px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-[calc(16px+env(safe-area-inset-top,0px))]',
            dialogShellClass: 'flex shrink-0 h-[calc(100dvh-32px)] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)] w-full flex-col overflow-hidden rounded-xl border border-border-default bg-bg-primary shadow-lg md:h-[calc(100dvh-32px)] md:max-w-[min(1480px,calc(100vw-32px))] md:rounded-2xl',
        }
    }

    return {
        ...SHARED,
        theme,
        isDark: true,
        flowColorMode: 'dark',
        graphBackgroundDotColor: 'rgba(255, 255, 255, 0.06)',
        dialogOverlayClass: 'fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[rgba(0,0,0,0.72)] px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-[calc(16px+env(safe-area-inset-top,0px))]',
        dialogShellClass: 'flex shrink-0 h-[calc(100dvh-32px)] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)] w-full flex-col overflow-hidden rounded-xl border border-border-default bg-bg-primary shadow-lg md:h-[calc(100dvh-32px)] md:max-w-[min(1480px,calc(100vw-32px))] md:rounded-2xl',
    }
}

function darkless(value: string): string {
    return value
}
