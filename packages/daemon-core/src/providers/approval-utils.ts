import type { ProviderModule } from './contracts.js';

const DEFAULT_APPROVAL_POSITIVE_HINTS = [
    'run',
    'approve',
    'accept',
    'allow once',
    'always allow',
    'allow',
    'yes',
    'proceed',
    'continue',
    'confirm',
    'save',
    'ok',
    'trust',
];

function normalizeApprovalLabel(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
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
): { index: number; label: string } {
    const labels = (buttons || []).map((button) => String(button || '').trim()).filter(Boolean);
    if (labels.length === 0) {
        return { index: 0, label: 'Approve' };
    }

    const normalizedButtons = labels.map((label) => normalizeApprovalLabel(label));
    const hints = getApprovalPositiveHints(provider);

    for (const hint of hints) {
        const exactIndex = normalizedButtons.findIndex((label) => label === hint);
        if (exactIndex >= 0) return { index: exactIndex, label: labels[exactIndex] };

        const prefixIndex = normalizedButtons.findIndex((label) => label.startsWith(hint));
        if (prefixIndex >= 0) return { index: prefixIndex, label: labels[prefixIndex] };

        const includeIndex = normalizedButtons.findIndex((label) => label.includes(hint));
        if (includeIndex >= 0) return { index: includeIndex, label: labels[includeIndex] };
    }

    return { index: 0, label: labels[0] };
}

export function formatAutoApprovalMessage(modalMessage?: string, buttonLabel?: string): string {
    const lines = [`Auto-approved${buttonLabel ? `: ${buttonLabel}` : ''}`];
    const cleanMessage = String(modalMessage || '').trim();
    if (cleanMessage) lines.push(cleanMessage);
    return lines.join('\n');
}
