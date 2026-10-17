/**
 * Owner Inbox one-tap: classify a live tool-permission request's provider
 * buttons and order them for display — narrowest one-time options first,
 * declines next, standing grants last (with a warning).
 *
 * The two label predicates mirror daemon-core's `isNegativeApprovalLabel` and
 * `isPersistentApprovalGrantLabel` (src/providers/approval-utils.ts). web-core
 * may not value-import the daemon-core barrel, so they are copied here. The
 * daemon remains the authority: it re-checks that the exact label is offered by
 * the live episode and that its polarity matches the action, and refuses
 * otherwise, so a drift here can only produce a refusal, never a wrong press.
 */
import type { PendingApprovalAction } from './PendingApprovalsInbox'

export type InboxButtonKind = 'once' | 'decline' | 'standing'

export interface InboxProviderButton {
    /** Exact provider label — sent verbatim; never the cleaned display text. */
    label: string
    /** Index in the provider's original button list. */
    index: number
    kind: InboxButtonKind
    action: PendingApprovalAction
}

function normalizeApprovalLabel(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/^[\s[(<{]*\d+(?:\s*[.)\]}>:-]|\s)+/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
}

export function isDeclineApprovalLabel(value: string): boolean {
    const label = normalizeApprovalLabel(value)
    return /^(no|deny|reject|cancel|skip|exit|stop)\b/.test(label)
        || /\bwithout\b/.test(label)
        || /\bdo not\b/.test(label)
}

export function isStandingGrantApprovalLabel(value: string): boolean {
    const label = normalizeApprovalLabel(value)
    if (!label) return false
    return /\balways\b/.test(label)
        || /\b(?:don t|dont|do not|never) ask(?: me)? again\b/.test(label)
        || /\b(?:this|the|current|whole|entire|rest of the|rest of this) (?:session|conversation|chat)\b/.test(label)
        || /\b(?:for|per) (?:the )?session\b|\bsession wide\b/.test(label)
        || /\b(?:this|the|current|whole|entire) (?:project|workspace|repo|repository|folder|directory)\b/.test(label)
        || /\ballow ?list\b|\bwhite ?list\b/.test(label)
        || /\beverything\b|\bremember\b|\bpermanent(?:ly)?\b|\bforever\b/.test(label)
        || /\ball (?:edits|commands|tools|actions|files|changes|requests|permissions)\b/.test(label)
        || /\bauto (?:accept|approve|allow|run)\b/.test(label)
        || /\btrust\b/.test(label)
        || /\bbypass\b|\bauto mode\b|\byolo\b|\bfull access\b|\bunrestricted\b/.test(label)
        || /\b(?:allow|accept|approve|yes|grant|run) (?:to )?all\b|\byes to all\b/.test(label)
        || /\bin the future\b|\bfrom now on\b|\bsimilar (?:commands|requests|actions)\b|\bfuture (?:commands|requests)\b/.test(label)
        || /\b(?:immer|toujours|siempre|sempre|sempres|zawsze|altijd|alltid|всегда)\b/u.test(label)
        || /항상|始终|总是|永远|一律|常に|いつも|今後|以後/u.test(label)
}

const KIND_ORDER: Record<InboxButtonKind, number> = { once: 0, decline: 1, standing: 2 }

/** Provider buttons in display order; empty when there is nothing usable. */
export function orderInboxProviderButtons(buttons: readonly unknown[] | null | undefined): InboxProviderButton[] {
    if (!Array.isArray(buttons)) return []
    const out: InboxProviderButton[] = []
    buttons.forEach((raw, index) => {
        if (typeof raw !== 'string' || !raw.trim()) return
        const kind: InboxButtonKind = isDeclineApprovalLabel(raw) ? 'decline' : isStandingGrantApprovalLabel(raw) ? 'standing' : 'once'
        out.push({ label: raw, index, kind, action: kind === 'decline' ? 'reject' : 'approve' })
    })
    // Stable: provider order is kept within each kind (narrowest one-time first).
    return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.index - b.index)
}

/** Display text only (key-hint glyphs stripped, length capped); the exact label is what gets sent. */
export function inboxButtonDisplayText(label: string): string {
    const text = label.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '').replace(/\s+/g, ' ').trim()
    return (text || label).slice(0, 80)
}
