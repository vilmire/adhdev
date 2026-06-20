import { createRequire } from 'module';
import type BetterSqlite3 from 'better-sqlite3';

let cached: typeof BetterSqlite3 | undefined;

/**
 * Load the `better-sqlite3` constructor in a way that survives every runtime the
 * daemon ships in.
 *
 * The naive `typeof require === 'function' ? require : createRequire(import.meta.url)`
 * is unsafe inside the daemon-cloud bundle: esbuild emits CJS output but, for any
 * chunk that touches `import.meta.url`, it shims the local `require` with a stub
 * that THROWS `Dynamic require of "..." is not supported`. That stub is still
 * `typeof === 'function'`, so the ternary picks it and the call throws — it never
 * reaches the `createRequire` fallback. The failure surfaced as `mesh_send_task`
 * crashing the whole tool call instead of gracefully degrading.
 *
 * The robust approach is to ATTEMPT the real `require` and CATCH the esbuild stub's
 * throw, then fall back to `createRequire`. We try multiple resolution bases so the
 * load works whether the code runs as:
 *   - a genuine CJS module (bare `require` works),
 *   - an esbuild CJS bundle with the throwing `require` shim (createRequire(import.meta.url)),
 *   - a pure ESM module where `require` is undefined (createRequire(import.meta.url)).
 */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
    if (cached) return cached;

    const errors: unknown[] = [];

    // 1) Real CJS require, when present and not the esbuild throwing shim.
    if (typeof require === 'function') {
        try {
            cached = require('better-sqlite3') as typeof BetterSqlite3;
            return cached;
        } catch (e) {
            // Either the esbuild "Dynamic require is not supported" shim, or a
            // genuine resolution failure. Fall through to createRequire.
            errors.push(e);
        }
    }

    // 2) createRequire anchored at this module's URL (works in ESM and in esbuild
    //    CJS bundles, where import.meta.url is rewritten to a usable value).
    try {
        const metaUrl = typeof import.meta?.url === 'string' ? import.meta.url : undefined;
        if (metaUrl) {
            cached = createRequire(metaUrl)('better-sqlite3') as typeof BetterSqlite3;
            return cached;
        }
    } catch (e) {
        errors.push(e);
    }

    // 3) Last resort: createRequire anchored at the current working directory.
    try {
        cached = createRequire(`${process.cwd()}/__adhdev_better_sqlite3_loader__.js`)(
            'better-sqlite3',
        ) as typeof BetterSqlite3;
        return cached;
    } catch (e) {
        errors.push(e);
    }

    const detail = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ');
    throw new Error(`Failed to load better-sqlite3: ${detail}`);
}
