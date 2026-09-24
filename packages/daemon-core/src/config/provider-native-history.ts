/**
 * Provider Native History — read chat history straight from a provider's own
 * on-disk store (jsonl / sqlite / json) instead of ADHDev's saved-history mirror.
 *
 * Split out of chat-history.ts (FILE-SIZE-HEADROOM): this is the native-source
 * read path in full — script resolution, record normalization, the mirror
 * materialization, and the native session listing. Pure move; chat-history.ts
 * re-exports the public surface so call sites are unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProviderCanonicalHistoryConfig, ProviderHistoryBehavior } from '../providers/contracts.js';
import {
    type HistoryMessage,
    type SavedHistorySessionSummary,
    findCollapsedIndexByIdentity,
    listSavedHistorySessions,
    normalizeSavedHistorySessionId,
    pageHistoryRecords,
    readChatHistory,
    readExistingSessionStartRecord,
    rewriteCanonicalSavedHistory,
    sanitizeHistoryMessage,
    sortSavedHistorySessionSummaries,
} from './chat-history.js';

export type ProviderNativeHistoryScripts = Record<string, ((input: any) => any) | undefined>;

type ProviderNativeHistoryReadResult = {
    records: HistoryMessage[];
    /** (NATIVE-TURN-SIGNAL) provider-native turn-terminal records, when the reader surfaces them. */
    turnTerminalMarkers?: Array<{ receivedAt: number; outcome: 'completed' | 'aborted'; summary: string; turnId?: string }>;
    sourcePath: string;
    sourceMtimeMs: number;
    providerSessionId?: string;
    workspace?: string;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
    // Antigravity: whether the resolved conversation was owner-token-confirmed as
    // this session's own (vs a bare recency pick). Threaded to the read-path so
    // the workspace-latest pin + first-read safe-mapping trust only fire for a
    // confirmed uuid. See dispatcher NativeHistoryResult.ownerConfirmed.
    ownerConfirmed?: boolean;
    // Sidecar-workspace (kimi) attribution decision for this read — 'pinned' /
    // 'claimed' / 'stale_reclaimed' / 'spawn_evidence' / 'legacy' on a bind,
    // 'ambiguous' / 'already_claimed' on a typed fail-closed result. Surfaced
    // for observability; the fail-closed values always accompany
    // unavailableReason 'attribution_unknown' and zero records.
    attribution?: string;
};

function getNativeHistoryScriptName(canonicalHistory: ProviderCanonicalHistoryConfig | undefined, key: 'readSession' | 'listSessions'): string {
    const configured = canonicalHistory?.scripts?.[key];
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return key === 'readSession' ? 'readNativeHistory' : 'listNativeHistory';
}

function getProviderNativeHistoryScript(
    scripts: ProviderNativeHistoryScripts | undefined,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    key: 'readSession' | 'listSessions',
): ((input: any) => any) | null {
    if (!canonicalHistory?.scripts) return null;
    const fn = scripts?.[getNativeHistoryScriptName(canonicalHistory, key)];
    return typeof fn === 'function' ? fn : null;
}

/**
 * @message-projection l3
 *
 * The FIRST hop every native-history read passes through. A field dropped here
 * can never be recovered downstream — the activeChat / persisted-tail remaps
 * only carry what they are handed.
 */
