/**
 * Spec-driven STARTUP modal dismissal (OPENCODE-UPDATE-MODAL class).
 *
 * Some CLIs open a boot-time prompt that hijacks the composer before the
 * first user input — e.g. opencode's "Update Available … Ask / Skip / Confirm"
 * dialog (dismissible with Esc, per its own footer hint). Such prompts are not
 * approvals (a generic approval gate would press the affirmative and, for the
 * update dialog, run the upgrade), and providers like opencode expose no CLI
 * flag/env to suppress them — only a per-workspace config file, which ADHDev
 * must not scatter into user repos, or a user-global config it must not edit
 * without consent.
 *
 * So the provider manifest may declare `tui.startupDismiss`:
 *
 *   "startupDismiss": {
 *     "$schema": "adhdev:tui/startup-dismiss@1",
 *     "patterns": [{ "regex": "Update Available", "flags": "i" }],
 *     "key": "",
 *     "maxAttempts": 3,
 *     "windowMs": 20000
 *   }
 *
 * The adapter consults decideStartupDismiss on each screen-snapshot change and
 * writes `key` when it fires. Bounded by construction: only within windowMs of
 * spawn, at most maxAttempts writes, and never twice for the same snapshot —
 * a prompt that survives Esc cannot turn into a key-spam loop.
 */

export interface StartupDismissConfig {
    patterns: Array<{ regex: string; flags?: string }>;
    key: string;
    maxAttempts?: number;
    windowMs?: number;
}

export interface StartupDismissState {
    attempts: number;
    lastDismissedSnapshot: string;
}

export function createStartupDismissState(): StartupDismissState {
    return { attempts: 0, lastDismissedSnapshot: '' };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WINDOW_MS = 20_000;

export function normalizeStartupDismissConfig(raw: unknown): StartupDismissConfig | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    // spec@4's `startup_dismiss` spells the bounds snake_case; the legacy
    // manifest's `tui.startupDismiss` is camelCase. One normalizer serves both.
    if (config.maxAttempts === undefined && config.max_attempts !== undefined) config.maxAttempts = config.max_attempts;
    if (config.windowMs === undefined && config.window_ms !== undefined) config.windowMs = config.window_ms;
    const key = typeof config.key === 'string' && config.key.length > 0 ? config.key : null;
    const patternsRaw = Array.isArray(config.patterns) ? config.patterns : [];
    const patterns = patternsRaw
        .map((entry) => {
            const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
            const regex = typeof record.regex === 'string' ? record.regex : '';
            const flags = typeof record.flags === 'string' ? record.flags : undefined;
            return regex ? { regex, ...(flags !== undefined ? { flags } : {}) } : null;
        })
        .filter((entry): entry is { regex: string; flags?: string } => entry !== null);
    if (!key || patterns.length === 0) return null;
    const maxAttempts = typeof config.maxAttempts === 'number' && Number.isFinite(config.maxAttempts) && config.maxAttempts > 0
        ? Math.floor(config.maxAttempts)
        : undefined;
    const windowMs = typeof config.windowMs === 'number' && Number.isFinite(config.windowMs) && config.windowMs > 0
        ? Math.floor(config.windowMs)
        : undefined;
    return { patterns, key, ...(maxAttempts !== undefined ? { maxAttempts } : {}), ...(windowMs !== undefined ? { windowMs } : {}) };
}

/**
 * Pure decision: should the adapter send the dismiss key for this snapshot?
 * Fail-closed on bad regexes (a broken pattern never types keys).
 */
export function decideStartupDismiss(
    config: StartupDismissConfig | null,
    state: StartupDismissState,
    screenSnapshot: string,
    spawnAt: number,
    now: number,
): { dismiss: boolean; matchedPattern?: string } {
    if (!config) return { dismiss: false };
    if (!screenSnapshot.trim()) return { dismiss: false };
    if (spawnAt <= 0) return { dismiss: false };
    if (now - spawnAt > (config.windowMs ?? DEFAULT_WINDOW_MS)) return { dismiss: false };
    if (state.attempts >= (config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) return { dismiss: false };
    if (screenSnapshot === state.lastDismissedSnapshot) return { dismiss: false };
    for (const pattern of config.patterns) {
        try {
            if (new RegExp(pattern.regex, pattern.flags).test(screenSnapshot)) {
                return { dismiss: true, matchedPattern: pattern.regex };
            }
        } catch {
            // fail closed — a malformed spec regex must never type keys
        }
    }
    return { dismiss: false };
}

/** Record a fired dismissal (caller writes the key). */
export function recordStartupDismiss(state: StartupDismissState, screenSnapshot: string): void {
    state.attempts += 1;
    state.lastDismissedSnapshot = screenSnapshot;
}
