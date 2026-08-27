import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printQuota, printClaudeStatuslineStatus, printClaudeInstallResult } from '../../src/quota/cli.js';
import { formatQuotaAccount } from '@adhdev/mesh-shared';
import type { ProviderQuota } from '../../src/quota/types.js';
import type { InstallResult, StatuslineStatus, StatuslineInstallPaths } from '../../src/quota/statusline/install.js';

// A coordinator misread the pre-existing "Claude quota reporting is not set
// up — run `adhdev quota claude:install`" line on 2026-08-05 as "install
// overwrites your statusline" — it wraps it, and the original is backed up.
// These tests lock the addendum that explains why/what/preserved so the same
// misreading does not recur, and the ★safety boundary that the addendum only
// appears for the actual "not set up" case, never for the unrelated
// "installed but no snapshot yet" unavailable message.

// chalk's color decision depends on ambient terminal detection (isTTY,
// FORCE_COLOR, CI, TERM, ...), which this suite does not control. A dev
// shell with FORCE_COLOR set makes chalk emit real ANSI escapes here even
// under a piped test run, which every other assertion in this file already
// tolerates via .toContain() on a substring — strip them so exact-match
// assertions are equally indifferent to the ambient color setting.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function captureLogs(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ').replace(ANSI_PATTERN, '')); };
    try {
        fn();
    } finally {
        console.log = original;
    }
    return lines;
}

function fakePaths(overrides: Partial<StatuslineInstallPaths> = {}): StatuslineInstallPaths {
    return {
        settingsFile: '/home/user/.claude/settings.json',
        wrapperFile: '/home/user/.adhdev/claude-statusline/adhdev-statusline.mjs',
        snapshotFile: '/home/user/.adhdev/claude-statusline/quota.json',
        backupFile: '/home/user/.adhdev/claude-statusline/statusline-backup.json',
        stateDir: '/home/user/.adhdev/claude-statusline',
        ...overrides,
    };
}

describe('printQuota — the claude "not set up" addendum', () => {
    it('explains why, what changes, and that existing config is preserved when claude is not set up', () => {
        const quota: ProviderQuota = {
            provider: 'claude-cli',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: 'Claude quota reporting is not set up — run `adhdev quota claude:install`',
            status: 'unavailable',
            metadata: { source: 'statusline', failureKind: 'missing-credentials' },
        };
        const joined = captureLogs(() => printQuota('Claude Code', quota)).join('\n');

        expect(joined).toContain('Claude quota reporting is not set up');
        // WHY: no outbound API.
        expect(joined).toMatch(/no quota API/i);
        // WHAT CHANGES + PRESERVED: wraps, does not replace, nothing lost.
        expect(joined).toMatch(/wraps.*not replace/i);
        expect(joined).toMatch(/nothing is lost/i);
        // Short: original line + exactly 2 addendum lines, not a wall of text.
        const nonBlankLines = captureLogs(() => printQuota('Claude Code', quota)).filter(l => l.trim() !== '');
        expect(nonBlankLines.length).toBeLessThanOrEqual(4); // name + error + 2 addendum lines
    });

    // ★safety boundary: the OTHER claude-cli unavailable message (already
    // installed, just waiting for a session) must not get the setup addendum —
    // it would be actively confusing ("install" advice for an already-installed user).
    it('does NOT show the setup addendum for the "no snapshot yet" (already installed) message', () => {
        const quota: ProviderQuota = {
            provider: 'claude-cli',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: 'No Claude quota captured yet — open a Claude Code session to record one',
            status: 'unavailable',
            metadata: { source: 'statusline', failureKind: 'missing-credentials' },
        };
        const joined = captureLogs(() => printQuota('Claude Code', quota)).join('\n');

        expect(joined).toContain('No Claude quota captured yet');
        expect(joined).not.toMatch(/no quota API/i);
        expect(joined).not.toMatch(/wraps.*not replace/i);
    });

    // ★safety boundary: other providers' unavailable/error messages are
    // completely unaffected — this is a claude-cli-only addendum.
    it('does NOT show the claude addendum for a different provider', () => {
        const quota: ProviderQuota = {
            provider: 'kimi',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: 'Not signed in to Kimi Code',
            status: 'unavailable',
            metadata: { source: 'oauth', failureKind: 'missing-credentials' },
        };
        const joined = captureLogs(() => printQuota('Kimi Code', quota)).join('\n');

        expect(joined).toContain('Not signed in to Kimi Code');
        expect(joined).not.toMatch(/no quota API/i);
        expect(joined).not.toMatch(/wraps.*not replace/i);
    });

    it('an ok snapshot renders windows with no addendum at all', () => {
        const quota: ProviderQuota = {
            provider: 'claude-cli',
            session: { usedPercent: 12, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 4, windowMinutes: 10080, resetsAt: null },
            updatedAt: Date.now(),
            error: null,
            status: 'ok',
        };
        const joined = captureLogs(() => printQuota('Claude Code', quota)).join('\n');

        expect(joined).toMatch(/12\.0%/);
        expect(joined).not.toMatch(/no quota API/i);
    });
});

