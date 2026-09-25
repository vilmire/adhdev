/**
 * Child-process helpers that default to a hidden console window on win32.
 *
 * Why this module exists: `windowsHide: true` had to be added by hand at every
 * single spawn site, and it was missed three times in a row. The OSS updater
 * was swept twice (2026-04-30 `upgrade-helper.ts`, 2026-08-29
 * `windows-atomic-upgrade.ts`) while the proprietary `packages/daemon-cloud`
 * was never swept at all — so `adhdev update` on Windows still flashed a
 * console window on every probe. The worst offender was `isDaemonRunning()`,
 * which spawns a `node -e` health probe and is called from polling loops
 * (stop-wait up to 10 iterations, start-confirm up to 8, plus the CLI's own
 * checks): twenty-plus window flashes for one update.
 *
 * The fix is to stop relying on reviewers noticing a missing option. Call these
 * wrappers instead of `node:child_process` directly and the default is correct;
 * `scripts/check-windows-hide.mjs` fails the build for any raw spawn that omits
 * the flag.
 *
 * Shape note: `windowsHide: true` is spread FIRST so `...options` can still
 * override it. A caller that genuinely wants a visible console (an inherited
 * interactive build, say) passes `windowsHide: false` explicitly, which reads
 * as a deliberate decision at the call site rather than an oversight. This
 * mirrors the two established precedents in this package — `resolveDeps()` in
 * `quota/fetchers/deps.ts` and `execQuiet()` in `launch.ts`.
 *
 * On non-win32 platforms `windowsHide` is inert, so these are safe everywhere
 * and callers need no platform branch.
 *
 * `hiddenExec`/`hiddenExecFileAsync` (2026-09-25, win32 console-flash follow-up):
 * `check-windows-hide.mjs` used to exclude bare `exec(` entirely — matching the
 * bare identifier `exec` produced far more false positives (`regex.exec(`, a
 * web-core RPC helper of the same name) than real defects. That let a genuine
 * violation ship: `providers/version-archive.ts`'s per-provider `--version`/`-V`/
 * `-v` boot probe used bare `exec` with no `windowsHide`, and after any detached
 * upgrade/restart the daemon has no console of its own, so each probe allocated
 * a fresh visible one. The gate is now import-binding-scoped instead of
 * identifier-scoped (only flags `exec`/`execFile` calls in files that actually
 * import them from `child_process`), so bare `exec`/`promisify(execFile)` calls
 * are enforceable without the old false-positive class. These two wrappers are
 * the sanctioned replacement for both shapes.
 */

import {
    exec,
    execFile,
    execFileSync,
    execSync,
    spawn,
    spawnSync,
    type ChildProcess,
    type ChildProcessWithoutNullStreams,
    type ExecException,
    type ExecFileOptions,
    type ExecFileOptionsWithBufferEncoding,
    type ExecFileOptionsWithStringEncoding,
    type ExecFileSyncOptions,
    type ExecFileSyncOptionsWithStringEncoding,
    type ExecOptions,
    type ExecOptionsWithBufferEncoding,
    type ExecOptionsWithStringEncoding,
    type ExecSyncOptions,
    type ExecSyncOptionsWithStringEncoding,
    type SpawnOptions,
    type SpawnSyncOptions,
    type SpawnSyncOptionsWithStringEncoding,
    type SpawnSyncReturns,
} from 'node:child_process';
import { promisify } from 'node:util';

/** `spawn` with the win32 console window hidden by default. */
export function hiddenSpawn(
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
): ChildProcess {
    return spawn(command, args as string[], { windowsHide: true, ...options });
}

/**
 * `spawnSync` with the win32 console window hidden by default.
 *
 * Overloaded on `encoding` the same way node's own typings are, so a caller
 * passing `encoding: 'utf8'` gets `SpawnSyncReturns<string>` back and can keep
 * calling `.trim()` on `stdout`/`stderr` without a cast.
 */
