/**
 * Quota CLI rendering — shared terminal output for `adhdev quota`.
 *
 * Both daemon-cloud (Commander-based `adhdev quota ...`) and daemon-standalone
 * (hand-rolled arg parsing) need identical output for the same underlying
 * fetch/install results, so the rendering lives here once instead of being
 * duplicated per CLI host.
 */

import * as fs from 'node:fs';
import chalk from 'chalk';
import { formatQuotaAccount, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import type { ProviderQuota, QuotaWindow } from './types.js';
import type { InstallResult, UninstallResult, StatuslineStatus } from './statusline/install.js';

/**
 * Why Claude alone needs an install step, in one line — shared by the "not
 * set up" error addendum and `claude:status`'s not-installed summary so the
 * two surfaces never drift apart.
 */
const CLAUDE_NO_API_LINE = 'Claude has no quota API — adhdev borrows your statusLine to read it.';
/** What install actually does to the user's config, in one line. */
const CLAUDE_WRAP_NOT_REPLACE_LINE = 'Install wraps (not replaces) your statusline, so nothing is lost.';

/**
 * Mirrors web-core's `quotaWindowCue` / `formatQuotaWindow`. daemon-core cannot
 * import web-core, so the cue decision is duplicated here on purpose:
 *  - `refreshing` — last-good carry-forward after a TRANSIENT failure
 *  - `stale` — `failureKind: 'no-data'` with retained windows (Claude
 *    statusline aged out). Distinct from refreshing: nothing is retrying.
 */
function windowCue(quota: ProviderQuota): 'refreshing' | 'stale' | undefined {
    if (quota.metadata?.lastGoodWindows === true) return 'refreshing';
    if (quota.metadata?.failureKind === 'no-data' && (quota.session || quota.weekly)) return 'stale';
    return undefined;
}

function formatWindow(label: string, window: QuotaWindow | null, cue: 'refreshing' | 'stale' | undefined = undefined): string {
    if (!window) {
        return `  ${label.padEnd(8)} ${chalk.gray('not reported')}`;
    }
    const percent = `${window.usedPercent.toFixed(1)}%`;
    const bar = renderBar(window.usedPercent);
    const reset = window.resetsAt === null ? '' : chalk.gray(`  resets ${formatRelative(window.resetsAt)}`);
    const marker = cue === 'refreshing' ? chalk.gray('  (refreshing)') : cue === 'stale' ? chalk.gray('  (stale)') : '';
    return `  ${label.padEnd(8)} ${bar} ${percent.padStart(6)} used${reset}${marker}`;
}

function renderBar(usedPercent: number): string {
    const width = 20;
    const filled = Math.round((Math.min(100, Math.max(0, usedPercent)) / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    if (usedPercent >= 90) return chalk.red(bar);
    if (usedPercent >= 70) return chalk.yellow(bar);
    return chalk.green(bar);
}

function formatRelative(atMs: number): string {
    const deltaMs = atMs - Date.now();
    if (deltaMs <= 0) {
        return 'now';
    }
    const minutes = Math.round(deltaMs / 60_000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** "3m ago" / "2h 14m ago" — the past-time counterpart to formatRelative. */
function formatAgo(atMs: number): string {
    const deltaMs = Date.now() - atMs;
    if (deltaMs <= 0) return 'just now';
    const minutes = Math.round(deltaMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/** Render one provider's quota block: "5 hour"/"7 day" bars + any error line. */
export function printQuota(name: string, quota: ProviderQuota): void {
    console.log();
    // The account label uses the SAME formatter the three dashboards use
    // (mesh-shared formatQuotaAccount), so the CLI cannot drift from them —
    // the CLI showing nothing while the UI showed an account is the exact
    // inconsistency this shares a function to prevent. Null when there is
    // nothing to say (no account reported, or the option is off, in which case
    // the email was never fetched), and then the heading renders alone.
    const account = formatQuotaAccount(quota as unknown as MeshNodeFactsProviderQuota);
    console.log(account ? `${chalk.bold(name)}  ${chalk.gray(account)}` : chalk.bold(name));
    if (quota.status === 'ok' || quota.session || quota.weekly) {
        const cue = windowCue(quota);
        console.log(formatWindow('5 hour', quota.session, cue));
        console.log(formatWindow('7 day', quota.weekly, cue));
    }
    if (quota.error) {
        const tone = quota.status === 'unavailable' ? chalk.gray : chalk.yellow;
        console.log(`  ${tone(quota.error)}`);
        // Claude is the one provider that needs a setup step, and the reason is
        // not obvious from the one-line error alone (a coordinator misread this
        // as "install overwrites your statusline" on 2026-08-05 — it wraps it).
        // Matched on the install-command mention specifically, not just
        // provider+unavailable, so the OTHER claude-cli unavailable message
        // ("no snapshot yet" — already installed, just needs a session) does not
        // get this addendum it doesn't need.
        if (quota.provider === 'claude-cli' && quota.error.includes('claude:install')) {
            console.log(`  ${chalk.gray(CLAUDE_NO_API_LINE)}`);
            console.log(`  ${chalk.gray(CLAUDE_WRAP_NOT_REPLACE_LINE)}`);
        }
    }
    console.log();
}

/** Render the outcome of `installClaudeStatusline()`. */
export function printClaudeInstallResult(result: InstallResult): void {
    console.log();
    console.log(
        chalk.green(
            result.outcome === 'reinstalled'
                ? '✓ Claude Code quota reporting re-installed'
                : '✓ Claude Code quota reporting installed',
        ),
    );
    if (result.originalCommand) {
        console.log(chalk.gray('  Your existing statusline is preserved and still runs:'));
        console.log(chalk.gray(`    ${truncate(result.originalCommand, 100)}`));
        console.log(chalk.gray(`  Backup: ${result.paths.backupFile}`));
    } else {
        console.log(chalk.gray('  You had no statusline configured; one was not added.'));
    }
    console.log();
    console.log(chalk.gray('  Open a Claude Code session, then run `adhdev quota claude`.'));
    console.log(chalk.gray('  Undo any time with `adhdev quota claude:uninstall`.'));
    console.log();
}

/** Render the outcome of `uninstallClaudeStatusline()`. */
export function printClaudeUninstallResult(result: UninstallResult): void {
    console.log();
    if (result.outcome === 'restored') {
        console.log(chalk.green('✓ Your original statusline has been restored'));
    } else if (result.outcome === 'removed') {
        console.log(chalk.green('✓ Claude Code quota reporting removed'));
        console.log(chalk.gray('  You had no statusline before install, so none was left behind.'));
    } else {
        console.log(chalk.yellow('• Claude Code quota reporting was not installed'));
        console.log(chalk.gray('  Your statusLine setting was left untouched.'));
    }
    console.log();
}

/** Render the result of `readStatuslineStatus()`. */
export function printClaudeStatuslineStatus(status: StatuslineStatus): void {
    console.log();
    if (status.installed) {
        console.log(chalk.green('✓ Installed'));
        console.log(
            chalk.gray(
                status.wrappedCommand
                    ? `  Wrapping your statusline: ${truncate(status.wrappedCommand, 100)}`
                    : '  You had no statusline before install.',
            ),
        );
        console.log(chalk.gray(`  Wrapper: ${status.paths.wrapperFile}`));
        console.log(chalk.gray(`  Backup: ${status.paths.backupFile}`));
        let snapshotMtimeMs: number | null = null;
        try {
            snapshotMtimeMs = fs.statSync(status.paths.snapshotFile).mtimeMs;
        } catch {
            // No snapshot yet — a Claude Code session has not run since install.
        }
        console.log(chalk.gray(
            snapshotMtimeMs === null
                ? '  Last snapshot: none yet — open a Claude Code session to record one'
                : `  Last snapshot: ${formatAgo(snapshotMtimeMs)} (${status.paths.snapshotFile})`,
        ));
        console.log(chalk.gray('  Undo with `adhdev quota claude:uninstall`.'));
    } else {
        console.log(chalk.yellow('• Not installed'));
        if (status.foreignStatusLine) {
            console.log(chalk.gray('  You have your own statusLine configured; install would wrap it.'));
        }
        console.log(chalk.gray(`  ${CLAUDE_NO_API_LINE}`));
        console.log(chalk.gray(`  ${CLAUDE_WRAP_NOT_REPLACE_LINE}`));
        console.log(chalk.gray('  Set up with `adhdev quota claude:install`.'));
    }
    console.log();
}

/** Render a `StatuslineInstallError` the same way both CLI hosts do. */
export function printQuotaInstallError(message: string): void {
    console.error(chalk.red(`\n✗ ${message}\n`));
}
