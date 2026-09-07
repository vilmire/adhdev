/**
 * Provider-session binding + canonical history hydration (verbatim move out of
 * CliProviderInstance — M-FILE-SIZE-DEBT decomposition).
 *
 * Owns the cluster that answers "which provider session is this instance bound
 * to, and what transcript has already been persisted for it":
 *   - promoteProviderSessionId — the sticky binding rule (authoritative-only
 *     rebind) plus the antigravity conversation claim taken at bind time.
 *   - syncCanonicalSavedHistoryIfNeeded — the bounded (per-status-report) vs
 *     full (once-per-resume) native/materialized hydration read, with its 2s
 *     window-tagged read cache.
 *   - restorePersistedHistoryFromCurrentSession — the once-per-resume seeding
 *     path that primes ChatHistoryWriter dedup state.
 *   - shouldSuppressFreshLaunchStartupReplay — the fresh-launch guard that keeps
 *     a provider's PRE-EXISTING workspace transcript from being replayed as this
 *     turn's output.
 *
 * State lives ON THE HOST (the provider instance) exactly as before, so the
 * existing per-incident suites that seed/inspect these fields directly are
 * unchanged. Provenance kept inline: hermes ≥0.14 sub-session rebind (sticky
 * binding), the antigravity two-sessions-one-.db crosswire RCA, and the
 * STATUS_HYDRATION_TAIL_LIMIT bounded-read decision.
 */

import { LOG } from '../logging/logger.js';
import type { ProviderModule } from './contracts.js';
import {
    ChatHistoryWriter,
    isNativeSourceCanonicalHistory,
    materializeProviderNativeHistory,
    readChatHistory,
    readProviderChatHistory,
} from '../config/chat-history.js';
import { claimAntigravityConversation } from './native-history/antigravity-claim-registry.js';
import type { PersistableCliHistoryMessage } from './cli-provider-history-dedup.js';
import { STATUS_HYDRATION_TAIL_LIMIT } from './cli-provider-instance-types.js';
import { isIdleStatus, getMessageTime } from './cli-provider-status-helpers.js';

/** The narrow surface of CliProviderInstance this cluster reads/writes. */
export interface HistorySyncHost {
    type: string;
    workingDir: string;
    instanceId: string;
    provider: ProviderModule;
    launchMode: 'new' | 'resume' | 'manual';
    providerSessionId?: string;
    historyWriter: ChatHistoryWriter;
    adapter: { updateRuntimeMeta(meta: { providerSessionId: string }): void };
    lastPersistedHistoryMessages: PersistableCliHistoryMessage[];
    lastNativeSourceCanonicalCheckAt: number;
    lastNativeSourceCanonicalCacheKey: string | undefined;
    suppressIdleHistoryReplay: boolean;
    antigravityClaimOwner(): string;
    onProviderSessionResolved?: (info: {
        instanceId: string;
        providerType: string;
        providerName: string;
        workspace: string;
        providerSessionId: string;
        previousProviderSessionId?: string;
    }) => void;
}

/** Normalizes a hydration read's messages into the persisted-tail shape. */
function toPersistableMessages(
    messages: Array<{ role: string; content: string; kind?: string; senderName?: string; receivedAt?: number }>,
): PersistableCliHistoryMessage[] {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
        kind: message.kind,
        senderName: message.senderName,
        receivedAt: message.receivedAt,
    })) as PersistableCliHistoryMessage[];
}

export function shouldHydrateExistingProviderHistory(host: HistorySyncHost): boolean {
    return host.launchMode === 'resume' || host.launchMode === 'manual';
}

