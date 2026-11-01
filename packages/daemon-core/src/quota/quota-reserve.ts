/**
 * Machine-wide quota RESERVE — the single home of "how much quota an
 * automatic consumer must leave for the person" (design: root repo
 * docs/design/2026-11-01-machine-quota-reserve.md).
 *
 * Why this lives here and nowhere else: the mesh launch gate and the
 * assistant review turn used to carry their own numbers (per-mesh policy
 * fields and a hard-coded constant), so one account's quota was judged by
 * different bars depending on who asked. Every reader now resolves through
 * `resolveQuotaReserve`; the regression gate
 * `scripts/check-quota-reserve-single-source.mjs` fails when the legacy field
 * names reappear in any other source file.
 *
 * Storage: `ADHDevConfig.quotaReserve` (machine-local config.json). A
 * reporting node ships its RAW stored value inside its node facts bundle so a
 * coordinator judges a snapshot with the reserve of the machine that owns the
 * account. A node that sends nothing (older daemon) resolves to the code
 * defaults — the same fail-open direction as before.
 *
 * This file is dependency-free (no config/mesh imports) on purpose: both the
 * config loader and the gate import it.
 */

/** A provider type ('claude-cli') or a pool key ('antigravity-cli:gemini'). */
export type QuotaReservePoolKey = string;

export interface QuotaReservePolicy {
    /** Skip a provider whose SESSION window has less than this % left. */
    routingSessionMinPercent?: number;
    /** Skip a provider whose long window (7d / 30d) has less than this % left. */
    routingLongMinPercent?: number;
    /** Waive a session-low block when the session resets within this many ms. */
    routingSessionResetImminentMs?: number;
    /** Skip an idle assistant review turn below this % of the tightest window. */
    assistantReviewMinPercent?: number;
}

export interface QuotaReserveMigrationRecord {
    at: string;
    fromMeshes: Array<{ meshId: string; fields: Record<string, number> }>;
    resolution: 'max';
}

export interface QuotaReserveConfig {
    version: 1;
    defaults?: QuotaReservePolicy;
    pools?: Record<QuotaReservePoolKey, QuotaReservePolicy>;
    /** accountKey (QuotaAccountLineage.key) → pool/provider key → policy. */
    accounts?: Record<string, Record<QuotaReservePoolKey, QuotaReservePolicy>>;
    migration?: QuotaReserveMigrationRecord;
    updatedAt?: string;
}

export type ResolvedQuotaReserve = Required<QuotaReservePolicy>;

/** Code defaults (owner decision Q6: keep the pre-reserve 10 / 15 / 5 min / 20). */
export const DEFAULT_QUOTA_RESERVE: ResolvedQuotaReserve = Object.freeze({
    routingSessionMinPercent: 10,
    routingLongMinPercent: 15,
    routingSessionResetImminentMs: 5 * 60 * 1000,
    assistantReviewMinPercent: 20,
});

const PERCENT_FIELDS = ['routingSessionMinPercent', 'routingLongMinPercent', 'assistantReviewMinPercent'] as const;
const DURATION_FIELDS = ['routingSessionResetImminentMs'] as const;
export const QUOTA_RESERVE_POLICY_FIELDS: readonly (keyof QuotaReservePolicy)[] = [...PERCENT_FIELDS, ...DURATION_FIELDS];
const FIELD_SET = new Set<string>(QUOTA_RESERVE_POLICY_FIELDS);
const POOL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const ACCOUNT_KEY_RE = /^[a-f0-9]{64}$/;

export type QuotaReserveScope = 'defaults' | 'pool' | 'account';

export function quotaReservePoolKey(provider: string, pool?: string | null): QuotaReservePoolKey {
    return pool ? `${provider}:${pool}` : provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
    throw new Error(`invalid_quota_reserve: ${message}`);
}

/** Strict policy validation (writer path): unknown field / out-of-range → throw. */
export function validateQuotaReservePolicy(input: unknown, where = 'policy'): QuotaReservePolicy {
    if (!isRecord(input)) fail(`${where} must be an object`);
    const out: QuotaReservePolicy = {};
    for (const [key, raw] of Object.entries(input)) {
        if (!FIELD_SET.has(key)) fail(`unknown field '${key}' in ${where} (known: ${QUOTA_RESERVE_POLICY_FIELDS.join(', ')})`);
        if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(`${key} must be a finite number (got ${JSON.stringify(raw)})`);
        if ((PERCENT_FIELDS as readonly string[]).includes(key)) {
            if (raw < 0 || raw > 100) fail(`${key} must be between 0 and 100 (got ${raw})`);
        } else if (raw < 0) {
            fail(`${key} must be >= 0 (got ${raw})`);
        }
        (out as Record<string, number>)[key] = (DURATION_FIELDS as readonly string[]).includes(key) ? Math.floor(raw) : raw;
    }
    return out;
}