// LAST-GOOD CARRY-FORWARD CLI PARITY — mirrors web-core's formatQuotaWindow
// (quota-format-last-good.test.ts): when daemon-core's
// carryForwardLastGoodWindows retains a prior reading after a TRANSIENT
// failure (metadata.lastGoodWindows), the CLI must not print those numbers
// as if they were freshly measured this tick.
describe('printQuota — last-good carry-forward marker', () => {
    const carriedQuota: ProviderQuota = {
        provider: 'kimi',
        session: { usedPercent: 28, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 71, windowMinutes: 10080, resetsAt: null },
        updatedAt: 1,
        error: 'kimi expired-token',
        status: 'error',
        metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true } as any,
    };

    it('appends "(refreshing)" to a carried-forward window', () => {
        const joined = captureLogs(() => printQuota('Kimi Code', carriedQuota)).join('\n');
        expect(joined).toMatch(/28\.0%.*\(refreshing\)/);
        expect(joined).toMatch(/71\.0%.*\(refreshing\)/);
    });

    it('does NOT append the marker to a freshly measured window', () => {
        const fresh: ProviderQuota = {
            provider: 'kimi',
            session: { usedPercent: 28, windowMinutes: 300, resetsAt: null },
            weekly: null,
            updatedAt: 1,
            error: null,
            status: 'ok',
            metadata: { source: 'oauth' },
        };
        const joined = captureLogs(() => printQuota('Kimi Code', fresh)).join('\n');
        expect(joined).not.toContain('(refreshing)');
        expect(joined).not.toContain('(stale)');
    });
});

describe('printQuota — no-data stale marker', () => {
    const claudeStale: ProviderQuota = {
        provider: 'claude-cli',
        session: { usedPercent: 23.5, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 11, windowMinutes: 10080, resetsAt: null },
        updatedAt: 1,
        error: 'Claude quota reading is stale (1201 min old) — open a Claude Code session to refresh',
        status: 'error',
        metadata: { source: 'statusline', failureKind: 'no-data' },
    };

    it('appends "(stale)" to no-data windows, not "(refreshing)"', () => {
        const joined = captureLogs(() => printQuota('Claude Code', claudeStale)).join('\n');
        expect(joined).toMatch(/23\.5%.*\(stale\)/);
        expect(joined).toMatch(/11\.0%.*\(stale\)/);
        expect(joined).not.toContain('(refreshing)');
    });
});

