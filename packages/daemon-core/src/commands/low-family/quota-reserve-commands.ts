/**
 * Machine quota reserve commands (design 2026-11-01-machine-quota-reserve §6).
 *
 * `quota_reserve_get` is readable by every local source (a coordinator may
 * LOOK at the machine's reserve). `quota_reserve_set` is OWNER-ONLY (owner
 * decision Q4): dashboard / REST / standalone sources only — never `ipc` (the
 * MCP path agents and coordinators use) and never `mesh` (a remote daemon).
 */
import { defineCommandSpecs } from '../command-registry.js';
import { getQuotaReserveConfig, setQuotaReserveConfig } from '../../config/config.js';
import { readQuotaCache } from '../../quota/refresh.js';
import { applyQuotaReserveSet, type QuotaReserveSetInput } from '../../quota/quota-reserve.js';
import { recordQuotaReserveEdit } from '../../quota/quota-reserve-metrics.js';
import { buildQuotaReserveView } from '../../quota/quota-reserve-view.js';
import type { LowFamilyContext } from './types.js';

type DepsOnly = Pick<LowFamilyContext, 'deps'>;

export const quotaReserveHandlers = {
    quota_reserve_get: async (_ctx: DepsOnly, _args: any) => ({
        success: true,
        ...buildQuotaReserveView(getQuotaReserveConfig(), readQuotaCache()),
    }),

    quota_reserve_set: async (_ctx: DepsOnly, args: any) => {
        try {
            const input: QuotaReserveSetInput = {
                scope: args?.scope,
                key: typeof args?.key === 'string' ? args.key : undefined,
                accountKey: typeof args?.accountKey === 'string' ? args.accountKey : undefined,
                policy: args?.policy === null ? null : args?.policy,
                replace: args?.replace === true,
            };
            if (input.policy !== null && (input.policy === undefined || typeof input.policy !== 'object' || Array.isArray(input.policy))) {
                return { success: false, error: 'invalid_quota_reserve: policy (object, or null to clear the scope) is required' };
            }
            const next = applyQuotaReserveSet(getQuotaReserveConfig(), input);
            setQuotaReserveConfig(next);
            recordQuotaReserveEdit();
            return { success: true, ...buildQuotaReserveView(getQuotaReserveConfig(), readQuotaCache()) };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};

export const quotaReserveSpecs = defineCommandSpecs('low', quotaReserveHandlers, {
    quota_reserve_get: { sources: ['ws', 'p2p', 'ext', 'api', 'standalone', 'ipc', 'internal'] },
    // Owner-only: no ipc (agents/MCP), no mesh (peer daemons), no push_relay.
    quota_reserve_set: { sources: ['ws', 'p2p', 'ext', 'api', 'standalone'], invalidates: ['daemon.metadata'] },
});
