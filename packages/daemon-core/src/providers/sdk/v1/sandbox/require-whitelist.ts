/**
 * Provider script require() whitelist.
 *
 * Provider scripts (detect_status.js, parse_session.js, the override layer
 * the v1 contract exposes, plus their _shared helpers) execute in the
 * daemon process with full Node access — see sandbox/README-design.ts for
 * the long story. Full isolation via isolated-vm has a real perf cost and
 * a real marshalling-complexity cost, so we instead constrain the most
 * dangerous attack surface: what a provider script can `require()`.
 *
 * The hook wraps Node's CJS `Module._load` and, when the calling file is
 * inside a directory that this loader has registered as a provider script
 * root, blocks every module that isn't on the allowlist below. Relative
 * paths are allowed but only when they resolve back inside the same
 * provider root — providers can require their sibling helpers but they
 * can't reach `../../../../etc/passwd` through a clever segment.
 *
 * The hook installs exactly once per process; subsequent `register()` /
 * `unregister()` calls just adjust the set of roots that are gated.
 *
 * Performance: the hook adds one `path.normalize` + one Set lookup to
 * every require call coming from a registered root. At the measured
 * baseline (~6 script invocations / second / session, each making
 * ≤1 require during initial module evaluation, zero during steady-state
 * calls), this is unmeasurable.
 */

import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as nodeFs from 'node:fs';
import * as nodeChildProcess from 'node:child_process';
import { LOG } from '../../../../logging/logger.js';

/**
 * Standard library modules a provider script may import unchanged.
 * Each entry is bare ("crypto") and node-prefixed ("node:crypto") so
 * both spellings work; production scripts use a mix of the two.
 *
 * Anything that touches the network, the process tree, or the V8 isolate
 * is intentionally absent. fs and child_process are NOT here; they're
 * exposed via the shims further down with a reduced surface.
 */
const SAFE_STDLIB = new Set<string>([
    'path', 'os', 'util', 'url', 'querystring', 'buffer',
    'events', 'stream', 'string_decoder', 'assert',
    'crypto', 'timers', 'punycode', 'zlib',
]);

/**
 * Standard library modules that need a shim — we expose a deliberately
 * narrowed surface and trap everything else.
 */
const SHIMMED_STDLIB = new Set<string>(['fs', 'child_process', 'process']);

const ALL_GATED_STDLIB = new Set<string>([
    ...SAFE_STDLIB,
    ...SHIMMED_STDLIB,
]);

/** Strip an optional `node:` prefix for bookkeeping. */
function normalizeModuleName(request: string): string {
    return request.startsWith('node:') ? request.slice(5) : request;
}

// ─── fs shim — read-only surface ────────────────────────────────────────────

/**
 * The set of `fs` members provider scripts are allowed to call. Each is
 * a read-only operation on the local filesystem. Anything that writes,
 * deletes, opens for write, or alters file metadata is omitted.
 *
 * We expose the *real* function reference so behavior is identical to
 * `require('fs')` for the operations that do pass — including streaming
 * iterators, error semantics, and {withFileTypes}-style overloads.
 */
const FS_READ_ONLY_MEMBERS = [
    'existsSync', 'statSync', 'lstatSync', 'realpathSync',
    'readFileSync', 'readdirSync', 'readlinkSync',
    'accessSync', 'constants',
    // Async equivalents — same read-only set.
    'exists', 'stat', 'lstat', 'realpath',
    'readFile', 'readdir', 'readlink', 'access',
    // Allow `fs.promises.{readFile,...}` for the modern async style.
    'promises',
] as const;

const FS_PROMISES_READ_ONLY_MEMBERS = [
    'stat', 'lstat', 'realpath', 'readFile', 'readdir', 'readlink', 'access',
] as const;

function buildFsShim(): typeof nodeFs {
    const shim: any = {};
    for (const key of FS_READ_ONLY_MEMBERS) {
        if (key === 'promises') continue; // handled below
        const real = (nodeFs as any)[key];
        if (real !== undefined) shim[key] = real;
    }
    // Re-build a minimal `promises` namespace so destructuring works.
    const realPromises = (nodeFs as any).promises || {};
    const promisesShim: any = {};
    for (const key of FS_PROMISES_READ_ONLY_MEMBERS) {
        const real = realPromises[key];
        if (real !== undefined) promisesShim[key] = real;
    }
    shim.promises = promisesShim;
    return shim as typeof nodeFs;
}

const FS_SHIM = Object.freeze(buildFsShim());

// ─── child_process shim — execFileSync only ─────────────────────────────────

