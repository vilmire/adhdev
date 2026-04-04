import type { ActiveChatData } from '../providers/provider-instance.js';

export type ManagedStatus =
    | 'idle'
    | 'generating'
    | 'waiting_approval'
    | 'error'
    | 'stopped'
    | 'starting'
    | 'panel_hidden'
    | 'not_monitored'
    | 'disconnected';

const WORKING_STATUSES = new Set([
    'generating',
    'streaming',
    'loading',
    'loading_reference',
    'thinking',
    'active',
]);

// Status snapshots are sent over P2P every 5s, so keep only a recent live window here.
// Older history is fetched on demand via `chat_history`, and CLI terminals stream via runtime events.
const STATUS_ACTIVE_CHAT_MESSAGE_LIMIT = 60;
const STATUS_ACTIVE_CHAT_TOTAL_BYTES_LIMIT = 96 * 1024;
const STATUS_ACTIVE_CHAT_STRING_LIMIT = 4 * 1024;
const STATUS_ACTIVE_CHAT_FALLBACK_STRING_LIMIT = 1024;
const STATUS_INPUT_CONTENT_LIMIT = 2 * 1024;
const STATUS_MODAL_MESSAGE_LIMIT = 2 * 1024;
const STATUS_MODAL_BUTTON_LIMIT = 120;

function truncateString(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 12) return value.slice(0, Math.max(0, maxChars));
    return `${value.slice(0, maxChars - 12)}...[truncated]`;
}

function truncateStringTail(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 12) return value.slice(value.length - Math.max(0, maxChars));
    return `...[truncated]${value.slice(value.length - (maxChars - 12))}`;
}

function trimStructuredStrings(value: unknown, maxChars: number): unknown {
    if (typeof value === 'string') return truncateString(value, maxChars);
    if (Array.isArray(value)) return value.map((item) => trimStructuredStrings(item, maxChars));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, trimStructuredStrings(nested, maxChars)]),
    );
}

function estimateBytes(value: unknown): number {
    try {
        return JSON.stringify(value).length;
    } catch {
        return String(value ?? '').length;
    }
}

function trimMessageForStatus(message: unknown, stringLimit: number): unknown {
    if (!message || typeof message !== 'object') return message;
    return trimStructuredStrings(message, stringLimit);
}

function trimMessagesForStatus(messages: unknown[] | null | undefined): unknown[] {
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const recent = messages.slice(-STATUS_ACTIVE_CHAT_MESSAGE_LIMIT);
    const kept: unknown[] = [];
    let totalBytes = 0;

    for (let i = recent.length - 1; i >= 0; i -= 1) {
        let normalized = trimMessageForStatus(recent[i], STATUS_ACTIVE_CHAT_STRING_LIMIT);
        let size = estimateBytes(normalized);

        if (size > STATUS_ACTIVE_CHAT_TOTAL_BYTES_LIMIT) {
            normalized = trimMessageForStatus(recent[i], STATUS_ACTIVE_CHAT_FALLBACK_STRING_LIMIT);
            size = estimateBytes(normalized);
        }

        if (kept.length > 0 && (totalBytes + size) > STATUS_ACTIVE_CHAT_TOTAL_BYTES_LIMIT) {
            continue;
        }

        kept.push(normalized);
        totalBytes += size;
    }

    return kept.reverse();
}

function hasApprovalButtons(activeModal?: { buttons?: unknown[] | null } | null): boolean {
    return (activeModal?.buttons?.length ?? 0) > 0;
}

export function normalizeManagedStatus(
    status?: string | null,
    opts?: { activeModal?: { buttons?: unknown[] | null } | null },
): ManagedStatus {
    if (hasApprovalButtons(opts?.activeModal)) return 'waiting_approval';

    const normalized = String(status || 'idle').trim().toLowerCase();
    if (normalized === 'waiting_approval') return 'waiting_approval';
    if (WORKING_STATUSES.has(normalized)) return 'generating';
    if (normalized === 'error') return 'error';
    if (normalized === 'stopped') return 'stopped';
    if (normalized === 'starting') return 'starting';
    if (normalized === 'panel_hidden') return 'panel_hidden';
    if (normalized === 'not_monitored') return 'not_monitored';
    if (normalized === 'disconnected') return 'disconnected';
    return 'idle';
}

export function isManagedStatusWorking(status?: string | null): boolean {
    return normalizeManagedStatus(status) === 'generating';
}

export function isManagedStatusWaiting(
    status?: string | null,
    opts?: { activeModal?: { buttons?: unknown[] | null } | null },
): boolean {
    return normalizeManagedStatus(status, opts) === 'waiting_approval';
}

export function normalizeActiveChatData<T extends ActiveChatData | null | undefined>(
    activeChat: T,
): T {
    if (!activeChat) return activeChat;
    return {
        ...activeChat,
        status: normalizeManagedStatus(activeChat.status, { activeModal: activeChat.activeModal }),
        messages: trimMessagesForStatus(activeChat.messages) as T extends { messages: infer M } ? M : never,
        activeModal: activeChat.activeModal ? {
            message: truncateString(activeChat.activeModal.message || '', STATUS_MODAL_MESSAGE_LIMIT),
            buttons: (activeChat.activeModal.buttons || []).map((button) =>
                truncateString(String(button || ''), STATUS_MODAL_BUTTON_LIMIT)
            ),
        } : activeChat.activeModal,
        inputContent: activeChat.inputContent
            ? truncateString(activeChat.inputContent, STATUS_INPUT_CONTENT_LIMIT)
            : activeChat.inputContent,
    } as T;
}
