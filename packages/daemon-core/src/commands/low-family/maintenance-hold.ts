/**
 * RF-ROUTER LOW family — worker-handoff new-work hold commands (mission c41fad0a).
 *
 * Commands to set, extend, release, and inspect the daemon-owned expiring CAS
 * new-work hold record, including TTL expiry and drain -> seal state reporting.
 *
 * Security invariants:
 * - F1: Command handlers never accept caller `now` arguments; time is owned by
 *   the daemon clock (or injected via `setNewWorkHoldClockForTests` in unit tests).
 * - F2: `set`, `extend`, and `release` require verified owner ingress
 *   (`isTrustedOwnerIngress`) or a valid `holderToken`. While a hold is active,
 *   `extend` and `release` require matching `holdId` and `holder`.
 */
import type { DaemonComponents } from '../../boot/daemon-components.js';
import {
    extendNewWorkHold,
    getNewWorkHoldStatus,
    releaseNewWorkHold,
    setNewWorkHold,
    verifyNewWorkHoldCallerAuthorization,
} from '../../maintenance/new-work-hold.js';
import { defineCommandSpecs, type CommandSpecAttributes } from '../command-registry.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

function resolveHoldComponents(ctx: LowFamilyContext): DaemonComponents | null {
    try {
        return ctx.components();
    } catch {
        return {
            cliManager: ctx.deps.cliManager,
            instanceManager: ctx.deps.instanceManager,
        } as unknown as DaemonComponents;
    }
}

function readOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMeshIdsArg(args: any): string[] | undefined {
    if (Array.isArray(args?.meshIds)) {
        return args.meshIds.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0);
    }
    const single = readOptionalString(args?.meshId ?? args?.mesh_id);
    return single ? [single] : undefined;
}

const handleSet: LowFamilyHandler = async (ctx, args) => {
    const auth = verifyNewWorkHoldCallerAuthorization('set', args);
    if (!auth.ok) return auth.refusal;
    const meshIds = readMeshIdsArg(args);
    return setNewWorkHold({
        holdId: readOptionalString(args?.holdId ?? args?.hold_id),
        holder: readOptionalString(args?.holder ?? args?.actor ?? args?.ownerId),
        holderToken: readOptionalString(args?.holderToken ?? args?.holder_token),
        reason: readOptionalString(args?.reason),
        scope: args?.scope === 'mesh' || (meshIds && meshIds.length > 0) ? 'mesh' : 'daemon',
        meshIds,
        ttlMs: readOptionalNumber(args?.ttlMs ?? args?.ttl_ms),
        maxAutoExtendCount: readOptionalNumber(args?.maxAutoExtendCount ?? args?.max_auto_extend_count),
        maxTotalExtensionMs: readOptionalNumber(args?.maxTotalExtensionMs ?? args?.max_total_extension_ms),
        expectedRevision: readOptionalNumber(args?.expectedRevision ?? args?.expected_revision),
        force: args?.force === true,
        components: resolveHoldComponents(ctx),
    });
};

const handleExtend: LowFamilyHandler = async (ctx, args) => {
    const auth = verifyNewWorkHoldCallerAuthorization('extend', args);
    if (!auth.ok) return auth.refusal;
    return extendNewWorkHold({
        holdId: readOptionalString(args?.holdId ?? args?.hold_id),
        holder: readOptionalString(args?.holder ?? args?.actor ?? args?.ownerId),
        holderToken: readOptionalString(args?.holderToken ?? args?.holder_token),
        reason: readOptionalString(args?.reason),
        ttlMs: readOptionalNumber(args?.ttlMs ?? args?.ttl_ms),
        expectedRevision: readOptionalNumber(args?.expectedRevision ?? args?.expected_revision),
        components: resolveHoldComponents(ctx),
    });
};

const handleRelease: LowFamilyHandler = async (ctx, args) => {
    const auth = verifyNewWorkHoldCallerAuthorization('release', args);
    if (!auth.ok) return auth.refusal;
    return releaseNewWorkHold({
        holdId: readOptionalString(args?.holdId ?? args?.hold_id),
        holder: readOptionalString(args?.holder ?? args?.actor ?? args?.ownerId),
        holderToken: readOptionalString(args?.holderToken ?? args?.holder_token),
        reason: readOptionalString(args?.reason),
        expectedRevision: readOptionalNumber(args?.expectedRevision ?? args?.expected_revision),
        components: resolveHoldComponents(ctx),
    });
};

const handleStatus: LowFamilyHandler = async (ctx, args) => {
    return getNewWorkHoldStatus({
        meshId: readOptionalString(args?.meshId ?? args?.mesh_id) ?? null,
        autoExtend: typeof args?.autoExtend === 'boolean' ? args.autoExtend : true,
        components: resolveHoldComponents(ctx),
    });
};

const handleMultiplex: LowFamilyHandler = async (ctx, args) => {
    const action = readOptionalString(args?.action ?? args?.op) || 'status';
    if (action === 'set') return handleSet(ctx, args);
    if (action === 'extend') return handleExtend(ctx, args);
    if (action === 'release') return handleRelease(ctx, args);
    if (action === 'status') return handleStatus(ctx, args);
    return {
        success: false,
        code: 'invalid_hold_action',
        error: `Unknown new-work hold action '${action}'. Expected set | extend | release | status.`,
    };
};

const HOLD_SPEC_OPTIONS: CommandSpecAttributes = {
    sources: ['ipc', 'standalone', 'p2p', 'mesh'],
    meshSender: 'authenticated_peer',
};

export const NEW_WORK_HOLD_EXEMPT_COMMANDS = [
    'maintenance_new_work_hold_set',
    'maintenance_new_work_hold_extend',
    'maintenance_new_work_hold_release',
    'maintenance_new_work_hold_status',
    'maintenance_new_work_hold',
    'new_work_hold_set',
    'new_work_hold_extend',
    'new_work_hold_release',
    'new_work_hold_status',
    'new_work_hold',
] as const;

export const maintenanceHoldSpecs = defineCommandSpecs(
    'low',
    {
        maintenance_new_work_hold_set: handleSet,
        maintenance_new_work_hold_extend: handleExtend,
        maintenance_new_work_hold_release: handleRelease,
        maintenance_new_work_hold_status: handleStatus,
        maintenance_new_work_hold: handleMultiplex,
        new_work_hold_set: handleSet,
        new_work_hold_extend: handleExtend,
        new_work_hold_release: handleRelease,
        new_work_hold_status: handleStatus,
        new_work_hold: handleMultiplex,
    },
    Object.fromEntries(NEW_WORK_HOLD_EXEMPT_COMMANDS.map((cmd) => [cmd, HOLD_SPEC_OPTIONS])),
);
