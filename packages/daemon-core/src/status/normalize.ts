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

export interface NormalizeActiveChatOptions {
    includeMessages?: boolean;
    includeInputContent?: boolean;
    includeActiveModal?: boolean;
    messageLimit?: number;
    totalBytesLimit?: number;
    stringLimit?: number;
    fallbackStringLimit?: number;
}

// Full snapshots are still capped, but can carry recent chat context for API/inspection use.
const FULL_STATUS_ACTIVE_CHAT_OPTIONS: Required<NormalizeActiveChatOptions> = {
    includeMessages: true,
    includeInputContent: true,
    includeActiveModal: true,
    messageLimit: 60,
    totalBytesLimit: 96 * 1024,
    stringLimit: 4 * 1024,
    fallbackStringLimit: 1024,
};

// Live/metadata snapshots only need routing + UI summary. Current chat text is loaded
// on demand via `read_chat`, and older history via `chat_history`.
export const LIVE_STATUS_ACTIVE_CHAT_OPTIONS: Required<NormalizeActiveChatOptions> = {
    includeMessages: false,
    includeInputContent: false,
    includeActiveModal: false,
    messageLimit: 0,
    totalBytesLimit: 0,
    stringLimit: 512,
    fallbackStringLimit: 256,
};

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

/**
 * Collapse timestamp / createdAt into receivedAt so downstream consumers
 * only ever need to read a single canonical time field.
 */
function normalizeMessageTime(message: unknown): unknown {
    if (!message || typeof message !== 'object') return message;
    const msg = message as Record<string, unknown>;
    if (msg.receivedAt == null) {
        const fallback = msg.timestamp ?? msg.createdAt;
        if (fallback != null) {
            const ts = typeof fallback === 'string' ? Date.parse(fallback as string) : Number(fallback);
            if (Number.isFinite(ts) && ts > 0) msg.receivedAt = ts;
        }
    }
    return msg;
}

function trimMessagesForStatus(
    messages: unknown[] | null | undefined,
    options: Required<NormalizeActiveChatOptions>,
): unknown[] {
    if (!options.includeMessages || options.messageLimit <= 0 || options.totalBytesLimit <= 0) return [];
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const recent = messages.slice(-options.messageLimit);
    const kept: unknown[] = [];
    let totalBytes = 0;

    for (let i = recent.length - 1; i >= 0; i -= 1) {
        let normalized = normalizeMessageTime(trimMessageForStatus(recent[i], options.stringLimit));
        let size = estimateBytes(normalized);

        if (size > options.totalBytesLimit) {
            normalized = normalizeMessageTime(trimMessageForStatus(recent[i], options.fallbackStringLimit));
            size = estimateBytes(normalized);
        }

        if (kept.length > 0 && (totalBytes + size) > options.totalBytesLimit) {
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
    options: NormalizeActiveChatOptions = FULL_STATUS_ACTIVE_CHAT_OPTIONS,
): T {
    if (!activeChat) return activeChat;
    const resolvedOptions: Required<NormalizeActiveChatOptions> = {
        ...FULL_STATUS_ACTIVE_CHAT_OPTIONS,
        ...options,
    };
    return {
        ...activeChat,
        status: normalizeManagedStatus(activeChat.status, { activeModal: activeChat.activeModal }),
        messages: trimMessagesForStatus(activeChat.messages, resolvedOptions) as T extends { messages: infer M } ? M : never,
        activeModal: resolvedOptions.includeActiveModal && activeChat.activeModal ? {
            message: truncateString(activeChat.activeModal.message || '', STATUS_MODAL_MESSAGE_LIMIT),
            buttons: (activeChat.activeModal.buttons || []).map((button) =>
                truncateString(String(button || ''), STATUS_MODAL_BUTTON_LIMIT)
            ),
        } : null,
        inputContent: resolvedOptions.includeInputContent && activeChat.inputContent
            ? truncateString(activeChat.inputContent, 2 * 1024)
            : undefined,
    } as T;
}
