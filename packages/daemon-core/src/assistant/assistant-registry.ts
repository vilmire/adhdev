/**
 * Assistant registry — `<configDir>/assistant.json`, one entry per daemon
 * (design 2026-10-07-assistant-layer.md §4.5, §4.3 restart note, §4.6).
 *
 * Shape follows the design's field list. Unlike `mesh-coordinators.json` the
 * entry is never deleted when the session goes away: aliases, `busyInputMode`,
 * `reviewTurn`, `memoryBudget`, `firstRelayAt` and `lastTurnState` are
 * settings/history that outlive any one assistant session. "Unregister" here
 * means clearing the session binding (`sessionId`, `mcpConfigPath`) only.
 *
 * Patterns kept from `mesh/coordinator-registry.ts`:
 *   - written immediately on every change, atomically (tmp + rename) at 0600;
 *   - a `daemon_shutdown` termination never releases the binding (the hosted
 *     runtime survives and is re-attached after restart);
 *   - stale bindings are pruned against the FULL boot-time restore set only
 *     (`pruneAfterRestore`), never against a partial list.
 * Restore re-binds by exact runtimeId only (`matchesAssistantRestore`). One
 * assistant per daemon means no workspace fallback (§4.5).
 */

import { existsSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import {
    ASSISTANT_ACCOUNT_SLOT,
    canonicalDaemonId,
    daemonIdsEquivalent,
    followedRemoteProjectKey,
    sanitizeRemoteRepoIdentity,
    type AssistantOwnerBindingReceipt,
    type FollowedRemoteProjectEntry,
    type FollowedRemoteProjectState,
    type SendPolicy,
} from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { resolveMemoryBudgets, type MemoryBudgets } from './memory/memory-store.js';
import { writeFileAtomic600 } from './store-guards.js';

export const ASSISTANT_REGISTRY_FILE = 'assistant.json';

/** Hermes `busy_input_mode` names (§4.3), mapped onto the existing SendPolicy. */
export const BUSY_INPUT_MODES = ['queue', 'interrupt', 'steer'] as const;
export type BusyInputMode = typeof BUSY_INPUT_MODES[number];
export const DEFAULT_BUSY_INPUT_MODE: BusyInputMode = 'queue';

/**
 * §4.3 table. Applies to HUMAN input into the assistant only; every daemon
 * input (relay, signals, restart note, review, first run) is always `queue`.
 * A refusal under the mapped policy is shown as is — callers never retry
 * under another mode (fail-closed).
 */
export function busyInputModeToSendPolicy(mode: BusyInputMode | undefined | null): SendPolicy {
    switch (mode) {
        case 'interrupt': return { mode: 'interrupt' };
        case 'steer': return { mode: 'send_now' };
        default: return { mode: 'queue' };
    }
}

export type AssistantTurnStateValue = 'idle' | 'working';

export interface AssistantTurnState {
    state: AssistantTurnStateValue;
    /** Epoch ms of the edge. */
    at: number;
    /** Session the edge was observed on. */
    sessionId: string;
}

export interface AssistantRegistryEntry {
    /** Bound assistant session (= hosted runtimeId); null when none is bound. */
    sessionId: string | null;
    cliType: string;
    workspace: string;
    mcpConfigPath?: string;
    /** User aliases → meshId (§4.2). */
    aliases: Record<string, string>;
    /** First launch, epoch ms. */
    createdAt: number;
    /** First relay ever delivered (M-metric anchor, §4.7), epoch ms. */
    firstRelayAt: number | null;
    busyInputMode: BusyInputMode;
    /** `false` disables the idle review turn (§4.10.7). */
    reviewTurn: boolean;
    /** D6 owner-chat execution; absence migrates to ON. */
    executionEnabled?: boolean;
    executionRevision?: number;
    lastTurnState: AssistantTurnState | null;
    memoryBudget?: Partial<MemoryBudgets>;
    /**
     * Epoch ms of idle review inputs delivered in the last 24 h (§4.10.7 "2 h
     * since the last review", "4 per day"). History, not a setting: kept here
     * so a daemon restart cannot re-fire a review the previous process already
     * delivered. Absent when empty.
     */
    reviewAts?: number[];
    /** Daily digest local hour 0–23 (absent → default 9; null → off). */
    digestHour?: number | null;
    /** When the last daily digest was queued (one per local day, survives restarts). */
    lastDigestAt?: number;
    /**
     * The bound session's last exchanges, saved after each finished turn while
     * the session is alive, for the next session's \`[ADHDev previous session]\`
     * note. A dead session's history is not readable for every CLI.
     */
    lastContext?: { sessionId: string; text: string; at: number };
    /**
     * Durable local owner-binding receipt for the single account-level
     * `personal` assistant slot on this Mac. Outlives ordinary daemon restarts
     * and session/provider replacements. Missing or mismatched receipt fails
     * closed until explicit owner reconciliation.
     */
    ownerBinding?: AssistantOwnerBindingReceipt;
    /**
     * Assistant-local followed remote projects keyed by canonical
     * `${hostDaemonId}::${meshId}`. Independent from `meshes.json` and member
     * host records.
     */
    followedRemoteProjects?: Record<string, FollowedRemoteProjectEntry>;
}

export interface BindAssistantSessionInput {
    sessionId: string;
    cliType: string;
    workspace: string;
    mcpConfigPath?: string;
    at: number;
}

export type AssistantSettingsPatch = Partial<Pick<AssistantRegistryEntry, 'aliases' | 'busyInputMode' | 'reviewTurn' | 'memoryBudget' | 'executionEnabled' | 'digestHour'>>;

const isDigestHour = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23;

export interface AssistantRegistryOptions {
    configDir?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPositiveSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

function normalizeAliases(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const alias = k.trim();
        if (alias && isStr(v)) out[alias] = v;
    }
    return out;
}

function normalizeTurnState(raw: unknown): AssistantTurnState | null {
    const r = raw as Partial<AssistantTurnState> | null;
    if (!r || (r.state !== 'idle' && r.state !== 'working') || !isNum(r.at) || !isStr(r.sessionId)) return null;
    return { state: r.state, at: r.at, sessionId: r.sessionId };
}

/** Review timestamps kept: the last 24 h, at most this many. */
export const ASSISTANT_REVIEW_HISTORY_MS = 24 * 60 * 60 * 1000;
const REVIEW_HISTORY_MAX = 16;

function normalizeReviewAts(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isNum).sort((a, b) => a - b).slice(-REVIEW_HISTORY_MAX);
}

