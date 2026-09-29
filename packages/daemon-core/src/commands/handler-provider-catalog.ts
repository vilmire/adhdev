/**
 * DaemonCommandHandler's provider catalog commands: availability listing, the
 * registry catalog, installing / uninstalling provider manifests, update checks with
 * activate / rollback, and provider sources (add / remove / list / set active).
 * Functions over the handler; the class keeps the delegating command methods.
 */
import { loadConfig } from '../config/config.js';
import { resolveRegistryBaseUrl } from '../config/registry-resolver.js';
import type { CommandResult, DaemonCommandHandler } from './handler.js';

/** The DaemonCommandHandler members these functions read or call (compiler-checked; no cast). */
export type ProviderCatalogCommandHost = Pick<DaemonCommandHandler, '_ctx' | 'getUpstreamInstallRoot' | 'handleListInstalledProviders'>;

/**
 * Return per-provider availability so the dashboard's provider catalog
 * can show "Installed" badges. Reuses the existing detection state from
 * ProviderLoader.getMachineProviderStatus() — no probing is triggered.
 */
export function handleListProviderAvailability(host: ProviderCatalogCommandHost, _args: any): CommandResult {
    if (!host._ctx.providerLoader) {
        return { success: false, error: 'ProviderLoader not initialized' };
    }
    const { describeTrust, requiresConfirmation } =
        require('../providers/provider-trust.js') as typeof import('../providers/provider-trust.js');
    const loader = host._ctx.providerLoader;
    const items = loader.getAll().map((provider) => {
        const machineConfig = loader.getMachineProviderConfig(provider.type);
        const lastDetection = machineConfig.lastDetection;
        const trust = (provider as any)._sourceTrust ?? 'trusted';
        const layer = (provider as any)._sourceLayer ?? 'upstream';
        const sourceName = (provider as any)._sourceName ?? null;
        return {
            type: provider.type,
            // Expose manifest aliases so thin clients (MCP launch_session) can
            // resolve an alias to the canonical type + category locally instead
            // of guessing the launch route from the type string's suffix.
            aliases: Array.isArray(provider.aliases) ? provider.aliases : [],
            category: provider.category,
            status: loader.getMachineProviderStatus(provider.type),
            installed: lastDetection?.ok === true,
            detectedPath: lastDetection?.path ?? null,
            checkedAt: lastDetection?.checkedAt ?? null,
            trust,
            trustDescription: describeTrust(trust),
            requiresConfirmation: requiresConfirmation(trust),
            sourceLayer: layer,
            sourceName,
        };
    });
    return { success: true, providers: items };
}

/**
 * Install (activate) a provider from the VERIFIED CHANNEL.
 *
 * CHANNEL-FIRST INSTALL (M-PROVIDER-DIST-UNIFY, 2026-08-10): this used to
 * download a single manifest JSON via the legacy registry shape and write
 * it into providers/.upstream — a path that 404s for channel-only
 * publications (the live kimi miss: published post-bootstrap, invisible
 * to every targeted sync AND uninstallable from the dashboard) and that
 * could not carry script bytes without a follow-up GitHub raw pull. The
 * verified channel bundle IS the full provider tree (scripts included,
 * digest-verified, atomic pointer flip, rollback), so installing a new
 * type is just a targeted channel sync — and the activation pointer then
 * keeps the type in every future sync's target set, so no .upstream
 * write is needed as an intent record.
 *
 * Args: { type: string, version?: string } (category accepted and
 * ignored — legacy REST callers send it). The verified channel serves
 * exactly ONE version per channel: a version request that does not match
 * the channel entry fails closed instead of pretending to honor it.
 */
