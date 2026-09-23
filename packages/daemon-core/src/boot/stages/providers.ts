/**
 * S2 bootProviders — provider loading, verified-channel boot sync, staleness
 * probe, version archive, IDE/CLI detection (wiring-unification B4).
 *
 * The channel sync used to call the host's `onStatusChange` from inside its
 * `.then()`; it now RETURNS its outcome (`channelBootSync`) and S3 turns an
 * activation into `daemon_facts{provider_channel_sync}` on the bus.
 */

import { LOG } from '../../logging/logger.js';
import { getConfigDir } from '../../config/config.js';
import { configDirChannelMismatch } from '../../config/config-dir.js';
import { isPreviewReleaseChannel, PROVIDER_CHANNEL_ENV_VAR } from '../../providers/channel/contract.js';
import { ProviderLoader, providerLoaderConfigOptions } from '../../providers/provider-loader.js';
import { VersionArchive, detectAllVersions } from '../../providers/version-archive.js';
import { detectIDEs, type IDEInfo } from '../../detection/ide-detector.js';
import { detectCLI, detectCLIs, setDefaultProviderLoader } from '../../detection/cli-detector.js';
import type { PlatformStage, ProvidersStage } from './types.js';

const STALENESS_FIRST_DELAY_MS = 10 * 60_000;
const STALENESS_INTERVAL_MS = 24 * 60 * 60_000;

type SyncReport = { status: string; activated: unknown[]; errors: Array<{ code: string; message: string }> } | null | undefined;

/**
 * First-sync → daemon-update sync as ONE chain, so the two verified syncs never
 * run concurrently. `onActivated` re-detects (the sync's own loadAll() cleared
 * providerAvailability, so providers enabled before it landed would otherwise
 * read `enabled_unchecked` forever). Never rejects.
 */
export function runChannelBootSync(
    providerLoader: Pick<ProviderLoader, 'maybeFirstSyncVerifiedChannel' | 'maybeSyncVerifiedChannelOnDaemonUpdate' | 'registerToDetector' | 'channel'>,
    refreshProviderAvailability: () => Promise<void>,
): Promise<{ activated: number }> {
    const onActivated = async (): Promise<void> => {
        providerLoader.registerToDetector();
        await refreshProviderAvailability();
    };
    return (providerLoader.maybeFirstSyncVerifiedChannel() as Promise<SyncReport>)
        .then(async (report) => {
            if (!report) return null;
            if (report.status === 'error') {
                LOG.warn('Init', `Verified channel first-sync failed (last-known-good preserved): ${report.errors.map((e) => `${e.code}: ${e.message}`).join(' | ') || 'unknown'}`);
            } else if (report.activated.length > 0) {
                LOG.info('Init', `Verified channel first-sync activated ${report.activated.length} providers (${providerLoader.channel})`);
                await onActivated();
            }
            return report;
        })
        // Daemon-update activation (owner decision 2026-08-10, option C): no-op
        // unless the store is non-empty AND the daemon version stamp differs —
        // same-version boots stay network-free.
        .then(async (firstSyncReport): Promise<{ activated: number }> => {
            if (firstSyncReport) {
                // First-sync ran — its success already stamped this version.
                return { activated: firstSyncReport.status === 'error' ? 0 : firstSyncReport.activated.length };
            }
            const report = await (providerLoader.maybeSyncVerifiedChannelOnDaemonUpdate() as Promise<SyncReport>);
            if (!report) return { activated: 0 };
            if (report.status === 'error') {
                // Full error MESSAGES, not just the closed-enum codes: the message
                // carries the transport cause (address/family/errno).
                LOG.warn('Init', `Daemon-update channel sync failed — PROVIDER MANIFESTS ARE STALE on this daemon (last-known-good activations still loaded; published provider fixes will NOT take effect until a sync succeeds): ${report.errors.map((e) => `${e.code}: ${e.message}`).join(' | ') || 'unknown'}`);
                return { activated: 0 };
            }
            if (report.activated.length > 0) {
                LOG.info('Init', `Daemon-update channel sync activated ${report.activated.length} providers (${providerLoader.channel})`);
                await onActivated();
            }
            return { activated: report.activated.length };
        })
        .catch((e: any) => {
            LOG.warn('Init', `Verified channel boot sync error: ${e?.message || e}`);
            return { activated: 0 };
        });
}

