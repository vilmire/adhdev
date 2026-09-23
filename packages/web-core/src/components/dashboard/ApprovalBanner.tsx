/**
 * ApprovalBanner — shared modal/approval banner for IDE & CLI agents.
 * Shows action-required buttons reported by the daemon.
 * Buttons are disabled after click to prevent duplicate submissions.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveConversation } from './types';
import { getConversationViewStates } from './DashboardMobileChatShared';
import { useInteractivePrompt } from '../../hooks/useInteractivePrompt';
import { IconWarning } from '../Icons';
import { IconSpinner } from '../Icons'

interface Props {
    activeConv: ActiveConversation;
    onModalButton: (btnText: string) => void;
}

/** One scope contract shared by the banner CTA and its owning modal surface. */
export function getInteractivePromptScopeId(activeConv: Pick<ActiveConversation, 'sessionId' | 'routeId'>): string {
    return activeConv.sessionId ?? activeConv.routeId;
}

// Normalize button text: strip Mac symbols AND Windows shortcut labels.
// \b-anchored so a shortcut word inside a real label (e.g. "Escalate",
// "Tabulate") is left intact — matching only the whole word.
export const cleanBtnText = (text: string) =>
    text.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '')             // Mac symbols
        .replace(/\s*\(\s*\b(?:Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)\b(?:\s*\+\s*\w+)*\s*\)/gi, '')  // parenthesized shortcut hint like "(Alt+Enter)"
        .replace(/\s*\b(?:Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)\b(?:\s*\+\s*\w+)*/gi, '')  // bare labels like "Alt+Enter"
        .trim();

/**
 * MULTISELECT-REMOTE-DEADLOCK: how long a clicked button stays in its disabled
 * "PROCESSING" state before the banner re-enables itself.
 *
 * The only previous reset was a status/modalMessage/connectionState change. When
 * an injection changed none of those — which is exactly what a REFUSED or
 * ineffective press does — the banner stayed frozen forever: spinner on the
 * clicked button, every sibling blurred at opacity-40, and no way back short of
 * a reload. That dead end is half of what made the remote wedge unrecoverable.
 *
 * 12s is comfortably longer than a modal that really is resolving takes to
 * report back (the status path re-renders and clears this immediately), so a
 * healthy press never sees the timeout; it only rescues the stuck case.
 */
const PENDING_BUTTON_RESET_MS = 12_000;