export async function handleInstallProviderManifest(host: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const loader = host._ctx.providerLoader;
    if (!loader) {
        return { success: false, error: 'ProviderLoader not initialized' };
    }
    const type = typeof args?.type === 'string' ? args.type.trim() : '';
    if (!type) return { success: false, error: 'type is required' };
    // Defense in depth: reject any obvious path-traversal in the type.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
        return { success: false, error: 'invalid type' };
    }
    const requestedVersion = typeof args?.version === 'string' && args.version.trim()
        ? args.version.trim()
        : null;

    const report = await loader.syncVerifiedChannel({ extraTargetTypes: [type] });
    const activatedNow = report.activated.some((a) => a.providerType === type);
    const active = loader.listVerifiedChannelPins().get(type)?.active ?? null;

    if (!active) {
        const skip = report.skipped.find((s: any) => s?.entry?.providerType === type);
        const err = report.errors.find((e) => e.providerType === type) ?? report.errors[0];
        return {
            success: false,
            code: 'channel_install_failed',
            error: skip?.reason
                || err?.message
                || `provider "${type}" is not activatable on channel "${loader.channel}" (not published, or no verified artifact)`,
        };
    }
    if (requestedVersion && active.providerVersion !== requestedVersion) {
        return {
            success: false,
            code: 'channel_version_mismatch',
            error: `verified channel "${loader.channel}" serves ${type}@${active.providerVersion}; version "${requestedVersion}" is not addressable — the channel carries exactly one version per channel`,
        };
    }
    // syncVerifiedChannel already reloaded manifests on activation; refresh
    // detection so a freshly installed provider resolves detected/not_detected
    // instead of sitting unchecked.
    loader.registerToDetector();
    return {
        success: true,
        installed: {
            type,
            category: active.category,
            version: active.providerVersion,
            digest: active.digest,
            channel: loader.channel,
            alreadyInstalled: !activatedNow,
        },
    };
}

/**
 * Return everything currently installed in the upstream cache with its
 * version. This is the "what does this daemon have" answer used both by
 * the UI and by the update checker.
 */
export function handleListInstalledProviders(host: ProviderCatalogCommandHost, _args: any): CommandResult {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    const installRoot = host.getUpstreamInstallRoot();
    if (!fs.existsSync(installRoot)) return { success: true, providers: [] };

    const CATEGORIES = ['cli', 'ide', 'extension', 'acp'] as const;
    const items: Array<{
        type: string;
        category: string;
        version: string;
        path: string;
        modelOptions?: string[];
        thinkingLevelOptions?: string[];
    }> = [];

    for (const category of CATEGORIES) {
        const categoryDir = path.join(installRoot, category);
        if (!fs.existsSync(categoryDir)) continue;
        let entries: string[];
        try { entries = fs.readdirSync(categoryDir); } catch { continue; }
        for (const type of entries) {
            // v1 manifest takes precedence over v0 when both are present.
            const v1Path = path.join(categoryDir, type, 'provider.v1.json');
            const v0Path = path.join(categoryDir, type, 'provider.json');
            const manifestPath = fs.existsSync(v1Path) ? v1Path : (fs.existsSync(v0Path) ? v0Path : null);
            if (!manifestPath) continue;
            try {
                const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                // Surface the manifest's advisory model / thinking-level lists so
                // consumers of this endpoint (standalone New-session dialog, mesh
                // node slot editor) get the same provider-specific dropdowns the
                // status-snapshot path already carries — otherwise every provider
                // (codex included) falls back to a free-text Model field.
                const modelOptions = Array.isArray(m.modelOptions)
                    ? m.modelOptions.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
                    : [];
                const thinkingLevelOptions = Array.isArray(m.thinkingLevelOptions)
                    ? m.thinkingLevelOptions.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
                    : [];
                items.push({
                    type,
                    category,
                    version: typeof m.providerVersion === 'string' ? m.providerVersion : '0.0.0',
                    path: manifestPath,
                    ...(modelOptions.length ? { modelOptions } : {}),
                    ...(thinkingLevelOptions.length ? { thinkingLevelOptions } : {}),
                });
            } catch {
                // Corrupt manifest — skip but don't fail the whole listing.
            }
        }
    }
    return { success: true, providers: items };
}

/**
 * Report, for each installed provider, what this daemon is actually
 * PINNED to and what the registry currently offers.
 *
 * READ-ONLY. It used to end by calling syncVerifiedChannel(), i.e. it
 * downloaded, verified AND ACTIVATED — a command named `check` that moved
 * the pointer, reachable over `GET /api/v1/providers/updates`, so a plain
 * GET mutated state. Activation now lives in `activate_provider_updates`.
 *
 * It also compared the wrong number. `.upstream` holds the installed
 * manifest, but the daemon loads the pinned store object, and those
 * diverge by design (the pin only advances on an explicit activation).
 * Reporting `.upstream` described a machine that was not the one running:
 * with `.upstream` at 1.0.3 and the pin at 1.0.0 it said "up to date"
 * while the daemon ran the older spec. `activeVersion` is now the pin.
 *
 * `installedVersion` is kept as an alias of the pin so existing readers
 * do not silently flip meaning; it is the number that decides behaviour.
 *
 * Returns { providers: [{ type, category, activeVersion, installedVersion,
 *   upstreamVersion, latestVersion, updateAvailable, stale, digest,
 *   activatedAt, previousVersion, error? }] }
 */
