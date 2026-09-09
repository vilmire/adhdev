/**
 * ApprovalBanner — shared modal/approval banner for IDE & CLI agents.
 * Shows action-required buttons reported by the daemon.
 * Buttons are disabled after click to prevent duplicate submissions.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveConversation } from './types';
import { getConversationViewStates } from './DashboardMobileChatShared';
import { IconWarning } from '../Icons';
import { IconSpinner } from '../Icons'

interface Props {
    activeConv: ActiveConversation;
    onModalButton: (btnText: string) => void;
}

// Normalize button text: strip Mac symbols AND Windows shortcut labels.
// \b-anchored so a shortcut word inside a real label (e.g. "Escalate",
// "Tabulate") is left intact — matching only the whole word.
export const cleanBtnText = (text: string) =>
    text.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '')             // Mac symbols
        .replace(/\s*\(\s*\b(?:Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)\b(?:\s*\+\s*\w+)*\s*\)/gi, '')  // parenthesized shortcut hint like "(Alt+Enter)"
        .replace(/\s*\b(?:Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)\b(?:\s*\+\s*\w+)*/gi, '')  // bare labels like "Alt+Enter"
        .trim();

export default function ApprovalBanner({ activeConv, onModalButton }: Props) {
    const { t } = useTranslation();
    const [pendingButton, setPendingButton] = useState<string | null>(null);

    // Reset pending on modal status change (approval complete or new approval)
    useEffect(() => {
        setPendingButton(null);
    }, [activeConv.modalMessage, activeConv.status, activeConv.connectionState]);

    const viewStates = getConversationViewStates(activeConv);
    if (!viewStates.isWaiting || !activeConv.modalButtons) return null;

    const handleClick = (btnText: string) => {
        if (pendingButton) return; // Already processing
        setPendingButton(btnText);
        onModalButton(btnText);
    };

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