function normalizeBudget(raw: unknown): Partial<MemoryBudgets> | undefined {
    const r = raw as Partial<MemoryBudgets> | null;
    if (!r || typeof r !== 'object') return undefined;
    const out: Partial<MemoryBudgets> = {};
    if (isNum(r.memory)) out.memory = r.memory;
    if (isNum(r.user)) out.user = r.user;
    return Object.keys(out).length ? out : undefined;
}

export function normalizeAssistantOwnerBinding(raw: unknown): AssistantOwnerBindingReceipt | undefined {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
    if (r.accountSlot !== ASSISTANT_ACCOUNT_SLOT) return undefined;
    const daemonId = isStr(r.daemonId) ? canonicalDaemonId(r.daemonId) : null;
    if (!daemonId) return undefined;
    if (!isPositiveSafeInt(r.bindingRevision)) return undefined;
    if (!isStr(r.boundAt)) return undefined;
    return {
        accountSlot: ASSISTANT_ACCOUNT_SLOT,
        daemonId,
        bindingRevision: r.bindingRevision,
        boundAt: r.boundAt.trim(),
    };
}

const LOCAL_OWNER_BINDING_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'local_owner_binding_missing',
    'local_owner_binding_mismatch',
    'assistant_owner_binding_missing',
    'assistant_owner_binding_mismatch',
]);

export function isLocalOwnerBindingRefusalCode(code: unknown): code is string {
    return typeof code === 'string' && LOCAL_OWNER_BINDING_REFUSAL_CODES.has(code.trim());
}

function isFollowedState(v: unknown): v is FollowedRemoteProjectState {
    return v === 'followed' || v === 'unfollowed' || v === 'revoked';
}

