/**
 * Registry / provider-distribution URL resolver.
 *
 * Single source of truth for the ADHDev provider *registry* base URL and the
 * provider *tarball* (GitHub) URL. Self-hosters can repoint both away from the
 * vendor defaults so the daemon never phones home to `api.adhf.dev` /
 * `github.com/vilmire/adhdev-providers`.
 *
 * Resolution priority (highest first):
 *   1. Explicit config field    — `config.registryUrl` / `config.providerTarballUrl`
 *   2. Environment variable      — `ADHDEV_REGISTRY_URL` / `ADHDEV_PROVIDER_TARBALL_URL`
 *   3. Vendor default            — existing URLs (unchanged for default users)
 *
 * Default users get byte-identical behavior: the vendor defaults equal the
 * literals these functions replaced.
 */

/** Vendor default registry base URL (no trailing slash). */
export const DEFAULT_REGISTRY_BASE_URL = 'https://api.adhf.dev/api/v1/registry';

/** Vendor default provider tarball URL (GitHub main branch archive). */
export const DEFAULT_PROVIDER_TARBALL_URL =
    'https://github.com/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz';

/** Env var that overrides the registry base URL. */
export const REGISTRY_URL_ENV_VAR = 'ADHDEV_REGISTRY_URL';

/** Env var that overrides the provider tarball URL. */
export const PROVIDER_TARBALL_URL_ENV_VAR = 'ADHDEV_PROVIDER_TARBALL_URL';

function cleanString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripTrailingSlashes(url: string): string {
    return url.replace(/\/+$/, '');
}

/**
 * Resolve the provider registry base URL.
 *
 * @param configuredUrl explicit config value (config.registryUrl); highest priority.
 * @param env process env source (defaults to process.env; injectable for tests).
 * @returns the resolved base URL with any trailing slash stripped, so callers
 *   can safely append `/providers`, `/providers/<type>`, etc.
 */
export function resolveRegistryBaseUrl(
    configuredUrl?: string | null,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const resolved =
        cleanString(configuredUrl) ??
        cleanString(env[REGISTRY_URL_ENV_VAR]) ??
        DEFAULT_REGISTRY_BASE_URL;
    return stripTrailingSlashes(resolved);
}

/**
 * Resolve the provider tarball (archive) URL.
 *
 * @param configuredUrl explicit config value (config.providerTarballUrl); highest priority.
 * @param env process env source (defaults to process.env; injectable for tests).
 */
export function resolveProviderTarballUrl(
    configuredUrl?: string | null,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return (
        cleanString(configuredUrl) ??
        cleanString(env[PROVIDER_TARBALL_URL_ENV_VAR]) ??
        DEFAULT_PROVIDER_TARBALL_URL
    );
}

/** Parsed tarball request target for callers that issue raw hostname/path requests. */
export interface TarballRequestTarget {
    /** Full resolved tarball URL. */
    url: string;
    /** Hostname component (e.g. `github.com`). */
    hostname: string;
    /** Path component including any query string (e.g. `/vilmire/...tar.gz`). */
    path: string;
}

/**
 * Resolve the provider tarball URL and split it into `{ url, hostname, path }`
 * for callers that build raw `https.request` options (e.g. HEAD ETag probes).
 */
export function resolveProviderTarballTarget(
    configuredUrl?: string | null,
    env: NodeJS.ProcessEnv = process.env,
): TarballRequestTarget {
    const url = resolveProviderTarballUrl(configuredUrl, env);
    const parsed = new URL(url);
    return {
        url,
        hostname: parsed.hostname,
        path: parsed.pathname + (parsed.search || ''),
    };
}
