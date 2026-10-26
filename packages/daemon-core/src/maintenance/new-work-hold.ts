import { MAX_NEW_WORK_HOLD_TTL_MS, MIN_NEW_WORK_HOLD_TTL_MS } from './new-work-hold-storage.js';
import { randomUUID } from 'node:crypto';
import { isTrustedOwnerIngress, readRouterCommandIngress } from '../commands/command-args.js';
import {
    DEFAULT_NEW_WORK_HOLD_TTL_MS,
    DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT,
    DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS,
    NEW_WORK_HELD_CODE,
    NEW_WORK_HOLD_CAS_CONFLICT_CODE,
    NEW_WORK_HOLD_NOT_ACTIVE_CODE,
    NEW_WORK_HOLD_INVALID_TTL_CODE,
    NEW_WORK_HOLD_UNAUTHORIZED_CODE,
    TOKEN_RE,
    NewWorkHoldPhase,
    NewWorkHoldScope,
    NewWorkHoldDrainSummary,
    NewWorkHoldSnapshot,
    NewWorkHeldInfo,
    SetNewWorkHoldOptions,
    ExtendNewWorkHoldOptions,
    ReleaseNewWorkHoldOptions,
    NewWorkHoldEvaluationOptions,
    NewWorkHoldSetResult,
    NewWorkHoldExtendResult,
    NewWorkHoldReleaseResult,
    NewWorkHoldStatusResult,
    NewWorkHoldRefusal,
    resolveNow,
    clampPositiveInt,
    readOptionalString,
    normalizeMeshIds,
    emptyDrainSummary,
    readState,
    writeState,
    toSnapshot,
    findReplay,
    recordReplay,
} from './new-work-hold-storage.js';
import { collectNewWorkHoldDrainSummary, reconcileHoldLifecycle, holdAppliesToMesh } from './new-work-hold-lifecycle.js';
export {
    DEFAULT_NEW_WORK_HOLD_TTL_MS,
    MIN_NEW_WORK_HOLD_TTL_MS,
    MAX_NEW_WORK_HOLD_TTL_MS,
    DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT,
    DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS,
    NEW_WORK_HELD_CODE,
    NEW_WORK_HOLD_CAS_CONFLICT_CODE,
    NEW_WORK_HOLD_NOT_ACTIVE_CODE,
    NEW_WORK_HOLD_INVALID_TTL_CODE,
    NEW_WORK_HOLD_UNAUTHORIZED_CODE,
    TERMINAL_MESH_QUEUE_STATUSES,
    NewWorkHoldPhase,
    NewWorkHoldStatus,
    NewWorkHoldStatusValue,
    NewWorkHoldScope,
    NewWorkHoldQueueRowSummary,
    NewWorkHoldDrainSummary,
    NewWorkHoldSnapshot,
    NewWorkHeldInfo,
    SetNewWorkHoldOptions,
    ExtendNewWorkHoldOptions,
    ReleaseNewWorkHoldOptions,
    NewWorkHoldEvaluationOptions,
    NewWorkHoldMutationResult,
    NewWorkHoldSetResult,
    NewWorkHoldExtendResult,
    NewWorkHoldReleaseResult,
    NewWorkHoldStatusResult,
    NewWorkHoldRefusal,
    registerNewWorkHoldDaemonComponents,
    setNewWorkHoldClockForTests,
    clearNewWorkHoldMemoryCacheForTests,
    resetNewWorkHoldStateForTests,
    resetNewWorkHoldForTests,
} from './new-work-hold-storage.js';
export { collectNewWorkHoldDrainSummary, startNewWorkHoldLifecycle } from './new-work-hold-lifecycle.js';