export function normalizeFollowedRemoteProjectEntry(raw: unknown): FollowedRemoteProjectEntry | null {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const hostDaemonId = isStr(r.hostDaemonId) ? canonicalDaemonId(r.hostDaemonId) : null;
    const meshId = isStr(r.meshId) ? r.meshId.trim() : '';
    const name = isStr(r.name) ? r.name.trim() : '';
    const slug = isStr(r.slug) ? r.slug.trim() : '';
    if (!hostDaemonId || !meshId || !name || !slug) return null;
    if (r.accountSlot !== undefined && r.accountSlot !== ASSISTANT_ACCOUNT_SLOT) return null;
    if (!isPositiveSafeInt(r.bindingRevision) || !isPositiveSafeInt(r.grantRevision)) return null;
    if (!isFollowedState(r.state)) return null;
    const key = followedRemoteProjectKey(hostDaemonId, meshId);
    const followedAt = isStr(r.followedAt) ? r.followedAt.trim() : new Date(0).toISOString();
    const updatedAt = isStr(r.updatedAt) ? r.updatedAt.trim() : followedAt;
    const unfollowedAt = isNum(r.unfollowedAt) || isStr(r.unfollowedAt) ? r.unfollowedAt : undefined;
    const revokedAt = isNum(r.revokedAt) || isStr(r.revokedAt) ? r.revokedAt : undefined;
    const revokedReason = isStr(r.revokedReason) ? r.revokedReason.trim() : undefined;
    const lastErrorCode = isStr(r.lastErrorCode) ? r.lastErrorCode.trim() : undefined;
    const lastObservedRaw = r.lastObserved as Record<string, unknown> | null | undefined;
    const lastObserved = lastObservedRaw && typeof lastObservedRaw === 'object' && isStr(lastObservedRaw.observedAt)
        ? {
            observedAt: lastObservedRaw.observedAt.trim(),
            ...(isStr(lastObservedRaw.coordinatorState) ? { coordinatorState: lastObservedRaw.coordinatorState.trim() } : {}),
            ...(typeof lastObservedRaw.coordinatorMissing === 'boolean' ? { coordinatorMissing: lastObservedRaw.coordinatorMissing } : {}),
            ...(isStr(lastObservedRaw.summary) ? { summary: lastObservedRaw.summary.trim().slice(0, 500) } : {}),
        }
        : undefined;
    return {
        key,
        hostDaemonId,
        ...(isStr(r.hostLabel) ? { hostLabel: r.hostLabel.trim() } : {}),
        meshId,
        name,
        slug,
        sanitizedRepoIdentity: isStr(r.sanitizedRepoIdentity) ? sanitizeRemoteRepoIdentity(r.sanitizedRepoIdentity) : null,
        accountSlot: ASSISTANT_ACCOUNT_SLOT,
        bindingRevision: r.bindingRevision,
        grantRevision: r.grantRevision,
        state: r.state,
        followedAt,
        updatedAt,
        ...(r.state === 'unfollowed' && unfollowedAt !== undefined ? { unfollowedAt } : {}),
        ...(r.state === 'revoked' && revokedAt !== undefined ? { revokedAt } : {}),
        ...(r.state === 'revoked' && revokedReason ? { revokedReason } : {}),
        ...(lastErrorCode ? { lastErrorCode } : {}),
        ...(r.lastCursor === null || isStr(r.lastCursor) ? { lastCursor: r.lastCursor } : {}),
        ...(r.coordinatorSessionId === null || isStr(r.coordinatorSessionId) ? { coordinatorSessionId: r.coordinatorSessionId } : {}),
        ...(lastObserved ? { lastObserved } : {}),
    };
}