interface NarrowedExecFileSyncOptions {
    cwd?: string;
    timeout?: number;
    encoding?: BufferEncoding | 'buffer';
    maxBuffer?: number;
    input?: string | Buffer | NodeJS.ArrayBufferView;
}

/**
 * `child_process.execFileSync(file, args, opts)` wrapper that strips
 * every option a provider script has no business setting — most
 * importantly `shell`, which would otherwise re-introduce arbitrary
 * command injection. `args` must be a string array; `file` is a
 * single binary name or absolute path; `opts` is narrowed to the
 * fields below.
 *
 * `spawn`, `exec`, `execSync`, `fork` are intentionally absent from
 * the shim. Providers that need them should ship a daemon-side
 * capability instead of running raw subprocesses out of their script.
 */
function shimmedExecFileSync(
    file: unknown,
    args?: unknown,
    options?: unknown,
): Buffer | string {
    if (typeof file !== 'string' || file.length === 0) {
        throw new TypeError('execFileSync: `file` must be a non-empty string');
    }
    let safeArgs: string[] = [];
    if (args !== undefined && args !== null) {
        if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
            throw new TypeError('execFileSync: `args` must be a string[] (no shell expansion).');
        }
        safeArgs = args as string[];
    }
    const safeOpts: NarrowedExecFileSyncOptions = {};
    if (options && typeof options === 'object') {
        const o = options as Record<string, unknown>;
        if (typeof o.cwd === 'string') safeOpts.cwd = o.cwd;
        if (typeof o.timeout === 'number') safeOpts.timeout = o.timeout;
        if (typeof o.encoding === 'string') safeOpts.encoding = o.encoding as BufferEncoding;
        if (typeof o.maxBuffer === 'number') safeOpts.maxBuffer = o.maxBuffer;
        if (typeof o.input === 'string' || o.input instanceof Buffer) {
            safeOpts.input = o.input as any;
        }
        // shell / env / uid / gid / detached / windowsHide / killSignal — all dropped.
    }
    return nodeChildProcess.execFileSync(file, safeArgs, safeOpts as any);
}

const CHILD_PROCESS_SHIM = Object.freeze({
    execFileSync: shimmedExecFileSync,
});

// ─── process shim — block lifecycle/abort/native bridges ────────────────────

/**
 * The methods on `globalThis.process` that a provider script must NEVER be
 * able to call. `exit`/`kill`/`abort` would terminate the daemon; `binding`
 * and `dlopen` are escape hatches that re-introduce arbitrary native code
 * (the whole reason the require() whitelist exists in the first place).
 */
const DANGEROUS_PROCESS_METHODS = new Set<string>([
    'exit', 'kill', 'abort', 'binding', 'dlopen', '_kill', '_exit',
    'reallyExit', '_fatalException',
]);

let _processGloballyHardened = false;
let _originalProcessMethods: Map<string, unknown> | null = null;

/**
 * Decide whether the current call stack passes through a registered provider
 * script root. We use `new Error().stack` (cheaper than `Error.captureStackTrace`
 * for hot paths because we never need a frame object). The stack string format
 * is `at <fn> (<filename>:line:col)` per frame; we scan for any registered
 * provider root substring. This is best-effort: a determined attacker who
 * controls a non-provider module loaded BY a provider could escape this, but
 * the require() whitelist already prevents loading such modules.
 */
function callStackTouchesProviderRoot(): boolean {
    if (_gatedRoots.length === 0) return false;
    const stack = new Error().stack || '';
    for (const root of _gatedRoots) {
        if (stack.includes(root.rootPath)) return true;
    }
    return false;
}

/**
 * Wrap `globalThis.process` methods so calls from provider script stacks
 * throw, while every other caller (daemon-core itself, npm deps, the test
 * harness) goes through untouched.
 *
 * Trade-off: this is a stack-introspection check on every call to the
 * affected methods. The methods in question (exit/kill/abort/binding/dlopen)
 * are not hot paths — they're either never called or called once at
 * shutdown. The cost is negligible.
 *
 * Alternative considered: wrap only the module-scope `process` binding via
 * Module._extensions. Node's ESM/CJS semantics make this unreliable across
 * dynamic-require paths. Stack introspection is uglier but correct.
 *
 * Caveat: a provider script that grabs `globalThis.process.exit` once and
 * passes the reference to a non-provider callback can still escape — the
 * stack at the actual call site no longer goes through provider code. We
 * accept this gap; the threat model assumes scripts are not actively
 * trying to launder calls through arbitrary daemon callbacks, just that
 * a naive `process.exit(0)` should not silently terminate the daemon.
 */
