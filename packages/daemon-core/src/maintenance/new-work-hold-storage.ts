import fs from 'node:fs';
import * as path from 'node:path';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { resolveConfigDir } from '../config/config-dir.js';
import { LOG } from '../logging/logger.js';

export const DEFAULT_NEW_WORK_HOLD_TTL_MS = 30 * 60 * 1000;
export const MIN_NEW_WORK_HOLD_TTL_MS = 1_000;
export const MAX_NEW_WORK_HOLD_TTL_MS = 4 * 60 * 60_000;
export const DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT = 6;
export const DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS = 4 * DEFAULT_NEW_WORK_HOLD_TTL_MS;

export const NEW_WORK_HELD_CODE = 'new_work_held' as const;
export const NEW_WORK_HOLD_CAS_CONFLICT_CODE = 'new_work_hold_cas_conflict' as const;
export const NEW_WORK_HOLD_NOT_ACTIVE_CODE = 'new_work_hold_not_active' as const;
export const NEW_WORK_HOLD_INVALID_TTL_CODE = 'new_work_hold_invalid_ttl' as const;
export const NEW_WORK_HOLD_UNAUTHORIZED_CODE = 'new_work_hold_unauthorized' as const;

export const TERMINAL_MESH_QUEUE_STATUSES = ['completed', 'done', 'failed', 'cancelled'] as const;

export const HOLD_FILE_NAME = 'new-work-hold.json';
export const HOLD_LOCK_FILE_NAME = 'new-work-hold.lock';
export const HOLD_SCHEMA_VERSION = 1;
export const STALE_LOCK_MS = 5_000;
export const MAX_REPLAY_ENTRIES = 64;
export const TOKEN_RE = /new_work_held\[hold=([^\s\]]+) rev=(\d+) expires=(\d+)(?: phase=([^\s\]]+))?\]/;

export type NewWorkHoldPhase = 'inactive' | 'draining' | 'sealed' | 'released';
export type NewWorkHoldStatus = 'inactive' | 'draining' | 'sealed' | 'released' | 'expired';
export type NewWorkHoldStatusValue = NewWorkHoldStatus;
export type NewWorkHoldScope = 'daemon' | 'mesh';

export interface NewWorkHoldQueueRowSummary {
    id: string;
    mesh_id: string;
    status: string;
    assigned_node_id?: string | null;
    assigned_session_id?: string | null;
    updated_at?: string;
}

export interface NewWorkHoldDrainSummary {
    inFlightCount: number;
    activeClaims: NewWorkHoldQueueRowSummary[];
    heldPendingQueue: NewWorkHoldQueueRowSummary[];
    openAttempts: Array<{ attempt_id: string; mesh_id: string; state: string }>;
    activeLaunches: unknown[];
    activeSubmits: Array<{ sessionId: string; pending: boolean }>;
    drained: boolean;
    draining: boolean;
    sealed: boolean;
    assignedQueueTasks: number;
    openTurnAttempts: number;
    activeSessionTurns: number;
    inFlightAutoLaunches: number;
    pendingQueueTasks: number;
    assignedTaskIds: string[];
    openAttemptIds: string[];
    activeSessionIds: string[];
    checkedAt: number;
}

export interface NewWorkHoldSnapshot {
    schema: 1;
    active: boolean;
    status: NewWorkHoldStatus;
    phase: NewWorkHoldPhase;
    sealed: boolean;
    holdId: string | null;
    holder: string | null;
    reason: string | null;
    meshId: string | null;
    scope: NewWorkHoldScope;
    meshIds: string[];
    revision: number;
    createdAt: number | null;
    updatedAt: number;
    expiresAt: number | null;
    remainingMs: number;
    ttlMs: number | null;
    sealedAt: number | null;
    releasedAt: number | null;
    expiredAt: number | null;
    releasedReason: string | null;
    autoExtend: boolean;
    autoExtendCount: number;
    maxAutoExtendCount: number;
    autoExtendedMs: number;
    maxTotalExtensionMs: number;
    autoExtendCapReached: boolean;
    autoExtendNotice?: string;
    persistenceWarning?: string;
}