/**
 * Read-only registry catalog proxy for dashboard surfaces (onboarding).
 * Routes through resolveRegistryBaseUrl so a self-hosted daemon never sends
 * its dashboard users to the vendor registry (the whole point of the
 * resolver — the onboarding dialog used to hardcode api.adhf.dev and
 * defeat it on the very first screen). Channel-aware like every other
 * registry read in this file.
 */
export async function handleRegistryCatalog(host: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const https = require('https') as typeof import('https');
    const cfg = loadConfig();
    const REGISTRY = resolveRegistryBaseUrl(cfg.registryUrl, process.env, cfg.serverUrl);
    const limit = Math.min(200, Math.max(1, Number(args?.limit) || 100));
    const sort = typeof args?.sort === 'string' && /^[a-z_]{1,32}$/.test(args.sort) ? args.sort : 'popular';
    const channel = host._ctx.providerLoader?.channel ?? 'stable';
    const url = `${REGISTRY}/providers?sort=${encodeURIComponent(sort)}&limit=${limit}&channel=${encodeURIComponent(channel)}`;
    try {
        const data: any = await new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        return { success: true, providers: Array.isArray(data?.providers) ? data.providers : [], registryBaseUrl: REGISTRY, channel };
    } catch (e: any) {
        return { success: false, error: `registry catalog fetch failed: ${e?.message || e}`, registryBaseUrl: REGISTRY };
    }
}

export async function handleCheckProviderUpdates(host: ProviderCatalogCommandHost, _args: any): Promise<CommandResult> {
    // Through the host so the class method stays the single dispatch seam.
    const installed = host.handleListInstalledProviders({});
    if (!installed.success) return installed;

    const https = require('https') as typeof import('https');
    const cfg = loadConfig();
    const REGISTRY = resolveRegistryBaseUrl(cfg.registryUrl, process.env, cfg.serverUrl);

    function fetchJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    const installedList = (installed as unknown as { providers: Array<{ type: string; category: string; version: string }> }).providers;
    // The pin is what the daemon loads; `.upstream` is only what is on
    // disk. Where a provider has no pin (channel store empty/disabled),
    // fall back to the upstream version so the row is still meaningful.
    const pins = host._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();
    // Staleness must be judged against the SAME channel the loader pins
    // from (channel/runtime.ts sends ?channel= on its listing for the same
    // reason). Without it, a preview-channel daemon compared its preview
    // pin against the stable row and mis-reported staleness both ways.
    const channel = host._ctx.providerLoader?.channel ?? 'stable';
    const checks = await Promise.all(
        installedList.map(async (p) => {
            const pin = pins.get(p.type);
            const activeVersion = pin?.active?.providerVersion ?? p.version;
            const base = {
                type: p.type,
                category: p.category,
                activeVersion,
                // Alias of the pin: this is the version that decides
                // behaviour, which is what a field named "installed" is
                // read as. `upstreamVersion` carries the on-disk manifest.
                installedVersion: activeVersion,
                upstreamVersion: p.version,
                digest: pin?.active?.digest ?? null,
                activatedAt: pin?.active?.activatedAt ?? null,
                previousVersion: pin?.previous?.providerVersion ?? null,
            };
            try {
                const remote = await fetchJson(`${REGISTRY}/providers/${encodeURIComponent(p.type)}?channel=${encodeURIComponent(channel)}`);
                const latestVersion = String(remote?.version ?? '');
                const stale = latestVersion !== '' && latestVersion !== activeVersion;
                return { ...base, latestVersion, updateAvailable: stale, stale };
            } catch (e: any) {
                return {
                    ...base,
                    latestVersion: null,
                    updateAvailable: false,
                    stale: false,
                    error: e?.message ?? String(e),
                };
            }
        })
    );

    // NO sync here. Activation moved to `activate_provider_updates` so
    // this command — and the GET that exposes it — cannot change state.
    // `channelSync: null` is kept so existing readers of the field see a
    // shape they already handle rather than an absent key.
    //
    // channelStaleness: one extra READ-ONLY channel listing so the caller
    // also learns about channel types this machine has never activated
    // nor installed (newTypes — the kimi class, invisible in the
    // installed-set rows above). Refreshes the badge snapshot as a side
    // effect of the same read; still zero pointer writes.
    let channelStaleness: unknown = null;
    try {
        channelStaleness = await host._ctx.providerLoader?.checkVerifiedChannelStaleness?.() ?? null;
    } catch { /* read-only extra — rows above are still valid without it */ }

    // modelStaleness: the same badge treatment for the MODEL-list axis,
    // reusing this payload rather than inventing a second convention.
    // Purely a cache read — no spawn, no network (see getModelDiscoveryStaleness).
    //
    // ★`cannotVerifyTypes` must stay distinct from `staleTypes`: claude-cli
    // and hermes-cli can never be enumerated, and rendering them as "up to
    // date" would assert a check that never happened — the same class of
    // comfortable lie as a phantom approval. (The machine dashboard renders
    // only `staleTypes` since 2026-09-25 — owner decision; the field stays
    // in the payload as a harmless cache read.)
    let modelStaleness: unknown = null;
    try {
        modelStaleness = host._ctx.providerLoader?.getModelDiscoveryStaleness?.() ?? null;
    } catch { /* read-only extra — rows above are still valid without it */ }
    return { success: true, providers: checks, channelSync: null, channelStaleness, modelStaleness };
}