/** Authorization helper for `set`/`extend`/`release` command handlers (F2). */
export function verifyNewWorkHoldCallerAuthorization(
    op: 'set' | 'extend' | 'release',
    args: unknown,
    configDir?: string,
): { ok: true } | { ok: false; refusal: { success: false; code: typeof NEW_WORK_HOLD_UNAUTHORIZED_CODE; reason: 'unauthorized'; error: string } } {
    const ingress = readRouterCommandIngress(args);
    const isOwner = Boolean(
        (ingress?.source === 'p2p' || ingress?.source === 'standalone') &&
        ingress?.inProcess !== true &&
        isTrustedOwnerIngress(args, ingress.source),
    );
    if (isOwner) return { ok: true };

    const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    const requestedToken = readOptionalString(record.holderToken);
    if (requestedToken) {
        const state = readState(configDir, resolveNow());
        if (state.active && state.holderToken && requestedToken === state.holderToken) return { ok: true };
        const envToken = readOptionalString(process.env.ADHDEV_NEW_WORK_HOLD_TOKEN);
        if (envToken && requestedToken === envToken) return { ok: true };
    }
    return {
        ok: false,
        refusal: {
            success: false,
            code: NEW_WORK_HOLD_UNAUTHORIZED_CODE,
            reason: 'unauthorized',
            error: `maintenance_new_work_hold_${op} requires verified owner ingress or a valid holderToken`,
        },
    };
}

/** Read-only hot-path evaluation (F3, F8): never writes to disk and short-circuits when inactive. */
export function evaluateNewWorkHold(options?: NewWorkHoldEvaluationOptions): {
    held: boolean;
    hold: NewWorkHoldSnapshot;
    drain: NewWorkHoldDrainSummary;
} {
    const now = resolveNow(options?.now);
    const rawState = readState(options?.configDir, now);
    if (!rawState.active) {
        return { held: false, hold: toSnapshot(rawState, now), drain: emptyDrainSummary(now, false) };
    }
    if (rawState.expiresAt !== null && now < rawState.expiresAt) {
        // Admission needs only the live fence. Keep the public drain projection
        // available lazily, without a queue census on every command/claim.
        let drain: NewWorkHoldDrainSummary | undefined;
        return { held: holdAppliesToMesh(rawState, options?.meshId), hold: toSnapshot(rawState, now),
            get drain() {
                return drain ??= collectNewWorkHoldDrainSummary({
                    meshIds: rawState.scope === 'mesh' ? rawState.meshIds : undefined,
                    active: true, now, components: options?.components,
                });
            } };
    }
    const { state, drain } = reconcileHoldLifecycle(options?.configDir, rawState, now, {
        components: options?.components,
        autoExtend: true,
        persist: false,
    });
    return { held: holdAppliesToMesh(state, options?.meshId), hold: toSnapshot(state, now), drain };
}

export function isNewWorkHeld(options?: NewWorkHoldEvaluationOptions): boolean {
    return evaluateNewWorkHold(options).held;
}

export function getNewWorkHoldStatus(options?: NewWorkHoldEvaluationOptions): NewWorkHoldStatusResult {
    const now = resolveNow(options?.now);
    const rawState = readState(options?.configDir, now);
    const { state, drain } = rawState.active
        ? reconcileHoldLifecycle(options?.configDir, rawState, now, {
            components: options?.components,
            // Observation callers cannot disable the hold owner's renewal policy.
            autoExtend: true,
            persist: options?.persist !== false,
        })
        : { state: rawState, drain: collectNewWorkHoldDrainSummary({ meshId: options?.meshId, active: false, now, components: options?.components }) };
    return {
        success: true,
        held: holdAppliesToMesh(state, options?.meshId),
        hold: toSnapshot(state, now),
        drain,
        ...(state.persistenceWarning ? { persistenceWarning: state.persistenceWarning } : {}),
    };
}