export interface NewWorkHeldInfo {
    holdId: string;
    revision: number;
    expiresAt: number;
    phase?: NewWorkHoldPhase;
    reason?: string | null;
}

export interface ReplayEntry {
    key: string;
    op: 'set' | 'extend' | 'release';
    holdId: string | null;
    holder: string | null;
    revision: number;
    snapshot: NewWorkHoldSnapshot;
}

export interface PersistedHoldState {
    schemaVersion: number;
    active: boolean;
    status: NewWorkHoldStatus;
    phase: NewWorkHoldPhase;
    sealed: boolean;
    holdId: string | null;
    holder: string | null;
    holderToken: string | null;
    reason: string | null;
    scope: NewWorkHoldScope;
    meshIds: string[];
    revision: number;
    createdAt: number | null;
    updatedAt: number;
    expiresAt: number | null;
    ttlMs: number | null;
    sealedAt: number | null;
    releasedAt: number | null;
    expiredAt: number | null;
    releasedReason: string | null;
    autoExtend: boolean;
    autoExtendCount: number;
    maxAutoExtendCount: number;
    autoExtendedMs: number;
    maxTotalExtensionMs: number;
    lastReleasedHoldId: string | null;
    lastExpiredHoldId: string | null;
    replays: ReplayEntry[];
    persistenceWarning?: string;
}

export interface SetNewWorkHoldOptions {
    holdId?: string | null;
    holder?: string | null;
    holderToken?: string | null;
    reason?: string | null;
    meshId?: string | null;
    meshIds?: string[];
    scope?: NewWorkHoldScope;
    ttlMs?: number | null;
    autoExtend?: boolean;
    maxAutoExtendCount?: number | null;
    maxTotalExtensionMs?: number | null;
    expectedRevision?: number | null;
    requestId?: string;
    force?: boolean;
    now?: number;
    configDir?: string;
    components?: Partial<DaemonComponents> | null;
}

export interface ExtendNewWorkHoldOptions {
    holdId?: string | null;
    holder?: string | null;
    holderToken?: string | null;
    reason?: string | null;
    ttlMs?: number | null;
    autoExtend?: boolean;
    expectedRevision?: number | null;
    requestId?: string;
    now?: number;
    configDir?: string;
    components?: Partial<DaemonComponents> | null;
}

export interface ReleaseNewWorkHoldOptions {
    holdId?: string | null;
    holder?: string | null;
    holderToken?: string | null;
    reason?: string | null;
    expectedRevision?: number | null;
    requestId?: string;
    now?: number;
    configDir?: string;
    components?: Partial<DaemonComponents> | null;
}

export interface NewWorkHoldEvaluationOptions {
    meshId?: string | null;
    now?: number;
    configDir?: string;
    components?: Partial<DaemonComponents> | null;
    autoExtend?: boolean;
    persist?: boolean;
}

export interface NewWorkHoldMutationResult {
    [key: string]: unknown;
    success: boolean;
    held: boolean;
    released?: boolean;
    replayed: boolean;
    idempotent: boolean;
    holderToken?: string | null;
    code?: string;
    reason?: string;
    error?: string;
    hold: NewWorkHoldSnapshot;
    drain: NewWorkHoldDrainSummary;
    persistenceWarning?: string;
}

export type NewWorkHoldSetResult = NewWorkHoldMutationResult;
export type NewWorkHoldExtendResult = NewWorkHoldMutationResult;
export type NewWorkHoldReleaseResult = NewWorkHoldMutationResult;

export interface NewWorkHoldStatusResult {
    [key: string]: unknown;
    success: true;
    held: boolean;
    hold: NewWorkHoldSnapshot;
    drain: NewWorkHoldDrainSummary;
    persistenceWarning?: string;
}