/**
 * Download, verify and ACTIVATE the newest channel objects: the pointer
 * flip that `check_provider_updates` used to perform as a side effect.
 *
 * Deliberately explicit and deliberately not automatic. The pin design is
 * intentional (content-addressed store, atomic pointer flip, retention,
 * last-known-good, rollback as a local flip) and boot stays network-free.
 * This command is the user saying "now".
 *
 * Fail-closed: on any registry/transport/digest failure nothing is
 * activated and the last-known-good objects keep loading.
 *
 * Args: { types?: string[] } — optional provider types unioned into the
 * sync target set. This is how a NEVER-activated channel type is
 * installed from the dashboard (kimi class): the default target set is
 * pins+installed, which by construction cannot contain a type published
 * after this machine's bootstrap.
 *
 * `only: true` (with non-empty `types`) RESTRICTS the sync to exactly
 * those types instead of extending the default set — the dashboard's
 * per-provider "Update" button. Without it, updating one provider also
 * moved every other stale pin. A restricted sync writes no
 * channel-activation stamp (it is partial). Older daemons ignore `only`
 * and update everything; `activated` still reports what really moved.
 */
export async function handleActivateProviderUpdates(host: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const typesRaw = Array.isArray(args?.types) ? args.types : [];
    const types: string[] = [];
    for (const candidate of typesRaw) {
        const type = typeof candidate === 'string' ? candidate.trim() : '';
        if (!type) continue;
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
            return { success: false, error: `invalid type: ${String(candidate).slice(0, 80)}` };
        }
        types.push(type);
    }
    const only = args?.only === true;
    if (only && types.length === 0) {
        return { success: false, error: 'only requires a non-empty types list' };
    }
    const before = host._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();
    let channelSync: unknown = null;
    try {
        channelSync = await host._ctx.providerLoader?.syncVerifiedChannel?.(
            only
                ? { onlyTargetTypes: types }
                : types.length > 0 ? { extraTargetTypes: types } : undefined,
        ) ?? null;
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
    const after = host._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();

    // Report what actually moved. "The sync succeeded" and "this machine
    // now runs a different spec" are different statements, and the second
    // is the one the caller needs — that gap is what hid the kimi fix.
    const activated: Array<{ type: string; from: string | null; to: string }> = [];
    for (const [type, pointer] of after) {
        const wasVersion = before.get(type)?.active?.providerVersion ?? null;
        const nowVersion = pointer.active?.providerVersion;
        if (nowVersion && wasVersion !== nowVersion) {
            activated.push({ type, from: wasVersion, to: nowVersion });
        }
    }
    return { success: true, activated, channelSync };
}

/**
 * Flip a provider back to its previously activated object.
 *
 * Purely local — the previous object is still in the content-addressed
 * store, so this needs no network and works when the registry is down.
 * That is the point of keeping last-known-good, and it was already
 * implemented on the loader but reachable from nowhere.
 *
 * Args: { providerType: string }
 */
export async function handleRollbackProviderUpdate(host: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const providerType = typeof args?.providerType === 'string' ? args.providerType.trim() : '';
    if (!providerType) return { success: false, error: 'providerType required' };

    const digest = host._ctx.providerLoader?.rollbackVerifiedChannel?.(providerType) ?? null;
    if (!digest) {
        // No previous activation to return to. Not an error the user can
        // act on by retrying, so say which case it is.
        return { success: false, error: `no rollback target for ${providerType}` };
    }
    const pin = host._ctx.providerLoader?.listVerifiedChannelPins?.()?.get(providerType);
    return {
        success: true,
        providerType,
        digest,
        activeVersion: pin?.active?.providerVersion ?? null,
        previousVersion: pin?.previous?.providerVersion ?? null,
    };
}

