/**
 * Pure model for the machine quota-reserve card: parse the daemon's
 * `quota_reserve_get` / `quota_reserve_set` answers and build the set args.
 *
 * Wire shapes mirror daemon-core `quota/quota-reserve-view.ts`; they are
 * redeclared (not imported) because web-core may only `import type` from
 * daemon-core's barrel and the view is not exported there.
 */

export type ReserveField = 'routingSessionMinPercent' | 'routingLongMinPercent' | 'routingSessionResetImminentMs' | 'assistantReviewMinPercent'
export const RESERVE_FIELDS: readonly ReserveField[] = ['routingSessionMinPercent', 'routingLongMinPercent', 'routingSessionResetImminentMs', 'assistantReviewMinPercent']

/** Code defaults, display only (placeholders). The daemon resolver is the source of truth. */
export const RESERVE_DISPLAY_DEFAULTS: Record<ReserveField, number> = {
    routingSessionMinPercent: 10,
    routingLongMinPercent: 15,
    routingSessionResetImminentMs: 5 * 60 * 1000,
    assistantReviewMinPercent: 20,
}

export type ReservePolicy = Partial<Record<ReserveField, number>>

export interface ReserveRow {
    provider: string
    pool: string | null
    poolKey: string
    accountKey: string | null
    policy: Record<ReserveField, number>
    source: Partial<Record<ReserveField, string>>
    remaining: { session: number | null; long: number | null; tightest: number | null }
    withinReserve: boolean
    withinReserveWindow: 'session' | 'long' | null
    belowAssistantReview: boolean
}

export interface ReserveRaw {
    version: 1
    defaults?: ReservePolicy
    pools?: Record<string, ReservePolicy>
    accounts?: Record<string, Record<string, ReservePolicy>>
    migration?: { at: string; fromMeshes: Array<{ meshId: string; fields: Record<string, number> }>; resolution: 'max' }
    updatedAt?: string
}

export interface ReserveView {
    raw: ReserveRaw | null
    rows: ReserveRow[]
    accounts: Record<string, string[]>
}

export type ReserveRead = { kind: 'ok'; view: ReserveView } | { kind: 'unsupported' } | { kind: 'error'; message: string }

function unwrap(answer: unknown): any {
    const a = answer as any
    // Cloud transport wraps the daemon result: { success, result: {...} }
    return a && typeof a === 'object' && a.result && typeof a.result === 'object' && !Array.isArray(a.result) ? a.result : a
}

export function parseQuotaReserveRead(answer: unknown): ReserveRead {
    const body = unwrap(answer)
    if (!body || typeof body !== 'object') return { kind: 'unsupported' }
    if (body.success === false) {
        const message = typeof body.error === 'string' ? body.error : 'error'
        return /unknown command|not supported|unsupported/i.test(message) ? { kind: 'unsupported' } : { kind: 'error', message }
    }
    if (!Array.isArray(body.rows)) return { kind: 'unsupported' }
    return {
        kind: 'ok',
        view: {
            raw: body.raw && typeof body.raw === 'object' ? body.raw as ReserveRaw : null,
            rows: body.rows as ReserveRow[],
            accounts: body.accounts && typeof body.accounts === 'object' ? body.accounts as Record<string, string[]> : {},
        },
    }
}

export function parseQuotaReserveSet(answer: unknown): { ok: true; view: ReserveView } | { ok: false; message: string } {
    const body = unwrap(answer)
    if (body?.success === false) return { ok: false, message: typeof body.error === 'string' ? body.error : 'failed' }
    const read = parseQuotaReserveRead(answer)
    return read.kind === 'ok' ? { ok: true, view: read.view } : { ok: false, message: read.kind === 'error' ? read.message : 'unsupported' }
}

/** Draft string for one input: '' = inherit. Durations show in minutes. */
export function fieldToDraft(field: ReserveField, value: number | undefined): string {
    if (value === undefined) return ''
    return String(field === 'routingSessionResetImminentMs' ? value / 60000 : value)
}

export function validateReserveDraft(field: ReserveField, raw: string): 'notANumber' | 'percentRange' | 'negative' | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return 'notANumber'
    if (field === 'routingSessionResetImminentMs') return n < 0 ? 'negative' : null
    return n < 0 || n > 100 ? 'percentRange' : null
}

/** Compose the FULL scope policy after one field edit (blank removes the override). */
export function composeScopePolicy(stored: ReservePolicy | undefined, field: ReserveField, raw: string): ReservePolicy {
    const next: ReservePolicy = { ...(stored ?? {}) }
    const trimmed = raw.trim()
    if (!trimmed) delete next[field]
    else next[field] = field === 'routingSessionResetImminentMs' ? Math.round(Number(trimmed) * 60000) : Number(trimmed)
    return next
}

export type ReserveScopeTarget =
    | { scope: 'defaults' }
    | { scope: 'pool'; key: string }
    | { scope: 'account'; key: string; accountKey: string }

export function storedPolicyFor(raw: ReserveRaw | null, target: ReserveScopeTarget): ReservePolicy | undefined {
    if (!raw) return undefined
    if (target.scope === 'defaults') return raw.defaults
    if (target.scope === 'pool') return raw.pools?.[target.key]
    return raw.accounts?.[target.accountKey]?.[target.key]
}

/** `quota_reserve_set` args: replaces the scope's fields wholesale (empty clears it). */
export function buildReserveSetArgs(target: ReserveScopeTarget, policy: ReservePolicy): Record<string, unknown> {
    return { ...target, policy, replace: true }
}

/** Last 4 of the hashed account key — never an email (reserve rows carry no PII). */
export function accountSuffix(accountKey: string): string {
    return accountKey.slice(-4)
}

/** Providers with >= 2 known accounts: the only ones the per-account override is offered for. */
export function providersWithMultipleAccounts(accounts: Record<string, string[]>): string[] {
    return Object.entries(accounts).filter(([, keys]) => keys.length >= 2).map(([provider]) => provider)
}
