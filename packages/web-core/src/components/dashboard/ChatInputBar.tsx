import { memo, useEffect, useRef, useState } from 'react';

interface ChatInputBarProps {
    contextKey: string;
    panelLabel: string;
    isSending: boolean;
    onSend: (message: string) => void;
    isActive?: boolean;
}

const ChatInputBar = memo(function ChatInputBar({
    contextKey,
    panelLabel,
    isSending,
    onSend,
    isActive = true,
}: ChatInputBarProps) {
    const chatInputRef = useRef<HTMLInputElement>(null);
    const [draftInput, setDraftInput] = useState('');

    useEffect(() => {
        setDraftInput('');
    }, [contextKey]);

    useEffect(() => {
        if (!isActive) return;
        chatInputRef.current?.focus();
    }, [contextKey, isActive]);

    const submitDraft = () => {
        const message = draftInput.trim();
        if (!message || isSending) return;
        setDraftInput('');
        onSend(message);
    };

    return (
        <div
            className="dashboard-input-area bg-[var(--surface-primary)] shrink-0 overflow-hidden transition-all duration-200 ease-out"
            style={{
                borderTop: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                maxHeight: isActive ? 72 : 0,
                opacity: isActive ? 1 : 0,
                transform: isActive ? 'translateY(0)' : 'translateY(10px)',
                padding: isActive ? '10px 12px' : '0 12px',
                pointerEvents: isActive ? 'auto' : 'none',
            }}
            aria-hidden={!isActive}
        >
            <div className="flex gap-2.5 items-center" title={isActive ? `Send message to ${panelLabel}` : undefined}>
                <div className="flex-1 relative">
                    <input
                        ref={chatInputRef}
                        type="text"
                        placeholder={`Send message to ${panelLabel}...`}
                        value={draftInput}
                        onChange={e => setDraftInput(e.target.value)}
                        onPaste={e => {
                            const pasted = e.clipboardData.getData('text');
                            if (pasted) setDraftInput(prev => prev + pasted);
                            e.preventDefault();
                        }}
                        onKeyDown={e => {
                            if (e.key !== 'Enter') return;
                            if (e.nativeEvent.isComposing) {
                                e.preventDefault();
                                return;
                            }
                            e.preventDefault();
                            submitDraft();
                        }}
                        onBlur={(e) => {
                            if (window.innerWidth < 768) {
                                const related = e.relatedTarget as HTMLElement | null;
                                if (related?.tagName === 'BUTTON') return;
                                setTimeout(() => {
                                    document.documentElement.scrollTop = 0;
                                }, 300);
                            }
                        }}
                        className="w-full h-10 rounded-[20px] px-4 bg-bg-secondary text-sm text-text-primary"
                        style={{ border: '1px solid var(--chat-input-border, var(--border-subtle))' }}
                    />
                </div>
                <button
                    onClick={submitDraft}
                    disabled={!draftInput.trim() || isSending}
                    className={`w-10 h-10 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                        draftInput.trim() && !isSending ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                    }`}
                    style={draftInput.trim() && !isSending ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={draftInput.trim() ? 'text-white' : 'text-text-muted'}>
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                </button>
            </div>
        </div>
    );
});

export default ChatInputBar;
