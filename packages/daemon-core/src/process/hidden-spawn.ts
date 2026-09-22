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
 */

import {
    execFileSync,
    execSync,
    spawn,
    spawnSync,
    type ChildProcess,
    type ChildProcessWithoutNullStreams,
    type ExecFileSyncOptions,
    type ExecFileSyncOptionsWithStringEncoding,
    type ExecSyncOptions,
    type ExecSyncOptionsWithStringEncoding,
    type SpawnOptions,
    type SpawnSyncOptions,
    type SpawnSyncReturns,
} from 'node:child_process';

/** `spawn` with the win32 console window hidden by default. */
export function hiddenSpawn(
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
): ChildProcess {
    return spawn(command, args as string[], { windowsHide: true, ...options });
}

/** `spawnSync` with the win32 console window hidden by default. */
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

export type { ChildProcess, ChildProcessWithoutNullStreams };
