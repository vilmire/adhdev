/**
 * RF-ROUTER LOW family — daemon self-upgrade + machine-settings commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. The
 * release-channel helpers (ReleaseChannel / CHANNEL_* / normalizeReleaseChannel /
 * resolveUpgradeChannel) were router module-locals used only by daemon_upgrade, so
 * they are relocated here unchanged. Handlers read only ctx.deps.packageName /
 * ctx.deps.statusVersion plus process-global config + npm/upgrade helpers, and
 * return the same CommandRouterResult the inlined cases did.
 */
import { loadConfig, updateConfig } from '../../config/config.js';
import { execNpmCommandSync, resolveCurrentGlobalInstallSurface, spawnDetachedDaemonUpgradeHelper } from '../upgrade-helper.js';
import { LOG } from '../../logging/logger.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

type ReleaseChannel = 'stable' | 'preview';
const CHANNEL_NPM_TAG: Record<ReleaseChannel, 'latest' | 'next'> = { stable: 'latest', preview: 'next' };
const CHANNEL_SERVER_URL: Record<ReleaseChannel, string> = {
    stable: 'https://api.adhf.dev',
    preview: 'https://api-preview.adhf.dev',
};

function normalizeReleaseChannel(value: unknown): ReleaseChannel | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'stable' || normalized === 'latest') return 'stable';
    if (normalized === 'preview' || normalized === 'next') return 'preview';
    return null;
}

function resolveUpgradeChannel(args: any): ReleaseChannel {
    return normalizeReleaseChannel(args?.channel)
        || normalizeReleaseChannel(args?.updatePolicy?.channel)
        || normalizeReleaseChannel(args?.npmTag)
        || normalizeReleaseChannel(loadConfig().updateChannel)
        || 'stable';
}

export const daemonLifecycleHandlers: Record<string, LowFamilyHandler> = {
    daemon_upgrade: async (ctx: LowFamilyContext, args: any) => {
        LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
        try {
            // Detect package name for upgrade
            const isStandalone = ctx.deps.packageName === '@adhdev/daemon-standalone'
                || process.argv[1]?.includes('daemon-standalone');
            const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';
            const npmSurface = resolveCurrentGlobalInstallSurface({ packageName: pkgName });
            const channel = resolveUpgradeChannel(args);
            const npmTag = CHANNEL_NPM_TAG[channel];

            // Check channel-pinned dist-tag and resolve it to a concrete install version.
            const latest = String(execNpmCommandSync(['view', `${pkgName}@${npmTag}`, 'version'], { encoding: 'utf-8', timeout: 10000 }, npmSurface)).trim();
            LOG.info('Upgrade', `Latest ${pkgName}@${npmTag}: v${latest}`);
            updateConfig({ updateChannel: channel, serverUrl: CHANNEL_SERVER_URL[channel] } as any);
            let currentInstalled: string | null = null;
            try {
                const currentJson = String(execNpmCommandSync(['ls', '-g', pkgName, '--depth=0', '--json'], {
                    encoding: 'utf-8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }, npmSurface)).trim();
                const parsed = JSON.parse(currentJson);
                currentInstalled = parsed?.dependencies?.[pkgName]?.version || null;
            } catch {
                // ignore ls failures; upgrade can still proceed
            }

            const runningVersion = typeof ctx.deps.statusVersion === 'string'
                ? ctx.deps.statusVersion.trim().replace(/^v/, '')
                : null;
            if (currentInstalled === latest && runningVersion === latest) {
                LOG.info('Upgrade', `Already on ${channel} channel version v${latest}; skipping install`);
                return { success: true, upgraded: false, alreadyLatest: true, version: latest, channel, npmTag };
            }
            if (currentInstalled === latest && runningVersion && runningVersion !== latest) {
                LOG.info('Upgrade', `Installed package is v${latest}, but running daemon is v${runningVersion}; scheduling restart`);
            }

            spawnDetachedDaemonUpgradeHelper({
                packageName: pkgName,
                targetVersion: latest,
                parentPid: process.pid,
                restartArgv: process.argv.slice(1),
                cwd: process.cwd(),
                sessionHostAppName: process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev',
            });
            LOG.info('Upgrade', `Scheduled detached ${channel} upgrade to v${latest}`);

            // Exit after the command response has been sent so the helper can replace the package cleanly.
            setTimeout(() => {
                LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                process.exit(0);
            }, 3000);

            return { success: true, upgraded: true, version: latest, restarting: true, channel, npmTag };
        } catch (e: any) {
            LOG.error('Upgrade', `Failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    },

    set_machine_nickname: async (_ctx: LowFamilyContext, args: any) => {
        const nickname = args?.nickname;
        updateConfig({ machineNickname: nickname || null });
        return { success: true };
    },
};