export function hiddenSpawnSync(
    command: string,
    args: readonly string[] | undefined,
    options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function hiddenSpawnSync(
    command: string,
    args?: readonly string[],
    options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string>;
export function hiddenSpawnSync(
    command: string,
    args: readonly string[] = [],
    options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
    return spawnSync(command, args as string[], { windowsHide: true, ...options });
}

/**
 * `execFileSync` with the win32 console window hidden by default.
 *
 * Overloaded on `encoding` the same way node's own typings are, so a caller
 * passing `encoding: 'utf-8'` gets a `string` back and can keep calling
 * `.trim()`/`JSON.parse()` without a cast. That also makes this assignable to
 * `typeof execFileSync`, so it can be injected into helpers that take the real
 * function as a parameter (see wizard.ts readLatestPublishedCliVersion).
 */
export function hiddenExecFileSync(
    file: string,
    args: readonly string[] | undefined,
    options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function hiddenExecFileSync(
    file: string,
    args?: readonly string[],
    options?: ExecFileSyncOptions,
): Buffer | string;
export function hiddenExecFileSync(
    file: string,
    args: readonly string[] = [],
    options: ExecFileSyncOptions = {},
): Buffer | string {
    return execFileSync(file, args as string[], { windowsHide: true, ...options });
}

/** `execSync` with the win32 console window hidden by default. */
export function hiddenExecSync(
    command: string,
    options: ExecSyncOptionsWithStringEncoding,
): string;
export function hiddenExecSync(
    command: string,
    options?: ExecSyncOptions,
): Buffer | string;
export function hiddenExecSync(
    command: string,
    options: ExecSyncOptions = {},
): Buffer | string {
    return execSync(command, { windowsHide: true, ...options });
}

/**
 * `exec` with the win32 console window hidden by default.
 *
 * Mirrors `child_process.exec`'s own 4-overload shape (bare command with an
 * optional callback, `ExecOptionsWithStringEncoding` → string results,
 * `ExecOptionsWithBufferEncoding` → Buffer results, generic `ExecOptions` →
 * the `string | Buffer` fallback) so this is a drop-in replacement for any
 * existing `exec(...)` call shape and callers keep the same result typing
 * they'd get from real `exec` — no extra casts needed at the call site.
 */
export function hiddenExec(
    command: string,
    callback?: (error: ExecException | null, stdout: string, stderr: string) => void,
): ChildProcess;
export function hiddenExec(
    command: string,
    options: ExecOptionsWithBufferEncoding,
    callback?: (error: ExecException | null, stdout: Buffer, stderr: Buffer) => void,
): ChildProcess;
export function hiddenExec(
    command: string,
    options: ExecOptionsWithStringEncoding,
    callback?: (error: ExecException | null, stdout: string, stderr: string) => void,
): ChildProcess;
export function hiddenExec(
    command: string,
    options: ExecOptions | undefined | null,
    callback?: (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => void,
): ChildProcess;
// The implementation signature's parameter types only need to be broad enough
// to be assignable FROM every overload above — they are not part of the
// public surface (TS hides the implementation signature from callers), so
// `any` here is the standard pattern for a manually-overloaded function whose
// individually-typed overloads already give callers real safety.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hiddenExec(command: string, optionsOrCallback?: any, callback?: any): ChildProcess {
    if (typeof optionsOrCallback === 'function') {
        return exec(command, { windowsHide: true }, optionsOrCallback);
    }
    const options: ExecOptions = { windowsHide: true, ...optionsOrCallback };
    return callback ? exec(command, options, callback) : exec(command, options);
}

// `util.promisify` special-cases `child_process.exec` by function identity
// (its `[util.promisify.custom]` resolves to `{ stdout, stderr }`, not the
// generic single-positional-arg shape a plain `promisify(fn)` would infer from
// a `(err, a, b) => void` callback). A caller who does `promisify(hiddenExec)`
// expecting exec-shaped behavior would silently get back a bare `stdout`
// string instead — this attaches the same custom-promisify contract `exec`
// itself has, wired through `hiddenExec`'s windowsHide default, so
// `promisify(hiddenExec)` is a true drop-in for `promisify(exec)`.
(hiddenExec as unknown as Record<symbol, unknown>)[promisify.custom] = (
    command: string,
    options?: ExecOptions,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> => {
    return promisify(exec)(command, { windowsHide: true, ...options } as ExecOptions);
};

/**
 * Promisified `execFile` with the win32 console window hidden by default.
 *
 * For the `await promisify(execFile)(...)`/`execFileAsync(...)` shape used
 * throughout `commands/router-refine.ts`, `mesh/mesh-refine-*.ts`, and the
 * `git/*.ts` helpers. Most existing call sites in this package add
 * `windowsHide: true` inline to a locally-bound `execFileAsync` instead of
 * switching to this wrapper (smaller diff against an established pattern); use
 * this one for new call sites so there's a single sanctioned name instead of
 * remembering the flag by hand. Overloaded on encoding the same way
 * `hiddenExecFileSync` already is, for the same reason: a caller passing
 * `encoding: 'utf8'` gets `Promise<{ stdout: string; stderr: string }>` back
 * without a cast.
 */
export function hiddenExecFileAsync(
    file: string,
    args: readonly string[] | undefined,
    options: ExecFileOptionsWithBufferEncoding,
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function hiddenExecFileAsync(
    file: string,
    args?: readonly string[],
    options?: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }>;
export function hiddenExecFileAsync(
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
export function hiddenExecFileAsync(
    file: string,
    args: readonly string[] = [],
    options: ExecFileOptions = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return promisify(execFile)(file, args as string[], { windowsHide: true, ...options } as ExecFileOptions);
}

export type { ChildProcess, ChildProcessWithoutNullStreams };