// ─── External provider sources (3rd-party git URLs) ──────────────

/**
 * Register a new external provider source. The daemon clones the repo
 * to ~/.adhdev/external/<name>/, walks it once to detect provided
 * types, and surfaces any conflicts with already-installed types so
 * the dashboard can ask the user how to resolve them.
 *
 * Args: { url: string, ref?: string, name?: string }
 *   - url: https://, git@, or any git-cloneable URL
 *   - ref: branch/tag/commit (default "main")
 *   - name: short identifier (default derived from URL)
 *
 * Returns: { source, providers, conflicts }
 *   - conflicts: list of types this new source provides that another
 *     source already exposes. UI uses this to prompt for active-source
 *     selection before the load takes effect.
 */
export async function handleAddProviderSource(self: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!url) return { success: false, error: 'url is required' };
    const ref = typeof args?.ref === 'string' && args.ref.trim() ? args.ref.trim() : 'main';

    // Defense in depth against argv flag-smuggling: reject anything that
    // looks like a git option in either positional. The `--` end-of-options
    // sentinel below catches accidental cases, but rejecting early gives
    // a clear error message and stops obviously malicious inputs from
    // even touching git.
    if (url.startsWith('-')) return { success: false, error: 'url must not start with "-"' };
    if (ref.startsWith('-')) return { success: false, error: 'ref must not start with "-"' };
    // Whitelist the protocols we'll forward to git. Anything else
    // (file://, ext-protocol-handlers, …) is refused outright.
    if (!/^(https?:\/\/|git@[a-z0-9._-]+:)[a-z0-9._@:/~\-]+$/i.test(url)) {
        return { success: false, error: 'url must be https://… or git@host:… and contain only URL-safe characters' };
    }
    // Refs are git refnames — letters, digits, slashes, dots, underscores,
    // dashes. Rejects e.g. spaces, semicolons, backticks, shell metas.
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
        return { success: false, error: 'ref must contain only [A-Za-z0-9._/-]' };
    }

    const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');
    const requestedName = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : ext.deriveSourceName(url);
    if (!/^@[a-z0-9_-]+$/i.test(requestedName)) {
        return { success: false, error: 'name must match @[a-z0-9_-]+' };
    }

    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const { hiddenSpawnSync } = require('../process/hidden-spawn.js') as typeof import('../process/hidden-spawn.js');

    const file = ext.loadExternalSources();
    if (file.sources.some(s => s.name === requestedName)) {
        return { success: false, error: `source name "${requestedName}" is already registered` };
    }
    if (file.sources.some(s => s.url === url && s.ref === ref)) {
        return { success: false, error: `source url+ref already registered (use a different name to track another ref)` };
    }

    const sourceDir = path.join(ext.externalRoot(), requestedName);
    if (!fs.existsSync(ext.externalRoot())) fs.mkdirSync(ext.externalRoot(), { recursive: true });
    if (fs.existsSync(sourceDir)) {
        return { success: false, error: `directory already exists: ${sourceDir} (rename or remove first)` };
    }

    // `--` sentinel after the option list so any future regex-bypassing
    // url that *did* start with `-` would still be treated as a path
    // by git rather than an option.
    const clone = hiddenSpawnSync('git', ['clone', '--depth=1', '--branch', ref, '--', url, sourceDir], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
    });
    if (clone.status !== 0) {
        try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        return { success: false, error: `git clone failed: ${(clone.stderr || clone.stdout || '').trim() || 'unknown error'}` };
    }

    const source: import('../providers/external-sources.js').ExternalSource = {
        name: requestedName,
        url,
        ref,
        addedAt: new Date().toISOString(),
    };
    ext.saveExternalSources({ schema: 1, sources: [...file.sources, source] });

    // Detect type-level conflicts with what's already on disk after this clone.
    const inventory = ext.inventoryExternalSources();
    const conflicts: { category: string; type: string; sources: string[] }[] = [];
    const newEntry = inventory.find(e => e.sourceName === requestedName);
    if (newEntry) {
        for (const [category, types] of Object.entries(newEntry.providers)) {
            for (const type of types) {
                const sources = ext.sourcesProviding(category, type);
                if (sources.length > 1) conflicts.push({ category, type, sources });
            }
        }
    }

    // Hot-reload so the daemon picks up the new providers immediately.
    if (self._ctx.providerLoader) {
        self._ctx.providerLoader.reload();
        self._ctx.providerLoader.registerToDetector();
    }

    return {
        success: true,
        source,
        providers: newEntry?.providers ?? {},
        conflicts,
    };
}

