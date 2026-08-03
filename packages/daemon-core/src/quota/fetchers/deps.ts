/**
 * Injectable side-effect surface for quota fetchers.
 *
 * Quota fetching touches the network, the clock and the environment. Tests
 * must be able to replace all three so the suite never issues a real request
 * to a provider API — mocking `globalThis.fetch` process-wide is both racy
 * under parallel test files and easy to leak between suites.
 */
'use strict';

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

export interface QuotaFetchDeps {
    /** Defaults to global `fetch`. */
    fetch?: QuotaFetch;
    /** Defaults to `Date.now`. */
    now?: () => number;
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

/** Fill in real implementations for anything a caller did not override. */
export function resolveDeps(overrides: QuotaFetchDeps = {}): Required<QuotaFetchDeps> {
    return {
        fetch: overrides.fetch ?? ((url, init) => fetch(url, init as RequestInit) as Promise<QuotaFetchResponse>),
        now: overrides.now ?? (() => Date.now()),
        env: overrides.env ?? process.env,
    };
}
