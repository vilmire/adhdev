/**
 * Opt-in install / uninstall of the Claude Code statusline wrapper.
 *
 * ── Why this is opt-in and never automatic ──
 * `statusLine` is a single-valued setting holding a command the user chose.
 * Capturing quota means replacing it with ours and calling theirs from inside.
 * That is a change to the user's visible prompt, so it happens only when a
 * human runs the command; nothing in the daemon boot path may call `install`.
 *
 * ── Safety properties ──
 *  - the previous `statusLine` value is written to a backup file *before*
 *    settings.json is modified, so uninstall can restore it exactly;
 *  - install is idempotent: re-running it re-renders the wrapper but keeps the
 *    original backup, so a wrapper never ends up wrapping another wrapper;
 *  - settings.json is rewritten by mutating the parsed object and re-serializing
 *    it, so unrelated keys, and their values, survive untouched;
 *  - the file is replaced via temp-file + rename, so an interrupted install
 *    cannot leave the user with a truncated settings.json.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    MAX_WRITE_INTERVAL_MS,
    MIN_WRITE_INTERVAL_MS,
    SNAPSHOT_VERSION,
} from './snapshot.js';
import {
    backupPath as defaultBackupPath,
    claudeSettingsPath as defaultSettingsPath,
    snapshotPath as defaultSnapshotPath,
    statuslineDir as defaultStatuslineDir,
    wrapperScriptPath as defaultWrapperPath,
} from './paths.js';
import { renderWrapperScript } from './wrapper-source.js';

/** Marks a `statusLine` entry as ours without relying on the path alone. */
export const WRAPPER_MARKER = 'adhdev-statusline';

/** The `statusLine` object shape, as far as we care about it. */
export interface ClaudeStatusLineSetting {
    type?: string;
    command?: string;
    [key: string]: unknown;
}

export interface StatuslineInstallPaths {
    settingsFile: string;
    wrapperFile: string;
    snapshotFile: string;
    backupFile: string;
    stateDir: string;
}

/** Resolve every path once so callers (and tests) can override the env. */
export function resolveInstallPaths(env: NodeJS.ProcessEnv = process.env): StatuslineInstallPaths {
    return {
        settingsFile: defaultSettingsPath(env),
        wrapperFile: defaultWrapperPath(env),
        snapshotFile: defaultSnapshotPath(env),
        backupFile: defaultBackupPath(env),
        stateDir: defaultStatuslineDir(env),
    };
}

/**
 * Recognize our own wrapper.
 *
 * Matches on the marker appearing in the command string, which covers both the
 * script path (which contains `adhdev-statusline`) and any future invocation
 * form, and does not misfire on a user command that merely mentions adhdev.
 */
export function isWrapperCommand(command: unknown, wrapperFile: string): boolean {
    if (typeof command !== 'string' || command === '') {
        return false;
    }
    return command.includes(wrapperFile) || command.includes(WRAPPER_MARKER);
}

function readJsonFile(file: string): { kind: 'ok'; value: Record<string, unknown> } | { kind: 'missing' } | { kind: 'invalid'; reason: string } {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read ${file}: ${message}` };
    }
    if (raw.trim() === '') {
        // An empty settings file is equivalent to no settings at all.
        return { kind: 'ok', value: {} };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `${file} is not valid JSON: ${message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'invalid', reason: `${file} does not contain a JSON object` };
    }
    return { kind: 'ok', value: parsed as Record<string, unknown> };
}

/** Replace a file atomically so a crash cannot truncate it. */
function writeFileAtomic(file: string, contents: string, mode?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, contents, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
    fs.renameSync(temp, file);
}

/**
 * What the backup file holds.
 *
 * `statusLine` is `null` when the user had none — an explicit "there was
 * nothing here", which uninstall must honour by *removing* the key rather than
 * restoring an empty object.
 */
export interface StatuslineBackup {
    version: number;
    savedAt: number;
    statusLine: ClaudeStatusLineSetting | null;
}

export type InstallOutcome = 'installed' | 'reinstalled';