export function promoteProviderSessionId(
    host: HistorySyncHost,
    sessionId: string,
    opts: { authoritative?: boolean } = {},
): void {
    const nextSessionId = String(sessionId || '').trim();
    if (!nextSessionId || nextSessionId === host.providerSessionId) return;

    // Sticky binding: once this instance is bound to a provider session,
    // an *observed* id (one discovered from a status parse or the native
    // history reader) must NOT hijack the live binding. hermes ≥0.14
    // spawns a fresh `sessions` row per internal sub-session, so a
    // newest-wins native read surfaces a different id mid-turn on every
    // poll; accepting it would re-bind the instance, re-hydrate unbounded
    // history (daemon saturation) and reset completion detection so the
    // turn never finalizes. Only an *authoritative* change — the first
    // bind (no id yet) or an explicit provider `new_session`/resume — may
    // replace an existing binding. Legitimate resume/new-session paths
    // pass authoritative:true and are unaffected.
    if (host.providerSessionId && !opts.authoritative) {
        LOG.debug('CLI', `[${host.type}] ignoring non-authoritative session id ${nextSessionId} (bound to ${host.providerSessionId})`);
        return;
    }

    const previousHistorySessionId = host.providerSessionId || host.instanceId;
    const previousProviderSessionId = host.providerSessionId;
    host.providerSessionId = nextSessionId;
    // Conversation-binding lock (antigravity): the moment this session is
    // authoritatively bound to a conversation uuid, claim it so a concurrent
    // sibling session's newest-on-disk discovery can never resolve to the
    // same .db (RCA: two antigravity sessions ~94ms apart shared one store
    // and cross-routed completions). Released on dispose().
    if (host.type === 'antigravity-cli') {
        const owner = host.antigravityClaimOwner();
        if (owner) claimAntigravityConversation(nextSessionId, owner);
    }
    host.historyWriter.promoteHistorySession(host.type, previousHistorySessionId, nextSessionId);
    host.historyWriter.writeSessionStart(host.type, nextSessionId, host.workingDir, host.instanceId);
    if (shouldHydrateExistingProviderHistory(host)) {
        restorePersistedHistoryFromCurrentSession(host);
    }
    host.adapter.updateRuntimeMeta({ providerSessionId: nextSessionId });
    host.onProviderSessionResolved?.({
        instanceId: host.instanceId,
        providerType: host.type,
        providerName: host.provider.name,
        workspace: host.workingDir,
        providerSessionId: nextSessionId,
        previousProviderSessionId,
    });
    LOG.info('CLI', `[${host.type}] discovered provider session id: ${nextSessionId}`);
}

export function shouldSuppressFreshLaunchStartupReplay(
    host: HistorySyncHost,
    parsedMessages: unknown[],
    parsedStatus: any,
    adapterStatus: any,
    parsedProviderSessionId = '',
): boolean {
    if (host.launchMode !== 'new') return false;
    if (host.providerSessionId) return false;
    if (!Array.isArray(parsedMessages) || parsedMessages.length === 0) return false;
    if (!isIdleStatus(adapterStatus?.status) || !isIdleStatus(parsedStatus?.status)) return false;
    if (parsedProviderSessionId) return true;

    const newestMessageAt = parsedMessages.reduce<number>((newest, message) => Math.max(newest, getMessageTime(message)), 0);

    // Untimestamped idle parser output during a fresh launch is usually the
    // provider's last workspace transcript before a new turn exists.
    return newestMessageAt === 0;
}