function normalizeFollowedRemoteProjects(raw: unknown): Record<string, FollowedRemoteProjectEntry> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, FollowedRemoteProjectEntry> = {};
    for (const value of Object.values(raw as Record<string, unknown>)) {
        const entry = normalizeFollowedRemoteProjectEntry(value);
        if (entry) out[entry.key] = entry;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate a parsed file. Returns null when the minimum fields are missing. */
export function normalizeAssistantRegistryEntry(raw: unknown): AssistantRegistryEntry | null {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (!isStr(r.cliType) || !isStr(r.workspace) || !isNum(r.createdAt)) return null;
    const mode = BUSY_INPUT_MODES.includes(r.busyInputMode as BusyInputMode) ? r.busyInputMode as BusyInputMode : DEFAULT_BUSY_INPUT_MODE;
    const budget = normalizeBudget(r.memoryBudget);
    const reviewAts = normalizeReviewAts(r.reviewAts);
    const ownerBinding = normalizeAssistantOwnerBinding(r.ownerBinding);
    const followedRemoteProjects = normalizeFollowedRemoteProjects(r.followedRemoteProjects);
    return {
        sessionId: isStr(r.sessionId) ? r.sessionId : null,
        cliType: r.cliType,
        workspace: r.workspace,
        ...(isStr(r.mcpConfigPath) ? { mcpConfigPath: r.mcpConfigPath } : {}),
        aliases: normalizeAliases(r.aliases),
        createdAt: r.createdAt,
        firstRelayAt: isNum(r.firstRelayAt) ? r.firstRelayAt : null,
        busyInputMode: mode,
        reviewTurn: r.reviewTurn !== false,
        executionEnabled: r.executionEnabled !== false,
        executionRevision: typeof r.executionRevision === 'number' && Number.isSafeInteger(r.executionRevision) ? r.executionRevision : 0,
        lastTurnState: normalizeTurnState(r.lastTurnState),
        ...(budget ? { memoryBudget: budget } : {}),
        ...(reviewAts.length ? { reviewAts } : {}),
        ...(r.digestHour === null ? { digestHour: null } : isDigestHour(r.digestHour) ? { digestHour: r.digestHour } : {}),
        ...(isNum(r.lastDigestAt) ? { lastDigestAt: r.lastDigestAt } : {}),
        ...(normalizeContext(r.lastContext) ? { lastContext: normalizeContext(r.lastContext)! } : {}),
        ...(ownerBinding ? { ownerBinding } : {}),
        ...(followedRemoteProjects ? { followedRemoteProjects } : {}),
    };
}

function normalizeContext(v: unknown): { sessionId: string; text: string; at: number } | null {
    const c = v as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return null;
    return isStr(c.sessionId) && isStr(c.text) && c.text.length <= 8_000 && isNum(c.at) ? { sessionId: c.sessionId, text: c.text, at: c.at } : null;
}

/**
 * The restore matcher (§4.5): a hosted runtime re-binds to the assistant only
 * when its runtimeId equals the registered sessionId exactly. No trimming, no
 * case folding, no workspace fallback.
 */
export function matchesAssistantRestore(
    entry: Pick<AssistantRegistryEntry, 'sessionId'> | null | undefined,
    record: { runtimeId?: unknown } | null | undefined,
): boolean {
    const sid = entry?.sessionId;
    const rid = record?.runtimeId;
    return typeof sid === 'string' && sid.length > 0 && typeof rid === 'string' && rid === sid;
}

/** The single restore record that re-binds the assistant, or null. */
export function findAssistantRestoreRecord<T extends { runtimeId?: unknown }>(
    entry: Pick<AssistantRegistryEntry, 'sessionId'> | null | undefined,
    records: readonly T[],
): T | null {
    return records.find((r) => matchesAssistantRestore(entry, r)) ?? null;
}

export class AssistantRegistry {
    readonly path: string;
    private cache: AssistantRegistryEntry | null | undefined;
    private lastReadError: NodeJS.ErrnoException | null = null;

    constructor(opts: AssistantRegistryOptions = {}) {
        this.path = join(opts.configDir ?? getConfigDir(), ASSISTANT_REGISTRY_FILE);
    }

    private cloneCached(): AssistantRegistryEntry | null {
        if (!this.cache) return null;
        return {
            ...this.cache,
            aliases: { ...this.cache.aliases },
            ...(this.cache.reviewAts ? { reviewAts: [...this.cache.reviewAts] } : {}),
            ...(this.cache.ownerBinding ? { ownerBinding: { ...this.cache.ownerBinding } } : {}),
            ...(this.cache.followedRemoteProjects
                ? {
                    followedRemoteProjects: Object.fromEntries(
                        Object.entries(this.cache.followedRemoteProjects).map(([k, v]) => [k, { ...v }]),
                    ),
                }
                : {}),
        };
    }

    /** The entry, or null when the assistant was never launched. Corrupt → null (the file is kept aside on the next write). */
    read(): AssistantRegistryEntry | null {
        if (this.cache !== undefined) {
            return this.cloneCached();
        }
        const outcome = this.load();
        if (outcome.kind === 'ok') {
            this.lastReadError = null;
            this.cache = outcome.entry;
            return this.cloneCached();
        }
        if (outcome.kind === 'unreadable') {
            this.lastReadError = outcome.error;
            // Transient read failure (ENFILE/EMFILE/EIO…): do not cache null.
            return null;
        }
        this.lastReadError = null;
        this.cache = null;
        return null;
    }

    /** Drop the in-memory copy (a person edited the file), keeping the previous cache on a transient read error. */
    reload(): AssistantRegistryEntry | null {
        const outcome = this.load();
        if (outcome.kind === 'ok') {
            this.lastReadError = null;
            this.cache = outcome.entry;
            return this.cloneCached();
        }
        if (outcome.kind === 'unreadable') {
            this.lastReadError = outcome.error;
            return this.cache ? this.cloneCached() : null;
        }
        this.lastReadError = null;
        this.cache = null;
        return null;
    }

    memoryBudgets(): MemoryBudgets {
        return resolveMemoryBudgets(this.read()?.memoryBudget ?? this.loadMemoryBudget());
    }

    /**
     * `launch_assistant` / restore: bind the session, creating the entry on
     * first launch. A NEW session id resets `lastTurnState` to idle for that
     * session and hands back the previous one — the restart-note input
     * (§4.3), which must be read before anything overwrites it. Re-binding
     * the same id (restore) keeps the state and returns `previous: null`.
     */
    bindSession(input: BindAssistantSessionInput): { entry: AssistantRegistryEntry; previous: AssistantTurnState | null } {
        const prev = this.read();
        const preLaunchBudget = prev ? undefined : this.loadMemoryBudget();
        const sameSession = !!prev && prev.sessionId === input.sessionId;
        const at = isNum(input.at) ? input.at : Date.now();
        const next: AssistantRegistryEntry = {
            ...(prev ?? {
                aliases: {},
                createdAt: at,
                firstRelayAt: null,
                busyInputMode: DEFAULT_BUSY_INPUT_MODE,
                reviewTurn: true,
                executionEnabled: true,
                executionRevision: 0,
                lastTurnState: null,
                ...(preLaunchBudget ? { memoryBudget: resolveMemoryBudgets(preLaunchBudget) } : {}),
            }),
            sessionId: input.sessionId,
            cliType: input.cliType,
            workspace: input.workspace,
        };
        if (!sameSession) next.lastTurnState = { state: 'idle', at, sessionId: input.sessionId };
        if (input.mcpConfigPath) next.mcpConfigPath = input.mcpConfigPath;
        else delete next.mcpConfigPath;
        const entry = this.write(next);
        return { entry, previous: sameSession ? null : prev?.lastTurnState ?? null };
    }

    /** Owner settings. Unknown busy modes are refused rather than coerced. */
    updateSettings(patch: AssistantSettingsPatch): AssistantRegistryEntry | null {
        const prev = this.read();
        if (!prev) return null;
        if (patch.busyInputMode !== undefined && !BUSY_INPUT_MODES.includes(patch.busyInputMode)) {
            throw new Error(`invalid busyInputMode: ${String(patch.busyInputMode)}`);
        }
        const next: AssistantRegistryEntry = { ...prev };
        if (patch.aliases !== undefined) next.aliases = normalizeAliases(patch.aliases);
        if (patch.busyInputMode !== undefined) next.busyInputMode = patch.busyInputMode;
        if (patch.executionEnabled !== undefined) {
            next.executionEnabled = patch.executionEnabled !== false;
            next.executionRevision = (next.executionRevision ?? 0) + 1;
        }
        if (patch.reviewTurn !== undefined) next.reviewTurn = patch.reviewTurn !== false;
        if (patch.digestHour !== undefined) {
            if (patch.digestHour !== null && !isDigestHour(patch.digestHour)) throw new Error(`invalid digestHour: ${String(patch.digestHour)}`);
            next.digestHour = patch.digestHour;
        }
        if (patch.memoryBudget !== undefined) {
            const b = normalizeBudget(patch.memoryBudget);
            if (b) next.memoryBudget = resolveMemoryBudgets({ ...(prev.memoryBudget ?? {}), ...b });
            else delete next.memoryBudget;
        }
        return this.write(next);
    }

    /** `turn` / `registered` edge of the bound session (restart note input, §4.3). */
    recordTurnState(sessionId: string, state: AssistantTurnStateValue, at: number): void {
        const prev = this.read();
        if (!prev || prev.sessionId !== sessionId) return;
        if (prev.lastTurnState?.state === state && prev.lastTurnState.sessionId === sessionId) return;
        this.write({ ...prev, lastTurnState: { state, at, sessionId } });
    }

    /** First relay delivery; later calls are no-ops. */
    markFirstRelay(at: number): void {
        const prev = this.read();
        if (!prev || prev.firstRelayAt !== null) return;
        this.write({ ...prev, firstRelayAt: at });
    }

    /** An idle review input reached the assistant (§4.10.7). Keeps the last 24 h. */
    recordReview(at: number): void {
        const prev = this.read();
        if (!prev || !isNum(at)) return;
        const reviewAts = normalizeReviewAts([...(prev.reviewAts ?? []), at].filter((t) => at - t < ASSISTANT_REVIEW_HISTORY_MS));
        this.write({ ...prev, reviewAts });
    }

    /** Save the bound session's last exchanges (previous-session note source). */
    recordContext(sessionId: string, text: string, at: number): void {
        const prev = this.read();
        if (!prev || prev.sessionId !== sessionId || !text || text.length > 8_000) return;
        this.write({ ...prev, lastContext: { sessionId, text, at } });
    }

    /** A daily digest was queued (one per local day). */
    recordDigest(at: number): void {
        const prev = this.read();
        if (!prev || !isNum(at)) return;
        this.write({ ...prev, lastDigestAt: at });
    }

    /**
     * The session left the registry. `daemon_shutdown` keeps the binding (the
     * runtime is re-attached after restart). Any other cause clears it; the
     * rest of the entry, `lastTurnState` included, is kept.
     */
    releaseSession(sessionId: string, cause: string): boolean {
        if (cause === 'daemon_shutdown') return false;
        const prev = this.read();
        if (!prev || !prev.sessionId || prev.sessionId !== sessionId) return false;
        const next: AssistantRegistryEntry = { ...prev, sessionId: null };
        delete next.mcpConfigPath;
        this.write(next);
        return true;
    }

    /**
     * After the boot-time restore: clear a binding whose runtime is not among
     * the live hosted runtimes. Callers MUST pass the full restore set.
     * Returns the cleared sessionId, or null.
     */
    pruneAfterRestore(liveRuntimeIds: ReadonlySet<string>): string | null {
        const prev = this.read();
        if (!prev?.sessionId || liveRuntimeIds.has(prev.sessionId)) return null;
        const cleared = prev.sessionId;
        const next: AssistantRegistryEntry = { ...prev, sessionId: null };
        delete next.mcpConfigPath;
        this.write(next);
        return cleared;
    }

    /**
     * Durable local owner-binding receipt for the account-level `personal`
     * assistant slot on this Mac. Returns null when missing or corrupt.
     */
    ownerBinding(): AssistantOwnerBindingReceipt | null {
        return this.read()?.ownerBinding ?? null;
    }

    /**
     * Verify that the local durable owner-binding receipt exists and matches
     * this daemon's canonical identity. Never auto-creates a missing receipt:
     * missing or mismatched receipts fail closed until explicit owner
     * reconciliation.
     */

    verifyLocalOwnerBinding(
        selfDaemonId: string,
    ):
        | { ok: true; receipt: AssistantOwnerBindingReceipt; binding: AssistantOwnerBindingReceipt }
        | { ok: false; code: 'local_owner_binding_missing' | 'local_owner_binding_mismatch' | 'local_owner_binding_unreadable'; error: string } {
        const canonicalSelf = canonicalDaemonId(selfDaemonId);
        if (!canonicalSelf) {
            return {
                ok: false,
                code: 'local_owner_binding_missing',
                error: 'Local daemon identity is not available to verify assistant owner binding.',
            };
        }
        const binding = this.ownerBinding();
        if (!binding) {
            if (this.lastReadError) {
                const errCode = this.lastReadError.code ?? 'EUNREADABLE';
                return {
                    ok: false,
                    code: 'local_owner_binding_unreadable',
                    error: `Local assistant owner binding receipt could not be read (${errCode}: ${this.lastReadError.message}); retry once transient read pressure clears.`,
                };
            }
            return {
                ok: false,
                code: 'local_owner_binding_missing',
                error: 'Local assistant owner binding receipt is missing or corrupt; explicit owner reconciliation is required.',
            };
        }
        if (binding.accountSlot !== ASSISTANT_ACCOUNT_SLOT || !daemonIdsEquivalent(binding.daemonId, canonicalSelf)) {
            return {
                ok: false,
                code: 'local_owner_binding_mismatch',
                error: `Local assistant owner binding receipt is bound to ${binding.daemonId}, not this daemon (${canonicalSelf}); explicit owner reconciliation is required.`,
            };
        }
        return { ok: true, receipt: binding, binding };
    }

    /**
     * Explicit owner reconciliation of the local `personal` assistant slot
     * binding on this Mac. Preserves the existing `bindingRevision` when already
     * bound to this daemon, or reuses `maxFollowedRevision` across followed
     * remote projects when the receipt is missing or the bound `daemonId`
     * changed, unless `opts.bumpRevision` / `opts.forceNewRevision` is true.
     * Revoked `local_owner_binding_*` followed entries whose `bindingRevision`
     * matches the resulting receipt are recovered unless
     * `opts.recoverFollowed === false`; callers that recover must also re-arm
     * the relay thread and poller (see `ensure_binding`).
     */
    reconcileOwnerBinding(
        selfDaemonId: string,
        opts?: { bumpRevision?: boolean; forceNewRevision?: boolean; recoverFollowed?: boolean; now?: string },
    ): AssistantOwnerBindingReceipt {
        const canonicalSelf = canonicalDaemonId(selfDaemonId);
        if (!canonicalSelf) {
            throw new Error(`Invalid selfDaemonId for assistant owner binding: ${String(selfDaemonId)}`);
        }
        const nowIso = opts?.now ?? new Date().toISOString();
        const base = this.ensureBaseEntry(Date.now());
        const existing = base.ownerBinding;
        const bump = opts?.bumpRevision === true || opts?.forceNewRevision === true;
        const followedEntries = Object.values(base.followedRemoteProjects ?? {});
        const maxFollowedRevision = followedEntries.reduce(
            (max, e) => (e && isPositiveSafeInt(e.bindingRevision) && e.bindingRevision > max ? e.bindingRevision : max),
            0,
        );
        const sameDaemon = Boolean(
            existing
            && existing.accountSlot === ASSISTANT_ACCOUNT_SLOT
            && daemonIdsEquivalent(existing.daemonId, canonicalSelf),
        );
        const nextRevision = bump
            ? Math.max(existing?.bindingRevision ?? 0, maxFollowedRevision) + 1
            : sameDaemon
                ? existing!.bindingRevision
                : maxFollowedRevision > 0
                    ? maxFollowedRevision
                    : (existing?.bindingRevision ?? 0) + 1;
        const receipt: AssistantOwnerBindingReceipt = sameDaemon && !bump
            ? existing!
            : {
                accountSlot: ASSISTANT_ACCOUNT_SLOT,
                daemonId: canonicalSelf,
                bindingRevision: nextRevision,
                boundAt: nowIso,
            };
        let nextFollowed = base.followedRemoteProjects;
        if (nextFollowed && opts?.recoverFollowed !== false) {
            let recoveredAny = false;
            const copy: Record<string, FollowedRemoteProjectEntry> = { ...nextFollowed };
            for (const [k, entry] of Object.entries(copy)) {
                if (
                    entry.state === 'revoked'
                    && isLocalOwnerBindingRefusalCode(entry.revokedReason ?? entry.lastErrorCode)
                    && entry.bindingRevision === receipt.bindingRevision
                ) {
                    const recovered = normalizeFollowedRemoteProjectEntry({
                        ...entry,
                        state: 'followed',
                        updatedAt: nowIso,
                        revokedAt: undefined,
                        revokedReason: undefined,
                        lastErrorCode: undefined,
                    });
                    if (recovered) {
                        copy[k] = recovered;
                        recoveredAny = true;
                    }
                }
            }
            if (recoveredAny) nextFollowed = copy;
        }
        if (sameDaemon && !bump && nextFollowed === base.followedRemoteProjects) {
            return existing!;
        }
        this.write({
            ...base,
            ownerBinding: receipt,
            ...(nextFollowed ? { followedRemoteProjects: nextFollowed } : {}),
        });
        return { ...receipt };
    }

    listFollowedRemoteProjects(): FollowedRemoteProjectEntry[] {
        const map = this.read()?.followedRemoteProjects;
        if (!map) return [];
        return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
    }

    getFollowedRemoteProject(key: string): FollowedRemoteProjectEntry | null {
        const map = this.read()?.followedRemoteProjects;
        if (!map) return null;
        return map[key] ? { ...map[key] } : null;
    }

    upsertFollowedRemoteProject(
        input: Omit<FollowedRemoteProjectEntry, 'key' | 'accountSlot' | 'followedAt' | 'updatedAt'> &
            Partial<Pick<FollowedRemoteProjectEntry, 'key' | 'accountSlot' | 'followedAt' | 'updatedAt'>>,
    ): FollowedRemoteProjectEntry {
        const canonicalHost = canonicalDaemonId(input.hostDaemonId) ?? input.hostDaemonId;
        const key = input.key || followedRemoteProjectKey(canonicalHost, input.meshId);
        const existing = this.read()?.followedRemoteProjects?.[key];
        const nowIso = new Date().toISOString();
        const normalized = normalizeFollowedRemoteProjectEntry({
            ...existing,
            ...input,
            key,
            hostDaemonId: canonicalHost,
            accountSlot: ASSISTANT_ACCOUNT_SLOT,
            followedAt: input.followedAt ?? existing?.followedAt ?? nowIso,
            updatedAt: input.updatedAt ?? nowIso,
        });
        if (!normalized) {
            throw new Error('Invalid followed remote project entry');
        }
        const base = this.ensureBaseEntry(Date.now());
        const nextMap: Record<string, FollowedRemoteProjectEntry> = {
            ...(base.followedRemoteProjects ?? {}),
            [normalized.key]: normalized,
        };
        this.write({ ...base, followedRemoteProjects: nextMap });
        return { ...normalized };
    }

    updateFollowedRemoteProject(
        key: string,
        patch: Partial<FollowedRemoteProjectEntry>,
    ): FollowedRemoteProjectEntry | null {
        const base = this.read();
        const existing = base?.followedRemoteProjects?.[key];
        if (!base || !existing) return null;
        const merged = normalizeFollowedRemoteProjectEntry({
            ...existing,
            ...patch,
            key: existing.key,
            hostDaemonId: existing.hostDaemonId,
            meshId: existing.meshId,
            updatedAt: patch.updatedAt ?? new Date().toISOString(),
        });
        if (!merged) return null;
        const nextMap: Record<string, FollowedRemoteProjectEntry> = {
            ...(base.followedRemoteProjects ?? {}),
            [key]: merged,
        };
        this.write({ ...base, followedRemoteProjects: nextMap });
        return { ...merged };
    }

    removeFollowedRemoteProject(key: string): boolean {
        const base = this.read();
        if (!base?.followedRemoteProjects?.[key]) return false;
        const nextMap = { ...base.followedRemoteProjects };
        delete nextMap[key];
        const next: AssistantRegistryEntry = { ...base };
        if (Object.keys(nextMap).length > 0) next.followedRemoteProjects = nextMap;
        else delete next.followedRemoteProjects;
        this.write(next);
        return true;
    }

    private ensureBaseEntry(at: number): AssistantRegistryEntry {
        const prev = this.read();
        if (prev) return prev;
        const preLaunchBudget = this.loadMemoryBudget();
        return {
            sessionId: null,
            cliType: 'codex',
            workspace: join(this.path, '..'),
            aliases: {},
            createdAt: at,
            firstRelayAt: null,
            busyInputMode: DEFAULT_BUSY_INPUT_MODE,
            reviewTurn: true,
            executionEnabled: true,
            executionRevision: 0,
            lastTurnState: null,
            ...(preLaunchBudget ? { memoryBudget: resolveMemoryBudgets(preLaunchBudget) } : {}),
        };
    }

    private load():
        | { kind: 'ok'; entry: AssistantRegistryEntry }
        | { kind: 'missing' }
        | { kind: 'corrupt' }
        | { kind: 'unreadable'; error: NodeJS.ErrnoException } {
        let raw: string;
        try {
            raw = readFileSync(this.path, 'utf-8');
        } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') return { kind: 'missing' };
            return { kind: 'unreadable', error: err };
        }
        try {
            const parsed = JSON.parse(raw);
            const entry = normalizeAssistantRegistryEntry(parsed);
            return entry ? { kind: 'ok', entry } : { kind: 'corrupt' };
        } catch {
            return { kind: 'corrupt' };
        }
    }

    private loadMemoryBudget(): Partial<MemoryBudgets> | undefined {
        if (!existsSync(this.path)) return undefined;
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, unknown> | null;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? normalizeBudget(parsed.memoryBudget)
                : undefined;
        } catch {
            return undefined;
        }
    }

    private write(entry: AssistantRegistryEntry): AssistantRegistryEntry {
        this.keepCorruptAside();
        writeFileAtomic600(this.path, `${JSON.stringify(entry, null, 2)}\n`);
        this.lastReadError = null;
        this.cache = entry;
        return this.read()!;
    }

    /** A file that exists and can be read, but does not parse, is renamed rather than overwritten silently. */
    private keepCorruptAside(): void {
        let raw: string;
        try {
            raw = readFileSync(this.path, 'utf-8');
        } catch {
            // Missing (ENOENT) or unreadable (ENFILE/EMFILE/EIO…): never rename a file we could not read.
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (normalizeAssistantRegistryEntry(parsed)) return;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && normalizeBudget((parsed as Record<string, unknown>).memoryBudget)) return;
        } catch { /* corrupt JSON → fall through */ }
        try {
            renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        } catch { /* best effort; the write below still proceeds */ }
    }
}

