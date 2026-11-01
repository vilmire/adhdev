/**
 * One-shot, idempotent boot migration: per-mesh quota thresholds → the
 * MACHINE quota reserve (design 2026-11-01-machine-quota-reserve §5).
 *
 * Before the reserve existed, each mesh carried its own session floor, long-window
 * floor and reset-imminent waiver in `policy.quotaRouting` (the field names live
 * in LEGACY_MESH_RESERVE_FIELDS). They are machine facts (whose quota is being
 * protected is a property of the account, not of the repo), so this moves them
 * into `config.quotaReserve.defaults` and deletes them from meshes.json.
 *
 * CONFLICT RULE (owner decision Q2): per field, the MOST CONSERVATIVE value
 * wins — percentages take the max, the reset-imminent waiver takes the min —
 * so no mesh's protection is ever reduced by the merge. Originals are kept in
 * `quotaReserve.migration.fromMeshes` and a WARN line is logged once when more
 * than one distinct value was merged.
 *
 * Reads meshes.json RAW (not via loadMeshConfig): the loader's sparse-policy
 * normalization already drops these fields on pre-v2 stores, which would erase
 * the very values this has to read. Each machine migrates only its own
 * meshes.json/config.json; a non-host machine writes only its own config.
 */
import { LOG } from '../logging/logger.js';
import { getQuotaReserveConfig, setQuotaReserveConfig } from './config.js';
import { readMeshConfigFromDisk, saveMeshConfig, withMeshConfigWriteLock } from './mesh-config-store.js';
import {
    DEFAULT_QUOTA_RESERVE,
    LEGACY_MESH_RESERVE_FIELDS,
    applyQuotaReserveSet,
    coerceQuotaReserve,
    mergeConservativeDefaults,
    type QuotaReserveConfig,
    type QuotaReservePolicy,
} from '../quota/quota-reserve.js';
import { recordQuotaReserveMigrationConflicts } from '../quota/quota-reserve-metrics.js';

export interface MeshQuotaReserveMigrationResult {
    /** meshes.json had legacy fields and they were removed. */
    migrated: boolean;
    /** Distinct field values that disagreed across meshes (resolved by the conservative rule). */
    conflictsResolved: number;
    /** Meshes that carried an explicit non-default value. */
    meshesWithValues: number;
}

const NONE: MeshQuotaReserveMigrationResult = { migrated: false, conflictsResolved: 0, meshesWithValues: 0 };

export function migrateMeshQuotaThresholdsToMachineReserve(now: string = new Date().toISOString()): MeshQuotaReserveMigrationResult {
    return withMeshConfigWriteLock(() => {
        const mesh = readMeshConfigFromDisk();
        if (!mesh) return NONE;
        const fromMeshes: Array<{ meshId: string; fields: Record<string, number> }> = [];
        let strip = false;
        for (const entry of mesh.meshes as Array<any>) {
            const routing = entry?.policy?.quotaRouting;
            if (!routing || typeof routing !== 'object') continue;
            const fields: Record<string, number> = {};
            for (const [legacy, reserveField] of Object.entries(LEGACY_MESH_RESERVE_FIELDS)) {
                if (!Object.prototype.hasOwnProperty.call(routing, legacy)) continue;
                strip = true;
                const value = routing[legacy];
                const target = reserveField as keyof QuotaReservePolicy;
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0
                    && (target === 'routingSessionResetImminentMs' || value <= 100)
                    && value !== DEFAULT_QUOTA_RESERVE[target]) {
                    fields[target] = target === 'routingSessionResetImminentMs' ? Math.floor(value) : value;
                }
                delete routing[legacy];
            }
            if (Object.keys(routing).length === 0) delete entry.policy.quotaRouting;
            if (Object.keys(fields).length) fromMeshes.push({ meshId: String(entry.id ?? ''), fields });
        }
        if (!strip) return NONE;

        let conflictsResolved = 0;
        if (fromMeshes.length) {
            let merged: QuotaReservePolicy | undefined = getQuotaReserveConfig()?.defaults;
            const distinct = new Map<string, Set<number>>();
            for (const { fields } of fromMeshes) {
                for (const [field, value] of Object.entries(fields)) {
                    (distinct.get(field) ?? distinct.set(field, new Set()).get(field)!).add(value);
                }
                merged = mergeConservativeDefaults(merged, fields as QuotaReservePolicy);
            }
            for (const values of distinct.values()) if (values.size > 1) conflictsResolved += values.size - 1;
            const next = applyQuotaReserveSet(getQuotaReserveConfig(), { scope: 'defaults', policy: merged as Record<string, unknown> }, now);
            const base: QuotaReserveConfig = coerceQuotaReserve(next) ?? { version: 1 };
            setQuotaReserveConfig({ ...base, migration: { at: now, fromMeshes, resolution: 'max' }, updatedAt: now });
            if (conflictsResolved > 0) {
                recordQuotaReserveMigrationConflicts(conflictsResolved);
                LOG.warn('QuotaReserve', `Merged per-mesh quota thresholds from ${fromMeshes.length} mesh(es) into the machine quota reserve using the most conservative value (${conflictsResolved} conflicting value(s) resolved). Originals kept in config quotaReserve.migration.`);
            } else {
                LOG.info('QuotaReserve', `Moved per-mesh quota thresholds from ${fromMeshes.length} mesh(es) into the machine quota reserve.`);
            }
        }
        // Config first, meshes.json second: a crash in between re-runs harmlessly
        // (max/min merge is idempotent) instead of losing the values.
        saveMeshConfig(mesh);
        return { migrated: true, conflictsResolved, meshesWithValues: fromMeshes.length };
    });
}
