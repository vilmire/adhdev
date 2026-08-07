/**
 * RF-ROUTER LOW family — daemon self-upgrade + machine-settings commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Handlers
 * read only ctx.deps.packageName / ctx.deps.statusVersion plus process-global
 * config + npm/upgrade helpers, and return the same CommandRouterResult the
 * inlined cases did.
 *
 * Phase 3: the release channel is a build-time identity (track-identity.ts),
 * not a runtime switch. daemon_upgrade always targets THIS build's npm
 * dist-tag (IDENTITY.npmTag) and never rewrites updateChannel/serverUrl —
 * channel hints from pre-Phase-3 callers (dashboard updatePolicy payloads,
 * mesh restart_daemon_node / mesh_restart_daemon args) are accepted and
 * ignored so a stale payload can never retarget the daemon to another
 * environment, and a self-hoster's custom serverUrl is never clobbered.
 */
import { loadConfig, updateConfig, setQuotaShowAccountEmail } from '../../config/config.js';
import { installClaudeStatusline } from '../../quota/statusline/install.js';
import { execNpmCommandSync, getUpgradeLogPath, resolveCurrentGlobalInstallSurface, spawnDetachedDaemonUpgradeHelper } from '../upgrade-helper.js';
import { LOG } from '../../logging/logger.js';
import { IDENTITY, TRACK } from '../../track-identity.js';
import { resolveSessionHostAppName } from '../../session-host/app-name.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const daemonLifecycleHandlers: Record<string, LowFamilyHandler> = {
    daemon_upgrade: async (ctx: LowFamilyContext, args: any) => {
        LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
        try {
            // Detect package name for upgrade
            const isStandalone = ctx.deps.packageName === '@adhdev/daemon-standalone'
                || process.argv[1]?.includes('daemon-standalone');
            const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';
            const npmSurface = resolveCurrentGlobalInstallSurface({ packageName: pkgName });
            // Deprecated channel hints (args.channel / args.updatePolicy.channel /
            // args.npmTag) are accepted and ignored: the upgrade target is this
            // binary's build track, full stop.
            if (args?.channel || args?.updatePolicy?.channel || args?.npmTag) {
                LOG.info('Upgrade', 'Ignoring deprecated channel hint — upgrade target is the build track');
            }
            const npmTag = IDENTITY.npmTag;

            // Check the build track's dist-tag and resolve it to a concrete install version.
            const latest = String(execNpmCommandSync(['view', `${pkgName}@${npmTag}`, 'version'], { encoding: 'utf-8', timeout: 10000 }, npmSurface)).trim();
            LOG.info('Upgrade', `Latest ${pkgName}@${npmTag}: v${latest}`);
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
                LOG.info('Upgrade', `Already on ${TRACK} track version v${latest}; skipping install`);
                return { success: true, upgraded: false, alreadyLatest: true, outcome: 'already_latest', version: latest, targetVersion: latest, channel: TRACK, npmTag };
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
                sessionHostAppName: resolveSessionHostAppName(),
            });
            LOG.info('Upgrade', `Scheduled detached ${TRACK} upgrade to v${latest}`);

            // Exit after the command response has been sent so the helper can replace the package cleanly.
            setTimeout(() => {
                LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                process.exit(0);
            }, 3000);

            // INTENT vs RESULT: this response goes out seconds before the daemon
            // exits; the detached helper decides the real outcome (npm install,
            // staged verification, health gate, rollback) tens of seconds to
            // ~120s LATER, with no channel back to this caller. So `upgraded`/
            // `version` (kept verbatim for existing callers) mean "scheduled
            // towards this TARGET version", NOT "now running it". The honest
            // signal is `outcome: 'scheduled'` + `targetVersion`, and the only
            // place the actual result lands is upgradeLogPath (and, on failure,
            // the durable notice surfaced via get_status_metadata.upgradeFailure).
            return {
                success: true,
                upgraded: true,
                version: latest,
                restarting: true,
                channel: TRACK,
                npmTag,
                outcome: 'scheduled',
                targetVersion: latest,
                upgradeLogPath: getUpgradeLogPath(),
                clientHint: `Upgrade to v${latest} SCHEDULED, not completed — the detached helper installs and restarts the daemon after this response, and a failure rolls back to the previous version. Check upgradeLogPath (or get_status_metadata.upgradeFailure after the restart) for the actual outcome.`,
            };
        } catch (e: any) {
            LOG.error('Upgrade', `Failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    },

    // Restart-only path (mesh restart_daemon_node mode="restart"): re-spawn the
    // daemon WITHOUT the npm reinstall daemon_upgrade performs. Used to reset
    // daemon state (memory leaks, zombie sessions, wedged internals) when the
    // version is already correct — downtime drops to the detached re-spawn.
    // killSessionHost is an explicit opt-in hard refresh (see upgrade-helper).
    daemon_restart: async (ctx: LowFamilyContext, args: any) => {
        LOG.info('Restart', 'Restart-only requested (no package reinstall)');
        try {
            const isStandalone = ctx.deps.packageName === '@adhdev/daemon-standalone'
                || process.argv[1]?.includes('daemon-standalone');
            const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';
            const killSessionHost = args?.killSessionHost === true;
            if (killSessionHost) {
                LOG.warn('Restart', 'killSessionHost requested — session-host will be stopped and ALL hosted sessions destroyed');
            }

            spawnDetachedDaemonUpgradeHelper({
                packageName: pkgName,
                targetVersion: '',
                parentPid: process.pid,
                restartArgv: process.argv.slice(1),
                cwd: process.cwd(),
                sessionHostAppName: resolveSessionHostAppName(),
                skipInstall: true,
                killSessionHost,
            });
            LOG.info('Restart', 'Scheduled detached restart-only helper');

            // Exit after the command response has been sent so the helper can re-spawn cleanly.
            setTimeout(() => {
                LOG.info('Restart', 'Exiting daemon so detached helper can re-spawn it...');
                process.exit(0);
            }, 3000);

            // Same intent-vs-result contract as daemon_upgrade above: the
            // response only confirms the restart-only helper was SCHEDULED;
            // the detached re-spawn (and its trace in upgradeLogPath) is the
            // actual outcome.
            return {
                success: true,
                restarted: true,
                restarting: true,
                mode: 'restart',
                killSessionHost,
                outcome: 'scheduled',
                upgradeLogPath: getUpgradeLogPath(),
                clientHint: 'Restart SCHEDULED, not completed — the detached helper re-spawns the daemon after this response. Check upgradeLogPath for the actual outcome.',
            };
        } catch (e: any) {
            LOG.error('Restart', `Failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    },

    set_machine_nickname: async (_ctx: LowFamilyContext, args: any) => {
        const nickname = args?.nickname;
        updateConfig({ machineNickname: nickname || null });
        return { success: true };
    },

    /**
     * Read the quota account-label preference for the machine page toggle.
     * Machine-level config, so it is answered here rather than through
     * `get_provider_settings` (which is scoped to a provider's own manifest).
     */
    get_quota_account_label: async (_ctx: LowFamilyContext, _args: any) => {
        return { success: true, enabled: loadConfig().quotaShowAccountEmail === true };
    },

    /**
     * Set it. Routed through setQuotaShowAccountEmail (not updateConfig) so the
     * "a human chose this" marker is recorded — without it the value would be
     * treated as a stale default and overwritten on the next default change.
     *
     * Takes effect on the next quota tick with no restart: the fetcher reads the
     * config through a function at fetch time (quota/fetchers/deps.ts).
     */
    set_quota_account_label: async (_ctx: LowFamilyContext, args: any) => {
        if (typeof args?.enabled !== 'boolean') {
            return { success: false, error: 'enabled (boolean) is required' };
        }
        setQuotaShowAccountEmail(args.enabled);
        return { success: true, enabled: args.enabled };
    },

    /**
     * Read the per-provider quota probe switch for the machine page toggle.
     * Independent of the machine-use flag (`enabled`), which gates launching
     * and mesh claims: a machine can use a provider and still not want its
     * quota read here. Absent = enabled.
     */
    get_quota_provider_enabled: async (_ctx: LowFamilyContext, args: any) => {
        const providerType = args?.providerType;
        if (typeof providerType !== 'string' || !providerType) {
            return { success: false, error: 'providerType (string) is required' };
        }
        return { success: true, enabled: loadConfig().machineProviders?.[providerType]?.quotaEnabled !== false };
    },

    /**
     * Set it. Takes effect on the next quota tick with no restart: the refresh
     * predicate re-reads the config through the loader on every probe.
     *
     * Enabling CLAUDE installs the statusline wrapper FIRST. Claude Code has
     * no quota API — the statusLine wrapper is the only collection path, so
     * enabling without installing it would silently collect nothing. The
     * install runs here (not on any daemon boot path, which may never call
     * install — see quota/statusline/install.ts) because this is a
     * human-triggered command handler: the UI has already shown the user the
     * confirm dialog before calling. If the install throws, the config is NOT
     * written, so the toggle never claims a probe that cannot deliver.
     *
     * DISABLING does not uninstall the wrapper: uninstalling destroys the
     * backup of the user's original statusLine, which nothing here was asked
     * to do. It stays removable via `adhdev quota claude:uninstall`.
     *
     * codex-cli and kimi need nothing extra (codex spawns `codex app-server`,
     * kimi reads a token — no user-file side effects), so their toggle applies
     * immediately.
     */
    set_quota_provider_enabled: async (_ctx: LowFamilyContext, args: any) => {
        const providerType = args?.providerType;
        if (typeof providerType !== 'string' || !providerType) {
            return { success: false, error: 'providerType (string) is required' };
        }
        if (typeof args?.enabled !== 'boolean') {
            return { success: false, error: 'enabled (boolean) is required' };
        }
        const enabled = args.enabled;

        let statusline: string | undefined;
        if (providerType === 'claude-cli' && enabled) {
            try {
                statusline = installClaudeStatusline().outcome;
            } catch (e: any) {
                LOG.error('Quota', `Claude statusline install failed: ${e?.message || e}`);
                return { success: false, error: e?.message || String(e) };
            }
        }

        // updateConfig merges shallowly, so the per-provider entry is merged
        // here. Unset IS enabled — enabling removes the key rather than
        // storing an explicit `true`.
        const config = loadConfig();
        const entry = { ...(config.machineProviders?.[providerType] ?? {}) };
        if (enabled) delete entry.quotaEnabled;
        else entry.quotaEnabled = false;
        updateConfig({ machineProviders: { ...(config.machineProviders ?? {}), [providerType]: entry } });

        return { success: true, enabled, ...(statusline ? { statusline } : {}) };
    },
};
