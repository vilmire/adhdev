/**
 * ApprovalBanner — shared modal/approval banner for IDE & CLI agents.
 * Shows action-required buttons reported by the daemon.
 * Buttons are disabled after click to prevent duplicate submissions.
 */
import { useState, useEffect } from 'react';
import type { ActiveConversation } from './types';
import { getConversationViewStates } from './DashboardMobileChatShared';
import { IconWarning } from '../Icons';

interface Props {
    activeConv: ActiveConversation;
    onModalButton: (btnText: string) => void;
}

export default function ApprovalBanner({ activeConv, onModalButton }: Props) {
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

    // Normalize button text: strip Mac symbols AND Windows shortcut labels
    const cleanBtnText = (text: string) =>
        text.replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '')             // Mac symbols
            .replace(/\s*(Alt|Ctrl|Shift|Cmd|Enter|Return|Esc|Tab|Backspace)(\+\s*\w+)*/gi, '')  // Windows labels like "Alt+Enter"
            .trim();

    return (
        <div
            className="text-white py-2.5 px-4 shrink-0 z-[5]"
            style={{ background: 'linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 85%, #000))' }}
        >
            {activeConv.modalMessage && (
                <div className="text-[11px] opacity-85 mb-1.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-full">
                    {activeConv.modalMessage.replace(/[\n\r]+/g, ' ').slice(0, 120)}
                </div>
            )}
            <div className="flex justify-between items-center">
                <div className="font-black text-xs flex items-center gap-2">
                    <IconWarning size={14} /> {pendingButton ? 'PROCESSING...' : 'ACTION REQUIRED'}
                </div>
                <div className="flex gap-2 flex-wrap">
                    {activeConv.modalButtons.map((btnText, idx) => {
                        const clean = cleanBtnText(btnText).toLowerCase();
                        const isPrimary = /^(run|approve|accept|yes|allow|always)/.test(clean);
                        const isDanger = /^(reject|deny|delete|remove|abort)/.test(clean);
                        const isThisPending = pendingButton === btnText;
                        const isDisabled = pendingButton !== null;
                        return (
                            <button
                                key={idx}
                                onClick={() => handleClick(btnText)}
                                disabled={isDisabled}
                                className={`btn btn-sm border-none rounded-md text-xs px-3 py-1 ${
                                    isPrimary ? 'bg-white font-extrabold'
                                    : isDanger ? 'bg-red-500/30 text-white font-semibold'
                                    : 'bg-white/15 text-white font-semibold'
                                } ${isDisabled && !isThisPending ? 'opacity-40' : 'opacity-100'} ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                style={isPrimary ? { color: 'var(--status-warning)' } : undefined}
                            >
                                {isThisPending ? '⏳ ...' : cleanBtnText(btnText)}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