export async function bootProviders(s1: PlatformStage): Promise<ProvidersStage> {
    const { cfg, appConfig } = s1;
    const providerSourceMode = appConfig.providerSourceMode || 'normal';
    const providerLoader = new ProviderLoader({
        logFn: cfg.providerLogFn,
        // Shared config projection — keeps this site, launch.ts and the CLI
        // factory from drifting.
        ...providerLoaderConfigOptions(appConfig),
        sourceMode: providerSourceMode,
        // Enables the daemon-update = provider-activation stamp (option C).
        daemonVersion: cfg.statusVersion,
    });

    // Boot-time auto-sync is limited to the bounded first-sync (empty channel
    // store only); after the bootstrap the user picks providers explicitly.
    providerLoader.loadAll();
    providerLoader.registerToDetector();

    // Config-dir / provider-channel axis warning (informational only): the two
    // axes normally move together, but ADHDEV_CONFIG_DIR feeds no signal into
    // resolveProviderChannel, so a dir that LOOKS like one track can resolve
    // the other track's channel (e.g. a preview child re-run under tsx).
    const hasExplicitChannelSignal = Boolean(
        (appConfig.providerChannel && appConfig.providerChannel.trim())
        || (process.env[PROVIDER_CHANNEL_ENV_VAR] ?? '').trim()
        || isPreviewReleaseChannel(appConfig.updateChannel),
    );
    const resolvedConfigDir = getConfigDir();
    const channelMismatch = configDirChannelMismatch(resolvedConfigDir, providerLoader.channel, hasExplicitChannelSignal);
    if (channelMismatch) {
        LOG.warn('Init', `Config dir looks like the ${channelMismatch.impliedTrack} track (${resolvedConfigDir}) but the resolved provider channel is '${channelMismatch.channel}'. This usually means the build-track stamp (__ADHDEV_BUILD_CHANNEL__) was absent for this process — e.g. running via tsx/ts-node instead of a built bundle — so provider-channel resolution fell through to its 'stable' default instead of following ADHDEV_CONFIG_DIR. Impact: providers installed under the OTHER channel's store will not be visible (can present as 0 providers loaded). Fix: set ADHDEV_PROVIDER_CHANNEL=${channelMismatch.impliedTrack} (or config.providerChannel) explicitly for this process, or run the built bundle instead of source.`);
    }

    const detectedIdes: { value: IDEInfo[] } = { value: [] };
    const refreshProviderAvailability = async (providerType?: string): Promise<void> => {
        const targetProvider = providerType ? providerLoader.getMeta(providerLoader.resolveAlias(providerType)) : null;
        const targetCategory = targetProvider?.category;
        if (!providerType || targetCategory === 'cli' || targetCategory === 'acp') {
            if (providerType && targetProvider) {
                const detected = await detectCLI(targetProvider.type, providerLoader, { includeVersion: false });
                providerLoader.setCliDetectionResults([{
                    id: targetProvider.type,
                    installed: !!detected,
                    path: detected?.path,
                }], false);
            } else {
                providerLoader.setCliDetectionResults(await detectCLIs(providerLoader, { includeVersion: false }), true);
            }
        }
        if (!providerType || targetCategory === 'ide') {
            detectedIdes.value = await detectIDEs(providerLoader);
            providerLoader.setIdeDetectionResults(detectedIdes.value, true);
        }
    };

    // Verified-channel first sync + daemon-update sync. Fire-and-forget so a
    // slow/unreachable registry never delays boot; fail-closed (errors keep
    // the previous store and retry next boot).
    const channelBootSync = runChannelBootSync(providerLoader, () => refreshProviderAvailability());

    // Verified-channel staleness probe (owner decision 2026-08-10, option A): a
    // read-only listing 10 minutes after boot and every 24h so dashboards can
    // badge stale pins. Never on the boot path, never from a status path.
    const staleListeners: Array<() => void> = [];
    const runStalenessProbe = async () => {
        try {
            const snap = await providerLoader.checkVerifiedChannelStaleness();
            if (snap.error) {
                LOG.debug('Provider', `Channel staleness probe failed (kept previous snapshot): ${snap.error}`);
            } else if (snap.staleTypes.length > 0 || snap.newTypes.length > 0) {
                LOG.info('Provider', `Channel staleness: ${snap.staleTypes.length} stale [${snap.staleTypes.join(', ')}], ${snap.newTypes.length} never-installed [${snap.newTypes.join(', ')}] (${snap.channel})`);
                for (const listener of staleListeners) {
                    try { listener(); } catch { /* a listener never breaks the probe */ }
                }
            }
        } catch (e: any) {
            LOG.debug('Provider', `Channel staleness probe error: ${e?.message || e}`);
        }
    };
    const stalenessInitialTimer = setTimeout(() => { void runStalenessProbe(); }, STALENESS_FIRST_DELAY_MS);
    stalenessInitialTimer.unref?.();
    const stalenessIntervalTimer = setInterval(() => { void runStalenessProbe(); }, STALENESS_INTERVAL_MS);
    stalenessIntervalTimer.unref?.();
    const stalenessProbe = {
        stop() {
            clearTimeout(stalenessInitialTimer);
            clearInterval(stalenessIntervalTimer);
            staleListeners.length = 0;
        },
        onStale(cb: () => void) { staleListeners.push(cb); },
    };

    // The default loader for loader-less provider-version reads (the self node's
    // version chips in mesh-node-identity.ts). Retained process slot: one
    // consumer, no ordering hazard.
    setDefaultProviderLoader(providerLoader);

    // Version detection runs OFF the boot path (the probing is expensive).
    const versionArchive = new VersionArchive();
    providerLoader.setVersionArchive(versionArchive);
    setTimeout(() => {
        void detectAllVersions(providerLoader, versionArchive)
            .then((versionResults) => {
                const installedProviders = versionResults.filter(v => v.installed);
                const withVersion = installedProviders.filter(v => v.version);
                LOG.info('Init', `Provider versions: ${installedProviders.length} installed, ${withVersion.length} versioned`);
                for (const v of withVersion) {
                    LOG.info('Init', `  ${v.type} (${v.category}): v${v.version}${v.warning ? ' ⚠ ' + v.warning : ''}`);
                }
                const noVersion = installedProviders.filter(v => !v.version);
                if (noVersion.length > 0) {
                    LOG.warn('Init', `  ${noVersion.length} installed but version unknown: ${noVersion.map(v => v.type).join(', ')}`);
                }
            })
            .catch(() => {});
    }, 0);

    LOG.info('Init', 'Detecting IDEs...');
    await refreshProviderAvailability();
    const installed = detectedIdes.value.filter((i) => i.installed);
    LOG.info('Init', `Found ${installed.length} IDE(s): ${installed.map((i) => i.id).join(', ') || 'none'}`);

    return {
        ...s1,
        providerLoader,
        versionArchive,
        detectedIdes,
        refreshProviderAvailability,
        channelBootSync,
        stalenessProbe,
    };
}