function normalizeProviderNativeHistoryRecords(agentType: string, historySessionId: string, records: unknown): HistoryMessage[] {
    if (!Array.isArray(records)) return [];
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId);
    return records
        .map((record: any) => {
            const base: HistoryMessage = {
                ts: typeof record?.ts === 'string' ? record.ts : new Date(Number(record?.receivedAt) || Date.now()).toISOString(),
                receivedAt: Number(record?.receivedAt) || Date.parse(record?.ts || '') || Date.now(),
                role: record?.role,
                content: String(record?.content || ''),
                kind: record?.kind || (record?.role === 'system' ? 'session_start' : 'standard'),
                senderName: record?.senderName,
                // The specific tool being invoked (e.g. 'read_file'), when the
                // reader resolves one — distinct from the generic
                // senderName:'Tool'. See dispatcher.ts toNativeHistoryMessage.
                toolName: typeof record?.toolName === 'string' && record.toolName ? record.toolName : undefined,
                agent: agentType,
                instanceId: record?.instanceId,
                historySessionId: normalizeSavedHistorySessionId(record?.historySessionId || normalizedSessionId),
                sessionTitle: record?.sessionTitle,
                workspace: record?.workspace,
            } as HistoryMessage;
            // (A2.3 v2 identity passthrough) — if the producer (native_history.js)
            // emitted v2 stable identity, keep it across the sanitize layer so
            // downstream (chat-commands.ts normalizeNativeHistoryMessages) sees
            // the producer's contract output instead of recomputing from index
            // and content hash. v1 producers without these fields are unaffected.
            if (typeof record?.providerUnitKey === 'string' && record.providerUnitKey) {
                (base as any).providerUnitKey = record.providerUnitKey;
            }
            if (typeof record?.bubbleId === 'string' && record.bubbleId) {
                (base as any).bubbleId = record.bubbleId;
            }
            if (typeof record?.sequence === 'number' && Number.isFinite(record.sequence)) {
                (base as any).sequence = record.sequence;
            }
            if (typeof record?._turnKey === 'string' && record._turnKey) {
                (base as any)._turnKey = record._turnKey;
            }
            if (typeof record?.bubbleState === 'string' && record.bubbleState) {
                (base as any).bubbleState = record.bubbleState;
            }
            // (TOOL-EXPAND) The content-free tool-block ref the native parser
            // stamps on truncated tool bubbles. This normalizer is the FIRST hop
            // every native-history read passes through (callProviderNativeHistoryRead
            // -> here -> pageHistoryRecords -> readProviderChatHistory), so a ref
            // dropped here can never be recovered by the downstream activeChat /
            // persisted-tail remaps — they only carry what they are handed. Copied
            // by NAME and only when present so prose bubbles keep their exact key
            // set, and re-read field by field as three numbers so nothing but the
            // three indices can ride this lane (the boundary that makes the ref
            // safe to project into activeChat at all).
            const ref = record?.toolBlockRef;
            if (ref && typeof ref === 'object'
                && typeof ref.sourceMtimeMs === 'number'
                && typeof ref.recordIndex === 'number'
                && typeof ref.blockIndex === 'number') {
                (base as any).toolBlockRef = {
                    sourceMtimeMs: ref.sourceMtimeMs,
                    recordIndex: ref.recordIndex,
                    blockIndex: ref.blockIndex,
                };
            }
            return sanitizeHistoryMessage(agentType, base);
        })
        .filter(Boolean) as HistoryMessage[];
}

