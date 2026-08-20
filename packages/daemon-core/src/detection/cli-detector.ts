/**
 * CLI AI Agent Detector
 * 
 * Dynamic CLI detection based on Provider.
 * Reads spawn.command from cli/acp categories via ProviderLoader to check installation.
 * 
 * Uses parallel execution for fast detection across many providers.
 */

import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import type { ProviderLoader } from '../providers/provider-loader.js';
import { findBinary } from '../cli-adapters/provider-cli-shared.js';
import { QUOTA_SUPPORTED_PROVIDERS, type MeshNodeFactsProviderEnablement } from '@adhdev/mesh-shared';

export interface CLIInfo {
    id: string;
    displayName: string;
    icon: string;
    command: string;
    versionCommand?: string;
    installed: boolean;
    version?: string;
    path?: string;
    category?: string;
}

function parseVersion(raw: string): string {
    const match = raw.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
    return match ? match[1] : raw.split('\n')[0].slice(0, 100);
}

function shellQuote(value: string): string {
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function expandHome(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith('~')) return trimmed;
    return path.join(os.homedir(), trimmed.slice(1));
}

function isExplicitCommandPath(command: string): boolean {
    const trimmed = command.trim();
    return path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~');
}

function resolveCommandPath(command: string): string | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (isExplicitCommandPath(trimmed)) {
        const expanded = expandHome(trimmed);
        const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
        return existsSync(candidate) ? candidate : null;
    }
    return null;
}

/**
 * Resolve a CLI command to an absolute path for install detection.
 * Order: explicit path → PATH (`where`/`which`) → well-known global-bin dirs
 * (e.g. %APPDATA%\npm) via the shared spawn-layer findBinary.
 *
 * The final step keeps detection consistent with the spawn layer: findBinary
 * already searches npm's default Windows prefix at %APPDATA%\npm (where
 * `npm i -g @openai/codex` lands), so a CLI installed under an npm prefix that
 * is NOT on the daemon's inherited PATH is detected as installed instead of
 * being blocked at the launch gate. findBinary returns a bare "<name>.cmd"
 * (non-absolute) when nothing is found, so we only accept an absolute path
 * that actually exists.
 */
async function resolveDetectionPath(command: string, whichCmd: string): Promise<string | null> {
    const explicitPath = resolveCommandPath(command);
    if (explicitPath) return explicitPath;
    const whichResult = await execAsync(`${whichCmd} ${shellQuote(command)}`);
    if (whichResult) return whichResult.split('\n')[0];
    const resolved = findBinary(command);
    if (path.isAbsolute(resolved) && existsSync(resolved)) return resolved;
    return null;
}

/** Run a shell command with timeout, returning stdout or null on failure */
function execAsync(cmd: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
        const child = exec(cmd, {
            encoding: 'utf-8',
            timeout: timeoutMs,
            ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        }, (err, stdout) => {
            if (err || !stdout?.trim()) {
                resolve(null);
            } else {
                resolve(stdout.trim());
            }
        });
        // Safety: kill on timeout
        child.on('error', () => resolve(null));
    });
}

/**
 * Detect all CLI/ACP agents (parallel)
 * @param providerLoader ProviderLoader instance (dynamic list creation)
 */
export async function detectCLIs(
    providerLoader?: ProviderLoader,
    options?: { includeVersion?: boolean; includeDisabled?: boolean },
): Promise<CLIInfo[]> {
    const platform = os.platform();
    const whichCmd = platform === 'win32' ? 'where' : 'which';
    const includeVersion = options?.includeVersion !== false;

    // Provider-based dynamic list creation, fallback is empty array
    const cliList = providerLoader
        ? providerLoader.getCliDetectionList({ includeDisabled: options?.includeDisabled })
        : [];

    // Run all `which` checks in parallel
    const results = await Promise.all(
        cliList.map(async (cli): Promise<CLIInfo> => {
            try {
                const firstPath = await resolveDetectionPath(cli.command, whichCmd);
                if (!firstPath) return { ...cli, installed: false };

                // Get version (parallel with other checks)
                let version: string | undefined;
                if (includeVersion) {
                    const versionCommands = [
                        `"${firstPath}" --version`,
                        `"${firstPath}" -V`,
                        `"${firstPath}" -v`,
                        cli.versionCommand,
                    ].filter((v): v is string => !!v);
                    try {
                        for (const versionCommand of versionCommands) {
                            const versionResult = await execAsync(versionCommand, 3000);
                            if (versionResult) {
                                version = parseVersion(versionResult);
                                break;
                            }
                        }
                    } catch { }
                }

                return { ...cli, installed: true, version, path: firstPath };
            } catch {
                return { ...cli, installed: false };
            }
        })
    );

    return results;
}

