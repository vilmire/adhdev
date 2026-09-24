// ---------------------------------------------------------------------------
// turn-ledger/policy — the 9 turn timing constants (from 28) + env resolution
// ---------------------------------------------------------------------------
// Wiring-unification Phase C1. Every turn/delivery deadline the reconcile,
// live-gate, acked-hold and stranded-dispatch modules used to own is one of
// these eight values or derived from them (derived values are never stored,
// so e.g. "the hold TTL must outlast the quiet window" is arithmetic, not a
// test). Pure: `resolveTurnPolicy` takes the env as an argument.
//
// Env names: canonical `ADHDEV_TURN_*_MS`; the legacy reconcile/in-flight names
// are kept as aliases (canonical wins). The legacy names are MAPPED here, not
// imported — mesh-reconcile-config / mesh-reconcile-acked-hold are deleted in C.
// ---------------------------------------------------------------------------

import type { ConsumeProfile } from '@adhdev/mesh-shared';

export interface TurnPolicy {
    /** Scheduler tick (was DEFAULT_RECONCILE_INTERVAL_MS). */
    tickMs: number;
    /** Transcript quiet window (was TRANSCRIPT_QUIET_RELEASE / TERMINAL_FALLBACK_QUIET / ASSIGNED_IDLE_TRANSCRIPT_COMPLETE). */
    quietWindowMs: number;
    /** Delivered-but-not-consumed grace (was CONSUME_GRACE_FLOOR; native-source profile × 2). */
    consumeGraceMs: number;
    /** Delivery ceiling (was PENDING_HELD_CEILING / DISPATCH_CONFIRM_TIMEOUT / STRICT_SESSION_MATCH_TTL 60→120 s). */
    deliveryCeilingMs: number;
    /** Liveness deadline (was ACKED death deadline / NATIVE_SOURCE_ACTIVITY_STALE 600→480 s / stall refire 600→480 s). */
    livenessDeadlineMs: number;
    /** Delivered-no-turn deadline (was DELIVERED_NO_TURN_DEADLINE). */
    noTurnDeadlineMs: number;
    /** Worker stall notice (was MESH_WORKER_STALL_IDLE_THRESHOLD; turn-active threshold = 2×). */
    stallNoticeMs: number;
    /** Hard ceiling (was QUEUE_HOLD_HARD_DEADLINE / ACKED_HOLD_HARD_CEILING). */
    hardCeilingMs: number;
    /**
     * How long a genuine FSM end of a report-capable mesh worker waits for the
     * structured report before committing weak (R9r → R13r; live rc.40: a Bash
     * tool call showed an idle screen 37 s into a 4-minute turn). Added 2026-09-24.
     *
     * Raised 180s → 600s the same day (live run 6 on rc.41): a claude-cli
     * worker's Bash tool slept 240s; the false-idle opened the hold at +43s,
     * the OLD 180s ceiling expired it at +223s — 43s before the worker even
     * resumed (the busy-edge R12r transition never got a chance to fire) and
     * 48s before its report, so the report landed late against an
     * already-weak-committed turn. Multi-minute tool calls are normal, and the
     * hold only ever engages for a session with a live worker-MCP bind (a
     * reportless session never enters await_report at all — see R9r), so a
     * longer default costs nothing on the common path.
     */
    awaitReportMs: number;
    /**
     * Liveness re-arm cadence while an `await_report` hold is open (2026-09-24,
     * preview rc.43 run 10): H4/R32u normally re-arm the `liveness` hold at
     * `unknownLivenessGraceMs` (3×tick = 12 s) after each expiry, which is a
     * remote transcript probe every 12 s. That is fine in `generating` — the
     * probe is how a dead worker is detected — but once the false-idle gate has
     * opened `await_report` the attempt already has its own 600 s deadline
     * (R13r commits weak when it expires), so re-probing every 12 s for the
     * whole window is a liveness-probe storm with nothing new to learn (run 10:
     * 11 probes in 2 min, same `finalizing` attempt, same worker). The liveness
     * hold still re-arms while `await_report` is held — a genuinely dead worker
     * must still be caught — just at this slower cadence instead.
     */
    livenessProbeIntervalFinalizingMs: number;
}

