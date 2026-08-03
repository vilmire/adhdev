import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    StatuslineInstallError,
    installClaudeStatusline,
    readStatuslineStatus,
    resolveInstallPaths,
    uninstallClaudeStatusline,
} from '../../src/quota/statusline/install';

/**
 * The owner's real statusline at the time this was written: an inline shell
 * one-liner that consumes stdin itself, shells out to git, and emits ANSI
 * escapes with no trailing newline. Used as the fixture precisely because it
 * is the hostile case — anything that survives round-tripping this survives a
 * simple `echo`.
 */
const REAL_WORLD_COMMAND =
    'input=$(cat); current_dir=$(echo "$input" | jq -r \'.workspace.current_dir\'); ' +
    'dir_name=$(basename "$current_dir"); printf "$(printf \'\\033[32m\')➜ $dir_name"';

let tempRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-statusline-'));
    env = {
        ADHDEV_HOME: path.join(tempRoot, 'adhdev'),
        CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude'),
    } as NodeJS.ProcessEnv;
    fs.mkdirSync(path.join(tempRoot, 'claude'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function settingsFile(): string {
    return resolveInstallPaths(env).settingsFile;
}

function writeSettings(value: unknown): void {
    fs.writeFileSync(settingsFile(), JSON.stringify(value, null, 2), 'utf-8');
}

function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
}

describe('installClaudeStatusline', () => {
    it('preserves the existing command by wrapping it, and points statusLine at the wrapper', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });

        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('installed');
        expect(result.originalCommand).toBe(REAL_WORLD_COMMAND);

        const statusLine = readSettings().statusLine as Record<string, unknown>;
        expect(statusLine.type).toBe('command');
        expect(statusLine.command).toContain(result.paths.wrapperFile);

        // The original must be recoverable verbatim, escapes and all.
        const wrapper = fs.readFileSync(result.paths.wrapperFile, 'utf-8');
        expect(wrapper).toContain(JSON.stringify(REAL_WORLD_COMMAND));
    });

    it('backs up the previous statusLine before touching settings', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND, padding: 2 } });

        const { paths } = installClaudeStatusline(env);
        const backup = JSON.parse(fs.readFileSync(paths.backupFile, 'utf-8')) as Record<string, unknown>;

        expect(backup.statusLine).toEqual({ type: 'command', command: REAL_WORLD_COMMAND, padding: 2 });
    });

    it('leaves every unrelated settings key untouched', () => {
        writeSettings({
            theme: 'dark',
            permissions: { allow: ['Bash(git:*)'] },
            statusLine: { type: 'command', command: 'echo hi' },
        });

        installClaudeStatusline(env);
        const settings = readSettings();

        expect(settings.theme).toBe('dark');
        expect(settings.permissions).toEqual({ allow: ['Bash(git:*)'] });
    });

    it('preserves sibling statusLine keys such as padding and refreshInterval', () => {
        writeSettings({
            statusLine: { type: 'command', command: 'echo hi', padding: 2, refreshInterval: 5 },
        });

        installClaudeStatusline(env);
        const statusLine = readSettings().statusLine as Record<string, unknown>;

        expect(statusLine.padding).toBe(2);
        expect(statusLine.refreshInterval).toBe(5);
    });

    it('installs when the user had no statusLine at all', () => {
        writeSettings({ theme: 'dark' });

        const result = installClaudeStatusline(env);

        expect(result.originalCommand).toBeNull();
        expect((readSettings().statusLine as Record<string, unknown>).command).toContain(
            result.paths.wrapperFile,
        );
        // The backup must record the *absence* explicitly, so uninstall knows
        // to delete the key rather than restore an empty object.
        const backup = JSON.parse(fs.readFileSync(result.paths.backupFile, 'utf-8')) as Record<string, unknown>;
        expect(backup.statusLine).toBeNull();
    });

    it('installs when settings.json does not exist yet', () => {
        const result = installClaudeStatusline(env);

        expect(result.outcome).toBe('installed');
        expect(readSettings().statusLine).toBeDefined();
    });

    it('is idempotent: re-installing does not wrap the wrapper', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        installClaudeStatusline(env);

        const second = installClaudeStatusline(env);

        expect(second.outcome).toBe('reinstalled');
        // The command it wraps must still be the user's, not our own wrapper.
        expect(second.originalCommand).toBe(REAL_WORLD_COMMAND);
        const wrapper = fs.readFileSync(second.paths.wrapperFile, 'utf-8');
        expect(wrapper).toContain(JSON.stringify(REAL_WORLD_COMMAND));
        expect(wrapper).not.toContain(`node ${JSON.stringify(second.paths.wrapperFile)}`);
    });

    it('keeps the original backup across repeated installs', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        installClaudeStatusline(env);
        installClaudeStatusline(env);
        installClaudeStatusline(env);

        const backup = JSON.parse(
            fs.readFileSync(resolveInstallPaths(env).backupFile, 'utf-8'),
        ) as { statusLine: { command: string } };

        expect(backup.statusLine.command).toBe(REAL_WORLD_COMMAND);
    });

    it('refuses to touch a settings file it cannot parse', () => {
        fs.writeFileSync(settingsFile(), '{ this is not json', 'utf-8');

        expect(() => installClaudeStatusline(env)).toThrow(StatuslineInstallError);
        // The unparseable file must be left exactly as found, not overwritten.
        expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe('{ this is not json');
    });
});

