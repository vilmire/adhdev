/**
 * Daemon-scoped env/flag override persistence.
 *
 * Feature flags such as ADHDEV_WORKER_MCP (see ../runtime-defaults.ts) are read
 * straight off `process.env` at call time — there is no mechanism for a chosen
 * value to survive a daemon restart or upgrade, since a plain relaunch starts
 * from a clean env unless something external (a shell profile, an OS service
 * unit) re-injects it. `config.json`'s `envOverrides` map fills that gap: boot
 * applies it to `process.env` once, early, so a flag set via `adhdev config env
 * set` keeps taking effect across restarts without touching the installed
 * binary or its launcher wrapper (a filesystem-hack version of this was tried
 * and rolled back — see the M-WORKER-MCP-ROLLOUT task notes).
 *
 * Scope is feature-flag persistence ONLY. Identity/secret material is
 * explicitly out of bounds: this codebase already treats env-carried identity
 * as untrustworthy because a process can set it on itself (see
 * docs/design/2026-08-28-worker-mcp.md §2.4 — `ADHDEV_COORDINATOR_SESSION_ID`
 * "must never become an authorization gate" for exactly this reason). Letting
 * this map carry token/secret-shaped keys would make that worse, not better —
 * config.json is user-editable, so it would become a second durable-secret
 * planting surface. `isSecretLikeEnvKey` rejects those outright rather than
 * merely warning.
 */

export interface EnvOverrideApplyResult {
    /** Keys actually written to `env` this call. */
    applied: Record<string, string>;
    /** Keys present in the config map but rejected as secret/identity-shaped. */
    skippedRejected: string[];
    /** Keys present in the config map but left alone because `env` already had an explicit value. */
    skippedExplicitEnv: string[];
    /** Applied keys not in the recognized-flag list (see KNOWN_FLAG_KEYS) — logged, not blocked. */
    unknownKeys: string[];
}

// Substring match against the key name — deliberately broad so it also catches
// non-ADHDEV_-prefixed keys a user might mistakenly add to the map (e.g.
// OPENAI_API_KEY). This is a deny-list, not an allow-list: it blocks the
// specific shape that is dangerous to persist (identity/secret material)
// rather than trying to enumerate every legitimate flag name in advance.
const SECRET_LIKE_KEY_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|COOKIE/i;

// Recognized daemon feature-flag keys. This is for LOG QUALITY only, never a
// gate — an unrecognized key is still applied (fail-open, per the task
// contract: the whole point of this map is that config drives the next
// restart), but flagging it in the boot log catches a typo that would
// otherwise silently do nothing.
const KNOWN_FLAG_KEYS = new Set(['ADHDEV_WORKER_MCP']);

export function isSecretLikeEnvKey(key: string): boolean {
    return SECRET_LIKE_KEY_PATTERN.test(key);
}

/**
 * Apply config-sourced env overrides to `env` (default `process.env`).
 * Explicit `env` values always win — an override only fills in a key that is
 * currently unset or empty.
 *
 * Call this as early in boot as possible, before any lazy env-flag read (e.g.
 * `isWorkerMcpEnabled()`) — it only affects reads that happen AFTER this call
 * runs. It cannot retroactively change a module-load-time top-level constant
 * that some earlier import already evaluated from `process.env` (see
 * `MESH_CONNECT_TIMEOUT_MS` in runtime-defaults.ts for an example of that
 * shape); this mechanism is for lazily-read flags, which is what every
 * feature-flag-style toggle in this codebase currently is.
 */
export function applyDaemonEnvOverrides(
    overrides: Record<string, string> | undefined,
    env: NodeJS.ProcessEnv = process.env,
    logFn: (msg: string) => void = () => {},
): EnvOverrideApplyResult {
    const result: EnvOverrideApplyResult = {
        applied: {},
        skippedRejected: [],
        skippedExplicitEnv: [],
        unknownKeys: [],
    };
    if (!overrides) return result;

    for (const [key, value] of Object.entries(overrides)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (typeof value !== 'string') continue;

        if (isSecretLikeEnvKey(key)) {
            result.skippedRejected.push(key);
            logFn(`rejected secret-shaped key "${key}" from config.envOverrides — identity/secret persistence is out of scope for this map`);
            continue;
        }

        if (typeof env[key] === 'string' && env[key] !== '') {
            result.skippedExplicitEnv.push(key);
            continue;
        }

        if (!KNOWN_FLAG_KEYS.has(key)) {
            result.unknownKeys.push(key);
            logFn(`applying unrecognized key "${key}" from config.envOverrides — verify spelling if this doesn't take effect`);
        }

        env[key] = value;
        result.applied[key] = value;
    }

    return result;
}