export interface NewWorkHoldRefusal {
    [key: string]: unknown;
    success: false;
    code: typeof NEW_WORK_HELD_CODE;
    reason: typeof NEW_WORK_HELD_CODE;
    recoverable: true;
    retryable: true;
    retryRecommended: false;
    held: true;
    holdId: string;
    revision: number;
    expiresAt: number;
    remainingMs: number;
    phase: NewWorkHoldPhase;
    sealed: boolean;
    holdRevision: number;
    holdPhase: NewWorkHoldPhase;
    holdReason: string | null;
    holdExpiresAt: number | null;
    command?: string;
    surface?: 'router_command' | 'queue_claim' | 'queue_autolaunch' | 'session_input' | 'mcp_send_task';
    error: string;
    nextAction: string;
}

export const stateByDir = new Map<string, PersistedHoldState>();
const diskIdentityByDir = new Map<string, { mtimeMs: number; size: number; ino: number }>();
export let registeredDaemonComponents: Partial<DaemonComponents> | null = null;
export let customClockForTests: (() => number) | null = null;

export function registerNewWorkHoldDaemonComponents(components: Partial<DaemonComponents> | null): void {
    registeredDaemonComponents = components;
}

/** Injectable clock for tests only (F1). Command handlers never accept caller `now`. */
export function setNewWorkHoldClockForTests(clock: (() => number) | null): void {
    customClockForTests = typeof clock === 'function' ? clock : null;
}

export function clearNewWorkHoldMemoryCacheForTests(): void {
    stateByDir.clear();
    diskIdentityByDir.clear();
}

export function resetNewWorkHoldStateForTests(): void {
    stateByDir.clear();
    diskIdentityByDir.clear();
    registeredDaemonComponents = null;
    customClockForTests = null;
    try {
        const dir = resolveConfigDir();
        if (dir) {
            fs.rmSync(path.join(dir, HOLD_FILE_NAME), { force: true });
            fs.rmSync(path.join(dir, HOLD_LOCK_FILE_NAME), { force: true });
        }
    } catch { /* ignore */ }
}

export const resetNewWorkHoldForTests = resetNewWorkHoldStateForTests;

export function resolveNow(overrideNow?: number): number {
    if (typeof overrideNow === 'number' && Number.isFinite(overrideNow) && overrideNow > 0) return Math.floor(overrideNow);
    if (customClockForTests) {
        const v = customClockForTests();
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
    }
    return Date.now();
}

export function clampPositiveInt(value: unknown, fallback: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
    return Math.min(max, Math.floor(value));
}

export function readOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeMeshIds(meshIds?: unknown, singleMeshId?: unknown): string[] {
    const seen = new Set<string>();
    const single = readOptionalString(singleMeshId);
    if (single) seen.add(single);
    if (Array.isArray(meshIds)) {
        for (const item of meshIds) {
            const s = readOptionalString(item);
            if (s) seen.add(s);
        }
    }
    return [...seen].sort();
}

export function holdFilePath(configDir?: string): string {
    const dir = configDir ? path.resolve(configDir) : path.resolve(resolveConfigDir());
    return path.join(dir, HOLD_FILE_NAME);
}

export function holdLockFilePath(configDir?: string): string {
    const dir = configDir ? path.resolve(configDir) : path.resolve(resolveConfigDir());
    return path.join(dir, HOLD_LOCK_FILE_NAME);
}

export function defaultPersistedState(now = Date.now()): PersistedHoldState {
    return {
        schemaVersion: HOLD_SCHEMA_VERSION,
        active: false,
        status: 'inactive',
        phase: 'inactive',
        sealed: false,
        holdId: null,
        holder: null,
        holderToken: null,
        reason: null,
        scope: 'daemon',
        meshIds: [],
        revision: 0,
        createdAt: null,
        updatedAt: now,
        expiresAt: null,
        ttlMs: null,
        sealedAt: null,
        releasedAt: null,
        expiredAt: null,
        releasedReason: null,
        autoExtend: true,
        autoExtendCount: 0,
        maxAutoExtendCount: DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT,
        autoExtendedMs: 0,
        maxTotalExtensionMs: DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS,
        lastReleasedHoldId: null,
        lastExpiredHoldId: null,
        replays: [],
    };
}