let sharedRegistry: AssistantRegistry | null = null;
let sharedRegistryOverridden = false;

/**
 * The daemon's one registry instance (boot wiring, `launch_assistant`,
 * restore), so its in-memory copy never goes stale against another writer in
 * the same process. Built lazily from the config dir.
 */
export function getAssistantRegistry(): AssistantRegistry {
    const expectedPath = join(getConfigDir(), ASSISTANT_REGISTRY_FILE);
    if (!sharedRegistry || (!sharedRegistryOverridden && sharedRegistry.path !== expectedPath)) {
        sharedRegistry = new AssistantRegistry();
    }
    return sharedRegistry;
}

/** Tests: install a registry (null → rebuild lazily from the config dir). */
export function setAssistantRegistryForTests(registry: AssistantRegistry | null): void {
    sharedRegistry = registry;
    sharedRegistryOverridden = registry !== null;
}

/**
 * Keep the registry in step with the bus (wiring calls this at boot):
 *  - `terminated` of the bound session releases the binding (not on daemon_shutdown);
 *  - `turn` started/resumed → working, committed → idle;
 *  - `registered` of the bound session → idle.
 */
export function subscribeAssistantRegistry(bus: Pick<SessionLifecycleBus, 'on'>, registry: AssistantRegistry): Unsubscribe {
    return bus.on(['terminated', 'turn', 'registered'], (event) => {
        if (event.kind === 'terminated') {
            registry.releaseSession(event.sessionId, event.cause);
            return;
        }
        if (event.kind === 'registered') {
            registry.recordTurnState(event.sessionId, 'idle', event.at);
            return;
        }
        if (event.phase === 'started' || event.phase === 'resumed') registry.recordTurnState(event.sessionId, 'working', event.at);
        else if (event.phase === 'committed') registry.recordTurnState(event.sessionId, 'idle', event.at);
    }, { name: 'assistant.registry' });
}