export interface InstallResult {
    outcome: InstallOutcome;
    /** The command now wrapped, or null when the user had no statusline. */
    originalCommand: string | null;
    paths: StatuslineInstallPaths;
}

export class StatuslineInstallError extends Error {}

/**
 * Install the wrapper into Claude Code's `statusLine` setting.
 *
 * Idempotent: if our wrapper is already installed, the *existing* backup is
 * kept and the previously-wrapped command is re-wrapped, so repeated installs
 * never nest and never lose the true original.
 */
export function installClaudeStatusline(env: NodeJS.ProcessEnv = process.env): InstallResult {
    const paths = resolveInstallPaths(env);

    const settingsResult = readJsonFile(paths.settingsFile);
    if (settingsResult.kind === 'invalid') {
        // Refuse rather than overwrite a file we cannot faithfully round-trip.
        throw new StatuslineInstallError(
            `${settingsResult.reason}. Fix or move the file, then retry.`,
        );
    }
    const settings = settingsResult.kind === 'missing' ? {} : settingsResult.value;

    const existingRaw = settings.statusLine;
    const existing =
        typeof existingRaw === 'object' && existingRaw !== null && !Array.isArray(existingRaw)
            ? (existingRaw as ClaudeStatusLineSetting)
            : null;

    const alreadyInstalled = isWrapperCommand(existing?.command, paths.wrapperFile);

    let originalStatusLine: ClaudeStatusLineSetting | null;
    let outcome: InstallOutcome;

    if (alreadyInstalled) {
        // Re-install: the truth about the original lives in the backup, not in
        // the settings file (which currently holds *us*). Reading the backup
        // is what prevents a wrapper wrapping a wrapper.
        outcome = 'reinstalled';
        originalStatusLine = readBackup(paths.backupFile)?.statusLine ?? null;
    } else {
        outcome = 'installed';
        originalStatusLine = existing;
        // Save before mutating anything: if the write below fails, the user
        // still has a recoverable record of what they had.
        const backup: StatuslineBackup = {
            version: 1,
            savedAt: Date.now(),
            statusLine: originalStatusLine,
        };
        writeFileAtomic(paths.backupFile, `${JSON.stringify(backup, null, 2)}\n`);
    }

    const originalCommand =
        typeof originalStatusLine?.command === 'string' && originalStatusLine.command !== ''
            ? originalStatusLine.command
            : null;

    const script = renderWrapperScript({
        snapshotPath: paths.snapshotFile,
        originalCommand,
        snapshotVersion: SNAPSHOT_VERSION,
        minWriteIntervalMs: MIN_WRITE_INTERVAL_MS,
        maxWriteIntervalMs: MAX_WRITE_INTERVAL_MS,
    });
    writeFileAtomic(paths.wrapperFile, script, 0o755);

    // Preserve any sibling keys the user set (padding, refreshInterval,
    // hideVimModeIndicator); only `type` and `command` are ours to define.
    const nextStatusLine: ClaudeStatusLineSetting = {
        ...(originalStatusLine ?? {}),
        type: 'command',
        command: buildWrapperCommand(paths.wrapperFile),
    };
    settings.statusLine = nextStatusLine;
    writeFileAtomic(paths.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

    return { outcome, originalCommand, paths };
}

/**
 * The shell command Claude Code will run.
 *
 * Quoted because the path may contain spaces, and executed via `node` rather
 * than relying on the executable bit and shebang, which do not apply on
 * Windows.
 */
export function buildWrapperCommand(wrapperFile: string): string {
    return `node ${JSON.stringify(wrapperFile)}`;
}

function readBackup(file: string): StatuslineBackup | null {
    const result = readJsonFile(file);
    if (result.kind !== 'ok') {
        return null;
    }
    const record = result.value;
    if (record.version !== 1) {
        return null;
    }
    const statusLine = record.statusLine;
    if (statusLine === null) {
        return { version: 1, savedAt: 0, statusLine: null };
    }
    if (typeof statusLine !== 'object' || Array.isArray(statusLine)) {
        return null;
    }
    return {
        version: 1,
        savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
        statusLine: statusLine as ClaudeStatusLineSetting,
    };
}

export type UninstallOutcome = 'restored' | 'removed' | 'not-installed';

export interface UninstallResult {
    outcome: UninstallOutcome;
    paths: StatuslineInstallPaths;
}

/**
 * Remove the wrapper and put the user's own statusline back.
 *
 * `restored` — the backed-up statusLine was written back verbatim.
 * `removed`  — there was no original, so the key is deleted entirely.
 * `not-installed` — our wrapper was not in place; settings are left alone.
 */
export function uninstallClaudeStatusline(env: NodeJS.ProcessEnv = process.env): UninstallResult {
    const paths = resolveInstallPaths(env);

    const settingsResult = readJsonFile(paths.settingsFile);
    if (settingsResult.kind === 'invalid') {
        throw new StatuslineInstallError(
            `${settingsResult.reason}. Fix the file by hand, then retry.`,
        );
    }
    if (settingsResult.kind === 'missing') {
        cleanupArtifacts(paths);
        return { outcome: 'not-installed', paths };
    }

    const settings = settingsResult.value;
    const existingRaw = settings.statusLine;
    const existing =
        typeof existingRaw === 'object' && existingRaw !== null && !Array.isArray(existingRaw)
            ? (existingRaw as ClaudeStatusLineSetting)
            : null;

    if (!isWrapperCommand(existing?.command, paths.wrapperFile)) {
        // Not ours — possibly the user re-configured statusLine themselves
        // after installing. Overwriting that would be exactly the destruction
        // this feature must avoid, so leave settings untouched.
        cleanupArtifacts(paths);
        return { outcome: 'not-installed', paths };
    }

    const backup = readBackup(paths.backupFile);
    let outcome: UninstallOutcome;
    if (backup?.statusLine) {
        settings.statusLine = backup.statusLine;
        outcome = 'restored';
    } else {
        // Either the user had no statusLine, or the backup is unreadable. In
        // both cases removing the key is right: it returns Claude Code to its
        // built-in status line rather than leaving our wrapper in place.
        delete settings.statusLine;
        outcome = 'removed';
    }
    writeFileAtomic(paths.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

    cleanupArtifacts(paths);
    return { outcome, paths };
}

/** Delete our own files. Never touches anything outside `stateDir`. */
function cleanupArtifacts(paths: StatuslineInstallPaths): void {
    for (const file of [paths.wrapperFile, paths.snapshotFile, paths.backupFile]) {
        try {
            fs.rmSync(file, { force: true });
        } catch {
            // A leftover file is untidy, not harmful; the settings restore
            // above is the part that must not fail.
        }
    }
    try {
        fs.rmdirSync(paths.stateDir);
    } catch {
        // Non-empty (user put something there) or already gone — either is fine.
    }
}

export interface StatuslineStatus {
    installed: boolean;
    /** Present when installed and a previous command was wrapped. */
    wrappedCommand: string | null;
    /** True when a statusLine exists but is not ours. */
    foreignStatusLine: boolean;
    paths: StatuslineInstallPaths;
}

/** Report install state without modifying anything. */
export function readStatuslineStatus(env: NodeJS.ProcessEnv = process.env): StatuslineStatus {
    const paths = resolveInstallPaths(env);
    const settingsResult = readJsonFile(paths.settingsFile);
    const settings = settingsResult.kind === 'ok' ? settingsResult.value : {};
    const existingRaw = settings.statusLine;
    const existing =
        typeof existingRaw === 'object' && existingRaw !== null && !Array.isArray(existingRaw)
            ? (existingRaw as ClaudeStatusLineSetting)
            : null;
    const installed = isWrapperCommand(existing?.command, paths.wrapperFile);
    const backup = installed ? readBackup(paths.backupFile) : null;
    const wrapped = backup?.statusLine?.command;
    return {
        installed,
        wrappedCommand: typeof wrapped === 'string' ? wrapped : null,
        foreignStatusLine: existing !== null && !installed,
        paths,
    };
}
