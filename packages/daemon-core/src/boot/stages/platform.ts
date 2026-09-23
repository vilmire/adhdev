/**
 * S1 bootPlatform — genuinely process-wide setup (wiring-unification B4).
 *
 * Runs first by construction: nothing else can be built without a
 * `PlatformStage`, so "hardening before any provider script" and "env
 * overrides before any flag read" no longer depend on statement order in one
 * 1,500-line function.
 */

import { LOG, installGlobalInterceptor } from '../../logging/logger.js';
import { loadConfig } from '../../config/config.js';
import { applyDaemonEnvOverrides } from '../../config/env-overrides.js';
import { readUpgradeFailureNotice } from '../../commands/upgrade-helper.js';
import { installProviderProcessShim } from '../../providers/sdk/v1/sandbox/require-whitelist.js';
import { applyProcessHardening } from '../process-hardening.js';
import type { DaemonBootConfig } from '../daemon-components.js';
import type { PlatformStage, UpgradeFailureNotice } from './types.js';

/** The boot WARN for a durable upgrade-failure notice (re-printed every boot until an upgrade succeeds). */
export function describeUpgradeFailureNotice(notice: UpgradeFailureNotice, statusVersion: string | undefined): string {
    // The notice is durable and NOT self-expiring. Without age, a days-old
    // failure reads exactly like one that just happened — so state when it was
    // recorded and which version it targeted, and say plainly when that target
    // is not the version now running (stale evidence, not a new failure).
    const age = notice.ageLabel
        ? `${notice.ageLabel}, recorded ${notice.recordedAt}`
        : 'recorded at an unknown time';
    const target = notice.targetVersion ? `, attempted target v${notice.targetVersion}` : '';
    const running = (statusVersion || '').trim().replace(/^v/, '');
    const supersededHint = notice.targetVersion
        && running
        && notice.targetVersion.replace(/^v/, '') !== running
        ? ` This notice targets a DIFFERENT version than the one now running (v${running}) — it is most likely a stale record of an earlier attempt, not a report about this boot.`
        : '';
    return `Previous daemon upgrade FAILED and was rolled back — this daemon is running the previous version. Notice (${age}${target}) at ${notice.noticePath}:\n${notice.notice}${supersededHint}`;
}

export async function bootPlatform(cfg: DaemonBootConfig): Promise<PlatformStage> {
    // Freeze built-in prototypes and shadow process.exit/kill/abort/binding/dlopen
    // so provider-script callers throw instead of killing the daemon.
    applyProcessHardening();
    installProviderProcessShim();
    installGlobalInterceptor();

    // Persisted daemon env/flag overrides (config.json `envOverrides`) land in
    // process.env BEFORE anything reads a feature flag. Explicit process.env
    // always wins. Cannot retroactively fix a module-load-time constant an
    // earlier import already evaluated.
    const envOverrideResult = applyDaemonEnvOverrides(
        loadConfig().envOverrides,
        process.env,
        (msg) => LOG.warn('EnvOverrides', msg),
    );
    const envOverridesApplied = Object.keys(envOverrideResult.applied);
    if (envOverridesApplied.length > 0) {
        LOG.info('EnvOverrides', `Applied ${envOverridesApplied.length} persisted env override(s) from config.json: ${envOverridesApplied.join(', ')}`);
    }

    // Post-restart rollback visibility: a notice still present at boot means the
    // LAST upgrade attempt failed and this daemon runs the previous version. The
    // schedule-time response went out long before the helper failed, so this
    // log (plus get_status_metadata.upgradeFailure) is the only in-band signal.
    const upgradeFailure = readUpgradeFailureNotice();
    if (upgradeFailure) LOG.warn('Upgrade', describeUpgradeFailureNotice(upgradeFailure, cfg.statusVersion));

    // One-shot: record the effective provider channel as an explicit
    // config.providerChannel so the legacy updateChannel fallback (resolver
    // priority 4) can eventually go without flipping any machine's channel.
    try {
        const { migrateProviderChannelConfig } = await import('../../providers/channel/channel-migration.js');
        const migration = migrateProviderChannelConfig();
        if (migration.migrated) {
            LOG.info('Providers', `Recorded explicit providerChannel=${migration.channel} in config (migrated from build-track/updateChannel derivation)`);
        }
    } catch { /* best-effort — the resolver's fallback chain still applies */ }

    // Re-read AFTER the migration (and after the env-override read above,
    // which ran too early to see it).
    const appConfig = loadConfig();
    return { cfg, appConfig, envOverridesApplied, upgradeFailure };
}
