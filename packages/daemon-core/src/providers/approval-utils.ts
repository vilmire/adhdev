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

function normalizeApprovalLabel(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/^[\s\[(<{]*\d+(?:\s*[.)\]}>:-]|\s)+/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function isNegativeApprovalLabel(value: string): boolean {
    const label = normalizeApprovalLabel(value);
    return /^(no|deny|reject|cancel|skip|exit|stop)\b/.test(label)
        || /\bwithout\b/.test(label)
        || /\bdo not\b/.test(label);
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
        return { index: -1, label: '' };
    }

    const normalizedButtons = labels.map((label) => normalizeApprovalLabel(label));
    const hints = getApprovalPositiveHints(provider);

    for (const hint of hints) {
        const exactIndex = normalizedButtons.findIndex((label, index) => label === hint && !isNegativeApprovalLabel(labels[index]));
        if (exactIndex >= 0) return { index: exactIndex, label: labels[exactIndex] };

        const prefixIndex = normalizedButtons.findIndex((label, index) => label.startsWith(hint) && !isNegativeApprovalLabel(labels[index]));
        if (prefixIndex >= 0) return { index: prefixIndex, label: labels[prefixIndex] };

        const includeIndex = normalizedButtons.findIndex((label, index) => label.includes(hint) && !isNegativeApprovalLabel(labels[index]));
        if (includeIndex >= 0) return { index: includeIndex, label: labels[includeIndex] };
    }

    return { index: -1, label: '' };
}

export function pickAutoApprovalButton(
    buttons: string[] | null | undefined,
): { index: number; label: string } {
    const labels = (buttons || []).map((button) => String(button || '').trim());
    const index = labels.findIndex(Boolean);
    return index >= 0 ? { index, label: labels[index] } : { index: -1, label: '' };
}

export function formatAutoApprovalMessage(modalMessage?: string, buttonLabel?: string): string {
    const lines = [`Auto-approved${buttonLabel ? `: ${buttonLabel}` : ''}`];
    const cleanMessage = String(modalMessage || '').trim();
    if (cleanMessage) lines.push(cleanMessage);
    return lines.join('\n');
}

/**
 * Returns true when the given text (e.g. last assistant message content, or
 * the tail of the PTY screen) looks like an active approval/input prompt
 * rather than a completed assistant response. Used to prevent false
 * idle/completion events when Claude Code surfaces a "Do you want to proceed?"
 * style prompt that the PTY parser captures as an assistant turn while the
 * session is still awaiting user input.
 */
export function looksLikeActiveApprovalPromptText(content: string): boolean {
    const text = content.trim();
    if (!text || text.length > 2000) return false;
    const hasApprovalQuestion = /do you want to (?:proceed|allow|run|make this edit|create)/i.test(text)
        || /this command requires approval/i.test(text)
        || /quick safety check/i.test(text)
        || /is this a project you trust/i.test(text);
    const hasNumberedChoices = /^\s*[❯›>]?\s*1[.)]\s+(?:yes|allow|proceed|run)/im.test(text)
        || /^\s*1[.)]\s+yes\b/im.test(text);
    if (hasApprovalQuestion && hasNumberedChoices) return true;
    const lastLines = text.split(/\r?\n/).slice(-12).join('\n');
    const hasDontAskAgain = /yes.*don'?t ask again/i.test(lastLines)
        || /yes.*always allow/i.test(lastLines);
    const hasNoOption = /^\s*[❯›>]?\s*\d+[.)]\s+no\b/im.test(lastLines);
    if (hasDontAskAgain && hasNoOption) return true;
    if (/what do you want to do\?/i.test(text) && /^\s*\d+[.)]\s+\S/m.test(text)) return true;
    return false;
}