export const DEFAULT_TURN_POLICY: Readonly<TurnPolicy> = Object.freeze({
    tickMs: 4_000,
    quietWindowMs: 8_000,
    consumeGraceMs: 90_000,
    deliveryCeilingMs: 120_000,
    livenessDeadlineMs: 480_000,
    noTurnDeadlineMs: 900_000,
    stallNoticeMs: 180_000,
    hardCeilingMs: 5_400_000,
    awaitReportMs: 600_000,
    livenessProbeIntervalFinalizingMs: 60_000,
});

/** Budgets (counts, not times) — deliberately not env-tunable. */
export const RECLAIM_BUDGET = 3;                 // was MAX_STRANDED_RECLAIMS
export const MAX_REDRIVES_PER_GENERATION = 1;    // was MAX_REDRIVES_PER_ATTEMPT
export const LIVENESS_FAIL_STREAK_LIMIT = 3;     // was ACKED_DEATH_CONSECUTIVE_READ_FAILURES
export const DEFAULT_MAX_TASK_RETRIES = 1;       // mesh policy maxTaskRetries default

// ─── derived values (never stored) ───────────────────────────────────────

/** TTL of live_pending / transcript_quiet holds, and the weak-candidate confirm window. */
export function holdTtlMs(p: TurnPolicy): number { return Math.round(1.5 * p.quietWindowMs); }
export function weakConfirmMs(p: TurnPolicy): number { return Math.round(1.5 * p.quietWindowMs); }
/** Grace after a liveness probe answers `unknown` (was RECLAIM_UNKNOWN_GRACE_TICKS × tick). */
export function unknownLivenessGraceMs(p: TurnPolicy): number { return 3 * p.tickMs; }
/**
 * Liveness re-arm interval after H4/R32u: the normal cadence (`unknown_grace`,
 * 3×tick) everywhere, except while an `await_report` hold is open, where the
 * probe backs off to `livenessProbeIntervalFinalizingMs` — never faster than
 * the normal cadence, so a policy misconfigured below it cannot make things
 * worse.
 */
export function livenessReArmMs(p: TurnPolicy, awaitReportHeld: boolean): number {
    const normal = unknownLivenessGraceMs(p);
    return awaitReportHeld ? Math.max(normal, p.livenessProbeIntervalFinalizingMs) : normal;
}
/** Accepted-but-never-delivered deadline (stranded-unconfirmed 300→240 s). */
export function awaitDeliveryMs(p: TurnPolicy): number { return 2 * p.deliveryCeilingMs; }
/** Max age of a transcript read that may still be treated as authoritative. */
export function authoritativeTranscriptAgeMs(p: TurnPolicy): number { return Math.round(p.deliveryCeilingMs / 2); }
export function consumeGraceFor(p: TurnPolicy, profile: ConsumeProfile): number {
    return profile === 'native_source' ? 2 * p.consumeGraceMs : p.consumeGraceMs;
}
export function stallTurnActiveThresholdMs(p: TurnPolicy): number { return 2 * p.stallNoticeMs; }

// ─── env resolution ──────────────────────────────────────────────────────

interface EnvBinding {
    field: keyof TurnPolicy;
    canonical: string;
    /** Legacy names, in precedence order, each with its historical clamp. */
    aliases: ReadonlyArray<{ name: string; min: number; max: number }>;
    min: number;
    max: number;
}

const HOUR = 60 * 60_000;

/**
 * Canonical clamps have a 0 (or near-0) floor so tests can force a deadline;
 * the ceilings stop a mis-set env from disabling a loss-net forever. Alias
 * clamps are the ones the legacy resolvers applied (mesh-reconcile-config.ts,
 * mesh-reconcile-acked-hold.ts), so an existing deployment's env keeps meaning
 * exactly what it meant.
 */