function callProviderNativeHistoryRead(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    scripts: ProviderNativeHistoryScripts | undefined,
    historySessionId: string | undefined,
    workspace?: string,
    excludeInProgressTurn?: boolean,
    sessionStartedAtMs?: number,
    envOverrides?: Record<string, string>,
    forceRefresh?: boolean,
    instanceId?: string,
): ProviderNativeHistoryReadResult | null {
    const fn = getProviderNativeHistoryScript(scripts, canonicalHistory, 'readSession');
    if (!fn) return null;
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId || '');
    const normalizedInstanceId = typeof instanceId === 'string' ? instanceId.trim() : '';
    const result = fn({
        agentType,
        sessionId: normalizedSessionId,
        // Arm the native-history executor's session pin guard. When the
        // instance is already bound to a provider session, pass that id as
        // `providerSessionId` so the executor rejects any *other* newest
        // session it would otherwise pick (hermes ≥0.14 creates a fresh
        // `sessions` row per internal sub-session, so an unpinned
        // newest-wins query drifts to a different id on every read →
        // re-bind churn + unbounded history re-hydration). When there is no
        // bound id yet (first-bind / workspace-only discovery) this is '',
        // which leaves the guard disarmed so discovery still works.
        providerSessionId: normalizedSessionId,
        historySessionId: normalizedSessionId,
        // Stable per-session owner key for the antigravity conversation-claim
        // registry (see dispatcher.resolveAntigravityPath / antigravityOwnerToken).
        // Equals the session registry's sessionId and the provider instance's
        // instanceId, so read side and instance side derive the identical claim
        // owner token and two concurrent antigravity sessions never cross-bind.
        instanceId: normalizedInstanceId || undefined,
        workspace,
        format: canonicalHistory?.format,
        watchPath: canonicalHistory?.watchPath,
        excludeInProgressTurn: excludeInProgressTurn === true,
        sessionStartedAtMs,
        envOverrides,
        forceRefresh: forceRefresh === true,
        args: { sessionId: normalizedSessionId, historySessionId: normalizedSessionId, instanceId: normalizedInstanceId || undefined, workspace, excludeInProgressTurn: excludeInProgressTurn === true, sessionStartedAtMs, envOverrides, forceRefresh: forceRefresh === true },
    });
    if (!result || typeof result !== 'object') return null;
    const records = normalizeProviderNativeHistoryRecords(agentType, normalizedSessionId, (result as any).messages || (result as any).records);
    const attribution = typeof (result as any).attribution === 'string' ? (result as any).attribution.trim() : undefined;
    const resultUnavailableReason = typeof (result as any).unavailableReason === 'string' ? (result as any).unavailableReason.trim() : undefined;
    if (records.length === 0) {
        // Typed fail-closed (e.g. kimi attribution_unknown under same-cwd
        // concurrency): surface the decision instead of collapsing to a bare
        // "no file" so read_chat can log/report WHY nothing was bound — and so
        // no pin is written from ambiguity (there is no providerSessionId).
        if (attribution || resultUnavailableReason) {
            return {
                records: [],
                sourcePath: '',
                sourceMtimeMs: 0,
                unavailableReason: resultUnavailableReason,
                ownerConfirmed: false,
                attribution,
            };
        }
        return null;
    }
    return {
        records,
        turnTerminalMarkers: Array.isArray((result as any).turnTerminalMarkers) ? (result as any).turnTerminalMarkers : undefined,
        sourcePath: typeof (result as any).sourcePath === 'string' ? (result as any).sourcePath : '',
        sourceMtimeMs: Number((result as any).sourceMtimeMs) || 0,
        providerSessionId: typeof (result as any).providerSessionId === 'string' ? (result as any).providerSessionId.trim() : undefined,
        workspace: typeof (result as any).workspace === 'string' ? (result as any).workspace.trim() : undefined,
        nativeHistoryCoverage: typeof (result as any).nativeHistoryCoverage === 'string' ? (result as any).nativeHistoryCoverage.trim() : undefined,
        partialReason: typeof (result as any).partialReason === 'string' ? (result as any).partialReason.trim() : undefined,
        unavailableReason: resultUnavailableReason,
        ownerConfirmed: typeof (result as any).ownerConfirmed === 'boolean' ? (result as any).ownerConfirmed : undefined,
        attribution,
    };
}

function buildNativeHistoryReadResult(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    scripts: ProviderNativeHistoryScripts | undefined,
    historySessionId: string | undefined,
    workspace?: string,
    excludeInProgressTurn?: boolean,
    sessionStartedAtMs?: number,
    envOverrides?: Record<string, string>,
    forceRefresh?: boolean,
    instanceId?: string,
): ProviderNativeHistoryReadResult | null {
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId || '');
    const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
    if (!canonicalHistory || (!normalizedSessionId && !normalizedWorkspace) || !isNativeSourceCanonicalHistory(canonicalHistory)) return null;
    return callProviderNativeHistoryRead(agentType, canonicalHistory, scripts, normalizedSessionId, workspace, excludeInProgressTurn, sessionStartedAtMs, envOverrides, forceRefresh, instanceId);
}