export function setNewWorkHold(opts: SetNewWorkHoldOptions = {}): NewWorkHoldSetResult {
    const now = resolveNow(opts.now);
    const rawState = structuredClone(readState(opts.configDir, now, true));
    const { state, drain: currentDrain } = reconcileHoldLifecycle(opts.configDir, rawState, now, { components: opts.components, persist: true });

    const replayByReq = findReplay(state, 'set', opts.requestId);
    if (replayByReq) {
        return {
            success: true,
            held: state.active,
            replayed: true,
            idempotent: true,
            holderToken: state.holderToken,
            hold: toSnapshot(state, now),
            drain: currentDrain,
        };
    }

    const requestedHoldId = readOptionalString(opts.holdId);
    const requestedHolder = readOptionalString(opts.holder);
    const requestedHolderToken = readOptionalString(opts.holderToken);
    const requestedMeshIds = normalizeMeshIds(opts.meshIds, opts.meshId);
    const requestedScope: NewWorkHoldScope = opts.scope === 'mesh' || requestedMeshIds.length > 0 ? 'mesh' : 'daemon';

    if (
        state.active &&
        !opts.force &&
        requestedHoldId &&
        state.holdId === requestedHoldId &&
        (!requestedHolder || !state.holder || state.holder === requestedHolder) &&
        (opts.expectedRevision === undefined || opts.expectedRevision === null || opts.expectedRevision === state.revision || opts.expectedRevision === state.revision - 1)
    ) {
        return {
            success: true,
            held: true,
            replayed: true,
            idempotent: true,
            holderToken: state.holderToken,
            hold: toSnapshot(state, now),
            drain: currentDrain,
        };
    }

    if (opts.expectedRevision !== undefined && opts.expectedRevision !== null && Math.floor(opts.expectedRevision) !== state.revision) {
        return {
            success: false,
            held: state.active,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: `CAS conflict setting new-work hold: expected revision ${opts.expectedRevision}, current revision is ${state.revision}`,
            hold: toSnapshot(state, now),
            drain: currentDrain,
        };
    }

    if (state.active && !opts.force) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'hold_already_active',
            error: `CAS conflict setting new-work hold: hold '${state.holdId}' (revision ${state.revision}, holder '${state.holder ?? 'unknown'}') is already active`,
            hold: toSnapshot(state, now),
            drain: currentDrain,
        };
    }

    let ttlMs = opts.ttlMs !== undefined && opts.ttlMs !== null ? Number(opts.ttlMs) : DEFAULT_NEW_WORK_HOLD_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return {
            success: false,
            held: state.active,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_INVALID_TTL_CODE,
            reason: 'invalid_ttl',
            error: `Invalid ttlMs '${opts.ttlMs}': must be a positive finite number`,
            hold: toSnapshot(state, now),
            drain: currentDrain,
        };
    }

    const holdId = requestedHoldId ?? `hold_${randomUUID()}`;
    const holderToken = requestedHolderToken ?? `htok_${randomUUID()}`;
    const freshDrain = collectNewWorkHoldDrainSummary({
        meshIds: requestedScope === 'mesh' ? requestedMeshIds : undefined,
        active: true,
        now,
        components: opts.components,
    });
    const phase: NewWorkHoldPhase = freshDrain.drained ? 'sealed' : 'draining';
    ttlMs = Math.min(MAX_NEW_WORK_HOLD_TTL_MS, Math.max(MIN_NEW_WORK_HOLD_TTL_MS, Math.floor(ttlMs)));

    const baseRevision = state.revision;

    state.active = true;
    state.status = phase;
    state.phase = phase;
    state.sealed = phase === 'sealed';
    state.holdId = holdId;
    state.holder = requestedHolder;
    state.holderToken = holderToken;
    state.reason = readOptionalString(opts.reason) ?? 'worker_handoff_new_work_hold';
    state.scope = requestedScope;
    state.meshIds = requestedMeshIds;
    state.revision = baseRevision + 1;
    state.createdAt = now;
    state.updatedAt = now;
    state.ttlMs = ttlMs;
    state.expiresAt = now + ttlMs;
    state.sealedAt = phase === 'sealed' ? now : null;
    state.releasedAt = null;
    state.expiredAt = null;
    state.releasedReason = null;
    state.autoExtend = opts.autoExtend !== false;
    state.autoExtendCount = 0;
    state.maxAutoExtendCount = clampPositiveInt(opts.maxAutoExtendCount, DEFAULT_MAX_NEW_WORK_HOLD_AUTO_EXTEND_COUNT, 1000);
    state.autoExtendedMs = 0;
    state.maxTotalExtensionMs = clampPositiveInt(opts.maxTotalExtensionMs, DEFAULT_MAX_NEW_WORK_HOLD_TOTAL_EXTENSION_MS, 24 * 60 * 60_000);

    const snap = toSnapshot(state, now);
    const reqId = readOptionalString(opts.requestId);
    if (reqId) {
        recordReplay(state, { key: `set:${reqId}`, op: 'set', holdId, holder: requestedHolder, revision: state.revision, snapshot: snap });
    }
    const writeRes = writeState(opts.configDir, state, { expectedRevision: baseRevision, now });
    if (writeRes.conflict && writeRes.currentDiskState) {
        return {
            success: false,
            held: writeRes.currentDiskState.active,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: writeRes.error || 'Concurrent revision conflict while activating new-work hold',
            hold: toSnapshot(writeRes.currentDiskState, now),
            drain: freshDrain,
        };
    }
    if (!writeRes.persisted) {
        const current = readState(opts.configDir, now);
        return { success: false, held: current.active, replayed: false, idempotent: false,
            code: 'new_work_hold_persistence_failed', reason: 'persistence_failed', error: writeRes.error,
            hold: toSnapshot(current, now), drain: freshDrain, persistenceWarning: writeRes.error };
    }
    return {
        success: true,
        held: true,
        replayed: false,
        idempotent: false,
        holderToken,
        hold: toSnapshot(state, now),
        drain: freshDrain,
        ...(state.persistenceWarning ? { persistenceWarning: state.persistenceWarning } : {}),
    };
}