describe('printClaudeStatuslineStatus — diagnostic output', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-quota-cli-status-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('installed: shows wrapper path, backup location, last snapshot time, and the revert command', () => {
        const snapshotFile = path.join(tempDir, 'quota.json');
        fs.writeFileSync(snapshotFile, '{}', 'utf-8');
        const paths = fakePaths({ snapshotFile });
        const status: StatuslineStatus = {
            installed: true,
            failureKind: null,
            danglingWrapperPath: null,
            wrappedCommand: 'my-old-statusline.sh',
            foreignStatusLine: false,
            volatileWrapperReason: null,
            paths,
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toContain('✓ Installed');
        expect(joined).toContain(paths.wrapperFile);
        expect(joined).toContain(paths.backupFile);
        expect(joined).toMatch(/Last snapshot:.*(just now|ago)/);
        expect(joined).toContain('claude:uninstall');
    });

    it('installed but no snapshot yet: says so instead of a stale/fake time', () => {
        const paths = fakePaths({ snapshotFile: path.join(tempDir, 'never-written.json') });
        const status: StatuslineStatus = {
            installed: true,
            failureKind: null,
            danglingWrapperPath: null,
            wrappedCommand: null,
            foreignStatusLine: false,
            volatileWrapperReason: null,
            paths,
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toMatch(/Last snapshot: none yet/);
    });

    it('not installed: shows the install command and the why/what-changes summary', () => {
        const status: StatuslineStatus = {
            installed: false,
            failureKind: null,
            danglingWrapperPath: null,
            wrappedCommand: null,
            foreignStatusLine: false,
            volatileWrapperReason: null,
            paths: fakePaths(),
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toContain('• Not installed');
        expect(joined).toMatch(/no quota API/i);
        expect(joined).toMatch(/wraps.*not replace/i);
        expect(joined).toContain('claude:install');
    });

    it('wrapper-missing: renders as its own state, borrowing neither of the other two', () => {
        // The 2026-08-20 failure was a two-state render for a three-state
        // world. "✓ Installed" would send the user to open a session that
        // cannot capture anything; "• Not installed" would hide that their
        // statusline is erroring on every prompt. Both are asserted absent.
        const status: StatuslineStatus = {
            installed: false,
            failureKind: 'wrapper-missing',
            danglingWrapperPath: '/private/tmp/gone/scratchpad/adhdev-statusline.mjs',
            wrappedCommand: 'my-old-statusline.sh',
            foreignStatusLine: false,
            volatileWrapperReason: 'a system temp directory, whose contents are reaped by the OS',
            paths: fakePaths(),
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toContain('✗ Broken');
        expect(joined).toContain('/private/tmp/gone/scratchpad/adhdev-statusline.mjs');
        expect(joined).toContain('claude:install');
        expect(joined).not.toContain('✓ Installed');
        expect(joined).not.toContain('• Not installed');
        expect(joined).not.toMatch(/open a Claude Code session to record one/);
    });
});

describe('printClaudeInstallResult — each message states only what was observed', () => {
    function result(overrides: Partial<InstallResult>): InstallResult {
        return {
            outcome: 'installed',
            originalCommand: null,
            repairedFrom: null,
            volatileWrapperReason: null,
            paths: fakePaths(),
            ...overrides,
        };
    }

    it('claims "you had no statusline" ONLY when that is what install saw', () => {
        const joined = captureLogs(() => printClaudeInstallResult(result({ outcome: 'installed' }))).join('\n');

        expect(joined).toContain('You had no statusline configured');
    });

    it('never claims "you had no statusline" when one was wrapped', () => {
        // The owner was shown this exact false line on 2026-08-20.
        const joined = captureLogs(() =>
            printClaudeInstallResult(result({ outcome: 'wrapped', originalCommand: 'echo mine' })),
        ).join('\n');

        expect(joined).not.toContain('You had no statusline configured');
        expect(joined).toContain('echo mine');
        expect(joined).toMatch(/preserved/i);
    });

    it('never claims "you had no statusline" when repairing a dangling entry', () => {
        // The dangling case has no wrapped command either, so a message keyed
        // on `originalCommand` alone lands back on the same false claim.
        const joined = captureLogs(() =>
            printClaudeInstallResult(
                result({ outcome: 'repaired', repairedFrom: '/gone/adhdev-statusline.mjs' }),
            ),
        ).join('\n');

        expect(joined).not.toContain('You had no statusline configured');
        expect(joined).toContain('repaired');
        expect(joined).toContain('/gone/adhdev-statusline.mjs');
    });

    it('warns about a volatile install location without claiming failure', () => {
        const joined = captureLogs(() =>
            printClaudeInstallResult(
                result({ volatileWrapperReason: 'a worktree scratchpad, which is deleted when that worktree goes away' }),
            ),
        ).join('\n');

        expect(joined).toContain('✓');
        expect(joined).toMatch(/worktree scratchpad/);
        expect(joined).toContain('claude:install');
    });
});

// ACCOUNT LABEL PARITY — the CLI must show what the dashboards show.
//
// The owner's report: "adhdev quota shows no account label" while the three
// dashboards did. The fix is not a second formatter in the CLI — that is how
// the drift started — but the SAME mesh-shared `formatQuotaAccount` both
// surfaces call. These tests pin the parity, not merely the presence.
describe('printQuota — account label parity with the dashboards', () => {
    const okQuota = (metadata: Record<string, unknown>) => ({
        provider: 'codex-cli',
        session: null,
        weekly: { usedPercent: 27, windowMinutes: 10080, resetsAt: null },
        updatedAt: 1,
        error: null,
        status: 'ok',
        metadata,
    }) as any;

    it('prints the account label next to the provider heading', () => {
        const joined = captureLogs(() => printQuota('Codex CLI', okQuota({
            source: 'app-server', planType: 'plus', accountEmail: 'user@example.com',
        }))).join('\n');
        expect(joined).toContain('user@example.com');
        expect(joined).toContain('Codex CLI');
    });

    it('renders EXACTLY what the shared formatter produces (no CLI-only format)', () => {
        // Parity assertion: if the CLI ever grows its own string, this breaks.
        const quota = okQuota({ planType: 'plus', accountEmail: 'user@example.com' });
        const expected = formatQuotaAccount(quota)!;
        expect(expected).toBe('user@example.com · plus');
        expect(captureLogs(() => printQuota('Codex CLI', quota)).join('\n')).toContain(expected);
    });

    it('shows the plan alone when no account was reported', () => {
        // planType is not gated by the account option, so it still renders.
        const joined = captureLogs(() => printQuota('Codex CLI', okQuota({ planType: 'plus' }))).join('\n');
        expect(joined).toContain('plus');
    });

    it('renders the heading alone when there is nothing to label', () => {
        // Claude Code reports no account at all — no empty separator, no
        // "unknown" placeholder, and no stray blank segment.
        const lines = captureLogs(() => printQuota('Claude Code', okQuota({ source: 'statusline' })));
        const heading = lines.find(l => l.includes('Claude Code'))!;
        expect(heading.trim()).toBe('Claude Code');
        expect(heading).not.toContain('·');
    });
});