export default function ApprovalBanner({ activeConv, onModalButton }: Props) {
    const { t } = useTranslation();
    const [pendingButton, setPendingButton] = useState<string | null>(null);

    // MULTISELECT-REMOTE-DEADLOCK: does this session have an answerable STRUCTURED
    // prompt (AskUserQuestion picker)? If so, the raw buttons below are the WRONG
    // surface and must not be offered.
    //
    // The raw path's only verb is `resolve_action` → a single-select `'{index}\r'`
    // injection. That cannot submit a multi-select checkbox picker at all (a digit
    // toggles a box without advancing; Enter toggles the cursor's row rather than
    // submitting — only Tab commits), so each tap silently flipped a checkbox the
    // user never chose and submitted nothing, leaving the session parked and
    // flapping between PROCESSING and ACTION REQUIRED. Offering the structured
    // picker instead routes the answer through the one path that emits the real
    // protocol (digit per selection + Tab + review Enter).
    //
    // Scoped to THIS conversation's session so another session's question can
    // never take over this banner. `hasActivePrompt` stays true after a dismiss,
    // which is the point: this is the reopen affordance for a prompt the user
    // closed and now needs back.
    const { hasActivePrompt, promptSession, reopen } = useInteractivePrompt(getInteractivePromptScopeId(activeConv));

    // Reset pending on modal status change (approval complete or new approval)
    useEffect(() => {
        setPendingButton(null);
    }, [activeConv.modalMessage, activeConv.status, activeConv.connectionState]);

    // MULTISELECT-REMOTE-DEADLOCK: failsafe un-stick. See PENDING_BUTTON_RESET_MS —
    // an injection that resolves nothing changes none of the deps above, so without
    // this the banner never re-enables.
    useEffect(() => {
        if (!pendingButton) return;
        const timer = setTimeout(() => setPendingButton(null), PENDING_BUTTON_RESET_MS);
        return () => clearTimeout(timer);
    }, [pendingButton]);

    const viewStates = getConversationViewStates(activeConv);
    // waiting_choice (structured question parked) must ALSO open the banner —
    // gating on isWaiting alone excluded it, so the structured-question
    // branches below were unreachable for exactly the sessions they exist for.
    if ((!viewStates.isWaiting && !viewStates.isWaitingChoice) || !activeConv.modalButtons) return null;

    const handleClick = (btnText: string) => {
        if (pendingButton) return; // Already processing
        setPendingButton(btnText);
        onModalButton(btnText);
    };

    // PICKER-PARSE-DEADLOCK-ESCAPE / waiting_choice-without-prompt: a structured
    // question owns this session but there is nothing answerable to render here
    // (the daemon-side parse hasn't produced a usable prompt, the prompt was
    // dismissed and reopen() has not resolved a session, or — for waiting_choice —
    // neither the P2P event hydration nor the rich status sync delivered the
    // prompt). The raw modal buttons below must still not be offered in any of
    // these cases — same MULTISELECT-REMOTE-DEADLOCK reasoning as the
    // structured-question branch, a raw press can silently corrupt a checkbox
    // picker — so this is a dead end for the button-based banner. Point the
    // owner at the terminal view instead of showing a CTA that (per the
    // answerQuestion button below) can open nothing.
    const renderQuestionUnavailable = () => (
        <div
            className="text-white py-2.5 px-4 shrink-0 z-[5]"
            style={{ background: 'linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 85%, #000))' }}
        >
            <div className="flex items-center gap-2">
                <div className="font-black text-xs flex items-center gap-2">
                    <IconWarning size={14} />
                    {t('approval.questionUnavailable', {
                        defaultValue: 'Question waiting — could not load it here. Answer it in the terminal view.',
                    })}
                </div>
            </div>
        </div>
    );

    if (hasActivePrompt && !promptSession) {
        return renderQuestionUnavailable();
    }

    // MULTISELECT-REMOTE-DEADLOCK: a structured question owns this session — show
    // the answer CTA and NOTHING else. The raw buttons are deliberately not
    // rendered even as a fallback: leaving them visible is what let a remote user
    // corrupt the picker's checkbox state one tap at a time.
    if (hasActivePrompt) {
        return (
            <div
                className="text-white py-2.5 px-4 shrink-0 z-[5]"
                style={{ background: 'linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 85%, #000))' }}
            >
                {activeConv.modalMessage && (
                    <div
                        className="text-2xs opacity-85 mb-1.5 line-clamp-3 max-w-full whitespace-pre-wrap break-words"
                        title={activeConv.modalMessage}
                    >
                        {activeConv.modalMessage}
                    </div>
                )}
                <div className="flex justify-between items-center gap-2">
                    <div className="font-black text-xs flex items-center gap-2">
                        <IconWarning size={14} /> {t('approval.questionPending', { defaultValue: 'Question waiting' })}
                    </div>
                    <button
                        onClick={reopen}
                        className="btn btn-sm border-none rounded-md text-xs px-3 py-1 font-extrabold cursor-pointer whitespace-nowrap shrink-0"
                        style={{
                            color: 'var(--status-warning)',
                            background: 'var(--surface-primary)',
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--status-warning) 18%, transparent)',
                        }}
                    >
                        {t('approval.answerQuestion', { defaultValue: 'Answer the question' })}
                    </button>
                </div>
            </div>
        );
    }

    // MULTISELECT-REMOTE-DEADLOCK: a waiting_choice conversation is owned by a
    // STRUCTURED question even when nothing is tracked locally (hasActivePrompt
    // false — the P2P event hydration and the rich status sync both missed it,
    // e.g. WS-only delivery where the server relay strips the prompt fields).
    // The raw buttons below must NEVER render for it: their only verb is a
    // single-select `'{index}\r'` injection, which silently corrupts a checkbox
    // picker one tap at a time. Same dead-end treatment as the branch above.
    if (viewStates.isWaitingChoice) {
        return renderQuestionUnavailable();
    }

    return (
        <div
            className="text-white py-2.5 px-4 shrink-0 z-[5]"
            style={{ background: 'linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 85%, #000))' }}
        >
            {activeConv.modalMessage && (
                <div
                    className="text-2xs opacity-85 mb-1.5 line-clamp-3 max-w-full whitespace-pre-wrap break-words"
                    title={activeConv.modalMessage}
                >
                    {activeConv.modalMessage}
                </div>
            )}
            <div className="flex justify-between items-center">
                <div className="font-black text-xs flex items-center gap-2">
                    <IconWarning size={14} /> {pendingButton ? t('approval.processing') : t('approval.actionRequired')}
                </div>
                <div className="flex gap-2 flex-wrap">
                    {activeConv.modalButtons.map((btnText, idx) => {
                        const clean = cleanBtnText(btnText).toLowerCase();
                        // (O6) Visual hierarchy follows RISK, not affirmativeness. Button
                        // ORDER is left exactly as the daemon reported it — reordering
                        // would break muscle memory and cause mis-taps; only styling ranks
                        // the choices:
                        //   1. one-time approve (isPrimary) — solid, strongest: the safe
                        //      affirmative default the eye should land on first
                        //   2. reject (isDanger) — red tint: the safe exit, kept loud
                        //   3. neutral choices — translucent
                        //   4. "Always allow" (isAlwaysAllow) — LEAST prominent: outline
                        //      only, warning icon. It grants the broadest standing
                        //      permission and is hard to walk back, so it must read as a
                        //      deliberate opt-in, never as the recommended choice.
                        const isAlwaysAllow = /^always\b/.test(clean);
                        const isPrimary = !isAlwaysAllow && /^(run|approve|accept|yes|allow|always)/.test(clean);
                        const isDanger = /^(reject|deny|delete|remove|abort)/.test(clean);
                        const isThisPending = pendingButton === btnText;
                        const isDisabled = pendingButton !== null;
                        return (
                            <button
                                key={idx}
                                onClick={() => handleClick(btnText)}
                                disabled={isDisabled}
                                title={isAlwaysAllow ? t('approval.alwaysAllowWarning') : undefined}
                                className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 ${
                                    isPrimary ? 'font-extrabold'
                                    : isDanger ? 'bg-red-500/30 text-white font-semibold'
                                    : isAlwaysAllow ? 'text-white/90 font-semibold'
                                    : 'text-white font-semibold'
                                } ${isDisabled && !isThisPending ? 'opacity-40' : 'opacity-100'} ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                style={isPrimary
                                    ? {
                                        color: 'var(--status-warning)',
                                        background: 'var(--surface-primary)',
                                        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--status-warning) 18%, transparent)',
                                    }
                                    : isAlwaysAllow
                                        ? {
                                            background: 'transparent',
                                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, white 55%, transparent)',
                                        }
                                        : !isDanger
                                            ? {
                                                background: 'color-mix(in srgb, var(--surface-primary) 82%, transparent)',
                                                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, white 10%, transparent)',
                                            }
                                            : undefined}
                            >
                                {isThisPending
                                    ? <IconSpinner size={12} />
                                    : isAlwaysAllow
                                        ? <span className="inline-flex items-center gap-1"><IconWarning size={11} />{cleanBtnText(btnText)}</span>
                                        : cleanBtnText(btnText)}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