export function extendNewWorkHold(opts: ExtendNewWorkHoldOptions = {}): NewWorkHoldExtendResult {
    const now = resolveNow(opts.now);
    const rawState = structuredClone(readState(opts.configDir, now, true));
    const { state, drain } = reconcileHoldLifecycle(opts.configDir, rawState, now, { components: opts.components, persist: true });

    const replayByReq = findReplay(state, 'extend', opts.requestId);
    if (replayByReq) {
        return {
            success: true,
            held: state.active,
            replayed: true,
            idempotent: true,
            holderToken: state.holderToken,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    if (!state.active) {
        return {
            success: false,
            held: false,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_NOT_ACTIVE_CODE,
            reason: state.status === 'expired' ? 'hold_expired' : 'hold_not_active',
            error: `Cannot extend new-work hold: hold is not active (status=${state.status})`,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    const requestedHoldId = readOptionalString(opts.holdId);
    const requestedHolder = readOptionalString(opts.holder);
    if (!requestedHoldId && !requestedHolder) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'hold_id_mismatch',
            error: `Cannot extend active new-work hold '${state.holdId}' without matching holdId or holder`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (requestedHoldId && requestedHoldId !== state.holdId) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'hold_id_mismatch',
            error: `CAS conflict extending new-work hold: expected holdId '${requestedHoldId}', active holdId is '${state.holdId}'`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (requestedHolder && state.holder && requestedHolder !== state.holder) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'holder_mismatch',
            error: `CAS conflict extending new-work hold: holder '${requestedHolder}' does not match active holder '${state.holder}'`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    const requestedToken = readOptionalString(opts.holderToken);
    if (requestedToken && state.holderToken && requestedToken !== state.holderToken) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_UNAUTHORIZED_CODE,
            reason: 'unauthorized',
            error: 'Cannot extend new-work hold: holderToken mismatch',
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== null && Math.floor(opts.expectedRevision) !== state.revision) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: `CAS conflict extending new-work hold: expected revision ${opts.expectedRevision}, current revision is ${state.revision}`,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    let ttlMs = opts.ttlMs !== undefined && opts.ttlMs !== null ? Number(opts.ttlMs) : (state.ttlMs ?? DEFAULT_NEW_WORK_HOLD_TTL_MS);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_INVALID_TTL_CODE,
            reason: 'invalid_ttl',
            error: `Invalid ttlMs '${opts.ttlMs}': must be a positive finite number`,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    ttlMs = Math.min(MAX_NEW_WORK_HOLD_TTL_MS, Math.max(MIN_NEW_WORK_HOLD_TTL_MS, Math.floor(ttlMs)));

    const baseRevision = state.revision;
    state.ttlMs = ttlMs;
    state.expiresAt = now + ttlMs;
    state.updatedAt = now;
    state.revision += 1;
    const updatedReason = readOptionalString(opts.reason);
    if (updatedReason) state.reason = updatedReason;
    if (opts.autoExtend === true) {
        state.autoExtendCount = (state.autoExtendCount || 0) + 1;
    }

    const snap = toSnapshot(state, now);
    const reqId = readOptionalString(opts.requestId);
    if (reqId) {
        recordReplay(state, { key: `extend:${reqId}`, op: 'extend', holdId: state.holdId, holder: state.holder, revision: state.revision, snapshot: snap });
    }
    const writeRes = writeState(opts.configDir, state, { expectedRevision: baseRevision, now });
    if (writeRes.conflict && writeRes.currentDiskState) {
        return {
            success: false,
            held: writeRes.currentDiskState.active,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: writeRes.error || 'Concurrent revision conflict while extending new-work hold',
            hold: toSnapshot(writeRes.currentDiskState, now),
            drain,
        };
    }
    if (!writeRes.persisted) {
        const current = readState(opts.configDir, now);
        return { success: false, held: current.active, replayed: false, idempotent: false,
            code: 'new_work_hold_persistence_failed', reason: 'persistence_failed', error: writeRes.error,
            hold: toSnapshot(current, now), drain: drain, persistenceWarning: writeRes.error };
    }
    return {
        success: true,
        held: true,
        replayed: false,
        idempotent: false,
        holderToken: state.holderToken,
        hold: toSnapshot(state, now),
        drain,
        ...(state.persistenceWarning ? { persistenceWarning: state.persistenceWarning } : {}),
    };
}

export function releaseNewWorkHold(opts: ReleaseNewWorkHoldOptions = {}): NewWorkHoldReleaseResult {
    const now = resolveNow(opts.now);
    const rawState = structuredClone(readState(opts.configDir, now, true));
    const { state, drain } = reconcileHoldLifecycle(opts.configDir, rawState, now, { components: opts.components, persist: true });

    const replayByReq = findReplay(state, 'release', opts.requestId);
    if (replayByReq) {
        return {
            success: true,
            held: false,
            released: true,
            replayed: true,
            idempotent: true,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    const requestedHoldId = readOptionalString(opts.holdId);
    const requestedHolder = readOptionalString(opts.holder);
    if (!state.active) {
        if (
            (!requestedHoldId || requestedHoldId === state.lastReleasedHoldId || requestedHoldId === state.lastExpiredHoldId) &&
            (opts.expectedRevision === undefined || opts.expectedRevision === null || opts.expectedRevision === state.revision || opts.expectedRevision === state.revision - 1)
        ) {
            return {
                success: true,
                held: false,
                released: false,
                replayed: true,
                idempotent: true,
                hold: toSnapshot(state, now),
                drain,
            };
        }
        return {
            success: false,
            held: false,
            replayed: false,
            idempotent: false,
            code: requestedHoldId ? NEW_WORK_HOLD_CAS_CONFLICT_CODE : NEW_WORK_HOLD_NOT_ACTIVE_CODE,
            reason: requestedHoldId ? 'hold_id_mismatch' : 'hold_not_active',
            error: `Cannot release new-work hold: hold '${requestedHoldId ?? ''}' is not active`,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    if (!requestedHoldId && !requestedHolder) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'hold_id_mismatch',
            error: `Cannot release active new-work hold '${state.holdId}' without matching holdId or holder`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (requestedHoldId && requestedHoldId !== state.holdId) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'hold_id_mismatch',
            error: `CAS conflict releasing new-work hold: expected holdId '${requestedHoldId}', active holdId is '${state.holdId}'`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (requestedHolder && state.holder && requestedHolder !== state.holder) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'holder_mismatch',
            error: `CAS conflict releasing new-work hold: holder '${requestedHolder}' does not match active holder '${state.holder}'`,
            hold: toSnapshot(state, now),
            drain,
        };
    }
    const requestedToken = readOptionalString(opts.holderToken);
    if (requestedToken && state.holderToken && requestedToken !== state.holderToken) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_UNAUTHORIZED_CODE,
            reason: 'unauthorized',
            error: 'Cannot release new-work hold: holderToken mismatch',
            hold: toSnapshot(state, now),
            drain,
        };
    }
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== null && Math.floor(opts.expectedRevision) !== state.revision) {
        return {
            success: false,
            held: true,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: `CAS conflict releasing new-work hold: expected revision ${opts.expectedRevision}, current revision is ${state.revision}`,
            hold: toSnapshot(state, now),
            drain,
        };
    }

    const baseRevision = state.revision;
    state.lastReleasedHoldId = state.holdId;
    state.active = false;
    state.status = 'released';
    state.phase = 'inactive';
    state.sealed = false;
    state.holderToken = null;
    state.releasedAt = now;
    state.releasedReason = readOptionalString(opts.reason) ?? 'explicit_release';
    state.updatedAt = now;
    state.revision += 1;

    const refreshedDrain = collectNewWorkHoldDrainSummary({
        meshIds: state.scope === 'mesh' ? state.meshIds : undefined,
        active: false,
        now,
        components: opts.components,
    });
    const snap = toSnapshot(state, now);
    const reqId = readOptionalString(opts.requestId);
    if (reqId) {
        recordReplay(state, { key: `release:${reqId}`, op: 'release', holdId: state.lastReleasedHoldId, holder: state.holder, revision: state.revision, snapshot: snap });
    }
    const writeRes = writeState(opts.configDir, state, { expectedRevision: baseRevision, now });
    if (writeRes.conflict && writeRes.currentDiskState) {
        return {
            success: false,
            held: writeRes.currentDiskState.active,
            replayed: false,
            idempotent: false,
            code: NEW_WORK_HOLD_CAS_CONFLICT_CODE,
            reason: 'cas_conflict',
            error: writeRes.error || 'Concurrent revision conflict while releasing new-work hold',
            hold: toSnapshot(writeRes.currentDiskState, now),
            drain: refreshedDrain,
        };
    }
    if (!writeRes.persisted) {
        const current = readState(opts.configDir, now);
        return { success: false, held: current.active, replayed: false, idempotent: false,
            code: 'new_work_hold_persistence_failed', reason: 'persistence_failed', error: writeRes.error,
            hold: toSnapshot(current, now), drain: refreshedDrain, persistenceWarning: writeRes.error };
    }
    return {
        success: true,
        held: false,
        released: true,
        replayed: false,
        idempotent: false,
        hold: toSnapshot(state, now),
        drain: refreshedDrain,
        ...(state.persistenceWarning ? { persistenceWarning: state.persistenceWarning } : {}),
    };
}

export function formatNewWorkHeldToken(info: NewWorkHeldInfo): string {
    const phase = info.phase || 'draining';
    return `${NEW_WORK_HELD_CODE}[hold=${info.holdId} rev=${info.revision} expires=${info.expiresAt} phase=${phase}]`;
}

export function formatNewWorkHeldMessage(info: NewWorkHeldInfo, prefix = 'New work is held on this daemon'): string {
    const token = formatNewWorkHeldToken(info);
    const reason = typeof info.reason === 'string' && info.reason.trim() ? `: ${info.reason.trim()}` : '';
    return `${prefix} (${token})${reason}`;
}

export class NewWorkHeldError extends Error {
    readonly code = NEW_WORK_HELD_CODE;
    readonly reason = NEW_WORK_HELD_CODE;
    readonly holdId: string;
    readonly revision: number;
    readonly expiresAt: number;
    readonly phase: NewWorkHoldPhase;
    readonly refusal?: NewWorkHoldRefusal;

    constructor(infoOrRefusal: NewWorkHeldInfo | NewWorkHoldRefusal, prefix?: string) {
        const isRefusal = typeof (infoOrRefusal as NewWorkHoldRefusal).error === 'string' && (infoOrRefusal as NewWorkHoldRefusal).success === false;
        const info: NewWorkHeldInfo = {
            holdId: infoOrRefusal.holdId || 'active',
            revision: typeof infoOrRefusal.revision === 'number' ? infoOrRefusal.revision : ((infoOrRefusal as NewWorkHoldRefusal).holdRevision ?? 1),
            expiresAt: typeof infoOrRefusal.expiresAt === 'number' ? infoOrRefusal.expiresAt : ((infoOrRefusal as NewWorkHoldRefusal).holdExpiresAt ?? 0),
            phase: infoOrRefusal.phase || (infoOrRefusal as NewWorkHoldRefusal).holdPhase || 'draining',
            reason: isRefusal ? (infoOrRefusal as NewWorkHoldRefusal).holdReason : (infoOrRefusal as NewWorkHeldInfo).reason,
        };
        super(isRefusal ? (infoOrRefusal as NewWorkHoldRefusal).error : formatNewWorkHeldMessage(info, prefix));
        this.name = 'NewWorkHeldError';
        this.holdId = info.holdId;
        this.revision = info.revision;
        this.expiresAt = info.expiresAt;
        this.phase = info.phase || 'draining';
        if (isRefusal) this.refusal = infoOrRefusal as NewWorkHoldRefusal;
    }
}

export function classifyNewWorkHeld(err: unknown): NewWorkHeldInfo | null {
    if (!err) return null;
    if (typeof err === 'object') {
        const obj = err as Record<string, unknown>;
        if (obj.code === NEW_WORK_HELD_CODE || obj.reason === NEW_WORK_HELD_CODE) {
            const phase = typeof obj.phase === 'string' ? obj.phase : (typeof obj.holdPhase === 'string' ? obj.holdPhase : undefined);
            return {
                holdId: typeof obj.holdId === 'string' && obj.holdId ? obj.holdId : 'active',
                revision: typeof obj.revision === 'number' ? obj.revision : (typeof obj.holdRevision === 'number' ? obj.holdRevision : 1),
                expiresAt: typeof obj.expiresAt === 'number' ? obj.expiresAt : (typeof obj.holdExpiresAt === 'number' ? obj.holdExpiresAt : 0),
                ...(phase ? { phase: phase as NewWorkHoldPhase } : {}),
            };
        }
    }
    const text = typeof err === 'string'
        ? err
        : typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : typeof (err as { error?: unknown }).error === 'string'
                ? (err as { error: string }).error
                : '';
    const match = TOKEN_RE.exec(text);
    if (!match) {
        if (text === NEW_WORK_HELD_CODE || text.startsWith(`${NEW_WORK_HELD_CODE}:`)) {
            return { holdId: 'active', revision: 1, expiresAt: 0 };
        }
        return null;
    }
    return {
        holdId: match[1],
        revision: Number(match[2]),
        expiresAt: Number(match[3]),
        ...(match[4] ? { phase: match[4] as NewWorkHoldPhase } : {}),
    };
}

export function buildNewWorkHeldRefusal(
    hold: NewWorkHoldSnapshot,
    detailOrContext?: string | { command?: string; surface?: NewWorkHoldRefusal['surface'] },
): NewWorkHoldRefusal {
    const context = typeof detailOrContext === 'object' && detailOrContext !== null ? detailOrContext : undefined;
    const prefix = typeof detailOrContext === 'string' && detailOrContext.trim()
        ? detailOrContext.trim()
        : context?.command
            ? `Command '${context.command}' refused while new-work hold is active`
            : 'New work is held on this daemon';
    const info: NewWorkHeldInfo = {
        holdId: hold.holdId || 'active',
        revision: hold.revision,
        expiresAt: hold.expiresAt || 0,
        phase: hold.phase,
        reason: hold.reason,
    };
    return {
        success: false,
        code: NEW_WORK_HELD_CODE,
        reason: NEW_WORK_HELD_CODE,
        recoverable: true,
        retryable: true,
        retryRecommended: false,
        held: true,
        holdId: info.holdId,
        revision: info.revision,
        expiresAt: info.expiresAt,
        remainingMs: hold.remainingMs,
        phase: hold.phase,
        sealed: hold.sealed,
        holdRevision: hold.revision,
        holdPhase: hold.phase,
        holdReason: hold.reason,
        holdExpiresAt: hold.expiresAt,
        ...(context?.command ? { command: context.command } : {}),
        ...(context?.surface ? { surface: context.surface } : {}),
        error: formatNewWorkHeldMessage(info, prefix),
        nextAction: 'Do not retry immediately in a tight loop. Enqueue new tasks via mesh_enqueue_task (which stays pending while held) or wait until maintenance_new_work_hold_status reports held=false.',
    };
}

export {
    NEW_WORK_HOLD_EXEMPT_COMMANDS,
    NEW_WORK_HOLD_GATED_COMMANDS,
    ROUTER_MAINTENANCE_EXEMPT_COMMANDS,
    admitRouterCommandUnderNewWorkHold,
    assertNewWorkHoldAdmission,
    resolveNewWorkHoldSessionMeshId,
    isRouterCommandMaintenanceExempt,
    isRunningWorkContinuation,
    type RunningWorkContinuationCheck,
} from './new-work-hold-admission.js';
