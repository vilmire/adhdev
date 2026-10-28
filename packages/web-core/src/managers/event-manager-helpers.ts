export type ToastActionVariant = 'primary' | 'danger' | 'default'

export interface ApprovalToastDescriptor {
    label: string
    variant: ToastActionVariant
    action: 'approve' | 'reject'
    button: string
    buttonIndex: number
}

export interface ViewRequestToastAction {
    label: string
    variant: 'primary' | 'danger'
    onClick: () => void
}

const PRIMARY_APPROVAL_BUTTON_RE = /^(run|approve|accept|yes|allow|always)/
const APPROVE_ACTION_RE = /^(run|approve|accept|yes|allow|always|proceed|save)/
const DANGER_APPROVAL_BUTTON_RE = /^(reject|deny|delete|remove|abort|cancel|no)/

export function cleanApprovalButtonText(text: string): string {
    return text
        .replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '')
        .replace(/\s*(Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)(\+\s*\w+)*/gi, '')
        // A hint wrapped in parentheses ("… session (shift+tab)", "Deny (esc)")
        // leaves an empty pair behind once the keys are stripped.
        .replace(/\s*\(\s*\)/g, '')
        .trim()
}

export function getApprovalToastVariant(buttonText: string): ToastActionVariant {
    const clean = cleanApprovalButtonText(buttonText).toLowerCase()
    if (PRIMARY_APPROVAL_BUTTON_RE.test(clean)) return 'primary'
    if (DANGER_APPROVAL_BUTTON_RE.test(clean)) return 'danger'
    return 'default'
}

export function getApprovalAction(buttonText: string): 'approve' | 'reject' {
    return APPROVE_ACTION_RE.test(cleanApprovalButtonText(buttonText).toLowerCase())
        ? 'approve'
        : 'reject'
}

export function buildApprovalToastDescriptors(buttons: string[]): ApprovalToastDescriptor[] {
    return buttons.map((button, buttonIndex) => ({
        label: cleanApprovalButtonText(button),
        variant: getApprovalToastVariant(button),
        action: getApprovalAction(button),
        button,
        buttonIndex,
    }))
}

export function formatApprovalToastMessage(ideLabel: string, modalMessage: string | undefined, fallbackMessage: string): string {
    if (!modalMessage) return fallbackMessage
    return `⚡ ${ideLabel}: ${modalMessage.replace(/[\n\r]+/g, ' ').slice(0, 80)}`
}

export function buildViewRequestToastActions(
    orgId: string,
    requestId: string,
    respond: (orgId: string, requestId: string, action: 'approve' | 'reject') => Promise<unknown>,
    onError?: (action: 'approve' | 'reject', error: unknown) => void,
): ViewRequestToastAction[] {
    return [
        {
            label: 'Approve',
            variant: 'primary',
            onClick: () => {
                respond(orgId, requestId, 'approve').catch((error) => onError?.('approve', error))
            },
        },
        {
            label: 'Decline',
            variant: 'danger',
            onClick: () => {
                respond(orgId, requestId, 'reject').catch((error) => onError?.('reject', error))
            },
        },
    ]
}

// ─── Approval-toast liveness ─────────────────────────────

const APPROVAL_GONE_CODES = new Set(['approval_button_changed', 'consent_modal_changed'])

/**
 * Did a `resolve_action` round-trip fail because the approval it targeted is
 * no longer on the CLI's screen (resolved by auto-approve / another client /
 * the terminal)? Daemon shapes (chat-commands-write.ts resolveAction PTY gate):
 *   - `{ success:false, error:'Not in approval state' }`   modal gone, never resolved recently
 *   - `{ success:true,  alreadyResolved:true }`             modal gone, resolved within cooldown
 *   - `{ success:false, stalePrompt:true, code:'approval_button_changed' }`
 *   - `{ success:false, code:'consent_modal_changed' }`
 * Cloud P2P wraps the body once (`{ success:true, result:<body> }`); a rejected
 * command arrives as a thrown/string error carrying the same message.
 * `approvalModalUnavailable` (status IS waiting_approval, no readable buttons)
 * is deliberately NOT "already handled".
 */
export function isApprovalAlreadyHandledOutcome(raw: unknown): boolean {
    if (typeof raw === 'string') return /not in approval state/i.test(raw)
    if (!raw || typeof raw !== 'object') return false
    const outer = raw as Record<string, unknown>
    const body = (outer.result && typeof outer.result === 'object' ? outer.result : outer) as Record<string, unknown>
    if (body.alreadyResolved === true || body.status === 'already_resolved') return true
    if (body.success !== false) return false
    if (body.stalePrompt === true) return true
    if (typeof body.code === 'string' && APPROVAL_GONE_CODES.has(body.code)) return true
    return typeof body.error === 'string' && /not in approval state/i.test(body.error)
}

/**
 * Is an approval still pending on this session entry (top-level or child)?
 * Reads only live session state: raw/chat status `waiting_approval`, or an
 * activeModal that still carries buttons.
 */
export function isSessionApprovalPending(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as {
        status?: unknown
        activeModal?: { buttons?: unknown[] | null } | null
        activeChat?: { status?: unknown; activeModal?: { buttons?: unknown[] | null } | null } | null
    }
    if (e.status === 'waiting_approval' || e.activeChat?.status === 'waiting_approval') return true
    const hasButtons = (m?: { buttons?: unknown[] | null } | null) => Array.isArray(m?.buttons) && m!.buttons!.length > 0
    return hasButtons(e.activeModal) || hasButtons(e.activeChat?.activeModal)
}