export const TURN_POLICY_ENV_BINDINGS: readonly EnvBinding[] = [
    { field: 'tickMs', canonical: 'ADHDEV_TURN_TICK_MS', min: 100, max: 60_000,
      aliases: [{ name: 'MESH_RECONCILE_INTERVAL_MS', min: 1_000, max: 60_000 }] },
    { field: 'quietWindowMs', canonical: 'ADHDEV_TURN_QUIET_WINDOW_MS', min: 0, max: 10 * 60_000, aliases: [] },
    { field: 'consumeGraceMs', canonical: 'ADHDEV_TURN_CONSUME_GRACE_MS', min: 0, max: HOUR, aliases: [] },
    { field: 'deliveryCeilingMs', canonical: 'ADHDEV_TURN_DELIVERY_CEILING_MS', min: 0, max: HOUR,
      aliases: [{ name: 'MESH_PENDING_HELD_CEILING_MS', min: 12_000, max: 30 * 60_000 }] },
    { field: 'livenessDeadlineMs', canonical: 'ADHDEV_TURN_LIVENESS_DEADLINE_MS', min: 0, max: HOUR,
      aliases: [{ name: 'MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS', min: 0, max: HOUR }] },
    { field: 'noTurnDeadlineMs', canonical: 'ADHDEV_TURN_NO_TURN_DEADLINE_MS', min: 0, max: 6 * HOUR, aliases: [] },
    { field: 'stallNoticeMs', canonical: 'ADHDEV_TURN_STALL_NOTICE_MS', min: 0, max: HOUR, aliases: [] },
    { field: 'hardCeilingMs', canonical: 'ADHDEV_TURN_HARD_CEILING_MS', min: 0, max: 24 * HOUR,
      aliases: [{ name: 'MESH_INFLIGHT_ACKED_HOLD_HARD_CEILING_MS', min: 0, max: 24 * HOUR }] },
    { field: 'awaitReportMs', canonical: 'ADHDEV_TURN_AWAIT_REPORT_MS', min: 0, max: HOUR, aliases: [] },
    { field: 'livenessProbeIntervalFinalizingMs', canonical: 'ADHDEV_TURN_LIVENESS_PROBE_INTERVAL_FINALIZING_MS', min: 0, max: HOUR, aliases: [] },
];

/**
 * Legacy env names that are intentionally NOT aliased: their mechanism is
 * gone, not renamed. Listed so the resolver can report them.
 *   MESH_PENDING_HELD_DRAIN_ESCALATE_MS — the 12 s escalate step is deleted (C2 deferral).
 *   MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS — fast-track is the weak_candidate hold (1.5 × quiet window).
 */
export const RETIRED_TURN_ENV_NAMES = [
    'MESH_PENDING_HELD_DRAIN_ESCALATE_MS',
    'MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS',
] as const;

export type TurnEnv = Readonly<Record<string, string | undefined>>;

function readClamped(env: TurnEnv, name: string, min: number, max: number): number | null {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
    return parsed;
}

export interface ResolvedTurnPolicy {
    policy: TurnPolicy;
    /** Which env name supplied each overridden field. */
    sources: Partial<Record<keyof TurnPolicy, string>>;
    /** Retired names present in the env (ignored). */
    ignored: string[];
}

export function resolveTurnPolicyDetailed(env: TurnEnv): ResolvedTurnPolicy {
    const policy: TurnPolicy = { ...DEFAULT_TURN_POLICY };
    const sources: Partial<Record<keyof TurnPolicy, string>> = {};
    for (const binding of TURN_POLICY_ENV_BINDINGS) {
        const canonical = readClamped(env, binding.canonical, binding.min, binding.max);
        if (canonical !== null) {
            policy[binding.field] = canonical;
            sources[binding.field] = binding.canonical;
            continue;
        }
        for (const alias of binding.aliases) {
            const value = readClamped(env, alias.name, alias.min, alias.max);
            if (value !== null) {
                policy[binding.field] = value;
                sources[binding.field] = alias.name;
                break;
            }
        }
    }
    const ignored = RETIRED_TURN_ENV_NAMES.filter((name) => typeof env[name] === 'string' && env[name]!.trim() !== '');
    return { policy, sources, ignored: [...ignored] };
}

export function resolveTurnPolicy(env: TurnEnv): TurnPolicy {
    return resolveTurnPolicyDetailed(env).policy;
}