function materializeNativeHistoryToMirror(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    historySessionId: string,
    workspace?: string,
    scripts?: ProviderNativeHistoryScripts,
): boolean {
    const normalizedSessionId = normalizeSavedHistorySessionId(historySessionId);
    if (!normalizedSessionId) return false;
    const nativeResult = callProviderNativeHistoryRead(agentType, canonicalHistory, scripts, normalizedSessionId, workspace);
    const nativeRecords = nativeResult?.records || [];
    if (nativeRecords.length === 0) return false;
    const normalizedRecords = nativeRecords.map((record) => ({
        ...record,
        agent: agentType,
        historySessionId: normalizedSessionId,
    }));
    const existingSessionStart = readExistingSessionStartRecord(agentType, normalizedSessionId);
    const records = existingSessionStart && normalizedRecords[0]?.kind !== 'session_start'
        ? [{ ...existingSessionStart, historySessionId: normalizedSessionId, agent: agentType }, ...normalizedRecords]
        : normalizedRecords;
    return rewriteCanonicalSavedHistory(agentType, normalizedSessionId, records);
}

export function materializeProviderNativeHistory(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig | undefined,
    historySessionId: string,
    workspace?: string,
    scripts?: ProviderNativeHistoryScripts,
): boolean {
    if (!canonicalHistory || canonicalHistory.mode !== 'materialized-mirror') return false;
    return materializeNativeHistoryToMirror(agentType, canonicalHistory, historySessionId, workspace, scripts);
}

export function isNativeSourceCanonicalHistory(canonicalHistory?: ProviderCanonicalHistoryConfig): boolean {
    if (!canonicalHistory) return false;
    if ((canonicalHistory as any).mode === 'disabled') return false;
    if ((canonicalHistory as any).mode === 'materialized-mirror') return false;
    return true;
}