/** Lenient policy coercion (reader path): keeps valid fields, drops the rest. */
function coercePolicy(input: unknown): QuotaReservePolicy | undefined {
    if (!isRecord(input)) return undefined;
    const out: QuotaReservePolicy = {};
    for (const key of QUOTA_RESERVE_POLICY_FIELDS) {
        const raw = input[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        if ((PERCENT_FIELDS as readonly string[]).includes(key)) {
            if (raw < 0 || raw > 100) continue;
            (out as Record<string, number>)[key] = raw;
        } else {
            if (raw < 0) continue;
            (out as Record<string, number>)[key] = Math.floor(raw);
        }
    }
    return Object.keys(out).length ? out : undefined;
}

function coerceMigration(input: unknown): QuotaReserveMigrationRecord | undefined {
    if (!isRecord(input) || typeof input.at !== 'string' || input.resolution !== 'max' || !Array.isArray(input.fromMeshes)) return undefined;
    const fromMeshes: QuotaReserveMigrationRecord['fromMeshes'] = [];
    for (const entry of input.fromMeshes.slice(0, 50)) {
        if (!isRecord(entry) || typeof entry.meshId !== 'string' || !isRecord(entry.fields)) continue;
        const fields: Record<string, number> = {};
        for (const [k, v] of Object.entries(entry.fields)) if (typeof v === 'number' && Number.isFinite(v)) fields[k] = v;
        fromMeshes.push({ meshId: entry.meshId, fields });
    }
    return { at: input.at, fromMeshes, resolution: 'max' };
}

const coerceCache = new WeakMap<object, QuotaReserveConfig | undefined>();

/**
 * Lenient normalization of an UNTRUSTED stored/wire value (config.json, node
 * facts). Never throws; invalid pieces are dropped; the result is sparse.
 * Memoized per input object — the gate calls this per candidate per tick.
 */
export function coerceQuotaReserve(raw: unknown): QuotaReserveConfig | undefined {
    if (!isRecord(raw)) return undefined;
    if (coerceCache.has(raw)) return coerceCache.get(raw);
    const out: QuotaReserveConfig = { version: 1 };
    const defaults = coercePolicy(raw.defaults);
    if (defaults) out.defaults = defaults;
    if (isRecord(raw.pools)) {
        const pools: Record<string, QuotaReservePolicy> = {};
        for (const [key, value] of Object.entries(raw.pools)) {
            const policy = POOL_KEY_RE.test(key) ? coercePolicy(value) : undefined;
            if (policy) pools[key] = policy;
        }
        if (Object.keys(pools).length) out.pools = pools;
    }
    if (isRecord(raw.accounts)) {
        const accounts: Record<string, Record<string, QuotaReservePolicy>> = {};
        for (const [accountKey, byPool] of Object.entries(raw.accounts)) {
            if (!ACCOUNT_KEY_RE.test(accountKey) || !isRecord(byPool)) continue;
            const inner: Record<string, QuotaReservePolicy> = {};
            for (const [key, value] of Object.entries(byPool)) {
                const policy = POOL_KEY_RE.test(key) ? coercePolicy(value) : undefined;
                if (policy) inner[key] = policy;
            }
            if (Object.keys(inner).length) accounts[accountKey] = inner;
        }
        if (Object.keys(accounts).length) out.accounts = accounts;
    }
    const migration = coerceMigration(raw.migration);
    if (migration) out.migration = migration;
    if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt;
    const result = out.defaults || out.pools || out.accounts || out.migration ? out : undefined;
    coerceCache.set(raw, result);
    return result;
}

export type QuotaReserveSource = 'account-pool' | 'account-provider' | 'pool' | 'provider' | 'defaults' | 'code-default';

export interface ResolveQuotaReserveInput {
    provider: string;
    /** Sub-pool within the provider ('gemini' | 'claude-gpt' for antigravity-cli). */
    pool?: string | null;
    /** QuotaAccountLineage.key — only for lineage kind 'account'. */
    accountKey?: string | null;
}

export interface ResolvedQuotaReserveWithSources {
    policy: ResolvedQuotaReserve;
    source: Partial<Record<keyof QuotaReservePolicy, QuotaReserveSource>>;
}

/**
 * Resolve the effective reserve. Order (field by field, first hit wins):
 * accounts[key][poolKey] → accounts[key][provider] → pools[poolKey] →
 * pools[provider] → defaults → code constants.
 */
export function resolveQuotaReserveDetailed(raw: unknown, input: ResolveQuotaReserveInput): ResolvedQuotaReserveWithSources {
    const config = coerceQuotaReserve(raw);
    const poolKey = quotaReservePoolKey(input.provider, input.pool);
    const account = input.accountKey && ACCOUNT_KEY_RE.test(input.accountKey) ? config?.accounts?.[input.accountKey] : undefined;
    const layers: Array<[QuotaReserveSource, QuotaReservePolicy | undefined]> = [
        ['account-pool', input.pool ? account?.[poolKey] : undefined],
        ['account-provider', account?.[input.provider]],
        ['pool', input.pool ? config?.pools?.[poolKey] : undefined],
        ['provider', config?.pools?.[input.provider]],
        ['defaults', config?.defaults],
    ];
    const policy = { ...DEFAULT_QUOTA_RESERVE };
    const source: ResolvedQuotaReserveWithSources['source'] = {};
    for (const field of QUOTA_RESERVE_POLICY_FIELDS) {
        let hit = false;
        for (const [name, layer] of layers) {
            const value = layer?.[field];
            if (value !== undefined) {
                (policy as Record<string, number>)[field] = value;
                source[field] = name;
                hit = true;
                break;
            }
        }
        if (!hit) source[field] = 'code-default';
    }
    return { policy, source };
}

export function resolveQuotaReserve(raw: unknown, input: ResolveQuotaReserveInput): ResolvedQuotaReserve {
    return resolveQuotaReserveDetailed(raw, input).policy;
}

function withoutEntry(config: QuotaReserveConfig, path: ['defaults'] | ['pools', string] | ['accounts', string, string]): QuotaReserveConfig {
    const copy: QuotaReserveConfig = JSON.parse(JSON.stringify(config));
    if (path[0] === 'defaults') delete copy.defaults;
    else if (path[0] === 'pools') delete copy.pools?.[path[1]];
    else delete copy.accounts?.[path[1]]?.[path[2]];
    return copy;
}

/** Drop fields equal to what the entry would inherit anyway (persistence economy). */
function prune(config: QuotaReserveConfig): QuotaReserveConfig {
    const out: QuotaReserveConfig = JSON.parse(JSON.stringify(config));
    const dropEqual = (policy: QuotaReservePolicy, parent: ResolvedQuotaReserve): QuotaReservePolicy | undefined => {
        const kept: QuotaReservePolicy = {};
        for (const field of QUOTA_RESERVE_POLICY_FIELDS) {
            const value = policy[field];
            if (value !== undefined && value !== parent[field]) (kept as Record<string, number>)[field] = value;
        }
        return Object.keys(kept).length ? kept : undefined;
    };
    if (out.defaults) {
        const kept = dropEqual(out.defaults, DEFAULT_QUOTA_RESERVE);
        if (kept) out.defaults = kept; else delete out.defaults;
    }
    // Pools: a bare provider entry inherits defaults; a `provider:pool` entry
    // inherits its provider entry — resolve against the config WITHOUT the entry.
    for (const key of Object.keys(out.pools ?? {})) {
        const [provider, pool] = key.split(':') as [string, string | undefined];
        const parent = resolveQuotaReserve(withoutEntry(out, ['pools', key]), { provider, pool: pool ?? null });
        const kept = dropEqual(out.pools![key], parent);
        if (kept) out.pools![key] = kept; else delete out.pools![key];
    }
    if (out.pools && !Object.keys(out.pools).length) delete out.pools;
    for (const accountKey of Object.keys(out.accounts ?? {})) {
        const byPool = out.accounts![accountKey];
        for (const key of Object.keys(byPool)) {
            const [provider, pool] = key.split(':') as [string, string | undefined];
            const parent = resolveQuotaReserve(withoutEntry(out, ['accounts', accountKey, key]), { provider, pool: pool ?? null, accountKey });
            const kept = dropEqual(byPool[key], parent);
            if (kept) byPool[key] = kept; else delete byPool[key];
        }
        if (!Object.keys(byPool).length) delete out.accounts![accountKey];
    }
    if (out.accounts && !Object.keys(out.accounts).length) delete out.accounts;
    return out;
}

export interface QuotaReserveSetInput {
    scope: QuotaReserveScope;
    /** Pool/provider key for scope 'pool' and 'account'. */
    key?: string;
    accountKey?: string;
    /** Partial fields merged into the scope; null deletes the scope entry. */
    policy: Record<string, unknown> | null;
    /** Replace the scope's fields wholesale instead of merging (an empty policy clears it). */
    replace?: boolean;
}

/**
 * Apply one `quota_reserve_set` mutation to a stored value and return the new
 * sparse value (undefined when nothing but defaults remains). Strict: throws
 * `invalid_quota_reserve` on bad scope / key / field / range.
 */
export function applyQuotaReserveSet(current: unknown, input: QuotaReserveSetInput, now: string = new Date().toISOString()): QuotaReserveConfig | undefined {
    const base: QuotaReserveConfig = JSON.parse(JSON.stringify(coerceQuotaReserve(current) ?? { version: 1 }));
    const patch = input.policy === null ? null : validateQuotaReservePolicy(input.policy);
    const merge = (existing: QuotaReservePolicy | undefined): QuotaReservePolicy | undefined => {
        if (patch === null) return undefined;
        const next = input.replace === true ? { ...patch } : { ...(existing ?? {}), ...patch };
        return Object.keys(next).length ? next : undefined;
    };
    if (input.scope === 'defaults') {
        const next = merge(base.defaults);
        if (next) base.defaults = next; else delete base.defaults;
    } else if (input.scope === 'pool') {
        const key = input.key;
        if (typeof key !== 'string' || !POOL_KEY_RE.test(key)) fail('scope pool requires a provider or provider:pool key');
        base.pools = base.pools ?? {};
        const next = merge(base.pools[key]);
        if (next) base.pools[key] = next; else delete base.pools[key];
    } else if (input.scope === 'account') {
        const key = input.key;
        if (typeof input.accountKey !== 'string' || !ACCOUNT_KEY_RE.test(input.accountKey)) fail('scope account requires a known accountKey (64-hex lineage key); unknown accounts cannot be overridden');
        if (typeof key !== 'string' || !POOL_KEY_RE.test(key)) fail('scope account requires a provider or provider:pool key');
        base.accounts = base.accounts ?? {};
        const byPool = (base.accounts[input.accountKey] = base.accounts[input.accountKey] ?? {});
        const next = merge(byPool[key]);
        if (next) byPool[key] = next; else delete byPool[key];
    } else {
        fail(`unknown scope '${String(input.scope)}' (defaults | pool | account)`);
    }
    const pruned = prune(base);
    if (!pruned.defaults && !pruned.pools && !pruned.accounts && !pruned.migration) return undefined;
    pruned.updatedAt = now;
    return pruned;
}

/** Incremental conservative merge used by the one-time mesh-threshold migration. */
export function mergeConservativeDefaults(
    current: QuotaReservePolicy | undefined,
    incoming: QuotaReservePolicy,
): QuotaReservePolicy {
    const out: QuotaReservePolicy = { ...(current ?? {}) };
    for (const field of QUOTA_RESERVE_POLICY_FIELDS) {
        const value = incoming[field];
        if (value === undefined) continue;
        const existing = out[field];
        if (existing === undefined) { (out as Record<string, number>)[field] = value; continue; }
        // Percent reserves keep the larger floor; the reset-imminent waiver keeps the smaller window.
        (out as Record<string, number>)[field] = field === 'routingSessionResetImminentMs'
            ? Math.min(existing, value) : Math.max(existing, value);
    }
    return out;
}

/**
 * The three legacy per-mesh policy fields this module replaced, mapped to
 * their machine-reserve names. Declared HERE (the single source) so the mesh
 * config writer/migrator can detect and move them without repeating the
 * literals — scripts/check-quota-reserve-single-source.mjs enforces that.
 */
export const LEGACY_MESH_RESERVE_FIELDS = {
    sessionMinRemainingPercent: 'routingSessionMinPercent',
    weeklyMinRemainingPercent: 'routingLongMinPercent',
    sessionResetImminentMs: 'routingSessionResetImminentMs',
} as const satisfies Record<string, keyof QuotaReservePolicy>;

/** Legacy assistant-review constant name, kept only so the gate can name it. */
export const LEGACY_ASSISTANT_REVIEW_FIELD = 'minQuotaRemainingPct';

/** Cap for the node-facts copy (design §3: ≤ 2 KB). Oversized → omitted (defaults). */
export const QUOTA_RESERVE_FACTS_MAX_BYTES = 2048;

/** The value a node ships in its facts bundle: stored reserve minus the migration audit trail. */
export function quotaReserveForFacts(raw: unknown): QuotaReserveConfig | undefined {
    const config = coerceQuotaReserve(raw);
    if (!config) return undefined;
    const { migration: _migration, ...rest } = config;
    // Oversize: shed the most specific layer first, so what survives is still
    // the more conservative-to-broad interpretation rather than all-defaults.
    for (const shed of [null, 'accounts', 'pools'] as const) {
        if (shed) delete rest[shed];
        if (!rest.defaults && !rest.pools && !rest.accounts) return undefined;
        if (JSON.stringify(rest).length <= QUOTA_RESERVE_FACTS_MAX_BYTES) return rest;
    }
    return undefined;
}
