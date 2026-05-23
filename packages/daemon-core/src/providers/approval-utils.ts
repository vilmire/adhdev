import type { ProviderModule } from './contracts.js';

const DEFAULT_APPROVAL_POSITIVE_HINTS = [
    'yes',
    'allow once',
    'approve',
    'accept',
    'continue',
    'run',
    'proceed',
    'confirm',
    'save',
    'ok',
    'trust',
    'allow',
    'always allow',
];

const UNSAFE_APPROVAL_LABEL_PATTERN = /\b(?:abort|cancel|deny|discard|do\s+not|end|interrupt|no|reject|stop|terminate)\b/i;

function normalizeApprovalLabel(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/^[\s\[(<{]*\d+(?:\s*[.)\]}>:-]|\s)+/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function isUnsafeApprovalButtonLabel(value: string): boolean {
    return UNSAFE_APPROVAL_LABEL_PATTERN.test(normalizeApprovalLabel(value));
}

export function getApprovalPositiveHints(provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null): string[] {
    const customHints = Array.isArray(provider?.approvalPositiveHints)
        ? provider.approvalPositiveHints
            .map((hint) => normalizeApprovalLabel(String(hint || '')))
            .filter(Boolean)
        : [];
    return customHints.length > 0 ? customHints : DEFAULT_APPROVAL_POSITIVE_HINTS;
}

export function pickApprovalButton(
    buttons: string[] | null | undefined,
    provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null,
): { index: number; label: string; unsafe?: boolean } {
    const labels = (buttons || []).map((button) => String(button || '').trim()).filter(Boolean);
    if (labels.length === 0) {
        return { index: 0, label: 'Approve' };
    }

    const normalizedButtons = labels.map((label) => normalizeApprovalLabel(label));
    const hints = getApprovalPositiveHints(provider);
    const safeCandidate = (index: number) => (
        index >= 0 && !isUnsafeApprovalButtonLabel(labels[index])
            ? { index, label: labels[index] }
            : null
    );

    for (const hint of hints) {
        const exactIndex = normalizedButtons.findIndex((label) => label === hint);
        const exact = safeCandidate(exactIndex);
        if (exact) return exact;

        const prefixIndex = normalizedButtons.findIndex((label) => label.startsWith(hint));
        const prefix = safeCandidate(prefixIndex);
        if (prefix) return prefix;

        const includeIndex = normalizedButtons.findIndex((label) => label.includes(hint));
        const include = safeCandidate(includeIndex);
        if (include) return include;
    }

    const nonUnsafeIndex = labels.findIndex((label) => !isUnsafeApprovalButtonLabel(label));
    if (nonUnsafeIndex >= 0) return { index: nonUnsafeIndex, label: labels[nonUnsafeIndex] };

    return { index: 0, label: labels[0], unsafe: true };
}

export function formatAutoApprovalMessage(modalMessage?: string, buttonLabel?: string): string {
    const lines = [`Auto-approved${buttonLabel ? `: ${buttonLabel}` : ''}`];
    const cleanMessage = String(modalMessage || '').trim();
    if (cleanMessage) lines.push(cleanMessage);
    return lines.join('\n');
}