/** Detect specific CLI — only probes the one requested provider */
export async function detectCLI(
    cliId: string,
    providerLoader?: ProviderLoader,
    options?: { includeVersion?: boolean },
): Promise<CLIInfo | null> {
    const resolvedId = providerLoader ? providerLoader.resolveAlias(cliId) : cliId;

    if (providerLoader) {
        const cliList = providerLoader.getCliDetectionList();
        const target = cliList.find((c) => c.id === resolvedId);
        if (target) {
            const platform = os.platform();
            const whichCmd = platform === 'win32' ? 'where' : 'which';
            try {
                const firstPath = await resolveDetectionPath(target.command, whichCmd);
                if (!firstPath) return null;
                let version: string | undefined;
                if (options?.includeVersion !== false) {
                    const versionCommands = [
                        `"${firstPath}" --version`,
                        `"${firstPath}" -V`,
                        `"${firstPath}" -v`,
                        target.versionCommand,
                    ].filter((v): v is string => !!v);
                    try {
                        for (const versionCommand of versionCommands) {
                            const versionResult = await execAsync(versionCommand, 3000);
                            if (versionResult) {
                                version = parseVersion(versionResult);
                                break;
                            }
                        }
                    } catch { }
                }
                return { ...target, installed: true, version, path: firstPath };
            } catch {
                return null;
            }
        }
    }

    // Fallback: full scan for unknown provider IDs
    const all = await detectCLIs(providerLoader, options);
    return all.find((c) => c.id === resolvedId && c.installed) || null;
}

/**
 * Fold a detected CLIInfo[] into the `{ providerId: version }` map surfaced as a
 * node's providerVersions (see RepoMeshNodeCapabilities.providerVersions). Only
 * installed providers that produced a parseable version string are included, so a
 * missing entry means "not installed or version unknown" — never a fabricated value.
 * Pure/deterministic: the same detection input always yields the same map, which is
 * what the git_status envelope carries and the mesh_status skew check compares.
 */
export function buildProviderVersions(detected: CLIInfo[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cli of detected) {
        if (!cli.installed) continue;
        const version = typeof cli.version === 'string' ? cli.version.trim() : '';
        if (!version) continue;
        out[cli.id] = version;
    }
    return out;
}

// ─── Cached provider-versions snapshot (mesh visibility, T7) ────────────────
//
// A node's providerVersions rides the git_status envelope, which a coordinator
// probes on every graph refresh. Running the full `--version` exec fan-out on
// each probe would be far too costly (one spawn per provider per probe), so the
// snapshot is memoized with a TTL and refreshed lazily in the background: a probe
// reads the current cache immediately (empty until the first refresh completes)
// and kicks off a refresh only when the cache is stale, never blocking the git
// response on version detection. Best-effort observability — a cold/empty map
// simply omits providerVersions from that probe, and the next probe carries it.
const PROVIDER_VERSIONS_TTL_MS = 5 * 60 * 1000; // 5 min — provider installs change rarely
let cachedProviderVersions: Record<string, string> = {};
let cachedProviderVersionsAt = 0;
let providerVersionsRefreshInFlight: Promise<void> | null = null;

// The daemon's active ProviderLoader, registered once at boot. detectCLIs only
// builds its detection list from a loader (no loader ⇒ empty list ⇒ empty version
// map), and getCachedProviderVersions is reachable on paths that have no loader in
// scope — most importantly the coordinator's own self/worktree node self-heal in
// mesh-node-identity.ts, which is a pure module with no daemon handle. Registering
// the loader here lets those loader-less reads still detect providers instead of
// silently returning {}. An explicit loader argument always wins over this default.
let defaultProviderLoader: ProviderLoader | undefined;

/**
 * Register this daemon's ProviderLoader as the fallback used by loader-less
 * provider-version reads (getCachedProviderVersions() with no argument). Called
 * once at boot. Without it the coordinator's self node never resolves a CLI list,
 * so its provider-version chips stay empty even though remote nodes populate.
 */
export function setDefaultProviderLoader(providerLoader: ProviderLoader): void {
    defaultProviderLoader = providerLoader;
}

function refreshProviderVersionsSnapshot(providerLoader?: ProviderLoader): Promise<void> {
    if (providerVersionsRefreshInFlight) return providerVersionsRefreshInFlight;
    const loader = providerLoader ?? defaultProviderLoader;
    providerVersionsRefreshInFlight = (async () => {
        try {
            const detected = await detectCLIs(loader, { includeVersion: true });
            cachedProviderVersions = buildProviderVersions(detected);
            cachedProviderVersionsAt = Date.now();
        } catch {
            // Best-effort: keep the last good snapshot on failure.
        } finally {
            providerVersionsRefreshInFlight = null;
        }
    })();
    return providerVersionsRefreshInFlight;
}