export function emptyDrainSummary(now: number, active = false): NewWorkHoldDrainSummary {
    return {
        inFlightCount: 0,
        activeClaims: [],
        heldPendingQueue: [],
        openAttempts: [],
        activeLaunches: [],
        activeSubmits: [],
        drained: true,
        draining: false,
        sealed: active,
        assignedQueueTasks: 0,
        openTurnAttempts: 0,
        activeSessionTurns: 0,
        inFlightAutoLaunches: 0,
        pendingQueueTasks: 0,
        assignedTaskIds: [],
        openAttemptIds: [],
        activeSessionIds: [],
        checkedAt: now,
    };
}

export function parsePersistedStateObject(parsed: Record<string, unknown>, now: number): PersistedHoldState {
    const active = parsed.active === true;
    const status: NewWorkHoldStatus =
        parsed.status === 'draining' || parsed.status === 'sealed' || parsed.status === 'released' ||
        parsed.status === 'expired' || parsed.status === 'inactive'
            ? parsed.status : active ? 'draining' : 'inactive';
    const phase: NewWorkHoldPhase =
        parsed.phase === 'draining' || parsed.phase === 'sealed' || parsed.phase === 'released' || parsed.phase === 'inactive'
            ? parsed.phase : active ? 'draining' : 'inactive';
    const meshIds = normalizeMeshIds(parsed.meshIds, parsed.meshId);
    const scope: NewWorkHoldScope = parsed.scope === 'mesh' || meshIds.length > 0 ? 'mesh' : 'daemon';
    return {
        schemaVersion: HOLD_SCHEMA_VERSION,
        active,
        status,
        phase,
        sealed: active && phase === 'sealed',
        holdId: readOptionalString(parsed.holdId),
        holder: readOptionalString(parsed.holder),
        holderToken: readOptionalString(parsed.holderToken),
        reason: readOptionalString(parsed.reason),
        scope,
        meshIds,
        revision: typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) && parsed.revision >= 0 ? Math.floor(parsed.revision) : 0,
        createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : null,
        updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : now,
        expiresAt: typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : null,
        ttlMs: typeof parsed.ttlMs === 'number' && Number.isFinite(parsed.ttlMs) ? parsed.ttlMs : null,
        sealedAt: typeof parsed.sealedAt === 'number' && Number.isFinite(parsed.sealedAt) ? parsed.sealedAt : null,
        releasedAt: typeof parsed.releasedAt === 'number' && Number.isFinite(parsed.releasedAt) ? parsed.releasedAt : null,
        expiredAt: typeof parsed.expiredAt === 'number' && Number.isFinite(parsed.expiredAt) ? parsed.expiredAt : null,
        releasedReason: readOptionalString(parsed.releasedReason),
        autoExtend: parsed.autoExtend !== false,
        autoExtendCount: clampPositiveInt(parsed.autoExtendCount, 0, 1000),
        maxAutoExtendCount: clampPositiveInt(parsed.maxAutoExtendCount, DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT, 1000),
        autoExtendedMs: clampPositiveInt(parsed.autoExtendedMs, 0, 24 * 60 * 60_000),
        maxTotalExtensionMs: clampPositiveInt(parsed.maxTotalExtensionMs, DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS, 24 * 60 * 60_000),
        lastReleasedHoldId: readOptionalString(parsed.lastReleasedHoldId),
        lastExpiredHoldId: readOptionalString(parsed.lastExpiredHoldId),
        replays: Array.isArray(parsed.replays) ? (parsed.replays.slice(-MAX_REPLAY_ENTRIES) as ReplayEntry[]) : [],
        ...(typeof parsed.persistenceWarning === 'string' && parsed.persistenceWarning.trim() ? { persistenceWarning: parsed.persistenceWarning.trim() } : {}),
    };
}

