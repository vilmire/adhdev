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
    } as T;
}
