import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { useControlsBarVisibility } from '../../hooks/useControlsBarVisibility';
import type { MessageInputSupport } from '@adhdev/daemon-core';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ImageAttachment {
    mimeType: string;
    /** base64-encoded image data (without the data: URI prefix) */
    data: string;
    /** original filename for alt text */
    name: string;
    /** data URI for preview rendering */
    previewUrl: string;
}

interface ChatInputBarProps {
    contextKey: string;
    panelLabel: string;
    isSending: boolean;
    isBusy?: boolean;
    /** Shown as the textarea placeholder (visible only while the draft is empty). */
    statusMessage?: string | null;
    /**
     * Shown on a dedicated line below the input, persistently (even while the
     * user is typing). Use for messages the user must keep seeing — send
     * errors, blocked-input reasons. Busy/generating status belongs in
     * `statusMessage` only, to avoid duplicating it under the placeholder.
     */
    inlineStatusMessage?: string | null;
    onSend: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>;
    onForceSend?: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>;
    canForceSend?: boolean;
    isActive?: boolean;
    showControlsToggle?: boolean;
    animateVisibility?: boolean;
    onControlsToggle?: () => void;
    /** Media input capabilities for this session. Absent = text-only. */
    messageInput?: MessageInputSupport;
}

export function shouldDisableChatSendButton({
    hasDraft,
    isBusy = false,
}: {
    hasDraft: boolean;
    isBusy?: boolean;
}): boolean {
    return !hasDraft || isBusy;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

async function buildAttachment(file: File): Promise<ImageAttachment | null> {
    if (file.size > MAX_FILE_SIZE_BYTES) return null;
    const dataUrl = await readFileAsDataUrl(file);
    // dataUrl: "data:<mimeType>;base64,<data>"
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return null;
    const data = dataUrl.slice(commaIdx + 1);
    return {
        mimeType: file.type || 'image/png',
        data,
        name: file.name,
        previewUrl: dataUrl,
    };
}

function supportsImageInput(messageInput: MessageInputSupport | undefined): boolean {
    if (!messageInput) return false;
    return messageInput.mediaTypes.includes('image') && messageInput.multipart;
}

const ChatInputBar = memo(function ChatInputBar({
    contextKey,
    panelLabel,
    isSending: _isSending,
    isBusy = false,
    statusMessage = null,
    inlineStatusMessage = null,
    onSend,
    onForceSend,
    canForceSend = false,
    isActive = true,
    showControlsToggle = false,
    animateVisibility = true,
    onControlsToggle,
    messageInput,
}: ChatInputBarProps) {
    const chatInputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [draftInput, setDraftInput] = useState('');
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const submitLockRef = useRef(false);
    const { isVisible: areControlsVisible, toggleVisibility: toggleControlsVisibility } = useControlsBarVisibility();

    const canAttachImages = supportsImageInput(messageInput);
    const hasDraft = !!draftInput.trim() || attachments.length > 0;

    useEffect(() => {
        setDraftInput('');
        setAttachments([]);
        setAttachError(null);
    }, [contextKey]);

    useEffect(() => {
        if (!isActive) return;
        chatInputRef.current?.focus({ preventScroll: true });
    }, [contextKey, isActive]);

    useEffect(() => {
        const el = chatInputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [draftInput]);

    const addFiles = useCallback(async (files: FileList | File[]) => {
        setAttachError(null);
        const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (imageFiles.length === 0) return;

        const remaining = MAX_ATTACHMENTS - attachments.length;
        if (remaining <= 0) {
            setAttachError(`Max ${MAX_ATTACHMENTS} images`);
            return;
        }

        const toProcess = imageFiles.slice(0, remaining);
        const oversized = toProcess.filter((f) => f.size > MAX_FILE_SIZE_BYTES);
        if (oversized.length > 0) {
            setAttachError(`Image too large (max 10 MB)`);
            return;
        }

        const results = await Promise.all(toProcess.map(buildAttachment));
        const valid = results.filter((a): a is ImageAttachment => a !== null);
        setAttachments((prev) => [...prev, ...valid]);
    }, [attachments.length]);

    const removeAttachment = useCallback((index: number) => {
        setAttachments((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const submitDraft = useCallback(async () => {
        const message = draftInput.trim();
        if ((!message && attachments.length === 0) || isBusy) return;
        if (submitLockRef.current) return;
        submitLockRef.current = true;
        const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
        try {
            const accepted = await onSend(message, currentAttachments);
            if (accepted !== false) {
                setDraftInput('');
                setAttachments([]);
                setAttachError(null);
            }
        } finally {
            submitLockRef.current = false;
        }
    }, [draftInput, attachments, isBusy, onSend]);

    const forceSubmitDraft = useCallback(async () => {
        if (!canForceSend || !onForceSend) return;
        const message = draftInput.trim();
        if ((!message && attachments.length === 0)) return;
        if (submitLockRef.current) return;
        submitLockRef.current = true;
        const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
        try {
            const accepted = await onForceSend(message, currentAttachments);
            if (accepted !== false) {
                setDraftInput('');
                setAttachments([]);
                setAttachError(null);
            }
        } finally {
            submitLockRef.current = false;
        }
    }, [attachments, canForceSend, draftInput, onForceSend]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!canAttachImages) return;
        e.preventDefault();
        setIsDragOver(true);
    }, [canAttachImages]);

    const handleDragLeave = useCallback(() => setIsDragOver(false), []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        if (!canAttachImages) return;
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files.length > 0) {
            void addFiles(e.dataTransfer.files);
        }
    }, [canAttachImages, addFiles]);

    return (
        <div
            className={[
                'dashboard-input-area bg-[var(--surface-primary)] shrink-0 overflow-hidden',
                animateVisibility ? 'transition-all duration-200 ease-out' : '',
                isDragOver ? 'ring-1 ring-inset ring-[var(--accent-primary)]' : '',
            ].filter(Boolean).join(' ')}
            style={{
                borderTop: isActive ? '1px solid var(--border-subtle)' : '1px solid transparent',
                maxHeight: isActive ? 200 : 0,
                opacity: isActive ? 1 : 0,
                transform: isActive ? 'translateY(0)' : 'translateY(10px)',
                padding: isActive ? '10px 12px' : '0 12px',
                pointerEvents: isActive ? 'auto' : 'none',
            }}
            aria-hidden={!isActive}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Attachment previews */}
            {attachments.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                    {attachments.map((att, i) => (
                        <div
                            key={i}
                            className="relative group w-14 h-14 rounded-lg overflow-hidden border border-border-subtle shrink-0"
                            style={{ background: 'var(--surface-secondary)' }}
                        >
                            <img
                                src={att.previewUrl}
                                alt={att.name}
                                className="w-full h-full object-cover"
                            />
                            <button
                                type="button"
                                onClick={() => removeAttachment(i)}
                                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px] leading-none"
                                aria-label={`Remove ${att.name}`}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex gap-2 items-center" title={isActive ? `Send message to ${panelLabel}` : undefined}>
                {showControlsToggle && (
                    <button
                        type="button"
                        onClick={() => {
                            toggleControlsVisibility();
                            onControlsToggle?.();
                        }}
                        aria-label={areControlsVisible ? 'Hide controls' : 'Show controls'}
                        aria-pressed={areControlsVisible}
                        title={areControlsVisible ? 'Hide controls' : 'Show controls'}
                        className="h-10 w-7 shrink-0 rounded-full border border-border-subtle bg-bg-secondary text-text-muted hover:text-text-primary hover:bg-[var(--surface-tertiary)] transition-colors flex items-center justify-center"
                    >
                        <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
                            <circle cx="6" cy="3" r="1.2" />
                            <circle cx="6" cy="9" r="1.2" />
                            <circle cx="6" cy="15" r="1.2" />
                        </svg>
                    </button>
                )}

                {/* Image attach button */}
                {canAttachImages && (
                    <>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                if (e.target.files) void addFiles(e.target.files);
                                e.target.value = '';
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={attachments.length >= MAX_ATTACHMENTS}
                            title={attachments.length >= MAX_ATTACHMENTS ? `Max ${MAX_ATTACHMENTS} images` : 'Attach image'}
                            className="h-10 w-8 shrink-0 rounded-full border border-border-subtle bg-bg-secondary text-text-muted hover:text-text-primary hover:bg-[var(--surface-tertiary)] transition-colors flex items-center justify-center disabled:opacity-40"
                            aria-label="Attach image"
                        >
                            {/* Paperclip icon */}
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                            </svg>
                        </button>
                    </>
                )}

                <div className="flex-1 relative">
                    <textarea
                        ref={chatInputRef}
                        rows={1}
                        placeholder={statusMessage || (canAttachImages && attachments.length > 0 ? 'Add a message (optional)...' : `Send message to ${panelLabel}... (Shift+Enter for newline)`)}
                        value={draftInput}
                        onChange={e => setDraftInput(e.target.value)}
                        onPaste={e => {
                            // Intercept image pastes when supported. Text pastes
                            // (including those with newlines) fall through to the
                            // textarea's default handler so the cursor position
                            // and selection are honored.
                            if (canAttachImages && e.clipboardData.files.length > 0) {
                                const hasImageFile = Array.from(e.clipboardData.files).some((f) => f.type.startsWith('image/'));
                                if (hasImageFile) {
                                    e.preventDefault();
                                    void addFiles(e.clipboardData.files);
                                }
                            }
                        }}
                        onKeyDown={e => {
                            if (e.key !== 'Enter') return;
                            if (e.nativeEvent.isComposing) return;
                            // Shift+Enter inserts a newline (textarea default).
                            // Plain Enter submits. No "double-newline submits"
                            // heuristic — interior newlines are preserved verbatim.
                            if (e.shiftKey) return;
                            e.preventDefault();
                            void submitDraft();
                        }}
                        className="w-full rounded-[20px] px-4 py-2 bg-bg-secondary text-sm text-text-primary resize-none leading-[1.4] block"
                        style={{
                            border: '1px solid var(--chat-input-border, var(--border-subtle))',
                            minHeight: 40,
                            maxHeight: 160,
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                        }}
                    />
                </div>
                <button
                    onClick={() => { void submitDraft(); }}
                    disabled={shouldDisableChatSendButton({ hasDraft, isBusy })}
                    className={`w-10 h-10 rounded-full flex items-center justify-center border-none shrink-0 transition-all duration-300 ${
                        hasDraft && !isBusy ? 'cursor-pointer' : 'bg-bg-secondary cursor-default'
                    }`}
                    style={hasDraft && !isBusy ? { background: 'var(--chat-send-bg, var(--accent-primary))' } : undefined}
                    aria-label="Send message"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={hasDraft ? 'text-white' : 'text-text-muted'}>
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                </button>
                {canForceSend && (
                    <button
                        type="button"
                        onClick={() => { void forceSubmitDraft(); }}
                        disabled={!hasDraft}
                        className={`h-10 px-3 rounded-full text-[11px] font-medium border border-border-subtle shrink-0 transition-colors ${
                            hasDraft
                                ? 'bg-bg-secondary text-text-primary hover:bg-[var(--surface-tertiary)]'
                                : 'bg-bg-secondary text-text-muted cursor-default opacity-60'
                        }`}
                        aria-label="Force send message now"
                        title="Force send message now"
                    >
                        Force
                    </button>
                )}
            </div>

            {/* Attach error / drag hint */}
            {(attachError || (canAttachImages && isDragOver)) && (
                <div className={`pt-1.5 px-1 text-[11px] ${attachError ? 'text-red-400' : 'text-[var(--accent-primary)]'}`}>
                    {attachError || 'Drop image here'}
                </div>
            )}
            {inlineStatusMessage && !attachError && (
                <div className="pt-2 px-1 text-[11px] text-text-muted opacity-80">
                    {inlineStatusMessage}
                </div>
            )}
        </div>
    );
});

export default ChatInputBar;
export type { ChatInputBarProps };
