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
import * as os from 'node:os';
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
import {
    classifyVolatilePath,
    extractScriptPathFromCommand,
    inspectEmbeddedPath,
    type EmbeddedPathHealth,
} from '../../config/embedded-path-health.js';

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
 * Snapshot files of the OTHER adhdev tracks present on this machine.
 *
 * Why fan-out is needed: Claude Code's `statusLine` is one machine-global
 * slot, while each adhdev track's daemon reads only its OWN config dir
 * (`~/.adhdev` stable, `~/.adhdev-preview` preview). Measured against Claude
 * Code 2.1.220, the statusline hook process inherits the env of whatever
 * launched the session — a track's session-host pins that track's
 * `ADHDEV_CONFIG_DIR`, but a session opened from a plain terminal or the
 * desktop app carries none — so the wrapper cannot reliably tell which track
 * a capture belongs to. The only correct behaviour is to record it for every
 * track.
 *
 * Why discovery happens at INSTALL time (baked into the wrapper) rather than
 * at runtime: the wrapper's tests spawn it with the real `$HOME`, and a
 * runtime home-dir scan would write test fixtures into real track dirs. The
 * cost is that a track first installed AFTER this install is not fed until
 * `claude:install` re-runs — acceptable, because re-install is idempotent and
 * this whole feature is opt-in to begin with.
 *
 * The scan is name-based (`$HOME/.adhdev*` directories that exist right now)
 * with no marker-file requirement: a track's daemon creates its config dir at
 * first boot, so existence is the only signal that is ever available.
 */
export function discoverSiblingSnapshotPaths(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = os.homedir(),
): string[] {
    const own = defaultSnapshotPath(env);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(homeDir, { withFileTypes: true });
    } catch {
        // An unreadable home dir leaves the wrapper single-target, which is
        // exactly the pre-fan-out behaviour — degraded, not broken.
        return [];
    }
    const targets = new Set<string>();
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('.adhdev')) {
            continue;
        }
        const candidate = path.join(homeDir, entry.name, 'claude-statusline', 'quota.json');
        if (candidate !== own) {
            targets.add(candidate);
        }
    }
    return [...targets].sort();
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

/**
 * What a `statusLine.command` actually is, filesystem included.
 *
 * `isWrapperCommand` above answers only "does this string name us?", which is
 * the right question for UNINSTALL (ownership is what decides whether we may
 * touch the setting). It is the wrong question for STATUS and INSTALL, because
 * a command naming a wrapper that no longer exists is not an installation — it
 * is a broken one, and reporting it as `installed` is what produced the two
 * contradictory-and-both-wrong messages recorded in
 * `config/embedded-path-health.ts`.
 *
 *  - `none`      — no statusLine, or one with no command.
 *  - `wrapper`   — ours, and the script it names is on disk.
 *  - `dangling`  — ours by name, but the script is gone. Neither installed nor
 *                  uninstalled; the user's statusline is currently BROKEN and
 *                  re-running install repairs it.
 *  - `foreign`   — someone else's statusline. We do not verify its target: a
 *                  command we did not write is not ours to judge.
 */
export type StatuslineCommandKind = 'none' | 'wrapper' | 'dangling' | 'foreign';

export interface StatuslineCommandVerdict {
    kind: StatuslineCommandKind;
    /** The raw command string, when there was one. */
    command: string | null;
    /**
     * Health of the script path parsed out of OUR command. Null for `none` and
     * for `foreign` (not ours to inspect), and also when the command names us
     * by marker but in a shape we cannot parse a path from — in which case the
     * verdict stays `wrapper`, since we have no evidence it is broken.
     */
    scriptHealth: EmbeddedPathHealth | null;
}