export function readProviderChatHistory(
    agentType: string,
    options: {
        canonicalHistory?: ProviderCanonicalHistoryConfig;
        historySessionId?: string;
        workspace?: string;
        offset?: number;
        limit?: number;
        excludeRecentCount?: number;
        /**
         * (SEAM) Identity of the oldest message in the caller's live window.
         * Preferred over `excludeRecentCount`, which is a count in a DIFFERENT
         * coordinate space than the one it is subtracted from. Ignored when it
         * cannot be resolved, falling back to the count — see
         * `findCollapsedIndexByIdentity`.
         */
        excludeFromIdentity?: string;
        historyBehavior?: ProviderHistoryBehavior;
        scripts?: ProviderNativeHistoryScripts;
        excludeInProgressTurn?: boolean;
        sessionStartedAtMs?: number;
        envOverrides?: Record<string, string>;
        forceRefresh?: boolean;
        /**
         * Drop tool/terminal/thought activity rows before paging — the
         * chat_history command's prose-only default (its `includeActivity`
         * opt-in flips this off). Absent/false preserves the historical
         * unfiltered record space for every other caller.
         */
        excludeActivity?: boolean;
        // Daemon instance id of the reading session (== the session registry's
        // sessionId). Threaded to the native-history dispatcher so the
        // antigravity conversation-claim owner token is keyed on this stable
        // per-session identity — identical to the token the provider instance
        // derives — instead of a spawn timestamp that differs across sample
        // sites and silently breaks claim isolation.
        instanceId?: string;
    } = {},
): {
    messages: HistoryMessage[];
    hasMore: boolean;
    source: 'provider-native' | 'adhdev-mirror' | 'native-unavailable';
    sourcePath?: string;
    sourceMtimeMs?: number;
    providerSessionId?: string;
    workspace?: string;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
    ownerConfirmed?: boolean;
    attribution?: string;
    /** (NATIVE-TURN-SIGNAL) provider-native turn-terminal records, when the reader surfaces them. */
    turnTerminalMarkers?: Array<{ receivedAt: number; outcome: 'completed' | 'aborted'; summary: string; turnId?: string }>;
} {
    if (isNativeSourceCanonicalHistory(options.canonicalHistory) && (options.historySessionId || options.workspace)) {
        const nativeResult = buildNativeHistoryReadResult(agentType, options.canonicalHistory, options.scripts, options.historySessionId, options.workspace, options.excludeInProgressTurn, options.sessionStartedAtMs, options.envOverrides, options.forceRefresh, options.instanceId);
        if (!nativeResult) return { messages: [], hasMore: false, source: 'native-unavailable' };
        if (nativeResult.records.length === 0) {
            // Typed fail-closed (attribution_unknown): propagate the decision —
            // never page an empty record set into a 'provider-native' result
            // that downstream could mistake for an empty-but-bound transcript.
            return {
                messages: [],
                hasMore: false,
                source: 'native-unavailable',
                unavailableReason: nativeResult.unavailableReason,
                ownerConfirmed: nativeResult.ownerConfirmed,
                attribution: nativeResult.attribution,
            };
        }
        return {
            ...pageHistoryRecords(agentType, nativeResult.records, options.offset || 0, options.limit || 30, options.excludeRecentCount || 0, options.historyBehavior, options.excludeFromIdentity, options.excludeActivity === true),
            source: 'provider-native',
            sourcePath: nativeResult.sourcePath,
            sourceMtimeMs: nativeResult.sourceMtimeMs,
            providerSessionId: nativeResult.providerSessionId,
            workspace: nativeResult.workspace,
            nativeHistoryCoverage: nativeResult.nativeHistoryCoverage,
            partialReason: nativeResult.partialReason,
            unavailableReason: nativeResult.unavailableReason,
            ownerConfirmed: nativeResult.ownerConfirmed,
            attribution: nativeResult.attribution,
            // (NATIVE-TURN-SIGNAL) Terminal markers ride alongside the paged messages —
            // deliberately NOT paged, since they are turn metadata, not chat content.
            turnTerminalMarkers: nativeResult.turnTerminalMarkers,
        };
    }
    return {
        ...readChatHistory(agentType, options.offset || 0, options.limit || 30, options.historySessionId, options.excludeRecentCount || 0, options.historyBehavior, options.excludeFromIdentity, options.excludeActivity === true),
        source: 'adhdev-mirror',
    };
}

function buildNativeSessionSummary(
    agentType: string,
    historySessionId: string,
    records: HistoryMessage[],
    sourcePath: string,
): SavedHistorySessionSummary | null {
    const visible = pageHistoryRecords(agentType, records, 0, Number.MAX_SAFE_INTEGER).messages;
    if (visible.length === 0) return null;
    let sourceMtimeMs = 0;
    try { sourceMtimeMs = fs.statSync(sourcePath).mtimeMs; } catch { /* ignore */ }
    const firstMessageAt = visible[0]?.receivedAt || sourceMtimeMs || Date.now();
    const lastMessageAt = visible[visible.length - 1]?.receivedAt || firstMessageAt;
    const lastNonSystem = [...visible].reverse().find((message) => message.role !== 'system') || visible[visible.length - 1];
    const firstSystem = visible.find((message) => message.kind === 'session_start');
    return {
        historySessionId,
        sessionTitle: lastNonSystem?.content,
        messageCount: visible.length,
        firstMessageAt,
        lastMessageAt,
        preview: lastNonSystem?.content,
        workspace: firstSystem?.workspace || (firstSystem?.kind === 'session_start' ? firstSystem.content : undefined),
        source: 'provider-native',
        sourcePath,
        sourceMtimeMs,
    };
}

