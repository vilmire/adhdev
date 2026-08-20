/**
 * The dangling-wrapper regression.
 *
 * Measured 2026-08-20: `~/.claude/settings.json` held a `statusLine.command`
 * pointing at a deleted worktree scratchpad, so Claude Code ran a command that
 * exited MODULE_NOT_FOUND on every prompt. Because the install check matched on
 * the command STRING alone and never asked the filesystem, the product reported
 * two mutually contradictory and both-wrong things: status said "installed —
 * open a Claude Code session to record one" (four were already open), and
 * install said "You had no statusline configured" (one plainly was).
 *
 * The fix is a THIRD state. These tests assert all three are distinguishable,
 * because collapsing any two of them back together is what reproduces the bug.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    classifyStatuslineCommand,
    installClaudeStatusline,
    readStatuslineStatus,
    resolveInstallPaths,
} from '../../src/quota/statusline/install';
import { classifyVolatilePath } from '../../src/config/embedded-path-health';
import { fetchClaudeQuota } from '../../src/quota/fetchers/claude';

let tempRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-dangling-'));
    env = {
        ADHDEV_CONFIG_DIR: path.join(tempRoot, 'adhdev'),
        CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude'),
    } as NodeJS.ProcessEnv;
    fs.mkdirSync(path.join(tempRoot, 'claude'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeSettings(value: unknown): void {
    fs.writeFileSync(resolveInstallPaths(env).settingsFile, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * Reproduce the owner's exact broken state: our wrapper command, naming a path
 * that does not exist. Built by installing normally and then deleting the
 * script, so the settings entry is byte-identical to a real install.
 */
function installThenDeleteWrapper(): string {
    const result = installClaudeStatusline(env);
    fs.rmSync(result.paths.wrapperFile, { force: true });
    return result.paths.wrapperFile;
}

describe('the three states are distinguishable', () => {
    it('reports installed:true for a wrapper whose script exists', () => {
        installClaudeStatusline(env);

        const status = readStatuslineStatus(env);

        expect(status.installed).toBe(true);
        expect(status.failureKind).toBeNull();
        expect(status.danglingWrapperPath).toBeNull();
    });

    it('reports installed:false for no statusLine at all', () => {
        writeSettings({});

        const status = readStatuslineStatus(env);

        expect(status.installed).toBe(false);
        expect(status.failureKind).toBeNull();
        expect(status.foreignStatusLine).toBe(false);
    });

    it('reports the THIRD state — neither installed nor not-installed — when the script is gone', () => {
        const deleted = installThenDeleteWrapper();

        const status = readStatuslineStatus(env);

        // Not installed: every consumer of `installed:true` goes on to describe
        // a working capture, and none of that is true here.
        expect(status.installed).toBe(false);
        // ...but not merely "not installed" either: there IS an entry, it is
        // ours, and the user's statusline is actively failing because of it.
        expect(status.failureKind).toBe('wrapper-missing');
        expect(status.danglingWrapperPath).toBe(deleted);
        // A dangling entry is OURS, so it is not a foreign statusline to wrap.
        expect(status.foreignStatusLine).toBe(false);
    });

    it('keeps a foreign statusLine distinct from all three', () => {
        writeSettings({ statusLine: { type: 'command', command: 'echo hi' } });

        const status = readStatuslineStatus(env);

        expect(status.installed).toBe(false);
        expect(status.failureKind).toBeNull();
        expect(status.foreignStatusLine).toBe(true);
    });
});

describe('classifyStatuslineCommand', () => {
    it('does not judge a foreign command whose target is also missing', () => {
        // Someone else's statusline pointing at a path that does not exist is
        // none of our business — we must not claim it is broken, and above all
        // must not offer to "repair" it by overwriting it.
        const verdict = classifyStatuslineCommand(
            'node "/nope/does-not-exist.mjs"',
            resolveInstallPaths(env).wrapperFile,
            env,
        );

        expect(verdict.kind).toBe('foreign');
        expect(verdict.scriptHealth).toBeNull();
    });

    it('treats an unparseable command that names us as present, not broken', () => {
        // Absence of a parseable path is absence of evidence. Reporting
        // `dangling` here would tell the user their working setup is broken.
        const verdict = classifyStatuslineCommand(
            'adhdev-statusline',
            resolveInstallPaths(env).wrapperFile,
            env,
        );

        expect(verdict.kind).toBe('wrapper');
    });
});

