/**
 * `adhdev quota` for the standalone CLI.
 *
 * Standalone has no Commander dependency — its top-level dispatch in
 * index.ts is a hand-rolled `primaryCommand` switch (see `attach`/`list`).
 * This mirrors that shape for `quota` while reusing the exact fetch/install
 * logic and terminal rendering that `packages/daemon-cloud/src/cli/quota-commands.ts`
 * uses, both of which live in `@adhdev/daemon-core` so neither CLI host
 * duplicates them.
 */

import {
    fetchAntigravityQuota,
    fetchClaudeQuota,
    fetchCodexQuota,
    fetchGrokQuota,
    fetchKimiQuota,
    forceRefreshQuota,
    installClaudeStatusline,
    readStatuslineStatus,
    uninstallClaudeStatusline,
    StatuslineInstallError,
    printQuota,
    printQuotaRefreshOutcome,
    printClaudeInstallResult,
    printClaudeUninstallResult,
    printClaudeStatuslineStatus,
    printQuotaInstallError,
} from '@adhdev/daemon-core';

export const QUOTA_HELP_TEXT = `
Usage: adhdev quota <provider>
       adhdev quota refresh [providers...]
       adhdev quota claude:install | claude:uninstall | claude:status

Providers:
  antigravity  Show Antigravity CLI plan usage (queries the Cloud Code API live; macOS and Windows)
  claude    Show Claude Code plan usage (requires \`adhdev quota claude:install\`)
  codex     Show Codex CLI plan usage (queries codex app-server live)
  grok      Show Grok CLI plan usage (queries the xAI billing API live)
  kimi      Show Kimi Code plan usage (queries the Kimi API live)

Refresh:
  refresh   Re-read quota now. Providers that recently returned HTTP 429 are
            NOT re-probed — the cooldown is reported with the time it lifts,
            because re-hitting the endpoint extends the provider's own throttle.
            Local-file providers (claude, codex) have no cooldown.

Claude Code setup (antigravity/codex/grok/kimi need no setup — they query live):
  claude:install     Set up Claude Code quota reporting by wrapping your statusline
  claude:uninstall   Remove Claude Code quota reporting and restore your original statusline
  claude:status      Show whether Claude Code quota reporting is set up
`;

/** Runs `adhdev quota <...args>`; returns the process exit code. */
export async function runQuotaCommand(args: readonly string[]): Promise<number> {
    const sub = args[0];
    switch (sub) {
        case 'antigravity':
        case 'agy':
            printQuota('Antigravity CLI', await fetchAntigravityQuota());
            return 0;
        case 'claude':
            printQuota('Claude Code', await fetchClaudeQuota());
            return 0;
        case 'codex':
            printQuota('Codex CLI', await fetchCodexQuota());
            return 0;
        case 'grok':
            printQuota('Grok CLI', await fetchGrokQuota());
            return 0;
        case 'kimi':
            printQuota('Kimi Code', await fetchKimiQuota());
            return 0;
        case 'refresh': {
            // Same shared entry point the daemon command uses
            // (daemon-core forceRefreshQuota), so the 429 cooldown, the
            // enable gate and the last-good carry-forward behave identically
            // on both CLI hosts instead of being re-implemented per surface.
            //
            // Standalone runs this in the CLI process. Unlike the cloud CLI —
            // which sends `refresh_provider_quota` to the running daemon over
            // local IPC — standalone has no always-on command channel (its IPC
            // server is opt-in), so what this warms is this process's cache. A
            // standalone daemon in the same process (`adhdev` with no
            // subcommand) picks up its own refreshes through the normal axis
            // TTL / SWR / backfill paths.
            const { entries } = await forceRefreshQuota(args.slice(1));
            printQuotaRefreshOutcome(entries);
            return entries.some((e) => e.outcome === 'unsupported') ? 1 : 0;
        }
        case 'claude:install':
        case 'claude-install': {
            try {
                printClaudeInstallResult(installClaudeStatusline());
                return 0;
            } catch (err) {
                if (err instanceof StatuslineInstallError) {
                    printQuotaInstallError(err.message);
                    return 1;
                }
                throw err;
            }
        }
        case 'claude:uninstall':
        case 'claude-uninstall': {
            try {
                printClaudeUninstallResult(uninstallClaudeStatusline());
                return 0;
            } catch (err) {
                if (err instanceof StatuslineInstallError) {
                    printQuotaInstallError(err.message);
                    return 1;
                }
                throw err;
            }
        }
        case 'claude:status':
            printClaudeStatuslineStatus(readStatuslineStatus());
            return 0;
        default:
            console.log(QUOTA_HELP_TEXT);
            return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 1;
    }
}