function normalizeProviderNativeHistorySessionSummary(agentType: string, item: any): SavedHistorySessionSummary | null {
    const historySessionId = normalizeSavedHistorySessionId(item?.historySessionId || item?.sessionId || '');
    if (!historySessionId) return null;
    const sourcePath = typeof item?.sourcePath === 'string' ? item.sourcePath : '';
    const sourceMtimeMs = Number(item?.sourceMtimeMs) || 0;
    const firstMessageAt = Number(item?.firstMessageAt) || sourceMtimeMs || Date.now();
    const lastMessageAt = Number(item?.lastMessageAt) || firstMessageAt;
    const messageCount = Math.max(0, Number(item?.messageCount) || 0);
    return {
        historySessionId,
        sessionTitle: typeof item?.sessionTitle === 'string' ? item.sessionTitle : undefined,
        messageCount,
        firstMessageAt,
        lastMessageAt,
        preview: typeof item?.preview === 'string' ? item.preview : undefined,
        workspace: typeof item?.workspace === 'string' ? item.workspace : undefined,
        source: 'provider-native',
        sourcePath,
        sourceMtimeMs,
    };
}

function collectProviderScriptNativeHistorySessionSummaries(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    scripts?: ProviderNativeHistoryScripts,
): SavedHistorySessionSummary[] | null {
    const fn = getProviderNativeHistoryScript(scripts, canonicalHistory, 'listSessions');
    if (!fn) return null;
    const result = fn({
        agentType,
        format: canonicalHistory.format,
        watchPath: canonicalHistory.watchPath,
        args: {},
    });
    if (!result || typeof result !== 'object') return [];
    const sessions = Array.isArray((result as any).sessions) ? (result as any).sessions : [];
    const summaries: SavedHistorySessionSummary[] = [];
    for (const item of sessions) {
        if (Array.isArray(item?.messages || item?.records)) {
            const historySessionId = normalizeSavedHistorySessionId(item?.historySessionId || item?.sessionId || '');
            if (!historySessionId) continue;
            const records = normalizeProviderNativeHistoryRecords(agentType, historySessionId, item.messages || item.records);
            const summary = buildNativeSessionSummary(agentType, historySessionId, records, typeof item?.sourcePath === 'string' ? item.sourcePath : '');
            if (summary) {
                if (Number(item?.sourceMtimeMs)) summary.sourceMtimeMs = Number(item.sourceMtimeMs);
                summaries.push(summary);
            }
            continue;
        }
        const summary = normalizeProviderNativeHistorySessionSummary(agentType, item);
        if (summary) summaries.push(summary);
    }
    return sortSavedHistorySessionSummaries(summaries);
}

function collectNativeHistorySessionSummaries(
    agentType: string,
    canonicalHistory: ProviderCanonicalHistoryConfig,
    scripts?: ProviderNativeHistoryScripts,
): SavedHistorySessionSummary[] {
    return collectProviderScriptNativeHistorySessionSummaries(agentType, canonicalHistory, scripts) || [];
}

export function listProviderHistorySessions(
    agentType: string,
    options: {
        canonicalHistory?: ProviderCanonicalHistoryConfig;
        offset?: number;
        limit?: number;
        historyBehavior?: ProviderHistoryBehavior;
        scripts?: ProviderNativeHistoryScripts;
    } = {},
): { sessions: SavedHistorySessionSummary[]; hasMore: boolean; source: 'provider-native' | 'adhdev-mirror' } {
    if (isNativeSourceCanonicalHistory(options.canonicalHistory)) {
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.max(1, options.limit || 30);
        const summaries = collectNativeHistorySessionSummaries(agentType, options.canonicalHistory!, options.scripts);
        return {
            sessions: summaries.slice(offset, offset + limit),
            hasMore: offset + limit < summaries.length,
            source: 'provider-native',
        };
    }
    return {
        ...listSavedHistorySessions(agentType, { offset: options.offset, limit: options.limit }, options.historyBehavior),
        source: 'adhdev-mirror',
    };
}