/** Classify the current `statusLine.command` into the four states above. */
export function classifyStatuslineCommand(
    command: unknown,
    wrapperFile: string,
    env: NodeJS.ProcessEnv = process.env,
): StatuslineCommandVerdict {
    if (typeof command !== 'string' || command.trim() === '') {
        return { kind: 'none', command: null, scriptHealth: null };
    }
    if (!isWrapperCommand(command, wrapperFile)) {
        return { kind: 'foreign', command, scriptHealth: null };
    }
    const scriptPath = extractScriptPathFromCommand(command);
    if (scriptPath === null) {
        // Ours by marker, unparseable shape. Absence of evidence only.
        return { kind: 'wrapper', command, scriptHealth: null };
    }
    const scriptHealth = inspectEmbeddedPath(scriptPath, env);
    return {
        kind: scriptHealth.state === 'missing' ? 'dangling' : 'wrapper',
        command,
        scriptHealth,
    };
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

/**
 * What install DID, stated precisely enough that the printed message cannot
 * contradict the config on disk:
 *  - `installed`   — there was no statusLine (or one with no command); ours is now there.
 *  - `wrapped`     — the user had their OWN statusline; it is preserved and called from ours.
 *  - `reinstalled` — ours was already in place and healthy; re-rendered.
 *  - `repaired`    — ours was in place but pointed at a script that no longer
 *                    existed. The user's statusline was BROKEN before this ran
 *                    and works now; saying "re-installed" would understate it.
 */
export type InstallOutcome = 'installed' | 'wrapped' | 'reinstalled' | 'repaired';

export interface InstallResult {
    outcome: InstallOutcome;
    /** The command now wrapped, or null when the user had no statusline. */
    originalCommand: string | null;
    /** The dangling path that was replaced; only set for `repaired`. */
    repairedFrom: string | null;
    /**
     * Set when the wrapper we just wrote lives somewhere disposable, so the
     * caller can warn that this install is expected to dangle later. A warning
     * and NOT a refusal — see the note at the call site.
     */
    volatileWrapperReason: string | null;
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

    const verdict = classifyStatuslineCommand(existing?.command, paths.wrapperFile, env);
    const alreadyInstalled = verdict.kind === 'wrapper' || verdict.kind === 'dangling';

    let originalStatusLine: ClaudeStatusLineSetting | null;
    let outcome: InstallOutcome;
    let repairedFrom: string | null = null;

    if (alreadyInstalled) {
        // Re-install: the truth about the original lives in the backup, not in
        // the settings file (which currently holds *us*). Reading the backup
        // is what prevents a wrapper wrapping a wrapper.
        //
        // `dangling` takes the same branch on purpose — a stale entry is still
        // OURS, so the backup still holds the user's real original and must not
        // be overwritten with the broken wrapper command. Only the reported
        // outcome differs, because the user-visible fact differs: their
        // statusline was failing on every invocation until now.
        outcome = verdict.kind === 'dangling' ? 'repaired' : 'reinstalled';
        repairedFrom = verdict.kind === 'dangling' ? verdict.scriptHealth?.referencedPath ?? null : null;
        originalStatusLine = readBackup(paths.backupFile)?.statusLine ?? null;
    } else {
        // `foreign` vs `none` is the distinction that the old single
        // 'installed' outcome collapsed, which is how install came to announce
        // "you had no statusline configured" about a statusLine that existed.
        outcome = verdict.kind === 'foreign' ? 'wrapped' : 'installed';
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
        additionalSnapshotPaths: discoverSiblingSnapshotPaths(env),
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

    // WARN, do not refuse.
    //
    // The wrapper path is derived from ADHDEV_CONFIG_DIR, and pointing that at
    // a temp dir is a legitimate, documented way to exercise install against a
    // throwaway config — every test in this suite does exactly that, and so
    // does manual verification. Refusing would break the supported workflow to
    // prevent a state we can now DETECT and REPAIR (`dangling` above), which is
    // the wrong trade: the harm was never that the path was written, it was
    // that nobody noticed when it broke.
    const wrapperVolatility = classifyVolatilePath(paths.wrapperFile, env);

    return {
        outcome,
        originalCommand,
        repairedFrom,
        volatileWrapperReason: wrapperVolatility.volatile ? wrapperVolatility.reason : null,
        paths,
    };
}

/**
 * The shell command Claude Code will run.
 *
 * Quoted because the path may contain spaces, and executed via `node` rather
 * than relying on the executable bit and shebang, which do not apply on
 * Windows.
 *
 * Plain double-quote wrapping, not JSON.stringify: JSON escapes backslashes
 * (`\` -> `\\`), and extractScriptPathFromCommand's quote-stripping regex
 * does not reverse that escaping — it takes whatever is between the quotes
 * verbatim. Every Windows path is backslashes, so JSON.stringify silently
 * desynced the round trip (isWrapperCommand/dangling-detection compared a
 * doubled-backslash string against the real single-backslash path) on every
 * Windows install. Neither form has ever handled an embedded literal `"`
 * correctly against that regex, so dropping JSON.stringify's quote-escaping
 * loses nothing there.
 */
export function buildWrapperCommand(wrapperFile: string): string {
    return `node "${wrapperFile}"`;
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
    /**
     * True ONLY for a wrapper that is present AND whose script exists.
     *
     * A dangling entry answers `false` here and sets `failureKind:
     * 'wrapper-missing'` — because every consumer of this boolean (the fetcher's
     * "installed but no capture yet" branch, the CLI's status render) goes on
     * to tell the user something about a working installation, and none of
     * those statements is true of a wrapper that cannot be loaded.
     */
    installed: boolean;
    /**
     * The third state, distinct from both installed and not-installed:
     * `statusLine` names our wrapper but the script is gone. Null otherwise.
     */
    failureKind: 'wrapper-missing' | null;
    /** The dangling path, when `failureKind` is 'wrapper-missing'. */
    danglingWrapperPath: string | null;
    /** Present when installed and a previous command was wrapped. */
    wrappedCommand: string | null;
    /** True when a statusLine exists but is not ours. */
    foreignStatusLine: boolean;
    /**
     * Set when the wrapper path currently configured (or the one we would
     * install) lives somewhere disposable. Advisory only.
     */
    volatileWrapperReason: string | null;
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

    const verdict = classifyStatuslineCommand(existing?.command, paths.wrapperFile, env);
    const installed = verdict.kind === 'wrapper';
    const dangling = verdict.kind === 'dangling';
    // The backup is still the record of the user's own statusline in the
    // dangling case, and reporting it is what lets the CLI say what a repair
    // would preserve.
    const backup = installed || dangling ? readBackup(paths.backupFile) : null;
    const wrapped = backup?.statusLine?.command;
    const volatility = classifyVolatilePath(
        dangling ? verdict.scriptHealth?.referencedPath ?? paths.wrapperFile : paths.wrapperFile,
        env,
    );
    return {
        installed,
        failureKind: dangling ? 'wrapper-missing' : null,
        danglingWrapperPath: dangling ? verdict.scriptHealth?.referencedPath ?? null : null,
        wrappedCommand: typeof wrapped === 'string' ? wrapped : null,
        // `dangling` is ours, not foreign — a repair, not a wrap.
        foreignStatusLine: verdict.kind === 'foreign',
        volatileWrapperReason: volatility.volatile ? volatility.reason : null,
        paths,
    };
}
