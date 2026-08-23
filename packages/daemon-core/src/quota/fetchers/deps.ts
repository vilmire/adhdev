/**
 * Injectable side-effect surface for quota fetchers.
 *
 * Quota fetching touches the network, the clock, the environment and — for
 * providers queried through their own CLI — child processes. Tests must be
 * able to replace all of them so the suite never issues a real request to a
 * provider API nor spawns a real CLI; mocking `globalThis.fetch` or
 * `node:child_process` process-wide is both racy under parallel test files and
 * easy to leak between suites.
 */
'use strict';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { isTestRuntimeEnv } from '../../config/config-dir.js';
import { loadConfig } from '../../config/config.js';

/** Minimal response surface a fetcher relies on. */
export interface QuotaFetchResponse {
    ok: boolean;
    status: number;
    headers?: { get?(name: string): string | null };
    json(): Promise<unknown>;
    text?(): Promise<string>;
}

export type QuotaFetch = (
    url: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    },
) => Promise<QuotaFetchResponse>;

/**
 * The slice of a child process a quota fetcher uses: line-oriented stdio and
 * the ability to terminate it. Deliberately narrower than Node's ChildProcess
 * so a test double stays small and no fetcher can reach for process control we
 * do not want it to have.
 */
export interface QuotaChildProcess {
    stdin: { write(chunk: string): void; end(): void };
    stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
    stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
    kill(signal?: NodeJS.Signals): void;
}

export type QuotaSpawn = (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
) => QuotaChildProcess;

export interface QuotaFetchDeps {
    /** Defaults to global `fetch`. */
    fetch?: QuotaFetch;
    /** Defaults to `Date.now`. */
    now?: () => number;
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Defaults to `child_process.spawn` with piped stdio. */
    spawn?: QuotaSpawn;
    /** Deferred callback, injectable so tests can drive timeouts deterministically. */
    setTimeout?: (handler: () => void, ms: number) => { unref?: () => void };
    clearTimeout?: (handle: unknown) => void;
    /**
     * Has the user opted into labelling quota with the signed-in account's
     * email? Defaults to the persisted config (`quotaShowAccountEmail`, which
     * is itself off unless the user turned it on — see config.ts).
     *
     * Injectable like every other side effect here so a test can exercise both
     * states without writing a config file. Read through a function rather than
     * a boolean so the answer reflects the config at FETCH time — a user who
     * turns the option off does not have to restart the daemon for the next
     * tick to stop collecting.
     */
    showAccountEmail?: () => boolean;
}

/**
 * Network quota fetchers (grok / kimi / antigravity) must not use the default
 * global `fetch` inside a test runtime — that is a live provider endpoint, and
 * on a machine with ~/.grok/auth.json (etc.) it actually fires. File/CLI
 * fetchers (claude statusline, codex spawn, opencode stats) do not call this.
 *
 * Call at the top of the fetcher, BEFORE credential reads, so a missing mock
 * fails loudly even when the developer is signed out.
 */
export function assertInjectedNetworkFetchInTest(overrides: QuotaFetchDeps, caller: string): void {
    if (overrides.fetch) return;
    if (!isTestRuntimeEnv()) return;
    throw new Error(
        `${caller}() in a test runtime without an injected fetch: this would hit a live provider endpoint. `
        + 'Mock the fetcher module, or pass deps.fetch (see test/quota/grok-quota.test.ts).',
    );
}

/** Fill in real implementations for anything a caller did not override. */
export function resolveDeps(overrides: QuotaFetchDeps = {}): Required<QuotaFetchDeps> {
    return {
        fetch: overrides.fetch ?? ((url, init) => fetch(url, init as RequestInit) as Promise<QuotaFetchResponse>),
        now: overrides.now ?? (() => Date.now()),
        env: overrides.env ?? process.env,
        spawn:
            overrides.spawn ??
            ((command, args, options) =>
                spawn(command, args, {
                    env: options.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }) as ChildProcessWithoutNullStreams as unknown as QuotaChildProcess),
        setTimeout: overrides.setTimeout ?? ((handler, ms) => setTimeout(handler, ms)),
        clearTimeout: overrides.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
        // Fail CLOSED: if the config cannot be read for any reason, treat the
        // option as off. A PII opt-in must never be enabled by an error path.
        showAccountEmail: overrides.showAccountEmail ?? (() => {
            try {
                return loadConfig().quotaShowAccountEmail === true;
            } catch {
                return false;
            }
        }),
    };
}