export function syncCanonicalSavedHistoryIfNeeded(
    host: HistorySyncHost,
    options: { full?: boolean } = {},
): boolean {
    if (!host.providerSessionId) return false;
    const canonicalHistory = host.provider.nativeHistory;
    if (!canonicalHistory) return false;

    // Per-status-report hydration reads only a bounded tail (snapshot needs at
    // most the newest 60). The once-per-resume restore path passes full:true
    // because seedSessionHistory needs the COMPLETE transcript to seed dedup
    // state. The read-cache key encodes the window so the bounded and full
    // reads don't share/clobber each other's 2s cache entry.
    const limit = options.full ? Number.MAX_SAFE_INTEGER : STATUS_HYDRATION_TAIL_LIMIT;
    const windowTag = options.full ? 'full' : `tail:${STATUS_HYDRATION_TAIL_LIMIT}`;

    // authority-ok: history-hydration READ routing, not a completion verdict. Selects
    // the on-disk native transcript vs the materialized-mirror read path; no
    // completion/stall/redrive decision is taken here.
    if (isNativeSourceCanonicalHistory(canonicalHistory)) {
        const cacheKey = [host.type, host.providerSessionId, host.workingDir, windowTag].join('\0');
        const now = Date.now();
        if (cacheKey === host.lastNativeSourceCanonicalCacheKey && now - host.lastNativeSourceCanonicalCheckAt < 2_000) {
            return true;
        }
        host.lastNativeSourceCanonicalCacheKey = cacheKey;
        host.lastNativeSourceCanonicalCheckAt = now;

        const restoredHistory = readProviderChatHistory(host.type, {
            canonicalHistory,
            historySessionId: host.providerSessionId,
            workspace: host.workingDir,
            offset: 0,
            limit,
            historyBehavior: host.provider.historyBehavior,
            scripts: host.provider.scripts as any,
        });
        if (restoredHistory.source === 'provider-native') {
            host.lastPersistedHistoryMessages = toPersistableMessages(restoredHistory.messages);
        }
        return true;
    }

    try {
        const cacheKey = [host.type, host.providerSessionId, host.workingDir, canonicalHistory.mode || 'materialized-mirror', windowTag].join('\0');
        const now = Date.now();
        if (cacheKey === host.lastNativeSourceCanonicalCacheKey && now - host.lastNativeSourceCanonicalCheckAt < 2_000) {
            return true;
        }
        host.lastNativeSourceCanonicalCacheKey = cacheKey;
        host.lastNativeSourceCanonicalCheckAt = now;

        if (!materializeProviderNativeHistory(host.type, canonicalHistory, host.providerSessionId, host.workingDir, host.provider.scripts as any)) {
            return false;
        }
        // Bounded by default: the per-status-report path only needs the newest
        // STATUS_HYDRATION_TAIL_LIMIT messages because the snapshot caps
        // activeChat.messages to the last 60 (status/normalize.ts) and loads
        // the rest lazily via read_chat on subscribe. The once-per-resume
        // restore path passes full:true so seedSessionHistory still sees the
        // COMPLETE transcript for prefix-dedup seeding. readChatHistory serves
        // a bounded limit as an O(tail) read.
        const restoredHistory = readChatHistory(host.type, 0, limit, host.providerSessionId, 0, host.provider.historyBehavior);
        host.lastPersistedHistoryMessages = toPersistableMessages(restoredHistory.messages);
        return true;
    } catch {
        return false;
    }
}

export function restorePersistedHistoryFromCurrentSession(host: HistorySyncHost): void {
    if (!host.providerSessionId) return;
    // Restore is the once-per-resume seeding path: it needs the COMPLETE
    // transcript so seedSessionHistory can prime dedup state. Pass full so the
    // hydration read is unbounded here (and only here).
    syncCanonicalSavedHistoryIfNeeded(host, { full: true });
    // authority-ok: history-restore READ routing, not a completion verdict — picks the
    // native transcript read vs the legacy chat-history read for seeding dedup state.
    const restoredHistory = isNativeSourceCanonicalHistory(host.provider.nativeHistory)
        ? readProviderChatHistory(host.type, {
            canonicalHistory: host.provider.nativeHistory,
            historySessionId: host.providerSessionId,
            workspace: host.workingDir,
            offset: 0,
            limit: Number.MAX_SAFE_INTEGER,
            historyBehavior: host.provider.historyBehavior,
            scripts: host.provider.scripts as any,
        })
        : (() => {
            host.historyWriter.compactHistorySession(host.type, host.providerSessionId!, host.provider.historyBehavior);
            return readChatHistory(host.type, 0, Number.MAX_SAFE_INTEGER, host.providerSessionId, 0, host.provider.historyBehavior);
        })();
    host.historyWriter.seedSessionHistory(
        host.type,
        restoredHistory.messages,
        host.providerSessionId,
        host.instanceId,
    );
    host.lastPersistedHistoryMessages = toPersistableMessages(restoredHistory.messages);
    host.suppressIdleHistoryReplay = restoredHistory.messages.length > 0;
}
