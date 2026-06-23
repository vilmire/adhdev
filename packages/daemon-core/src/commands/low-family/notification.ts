/**
 * RF-ROUTER LOW family — session notification / seen-state commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Each handler
 * mutates only the persisted recent-activity state store (loadState/saveState) and
 * fires ctx.deps.onStatusChange; session lookup is rebuilt from deps the router
 * already holds. Returns the same CommandRouterResult the inlined cases did.
 */
import { loadState, saveState } from '../../config/state-store.js';
import { markSessionSeen, dismissSessionNotification, markSessionNotificationUnread } from '../../config/recent-activity.js';
import { buildSessionEntries } from '../../status/builders.js';
import { getSessionCompletionMarker } from '../../status/snapshot.js';
import { LOG } from '../../logging/logger.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';

export const notificationHandlers: Record<string, LowFamilyHandler> = {
    mark_session_seen: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = args?.sessionId;
        if (!sessionId || typeof sessionId !== 'string') {
            return { success: false, error: 'sessionId is required' };
        }
        const currentState = loadState();
        const prevSeenAt = currentState.sessionReads?.[sessionId] || 0;
        const sessionEntries = buildSessionEntries(
            ctx.deps.instanceManager.collectAllStates(),
            ctx.deps.cdpManagers,
        );
        const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
        const requestedCompletionMarker = typeof args?.completionMarker === 'string'
            ? args.completionMarker.trim()
            : '';
        const completionMarker = requestedCompletionMarker || (targetSession ? getSessionCompletionMarker(targetSession) : '');
        const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
            ? args.providerSessionId.trim()
            : '';
        const providerSessionId = requestedProviderSessionId || targetSession?.providerSessionId;
        const next = markSessionSeen(
            currentState,
            sessionId,
            typeof args?.seenAt === 'number' ? args.seenAt : Date.now(),
            completionMarker,
            providerSessionId,
        );
        if (READ_DEBUG_ENABLED) {
            LOG.info('RecentRead', `mark_session_seen sessionId=${sessionId} seenAt=${String(args?.seenAt || '')} prevSeenAt=${String(prevSeenAt)} nextSeenAt=${String(next.sessionReads?.[sessionId] || 0)} marker=${completionMarker || '-'}`);
        }
        saveState(next);
        ctx.deps.onStatusChange?.();
        return {
            success: true,
            sessionId,
            seenAt: next.sessionReads?.[sessionId] || Date.now(),
            completionMarker,
        };
    },

    delete_notification: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = args?.sessionId;
        const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
        if (!sessionId || typeof sessionId !== 'string') {
            return { success: false, error: 'sessionId is required' };
        }
        if (!notificationId) {
            return { success: false, error: 'notificationId is required' };
        }
        const sessionEntries = buildSessionEntries(
            ctx.deps.instanceManager.collectAllStates(),
            ctx.deps.cdpManagers,
        );
        const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
        const next = dismissSessionNotification(
            loadState(),
            sessionId,
            notificationId,
            targetSession?.providerSessionId,
        );
        saveState(next);
        ctx.deps.onStatusChange?.();
        return {
            success: true,
            sessionId,
            notificationId,
        };
    },

    mark_notification_unread: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = args?.sessionId;
        const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
        if (!sessionId || typeof sessionId !== 'string') {
            return { success: false, error: 'sessionId is required' };
        }
        if (!notificationId) {
            return { success: false, error: 'notificationId is required' };
        }
        const sessionEntries = buildSessionEntries(
            ctx.deps.instanceManager.collectAllStates(),
            ctx.deps.cdpManagers,
        );
        const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
        const next = markSessionNotificationUnread(
            loadState(),
            sessionId,
            notificationId,
            targetSession?.providerSessionId,
        );
        saveState(next);
        ctx.deps.onStatusChange?.();
        return {
            success: true,
            sessionId,
            notificationId,
        };
    },
};