describe('uninstallClaudeStatusline', () => {
    it('restores the original command byte-for-byte', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND, padding: 2 } });
        installClaudeStatusline(env);

        const result = uninstallClaudeStatusline(env);

        expect(result.outcome).toBe('restored');
        expect(readSettings().statusLine).toEqual({
            type: 'command',
            command: REAL_WORLD_COMMAND,
            padding: 2,
        });
    });

    it('removes the statusLine key entirely when the user never had one', () => {
        writeSettings({ theme: 'dark' });
        installClaudeStatusline(env);

        const result = uninstallClaudeStatusline(env);

        expect(result.outcome).toBe('removed');
        expect(readSettings()).not.toHaveProperty('statusLine');
        expect(readSettings().theme).toBe('dark');
    });

    it('deletes the wrapper, snapshot and backup', () => {
        writeSettings({ statusLine: { type: 'command', command: 'echo hi' } });
        const { paths } = installClaudeStatusline(env);
        fs.writeFileSync(paths.snapshotFile, '{}', 'utf-8');

        uninstallClaudeStatusline(env);

        expect(fs.existsSync(paths.wrapperFile)).toBe(false);
        expect(fs.existsSync(paths.snapshotFile)).toBe(false);
        expect(fs.existsSync(paths.backupFile)).toBe(false);
    });

    it('does not touch a statusLine the user re-configured after installing', () => {
        // Overwriting this would be exactly the prompt destruction the feature
        // must avoid: the user's newer choice outranks our stale backup.
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        installClaudeStatusline(env);
        writeSettings({ statusLine: { type: 'command', command: 'echo my-new-prompt' } });

        const result = uninstallClaudeStatusline(env);

        expect(result.outcome).toBe('not-installed');
        expect((readSettings().statusLine as Record<string, unknown>).command).toBe('echo my-new-prompt');
    });

    it('reports not-installed when settings.json is absent', () => {
        expect(uninstallClaudeStatusline(env).outcome).toBe('not-installed');
    });

    it('falls back to removing the key when the backup is unreadable', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        const { paths } = installClaudeStatusline(env);
        fs.writeFileSync(paths.backupFile, 'corrupted', 'utf-8');

        const result = uninstallClaudeStatusline(env);

        // Leaving our wrapper in place would be worse than reverting to the
        // built-in status line.
        expect(result.outcome).toBe('removed');
        expect(readSettings()).not.toHaveProperty('statusLine');
    });

    it('round-trips settings through install and uninstall unchanged', () => {
        const original = {
            theme: 'dark',
            effortLevel: 'high',
            permissions: { allow: ['Bash(git:*)'], deny: [] },
            statusLine: { type: 'command', command: REAL_WORLD_COMMAND },
        };
        writeSettings(original);

        installClaudeStatusline(env);
        uninstallClaudeStatusline(env);

        expect(readSettings()).toEqual(original);
    });
});

describe('readStatuslineStatus', () => {
    it('reports not installed, and flags a foreign statusLine', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });

        const status = readStatuslineStatus(env);

        expect(status.installed).toBe(false);
        expect(status.foreignStatusLine).toBe(true);
    });

    it('reports the wrapped command once installed', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        installClaudeStatusline(env);

        const status = readStatuslineStatus(env);

        expect(status.installed).toBe(true);
        expect(status.foreignStatusLine).toBe(false);
        expect(status.wrappedCommand).toBe(REAL_WORLD_COMMAND);
    });

    it('does not modify settings', () => {
        writeSettings({ statusLine: { type: 'command', command: REAL_WORLD_COMMAND } });
        const before = fs.readFileSync(settingsFile(), 'utf-8');

        readStatuslineStatus(env);

        expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(before);
    });
});
