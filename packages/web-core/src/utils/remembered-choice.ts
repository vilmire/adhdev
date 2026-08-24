/**
 * remembered-choice — browser-local "last used selection" storage for launch
 * dialogs and forms.
 *
 * A scope maps to one localStorage key (`adhdev.remember.<scope>`) holding a
 * flat string→string record of the choices the user last committed (e.g. on a
 * successful launch). On the next open the dialog reads the record and
 * preselects matching options.
 *
 * Design principle (the reason this stays untangled):
 * - **Apply a stored value ONLY when it exists in the currently available
 *   option list; otherwise silently ignore it and keep the default.** The
 *   store is a hint, never a contract — a machine that went offline, a
 *   provider that was uninstalled, or a deleted mesh must degrade to the
 *   plain default without any error surface. This fail-open rule is what
 *   prevents stale browser state from wedging the dialog.
 * - Values are written only on a successful commit (launch/create), never on
 *   every keystroke, so the store always describes a selection that actually
 *   worked at least once.
 * - Storage failures (Safari private mode, quota, disabled storage) are
 *   swallowed: reads return null, writes are no-ops. The feature simply
 *   disappears in such environments.
 */

const STORAGE_KEY_PREFIX = 'adhdev.remember.'

function storageKeyFor(scope: string): string {
    return `${STORAGE_KEY_PREFIX}${scope.trim()}`
}

/**
 * Read the remembered values for a scope.
 *
 * Returns `null` when there is nothing stored, storage is unavailable, or the
 * stored JSON is broken/not an object. Non-string values inside a stored
 * record are dropped; a record with no string entries left is reported as
 * `null`. Callers must still validate each value against the current option
 * list before applying it (see the fail-open principle above).
 */
export function readRememberedChoice(scope: string): Record<string, string> | null {
    if (typeof window === 'undefined' || !scope.trim()) return null
    try {
        const raw = window.localStorage.getItem(storageKeyFor(scope))
        if (!raw) return null
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        const values: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'string' && value) values[key] = value
        }
        return Object.keys(values).length > 0 ? values : null
    } catch {
        return null
    }
}

/**
 * Overwrite the remembered values for a scope.
 *
 * Empty-string values are pruned on write (an empty selection means "provider
 * default" and needs no memory), so call sites can pass their raw state
 * without pre-filtering. Writing a record that prunes down to nothing clears
 * the scope entirely. All storage errors are swallowed.
 */
export function writeRememberedChoice(scope: string, values: Record<string, string>): void {
    if (typeof window === 'undefined' || !scope.trim()) return
    try {
        const pruned: Record<string, string> = {}
        for (const [key, value] of Object.entries(values)) {
            if (typeof value === 'string' && value) pruned[key] = value
        }
        if (Object.keys(pruned).length === 0) {
            window.localStorage.removeItem(storageKeyFor(scope))
            return
        }
        window.localStorage.setItem(storageKeyFor(scope), JSON.stringify(pruned))
    } catch {
        /* noop — storage unavailable (private mode, quota, disabled) */
    }
}