/**
 * Remove a registered external source. Deletes the clone directory and
 * any active-source entry pointing to it.
 *
 * Args: { name: string }
 */
export async function handleRemoveProviderSource(host: ProviderCatalogCommandHost, args: any): Promise<CommandResult> {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return { success: false, error: 'name is required' };
    const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');

    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const file = ext.loadExternalSources();
    const match = file.sources.find(s => s.name === name);
    if (!match) return { success: false, error: `source "${name}" not registered` };

    const sourceDir = path.join(ext.externalRoot(), name);
    if (fs.existsSync(sourceDir)) {
        try { fs.rmSync(sourceDir, { recursive: true, force: true }); }
        catch (e: any) { return { success: false, error: `failed to delete ${sourceDir}: ${e?.message || e}` }; }
    }

    ext.saveExternalSources({
        schema: 1,
        sources: file.sources.filter(s => s.name !== name),
    });

    // Drop any active-source entries that pointed at this source.
    const active = ext.loadProvidersActive();
    const filteredActive: Record<string, string> = {};
    for (const [type, src] of Object.entries(active.active)) {
        if (src !== name) filteredActive[type] = src;
    }
    ext.saveProvidersActive({ schema: 1, active: filteredActive });

    if (host._ctx.providerLoader) {
        host._ctx.providerLoader.reload();
        host._ctx.providerLoader.registerToDetector();
    }

    return { success: true, removed: { name } };
}

/**
 * List registered external sources + each source's currently installed
 * providers + the active selection for any conflicting types. Used by
 * the dashboard's "Sources" tab.
 */
export function handleListProviderSources(host: ProviderCatalogCommandHost, _args: any): CommandResult {
    const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');
    const file = ext.loadExternalSources();
    const inventory = ext.inventoryExternalSources();
    const active = ext.loadProvidersActive();

    // Build a per-source view + flag types that have ambiguity.
    const sources = file.sources.map(s => {
        const inv = inventory.find(e => e.sourceName === s.name);
        return {
            ...s,
            providers: inv?.providers ?? {},
        };
    });

    // Compute conflicts globally — any type provided by ≥ 2 sources.
    const conflictMap = new Map<string, { category: string; sources: string[] }>();
    for (const inv of inventory) {
        for (const [category, types] of Object.entries(inv.providers)) {
            for (const type of types) {
                const candidates = ext.sourcesProviding(category, type);
                if (candidates.length > 1 && !conflictMap.has(type)) {
                    conflictMap.set(type, { category, sources: candidates });
                }
            }
        }
    }
    const conflicts = [...conflictMap.entries()].map(([type, info]) => ({
        type,
        category: info.category,
        candidates: info.sources,
        active: active.active[type] ?? null,
    }));

    return { success: true, sources, conflicts };
}

/**
 * Pick which source's copy of a conflicting provider type is active.
 * Other sources' copies stay on disk but the loader ignores them.
 *
 * Args: { type: string, sourceName: string }
 */
export function handleSetActiveProviderSource(host: ProviderCatalogCommandHost, args: any): CommandResult {
    const type = typeof args?.type === 'string' ? args.type.trim() : '';
    const sourceName = typeof args?.sourceName === 'string' ? args.sourceName.trim() : '';
    if (!type || !sourceName) return { success: false, error: 'type and sourceName are required' };
    const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');

    // Validate: the source must actually provide that type.
    const inventory = ext.inventoryExternalSources();
    const entry = inventory.find(e => e.sourceName === sourceName);
    if (!entry) return { success: false, error: `source "${sourceName}" not found` };
    const provided = Object.values(entry.providers).some(types => types.includes(type));
    if (!provided) return { success: false, error: `source "${sourceName}" does not provide type "${type}"` };

    const active = ext.loadProvidersActive();
    active.active[type] = sourceName;
    ext.saveProvidersActive(active);

    if (host._ctx.providerLoader) {
        host._ctx.providerLoader.reload();
        host._ctx.providerLoader.registerToDetector();
    }

    return { success: true, type, sourceName };
}
