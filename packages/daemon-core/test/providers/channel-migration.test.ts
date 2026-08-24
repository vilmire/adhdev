/**
 * Provider-channel explicit-record migration.
 *
 * The properties pinned here are the ones that make the eventual removal of
 * the updateChannel fallback (resolveProviderChannel priority 4) safe:
 *   - a machine with no explicit providerChannel gets its EFFECTIVE channel
 *     recorded (updateChannel=preview machines stay preview)
 *   - an existing explicit choice is never rewritten
 *   - the session-scoped ADHDEV_PROVIDER_CHANNEL env override is never
 *     baked into persistent config
 *   - the migration is idempotent
 */
import { describe, expect, it, beforeEach } from 'vitest';

// Config writes land under getConfigDir(), isolated per-run to a tmp dir by
// test/helpers/setup-env.ts (ADHDEV_CONFIG_DIR). Do not reassign it here.
const { loadConfig, saveConfig, updateConfig } = await import('../../src/config/config.js');
const { migrateProviderChannelConfig } = await import('../../src/providers/channel/channel-migration.js');

function clearProviderChannel(): void {
    const config = loadConfig();
    delete (config as Record<string, unknown>).providerChannel;
    saveConfig(config);
}

describe('migrateProviderChannelConfig', () => {
    beforeEach(() => {
        clearProviderChannel();
        updateConfig({ updateChannel: 'stable' });
    });

    it('records stable for a machine with no channel signals', () => {
        const result = migrateProviderChannelConfig({});
        expect(result).toEqual({ migrated: true, channel: 'stable' });
        expect(loadConfig().providerChannel).toBe('stable');
    });

    it('records preview for a machine whose legacy updateChannel is preview', () => {
        updateConfig({ updateChannel: 'preview' });
        const result = migrateProviderChannelConfig({});
        expect(result).toEqual({ migrated: true, channel: 'preview' });
        expect(loadConfig().providerChannel).toBe('preview');
    });

    it('never rewrites an existing explicit providerChannel', () => {
        updateConfig({ providerChannel: 'preview', updateChannel: 'stable' });
        const result = migrateProviderChannelConfig({});
        expect(result).toEqual({ migrated: false, channel: 'preview' });
        expect(loadConfig().providerChannel).toBe('preview');
    });

    it('does not bake the session-scoped env override into config', () => {
        const result = migrateProviderChannelConfig({ ADHDEV_PROVIDER_CHANNEL: 'preview' });
        // updateChannel is stable and there is no preview build stamp in the
        // provided env — the durable derivation is stable even though the
        // session override says preview.
        expect(result).toEqual({ migrated: true, channel: 'stable' });
        expect(loadConfig().providerChannel).toBe('stable');
    });

    it('is idempotent — the second boot is a no-op', () => {
        expect(migrateProviderChannelConfig({}).migrated).toBe(true);
        expect(migrateProviderChannelConfig({}).migrated).toBe(false);
    });
});