export function installProviderProcessShim(): void {
    if (_processGloballyHardened) return;
    _processGloballyHardened = true;
    const proc = globalThis.process as unknown as Record<string, unknown>;
    if (!proc) return;
    _originalProcessMethods = new Map();
    for (const name of DANGEROUS_PROCESS_METHODS) {
        const original = proc[name];
        if (typeof original !== 'function') continue;
        _originalProcessMethods.set(name, original);
        const wrapped = function gatedProcessMethod(this: unknown, ...args: unknown[]): unknown {
            if (callStackTouchesProviderRoot()) {
                const err: any = new Error(
                    `process.${name}() denied: provider scripts cannot terminate, signal, or extend the daemon process.`,
                );
                err.code = 'PROVIDER_PROCESS_DENIED';
                err.method = name;
                throw err;
            }
            return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
        try {
            // Preserve `.name` for stack traces / debugging tools.
            Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
            proc[name] = wrapped;
        } catch {
            // Some Node builds mark certain process.* members non-writable.
            // Skip silently; the require('process') gate still applies.
        }
    }
}

/** For tests — restore the original process.* methods. */
export function _uninstallProviderProcessShimForTest(): void {
    if (!_originalProcessMethods) {
        _processGloballyHardened = false;
        return;
    }
    const proc = globalThis.process as unknown as Record<string, unknown>;
    for (const [name, original] of _originalProcessMethods) {
        try { proc[name] = original; } catch { /* noop */ }
    }
    _originalProcessMethods = null;
    _processGloballyHardened = false;
}

/**
 * Build the `process` shim returned to provider scripts that do
 * `require('process')`. Same surface as `globalThis.process` minus the
 * dangerous methods, which are replaced with throwers regardless of caller
 * (because they got here via the whitelist — caller is definitively a
 * provider script).
 */
function buildProcessShim(): NodeJS.Process {
    const real = globalThis.process;
    const shim: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(real) as Array<keyof NodeJS.Process>) {
        if (DANGEROUS_PROCESS_METHODS.has(String(key))) continue;
        try { shim[key as string] = (real as any)[key]; } catch { /* noop */ }
    }
    for (const name of DANGEROUS_PROCESS_METHODS) {
        shim[name] = function blockedProcessMethod(): never {
            const err: any = new Error(
                `process.${name}() denied via require('process'): provider scripts cannot terminate, signal, or extend the daemon.`,
            );
            err.code = 'PROVIDER_PROCESS_DENIED';
            err.method = name;
            throw err;
        };
    }
    return Object.freeze(shim) as unknown as NodeJS.Process;
}

const PROCESS_SHIM = buildProcessShim();

// ─── Hook installation ─────────────────────────────────────────────────────

interface GatedRoot {
    /** Normalized, realpath-resolved absolute path. */
    rootPath: string;
}

const _gatedRoots: GatedRoot[] = [];
let _installed = false;

/**
 * Register a directory whose `.js` files should be subject to the
 * whitelist when they call require(). Idempotent — repeated registration
 * of the same root is a no-op. Pass the same string back to
 * `unregisterProviderScriptRoot` to remove it.
 */
export function registerProviderScriptRoot(absRoot: string): void {
    const normalized = canonicalize(absRoot);
    if (!normalized) return;
    if (_gatedRoots.some((g) => g.rootPath === normalized)) return;
    _gatedRoots.push({ rootPath: normalized });
    ensureInstalled();
}

/** Inverse of registerProviderScriptRoot. */
export function unregisterProviderScriptRoot(absRoot: string): void {
    const normalized = canonicalize(absRoot);
    if (!normalized) return;
    const idx = _gatedRoots.findIndex((g) => g.rootPath === normalized);
    if (idx >= 0) _gatedRoots.splice(idx, 1);
}

/** For tests — drop every registration and reset internal state. */
export function _resetProviderScriptRoots(): void {
    _gatedRoots.length = 0;
}

/** For tests — peek at the gated root list. */
export function _getRegisteredRoots(): readonly string[] {
    return _gatedRoots.map((g) => g.rootPath);
}

function canonicalize(p: string): string | null {
    try {
        const resolved = path.resolve(p);
        try {
            return nodeFs.realpathSync.native
                ? nodeFs.realpathSync.native(resolved)
                : nodeFs.realpathSync(resolved);
        } catch {
            // Root may not exist yet (e.g. external dir created lazily);
            // we still register the resolved path so future requires from
            // inside are gated once the directory shows up.
            return resolved;
        }
    } catch {
        return null;
    }
}