export function buildFailClosedStateFromCorruptDisk(cached: PersistedHoldState | undefined, now: number, warning: string): PersistedHoldState {
    if (cached && cached.active) return { ...cached, persistenceWarning: warning };
    return {
        ...defaultPersistedState(now),
        active: true,
        status: 'draining',
        phase: 'draining',
        holdId: cached?.holdId ?? 'hold_corrupt_state_fail_closed',
        holder: cached?.holder ?? 'system_fail_closed',
        holderToken: cached?.holderToken ?? null,
        reason: cached?.reason ?? 'corrupt_hold_state_file',
        revision: Math.max(1, (cached?.revision ?? 0) + 1),
        createdAt: cached?.createdAt ?? now,
        updatedAt: now,
        expiresAt: now + DEFAULT_NEW_WORK_HOLD_TTL_MS,
        ttlMs: DEFAULT_NEW_WORK_HOLD_TTL_MS,
        persistenceWarning: warning,
    };
}

export function readState(configDir?: string, now = Date.now(), forMutation = false): PersistedHoldState {
    const filePath = holdFilePath(configDir);
    const dirKey = path.dirname(filePath);
    // A failed first set may fence local reads, but cannot replay as a durable
    // acknowledgement. Mutations retry against disk after persistence errors.
    const cachedState = stateByDir.get(dirKey);
    const cached = forMutation && cachedState?.persistenceWarning ? undefined : cachedState;
    try {
        const identity = fs.statSync(filePath);
        const previousIdentity = diskIdentityByDir.get(dirKey);
        if (!forMutation && cached && !cached.persistenceWarning && previousIdentity
            && identity.mtimeMs === previousIdentity.mtimeMs && identity.size === previousIdentity.size
            && identity.ino === previousIdentity.ino) return cached;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.active !== 'boolean') {
            const warning = `Invalid new-work-hold.json schema at ${filePath}; failing closed with active hold`;
            LOG.warn('NewWorkHold', warning);
            const failClosed = buildFailClosedStateFromCorruptDisk(cached, now, warning);
            stateByDir.set(dirKey, failClosed);
            return failClosed;
        }
        const diskState = parsePersistedStateObject(parsed, now);
        diskIdentityByDir.set(dirKey, { mtimeMs: identity.mtimeMs, size: identity.size, ino: identity.ino });
        if (cached && cached.persistenceWarning && cached.revision >= diskState.revision) return cached;
        stateByDir.set(dirKey, diskState);
        return diskState;
    } catch (err) {
        diskIdentityByDir.delete(dirKey);
        if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) {
            if (cached) return cached;
            const fresh = defaultPersistedState(now);
            stateByDir.set(dirKey, fresh);
            return fresh;
        }
        const warning = `Corrupt or unreadable new-work-hold.json (${(err as Error)?.message || String(err)}); failing closed with active hold`;
        LOG.warn('NewWorkHold', warning);
        const failClosed = buildFailClosedStateFromCorruptDisk(cached, now, warning);
        stateByDir.set(dirKey, failClosed);
        return failClosed;
    }
}

export interface WriteStateResult {
    persisted: boolean;
    conflict: boolean;
    currentDiskState?: PersistedHoldState;
    error?: string;
}

export function acquireHoldLock(lockPath: string, now: number): number | null {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return fs.openSync(lockPath, 'wx');
        } catch (err: any) {
            if (err?.code !== 'EEXIST') throw err;
            try {
                if (now - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockPath);
            } catch { /* lock disappeared */ }
        }
    }
    return null;
}

