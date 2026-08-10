import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PER-PROVIDER QUOTA TOGGLE — the quotaEnabled axis.
//
// `machineProviders[type].enabled` says "this machine USES provider X" and
// gates launching, mesh claims and quota probes. `quotaEnabled` is a second,
// INDEPENDENT axis that gates ONLY the probe: a machine can use a provider
// and still not want its quota read here. Unset = enabled, so configs written
// before the axis existed keep probing; only an explicit `false` stops it.

// Same module-level fetcher mocking as quota-enabled-gate.test.ts: the
// fetcher modules are mocked so "was this provider probed at all" is a real
// call-count assertion.
const fetchClaudeQuota = vi.fn();
const fetchCodexQuota = vi.fn();
const fetchKimiQuota = vi.fn();

vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }));
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }));
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }));
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage: vi.fn(), OPENCODE_USAGE_DAYS: 7 }));

// The statusline install is mocked so enabling claude-cli never touches the
// real ~/.claude/settings.json, and so a failing install can be simulated.
const installClaudeStatusline = vi.fn();
vi.mock('../../src/quota/statusline/install.js', () => ({ installClaudeStatusline }));

const {
    clearQuotaCache,
    quotaProviderEnabledFromLoader,
    refreshQuotaCacheOnce,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js');
const { daemonLifecycleHandlers } = await import('../../src/commands/low-family/daemon-lifecycle.js');

const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    status: 'ok',
    metadata: {},
});

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
    configDir = join(tmpdir(), `adhdev-quota-toggle-${randomUUID().slice(0, 8)}`);
    mkdirSync(configDir, { recursive: true });
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
    installClaudeStatusline.mockReturnValue({ outcome: 'installed', originalCommand: null, paths: {} });
});

afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
    clearQuotaCache();
    __resetQuotaBootRefreshForTests();
    __resetQuotaHydrationForTests();
    vi.clearAllMocks();
});

describe('quotaProviderEnabledFromLoader — the two axes', () => {
    it('ANDs the machine-use gate with the quota gate', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'));
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'));
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'));

        const predicate = quotaProviderEnabledFromLoader({
            isMachineProviderEnabled: () => true,
            isMachineQuotaEnabled: (t) => t !== 'codex-cli',
        });
        expect(predicate('codex-cli')).toBe(false);
        expect(predicate('claude-cli')).toBe(true);
        expect(predicate('kimi')).toBe(true);

        await refreshQuotaCacheOnce(undefined, predicate);
        expect(fetchCodexQuota).not.toHaveBeenCalled();
        expect(fetchClaudeQuota).toHaveBeenCalledTimes(1);
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1);
    });

    it('treats a loader without isMachineQuotaEnabled as quota-enabled (backwards compat)', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'));
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'));
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'));

        // Loaders predating the axis (and minimal test doubles) have no quota
        // method — the predicate must fall back to the machine gate alone.
        const predicate = quotaProviderEnabledFromLoader({
            isMachineProviderEnabled: () => true,
        });
        expect(predicate('claude-cli')).toBe(true);
        expect(predicate('codex-cli')).toBe(true);
        expect(predicate('kimi')).toBe(true);

        await refreshQuotaCacheOnce(undefined, predicate);
        expect(fetchClaudeQuota).toHaveBeenCalledTimes(1);
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1);
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1);
    });

    it('keeps the machine gate authoritative: quota-enabled cannot probe a provider the machine does not use', async () => {
        const predicate = quotaProviderEnabledFromLoader({
            isMachineProviderEnabled: () => false,
            isMachineQuotaEnabled: () => true,
        });
        expect(predicate('claude-cli')).toBe(false);

        await refreshQuotaCacheOnce(undefined, predicate);
        expect(fetchClaudeQuota).not.toHaveBeenCalled();
        expect(fetchCodexQuota).not.toHaveBeenCalled();
        expect(fetchKimiQuota).not.toHaveBeenCalled();
    });
});

describe('config round-trip', () => {
    it('preserves an explicit quotaEnabled: false; a missing key stays missing', async () => {
        const { loadConfig, saveConfig } = await import('../../src/config/config.js');
        saveConfig({
            machineProviders: {
                'claude-cli': { enabled: true, quotaEnabled: false },
                'codex-cli': { enabled: true },
            },
        } as any);

        const loaded = loadConfig();
        expect(loaded.machineProviders?.['claude-cli']?.quotaEnabled).toBe(false);
        expect(loaded.machineProviders?.['codex-cli']?.quotaEnabled).toBeUndefined();
    });
});

describe('get/set_quota_provider_enabled handlers', () => {
    // These handlers ignore ctx — they read process-global config.
    const ctx = {} as any;
    const setHandler = daemonLifecycleHandlers.set_quota_provider_enabled;
    const getHandler = daemonLifecycleHandlers.get_quota_provider_enabled;

    it('disable writes quotaEnabled: false; re-enable removes the key (unset = enabled)', async () => {
        let res: any = await setHandler(ctx, { providerType: 'codex-cli', enabled: false });
        expect(res.success).toBe(true);
        expect((await getHandler(ctx, { providerType: 'codex-cli' })).enabled).toBe(false);

        res = await setHandler(ctx, { providerType: 'codex-cli', enabled: true });
        expect(res.success).toBe(true);
        const { loadConfig } = await import('../../src/config/config.js');
        expect(loadConfig().machineProviders?.['codex-cli']?.quotaEnabled).toBeUndefined();
        expect((await getHandler(ctx, { providerType: 'codex-cli' })).enabled).toBe(true);

        // codex needs no user-file side effect — the install is claude-only.
        expect(installClaudeStatusline).not.toHaveBeenCalled();
    });

    it('rejects invalid args', async () => {
        expect((await setHandler(ctx, {})).success).toBe(false);
        expect((await setHandler(ctx, { providerType: 'codex-cli' })).success).toBe(false);
        expect((await setHandler(ctx, { providerType: 'codex-cli', enabled: 'yes' })).success).toBe(false);
        expect((await getHandler(ctx, {})).success).toBe(false);
    });

    it('enabling claude-cli installs the statusline wrapper and reports the outcome', async () => {
        const res: any = await setHandler(ctx, { providerType: 'claude-cli', enabled: true });
        expect(res.success).toBe(true);
        expect(res.enabled).toBe(true);
        expect(res.statusline).toBe('installed');
        expect(installClaudeStatusline).toHaveBeenCalledTimes(1);
    });

    it('a failing claude-cli install leaves the config untouched', async () => {
        await setHandler(ctx, { providerType: 'claude-cli', enabled: false });
        installClaudeStatusline.mockImplementationOnce(() => { throw new Error('settings.json is not valid JSON'); });

        const res: any = await setHandler(ctx, { providerType: 'claude-cli', enabled: true });
        expect(res.success).toBe(false);
        expect(String(res.error)).toContain('settings.json is not valid JSON');
        // Install-first ordering: the toggle never claims a probe that cannot
        // deliver, so the stored value is still the previous one.
        expect((await getHandler(ctx, { providerType: 'claude-cli' })).enabled).toBe(false);
    });
});
