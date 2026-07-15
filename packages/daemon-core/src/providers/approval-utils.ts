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

export function normalizeApprovalLabel(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/^[\s\[(<{]*\d+(?:\s*[.)\]}>:-]|\s)+/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function isNegativeApprovalLabel(value: string): boolean {
    const label = normalizeApprovalLabel(value);
    return /^(no|deny|reject|cancel|skip|exit|stop)\b/.test(label)
        || /\bwithout\b/.test(label)
        || /\bdo not\b/.test(label);
}

/**
 * True when any of the given button labels reads as a decline/negative option
 * (No / Deny / Cancel / Skip / …). Used as the second half of an approval-modal
 * structural anchor: a real approval modal offers BOTH an affirmative and a
 * decline, which distinguishes it from a generic numbered menu or prose list.
 */
export function hasNegativeApprovalOption(buttons: string[] | null | undefined): boolean {
    return (buttons || []).some((button) => isNegativeApprovalLabel(String(button || '')));
}

/**
 * True when a button reliably identifies a tool-CONSENT modal on its own — a
 * scoped permission-grant affirmative such as:
 *   - "Yes, allow all edits in tmp/ during this session"
 *   - "Yes, and don't ask again for example.com"
 *   - "Yes, allow reading from etc/ from this project"
 *   - "Always allow"
 *
 * These options only ever appear in a genuine approval/permission prompt; a
 * /model or /mode picker ("1. Default  2. Opus  3. Sonnet") never offers a
 * "grant this scope" choice. They therefore serve as a SECOND reliable
 * structural anchor alongside {@link hasNegativeApprovalOption}.
 *
 * Why this exists (tall-diff fallback, #137): when a Write/Edit diff is tall,
 * the trailing decline option ("3. No") can scroll off the bottom of the
 * captured PTY frame, leaving only "1. Yes" + "2. Yes, allow … this session".
 * hasNegativeApprovalOption then reads false and the auto-approve gate bails —
 * a delegated worker sits forever on a modal it could safely have approved. The
 * grant-scope affirmative lets the gate recognize the consent modal WITHOUT
 * seeing the off-frame decline. The gate still selects the plain "Yes"
 * (allow-once) via pickApprovalButton, never the broader grant, and the settle
 * gate still requires a stable modal — so a half-rendered frame never fires.
 * Kept deliberately narrow so no picker/confirm modal can trip it.
 */
export function hasReliableApprovalAffirmative(buttons: string[] | null | undefined): boolean {
    return (buttons || []).some((button) => {
        const label = normalizeApprovalLabel(String(button || ''));
        if (!label) return false;
        // "always allow …" as a standalone grant option.
        if (/^always allow\b/.test(label)) return true;
        // "yes, …" scoped grants: allow / always allow / don't ask again / etc.
        // (normalizeApprovalLabel strips the apostrophe, so "don't" → "don t").
        if (/^yes\b/.test(label)) {
            if (/\ballow\b/.test(label)) return true;
            if (/\bask again\b/.test(label)) return true;
            if (/\bduring this session\b/.test(label)) return true;
            if (/\bfrom this project\b/.test(label)) return true;
        }
        return false;
    });
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

    // Match QUALITY dominates hint ORDER: try the strongest tier (exact) across
    // ALL hints before falling to prefix, and prefix before the weakest tier
    // (substring). The old code exhausted all three tiers per-hint, so a weak
    // substring hit on an early hint beat a strong prefix hit on a later hint.
    //
    // Live cursor defect: the 'Not in allowlist: git status' modal offers
    //   ["Run (once)", "Add Shell(git status) to allowlist?", "Run Everything", "Skip"]
    // with hints ["trust","allow",…,"run","yes"]. `allow` (earlier) substring-hit
    // "add shell … to allow-LIST" → index 1 (a scope-broadening grant that does
    // NOT execute the command) before `run` (later) prefix-hit "run once" → the
    // correct least-permissive affirmative at index 0. Approve then wedged.
    //
    // Substring is further constrained to WHOLE-WORD hits so `allow` matches
    // "allow all edits" but never "allowlist" — a hint buried inside a larger
    // word (allowlist, disallow, runtime) is almost never the intended button.
    const includesWord = (label: string, hint: string): boolean => {
        if (!label.includes(hint)) return false;
        const re = new RegExp(`(?:^|\\s)${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
        return re.test(label);
    };

    const findMatch = (
        predicate: (label: string, hint: string) => boolean,
    ): { index: number; label: string } | null => {
        for (const hint of hints) {
            const idx = normalizedButtons.findIndex(
                (label, index) => predicate(label, hint) && !isNegativeApprovalLabel(labels[index]),
            );
            if (idx >= 0) return { index: idx, label: labels[idx] };
        }
        return null;
    };

    return (
        findMatch((label, hint) => label === hint)
        ?? findMatch((label, hint) => label.startsWith(hint))
        ?? findMatch((label, hint) => includesWord(label, hint))
        ?? { index: -1, label: '' }
    );
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
