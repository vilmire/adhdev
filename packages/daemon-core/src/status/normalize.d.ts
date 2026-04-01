import type { ActiveChatData } from '../providers/provider-instance.js';
export type ManagedStatus = 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';
export declare function normalizeManagedStatus(status?: string | null, opts?: {
    activeModal?: {
        buttons?: unknown[] | null;
    } | null;
}): ManagedStatus;
export declare function isManagedStatusWorking(status?: string | null): boolean;
export declare function isManagedStatusWaiting(status?: string | null, opts?: {
    activeModal?: {
        buttons?: unknown[] | null;
    } | null;
}): boolean;
export declare function normalizeActiveChatData<T extends ActiveChatData | null | undefined>(activeChat: T): T;