function isCallerInsideGatedRoot(callerFilename: string): GatedRoot | null {
    if (!callerFilename) return null;
    let normalized: string;
    try { normalized = canonicalize(callerFilename) || callerFilename; } catch { normalized = callerFilename; }
    for (const root of _gatedRoots) {
        if (normalized === root.rootPath) return root;
        if (normalized.startsWith(root.rootPath + path.sep)) return root;
    }
    return null;
}

/**
 * Wrap Module._load exactly once. Subsequent calls to register/unregister
 * just adjust the set of roots — the hook itself stays installed.
 */
function ensureInstalled(): void {
    if (_installed) return;
    _installed = true;

    // CJS-only hook. ESM provider scripts are not currently supported
    // (everything in adhdev-providers/ is CJS), so we don't need a
    // matching `module.register()` ESM loader. If/when we accept ESM
    // provider scripts, this hook becomes a no-op for them and we'll
    // need to extend it.
    const Module = require('module') as any;
    const originalLoad = Module._load as (
        request: string,
        parent: NodeJS.Module | null,
        isMain: boolean,
    ) => unknown;

    Module._load = function gatedLoad(
        this: unknown,
        request: string,
        parent: NodeJS.Module | null,
        isMain: boolean,
    ): unknown {
        const callerFilename = parent?.filename || '';
        const gated = isCallerInsideGatedRoot(callerFilename);
        if (!gated) {
            // Caller is not provider code — bypass the gate entirely so
            // daemon-core, vendored npm modules, etc. work as before.
            return originalLoad.call(this, request, parent, isMain);
        }
        return gatedRequire.call(this, request, parent, isMain, gated, originalLoad);
    };
}

/**
 * The actual gate. Runs only when the caller lives inside a registered
 * provider script root. `this` is forwarded from Module._load so
 * delegating to originalLoad mirrors Node's own semantics.
 */
function gatedRequire(
    this: unknown,
    request: string,
    parent: NodeJS.Module | null,
    isMain: boolean,
    gated: GatedRoot,
    originalLoad: (this: unknown, request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown,
): unknown {
    // 1. Relative imports — must stay inside the same provider root.
    if (request.startsWith('./') || request.startsWith('../') || path.isAbsolute(request)) {
        let resolved: string;
        try {
            // Reuse the caller's require to mirror Node's resolution rules.
            const callerRequire = parent?.filename ? createRequire(parent.filename) : createRequire(path.join(gated.rootPath, '__entry__.js'));
            resolved = callerRequire.resolve(request);
        } catch {
            // Fall through to the regular loader; it will throw the
            // standard MODULE_NOT_FOUND with the same path Node would.
            return originalLoad.call(this, request, parent, isMain);
        }
        const resolvedCanon = canonicalize(resolved) || resolved;
        if (!(resolvedCanon === gated.rootPath || resolvedCanon.startsWith(gated.rootPath + path.sep))) {
            denyRequire(request, parent, `relative path escapes provider root (resolved to ${resolvedCanon})`);
        }
        // Inside the root — let it through. The hook will gate any
        // subsequent require() calls made by the loaded file too.
        return originalLoad.call(this, request, parent, isMain);
    }

    // 2. Bare specifier — only the stdlib subset is allowed.
    const normalized = normalizeModuleName(request);
    if (!ALL_GATED_STDLIB.has(normalized)) {
        denyRequire(request, parent, 'module not on the provider script whitelist');
    }
    if (normalized === 'fs') return FS_SHIM;
    if (normalized === 'child_process') return CHILD_PROCESS_SHIM;
    if (normalized === 'process') return PROCESS_SHIM;
    // SAFE_STDLIB — pass through.
    return originalLoad.call(this, request, parent, isMain);
}

function denyRequire(request: string, parent: NodeJS.Module | null, reason: string): never {
    const caller = parent?.filename || '<unknown>';
    const message = `Provider script require('${request}') denied: ${reason}. Caller: ${caller}`;
    LOG.warn('ProviderScript', `[require-whitelist] ${message}`);
    const err: any = new Error(message);
    err.code = 'PROVIDER_REQUIRE_DENIED';
    err.deniedModule = request;
    err.callerFilename = caller;
    throw err;
}

/**
 * Public re-exports — registry consumers want to know what's on the
 * allowlist without parsing this file.
 */
export const PROVIDER_REQUIRE_POLICY = Object.freeze({
    safeStdlib: Array.from(SAFE_STDLIB).sort(),
    shimmedStdlib: Array.from(SHIMMED_STDLIB).sort(),
    fsAllowedMembers: Array.from(FS_READ_ONLY_MEMBERS),
    childProcessAllowedMembers: ['execFileSync'],
    processDeniedMembers: Array.from(DANGEROUS_PROCESS_METHODS).sort(),
});
