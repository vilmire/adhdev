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

export function formatApprovalSystemMessage(modalMessage?: string, modalButtons?: string[]): string {
    const modalText = modalMessage || 'Approval requested'
    const buttons = modalButtons?.length
        ? modalButtons.map((button) => `[${button}]`).join(' ')
        : '[Approve] [Reject]'
    return `⚡ Approval requested: ${modalText}\n${buttons}`
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
