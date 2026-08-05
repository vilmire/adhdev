import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printQuota, printClaudeStatuslineStatus } from '../../src/quota/cli.js';
import type { ProviderQuota } from '../../src/quota/types.js';
import type { StatuslineStatus, StatuslineInstallPaths } from '../../src/quota/statusline/install.js';

// A coordinator misread the pre-existing "Claude quota reporting is not set
// up — run `adhdev quota claude:install`" line on 2026-08-05 as "install
// overwrites your statusline" — it wraps it, and the original is backed up.
// These tests lock the addendum that explains why/what/preserved so the same
// misreading does not recur, and the ★safety boundary that the addendum only
// appears for the actual "not set up" case, never for the unrelated
// "installed but no snapshot yet" unavailable message.

function captureLogs(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
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
            wrappedCommand: 'my-old-statusline.sh',
            foreignStatusLine: false,
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
            wrappedCommand: null,
            foreignStatusLine: false,
            paths,
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toMatch(/Last snapshot: none yet/);
    });

    it('not installed: shows the install command and the why/what-changes summary', () => {
        const status: StatuslineStatus = {
            installed: false,
            wrappedCommand: null,
            foreignStatusLine: false,
            paths: fakePaths(),
        };

        const joined = captureLogs(() => printClaudeStatuslineStatus(status)).join('\n');

        expect(joined).toContain('• Not installed');
        expect(joined).toMatch(/no quota API/i);
        expect(joined).toMatch(/wraps.*not replace/i);
        expect(joined).toContain('claude:install');
    });
});
