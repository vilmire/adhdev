/**
 * Process-level hardening — boot-time mitigations against provider scripts.
 *
 * Provider scripts run in-process (see providers/sdk/v1/sandbox/README-design.ts).
 * The require() whitelist (sandbox/require-whitelist.ts) blocks the obvious
 * attack surfaces (no `child_process.exec`, no `fs.writeFile`, no `net`, etc.)
 * but a malicious or buggy script can still:
 *
 *   1. Pollute Object.prototype to influence the daemon's downstream consumers
 *      (e.g. `Object.prototype.toString = () => '...'` makes every untagged
 *      object stringify to that value across the whole process).
 *   2. Mutate Array/Function/String prototypes for similar effect.
 *   3. Call `process.exit()` / `process.kill()` to kill the daemon.
 *
 * Sandbox isolation (isolated-vm) is the proper fix but has a real perf cost
 * and a real marshalling-complexity cost. As a cheaper layer we just freeze
 * the built-in prototypes at boot, which is irreversible and catches every
 * prototype-pollution variant for the lifetime of the process.
 *
 * `applyProcessHardening()` is idempotent — calling it twice is a no-op the
 * second time. The function intentionally swallows any "cannot redefine
 * property" errors that would arise if some upstream code already froze
 * the same prototype: the post-condition (prototype is frozen) is satisfied
 * either way.
 *
 * Trade-offs:
 *   - Read-only access to prototype methods (`Object.prototype.hasOwnProperty.call`,
 *     `Array.prototype.slice.call`, etc.) is unaffected — only writes throw.
 *   - Some older npm libraries patch Array.prototype or Function.prototype at
 *     import time. If a daemon-core dep does this, the import will throw. The
 *     daemon-core vitest suite is the canonical regression check for this.
 *   - We deliberately do NOT freeze RegExp.prototype, Error.prototype, Map/Set
 *     prototypes, or Date.prototype because at least one of those tends to be
 *     mutated by mainstream test/runtime libs and the value of freezing them
 *     is low (no useful prototype-pollution attack surface).
 */

let _hardened = false;

/** Prototypes that get frozen at boot. */
const HARDENED_PROTOS: Array<{ name: string; proto: object }> = [
    { name: 'Object', proto: Object.prototype },
    { name: 'Array', proto: Array.prototype },
    { name: 'Function', proto: Function.prototype },
    { name: 'String', proto: String.prototype },
    { name: 'Number', proto: Number.prototype },
    { name: 'Boolean', proto: Boolean.prototype },
    { name: 'Promise', proto: Promise.prototype },
];

/**
 * Freeze the canonical built-in prototypes so provider scripts (and anything
 * else running in this process) cannot mutate them. Idempotent.
 *
 * Returns the list of prototype names that were newly frozen — primarily for
 * tests / observability. Already-frozen prototypes are not re-reported.
 */
export function applyProcessHardening(): string[] {
    if (_hardened) return [];
    _hardened = true;

    const newlyFrozen: string[] = [];
    for (const entry of HARDENED_PROTOS) {
        if (Object.isFrozen(entry.proto)) continue;
        try {
            Object.freeze(entry.proto);
            newlyFrozen.push(entry.name);
        } catch {
            // Some host/runtime combinations refuse to freeze a built-in
            // prototype (e.g. it has a non-configurable accessor). We treat
            // this as best-effort — log nothing here (logger not guaranteed
            // to be initialized this early) and move on. Subsequent reads
            // of `Object.isFrozen(proto)` will reveal the gap.
        }
    }
    return newlyFrozen;
}

/** For tests only — clears the internal "already hardened" flag. The
 *  prototypes themselves cannot be un-frozen, so this is mostly useful for
 *  testing the idempotency guard. */
export function _resetProcessHardeningForTest(): void {
    _hardened = false;
}

/** For tests only — peek at the hardened state. */
export function _isProcessHardened(): boolean {
    return _hardened;
}