export function writeState(configDir: string | undefined, state: PersistedHoldState, options?: { expectedRevision?: number; now?: number }): WriteStateResult {
    const now = options?.now ?? Date.now();
    const filePath = holdFilePath(configDir);
    const lockPath = holdLockFilePath(configDir);
    const dirKey = path.dirname(filePath);
    let lockFd: number | null = null;
    try {
        fs.mkdirSync(dirKey, { recursive: true });
        lockFd = acquireHoldLock(lockPath, now);
        if (lockFd === null) {
            const warning = 'Failed to acquire new-work-hold.lock: concurrent writer in progress';
            state.persistenceWarning = warning;
            if (state.active && !stateByDir.get(dirKey)?.active) stateByDir.set(dirKey, { ...state, replays: [] });
            LOG.warn('NewWorkHold', warning);
            return { persisted: false, conflict: true, error: warning };
        }
        if (fs.existsSync(filePath)) {
            try {
                const parsedDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
                if (parsedDisk && typeof parsedDisk === 'object' && typeof parsedDisk.active === 'boolean') {
                    const diskState = parsePersistedStateObject(parsedDisk, now);
                    const hasConflict = typeof options?.expectedRevision === 'number'
                        ? diskState.revision !== options.expectedRevision
                        : diskState.revision > state.revision;
                    if (hasConflict) {
                        stateByDir.set(dirKey, diskState);
                        return {
                            persisted: false,
                            conflict: true,
                            currentDiskState: diskState,
                            error: `Concurrent revision conflict on new-work-hold.json: disk revision is ${diskState.revision}, expected ${options?.expectedRevision ?? state.revision - 1}`,
                        };
                    }
                }
            } catch { /* corrupt on-disk file may be overwritten by a valid new state */ }
        }
        delete state.persistenceWarning;
        const tmpPath = `${filePath}.${process.pid}.${now}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(tmpPath, filePath);
        stateByDir.set(dirKey, state);
        return { persisted: true, conflict: false };
    } catch (err) {
        const warning = `Failed to persist new-work-hold.json: ${(err as Error)?.message || String(err)}`;
        state.persistenceWarning = warning;
        if (state.active && !stateByDir.get(dirKey)?.active) stateByDir.set(dirKey, { ...state, replays: [] });
        LOG.warn('NewWorkHold', warning);
        return { persisted: false, conflict: false, error: warning };
    } finally {
        if (lockFd !== null) {
            try { fs.closeSync(lockFd); } catch { /* ignore */ }
            try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        }
    }
}

export function toSnapshot(state: PersistedHoldState, now: number): NewWorkHoldSnapshot {
    const remainingMs = state.active && typeof state.expiresAt === 'number' ? Math.max(0, state.expiresAt - now) : 0;
    const autoExtendCapReached = state.autoExtendCount >= state.maxAutoExtendCount || state.autoExtendedMs >= state.maxTotalExtensionMs;
    return {
        schema: 1,
        active: state.active,
        status: state.status,
        phase: state.phase,
        sealed: Boolean(state.active && state.phase === 'sealed'),
        holdId: state.holdId,
        holder: state.holder,
        reason: state.reason,
        meshId: state.meshIds[0] ?? null,
        scope: state.scope,
        meshIds: [...state.meshIds],
        revision: state.revision,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        expiresAt: state.expiresAt,
        remainingMs,
        ttlMs: state.ttlMs,
        sealedAt: state.sealedAt,
        releasedAt: state.releasedAt,
        expiredAt: state.expiredAt,
        releasedReason: state.releasedReason,
        autoExtend: state.autoExtend,
        autoExtendCount: state.autoExtendCount,
        maxAutoExtendCount: state.maxAutoExtendCount,
        autoExtendedMs: state.autoExtendedMs,
        maxTotalExtensionMs: state.maxTotalExtensionMs,
        autoExtendCapReached,
        ...(autoExtendCapReached ? { autoExtendNotice: `Auto-extension cap reached; fence expires at ${state.expiresAt}. Assigned work may still be running. Extend manually to keep draining.` } : {}),
        ...(state.persistenceWarning ? { persistenceWarning: state.persistenceWarning } : {}),
    };
}

export function findReplay(state: PersistedHoldState, op: ReplayEntry['op'], requestId?: string): ReplayEntry | undefined {
    const req = readOptionalString(requestId);
    if (!req) return undefined;
    const key = `${op}:${req}`;
    return state.replays.find((r) => r.key === key);
}

export function recordReplay(state: PersistedHoldState, entry: ReplayEntry): void {
    state.replays = [...state.replays.filter((r) => r.key !== entry.key), entry].slice(-MAX_REPLAY_ENTRIES);
}