describe('install messages match the state actually observed', () => {
    it('reports `installed` only when there truly was no statusLine', () => {
        writeSettings({});

        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('installed');
        expect(result.originalCommand).toBeNull();
    });

    it('reports `wrapped`, NOT "you had no statusline", when one existed', () => {
        // The exact false claim the owner was shown.
        writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });

        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('wrapped');
        expect(result.originalCommand).toBe('echo mine');
    });

    it('reports `repaired` — not `installed`, not `reinstalled` — for a dangling entry', () => {
        const deleted = installThenDeleteWrapper();

        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('repaired');
        expect(result.repairedFrom).toBe(deleted);
        expect(fs.existsSync(result.paths.wrapperFile)).toBe(true);
        expect(readStatuslineStatus(env).installed).toBe(true);
    });

    it('reports `reinstalled` for a healthy re-run', () => {
        installClaudeStatusline(env);

        expect(installClaudeStatusline(env).outcome).toBe('reinstalled');
    });

    it('does not overwrite the user backup when repairing a dangling entry', () => {
        // The repair path shares a branch with re-install precisely so the
        // user's original survives. If it ever took the fresh-install branch it
        // would back up the BROKEN wrapper command as if it were the user's,
        // and uninstall would then "restore" a command that cannot run.
        writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
        installClaudeStatusline(env);
        installThenDeleteWrapper();

        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('repaired');
        expect(result.originalCommand).toBe('echo mine');
    });
});

describe('the claude fetcher stops telling users to open a session that cannot help', () => {
    it('names the missing wrapper instead of blaming the absent session', async () => {
        installThenDeleteWrapper();

        const quota = await fetchClaudeQuota({ env });

        expect(quota.status).toBe('unavailable');
        expect(quota.error).toContain('wrapper is missing');
        expect(quota.error).toContain('claude:install');
        // The precise wrong advice from 2026-08-20 must not reappear.
        expect(quota.error).not.toContain('open a Claude Code session');
    });

    it('still says "open a session" when the wrapper is genuinely healthy', async () => {
        installClaudeStatusline(env);

        const quota = await fetchClaudeQuota({ env });

        expect(quota.error).toContain('open a Claude Code session');
    });
});

describe('volatile install locations are warned about, not refused', () => {
    it('installs successfully but flags a temp-dir wrapper', () => {
        // This whole suite installs under os.tmpdir(), which is exactly the
        // legitimate throwaway-config workflow the guard must not break: the
        // install has to SUCCEED and merely carry a warning.
        const result = installClaudeStatusline(env);

        expect(result.volatileWrapperReason).toBeTruthy();
        expect(fs.existsSync(result.paths.wrapperFile)).toBe(true);
        expect(readStatuslineStatus(env).installed).toBe(true);
    });

    it('does not flag an ordinary config dir', () => {
        // Asserted on a literal home-shaped path rather than on this suite's
        // own fixtures: the fixtures live under os.tmpdir() by design, and
        // os.tmpdir() is consulted unconditionally (env vars can add temp
        // roots, never remove the real one) — which is the correct production
        // behaviour and would make a fixture-based "normal" path unreachable.
        const verdict = classifyVolatilePath(
            path.join(path.sep, 'Users', 'someone', '.adhdev', 'claude-statusline', 'x.mjs'),
            {} as NodeJS.ProcessEnv,
        );

        expect(verdict.volatile).toBe(false);
    });

    it('flags a deleted-worktree scratchpad by name, not just by temp root', () => {
        // The owner's actual dangling path shape. Called out separately from
        // "it is under /tmp" because the reason text has to be actionable.
        const verdict = classifyVolatilePath(
            '/Users/x/work/worktrees/some-branch/nested/scratchpad/statusline/adhdev-statusline.mjs',
            { TMPDIR: '/nowhere' } as NodeJS.ProcessEnv,
        );

        expect(verdict.volatile).toBe(true);
        expect(verdict.reason).toContain('worktree');
    });
});