/**
 * Return the current cached provider-versions map for this daemon, triggering a
 * lazy background refresh when the snapshot is stale/cold. Never blocks: returns
 * whatever is currently cached (an empty object before the first refresh lands).
 * This is the source the git_status envelope reads to self-report a node's
 * provider versions to the mesh coordinator.
 */
export function getCachedProviderVersions(providerLoader?: ProviderLoader): Record<string, string> {
    const stale = Date.now() - cachedProviderVersionsAt > PROVIDER_VERSIONS_TTL_MS;
    if (stale) {
        // Fire-and-forget; the current (possibly empty) snapshot is returned now.
        void refreshProviderVersionsSnapshot(providerLoader);
    }
    return { ...cachedProviderVersions };
}

/**
 * Return the `{ providerType: pinnedSpecVersion }` map for this daemon — the
 * verified-channel PIN, i.e. which provider MANIFEST the daemon actually loads.
 *
 * Deliberately SEPARATE from getCachedProviderVersions(). That map is the CLI
 * BINARY version (what `claude --version` prints); this one is the spec pin
 * (what ~/.adhdev/providers/.store activated). They answer different questions
 * and routinely disagree — a machine can run kimi-code 1.2.3 while pinned to
 * kimi spec 1.0.0 — so folding them into one field would be exactly the
 * multi-identifier confusion that keeps producing canon-identity defects.
 *
 * Why this exists: a published provider fix does not reach a machine on its own
 * (the pin only advances on an explicit activation, by design). Without this
 * field there is NO way to ask a remote node which spec it is running, so a
 * shipped fix can sit unadopted on a node indefinitely and look identical to a
 * node that has it.
 *
 * Pure local read: no network, no pointer writes, no detection pass.
 */
export function getProviderSpecPins(providerLoader?: ProviderLoader): Record<string, string> {
    const loader = providerLoader ?? defaultProviderLoader;
    const out: Record<string, string> = {};
    try {
        const pins = loader?.listVerifiedChannelPins?.();
        if (!pins) return out;
        for (const [type, pointer] of pins) {
            const version = pointer?.active?.providerVersion;
            // A missing entry means "no pin" — never a fabricated value, same
            // contract as buildProviderVersions above.
            if (typeof version === 'string' && version) out[type] = version;
        }
    } catch {
        // Best-effort: a corrupt/absent store reports no pins rather than
        // failing the envelope that carries it.
    }
    return out;
}

/**
 * Per-provider enablement state for the node-facts bundle — the two axes
 * ProviderLoader already owns (`isMachineProviderEnabled` /
 * `isMachineQuotaEnabled`), resolved to plain booleans so a remote reader never
 * re-derives this machine's config defaults.
 *
 * Why it exists: a provider disabled on EITHER axis is pruned from the quota
 * cache outright (quota/refresh.ts), so its absence from `nodeFacts.quota` is
 * indistinguishable from "never measured yet" to anyone but the owning daemon.
 * Shipping the state alongside the snapshots is what lets a COORDINATOR
 * classify a remote node's missing entry instead of guessing — see
 * mesh-quota-routing.ts classifyAbsentQuotaReason.
 *
 * Scoped to QUOTA_SUPPORTED_PROVIDERS, not every provider this machine knows:
 * the sole consumer is the absent-quota-entry classifier, and a provider with
 * no fetcher can never have a snapshot for any reason other than "no fetcher
 * exists" — reporting its switches would answer a question nobody asks and
 * grow the bundle on every git_status for nothing.
 *
 * Pure in-memory/config read — no spawn, no network. Same best-effort contract
 * as getProviderSpecPins: a loader that throws reports nothing rather than
 * failing the envelope that carries it.
 */
export function getProviderEnablementFacts(
    providerLoader?: ProviderLoader,
): Record<string, MeshNodeFactsProviderEnablement> {
    const loader = providerLoader ?? defaultProviderLoader;
    const out: Record<string, MeshNodeFactsProviderEnablement> = {};
    if (!loader) return out;
    for (const type of QUOTA_SUPPORTED_PROVIDERS) {
        try {
            // Resolve BOTH defaults here (enabled defaults false, quotaEnabled
            // defaults true) so the wire carries a decided verdict, never a
            // rule a reader has to reapply.
            out[type] = {
                enabled: loader.isMachineProviderEnabled(type) === true,
                quotaEnabled: loader.isMachineQuotaEnabled
                    ? loader.isMachineQuotaEnabled(type) !== false
                    : true,
            };
        } catch {
            // One unreadable provider must not cost the others their entry.
        }
    }
    return out;
}
