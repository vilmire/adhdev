/**
 * One-shot config migration: make the provider channel explicit.
 *
 * The provider channel historically fell back to the daemon release channel
 * (`config.updateChannel`, resolveProviderChannel priority 4) — a key that
 * doctor/setup label "deprecated · ignored" on the RELEASE axis while it
 * stayed load-bearing on the PROVIDER axis. A user who trusts that output and
 * deletes the key silently flips a preview machine's provider bundle to
 * stable (fragmentation audit 2026-08-24, CRIT #4).
 *
 * This migration runs once per machine at daemon boot: when
 * `config.providerChannel` is absent, it computes the channel the machine is
 * EFFECTIVELY on today — from durable sources only (build-track stamp +
 * config.updateChannel) — and records it explicitly. After the fleet has
 * booted a build carrying this migration, the priority-4 updateChannel
 * fallback in resolveProviderChannel can be removed (Phase 3) without any
 * machine changing channels.
 *
 * Deliberately NOT durable-recorded: the ADHDEV_PROVIDER_CHANNEL env
 * override. It is session-scoped (e.g. sibling-workspace provider testing);
 * baking it into config would freeze a temporary override forever.
 */
import { loadConfig, updateConfig } from '../../config/config.js';
import {
    resolveProviderChannel,
    PROVIDER_CHANNEL_ENV_VAR,
    type ProviderChannel,
} from './contract.js';

export interface ProviderChannelMigrationResult {
    /** true when this call wrote an explicit providerChannel into config. */
    migrated: boolean;
    /** The explicit channel now recorded (or already present) in config. */
    channel: ProviderChannel;
}

export function migrateProviderChannelConfig(
    env: NodeJS.ProcessEnv = process.env,
): ProviderChannelMigrationResult {
    const config = loadConfig();
    const existing = (config.providerChannel ?? '').trim();
    if (existing) {
        return { migrated: false, channel: existing === 'preview' ? 'preview' : 'stable' };
    }
    const durableEnv: NodeJS.ProcessEnv = { ...env };
    delete durableEnv[PROVIDER_CHANNEL_ENV_VAR];
    const channel = resolveProviderChannel(undefined, durableEnv, config.updateChannel);
    updateConfig({ providerChannel: channel });
    return { migrated: true, channel };
}
