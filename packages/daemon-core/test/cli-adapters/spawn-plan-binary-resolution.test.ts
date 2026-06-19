/**
 * Binary-resolution regression coverage for the single-source spawn planner
 * (resolveCliSpawnPlanFromParts).
 *
 * Two fragile cases this locks in:
 *
 *  (a) Symlinked binary (the antigravity-cli install shape) — a CLI installed as
 *      a symlink must resolve to the right shell-wrap decision based on the REAL
 *      target's file type, not the symlink itself. The planner derives shell
 *      wrapping from isScriptBinary()/looksLikeMachOOrElf(), both of which
 *      realpath the path before reading magic bytes, so a symlink to a native
 *      binary spawns directly and a symlink to a shebang script gets login-shell
 *      wrapped. The OS follows the symlink at exec time, so the absolute symlink
 *      path is a valid spawn target either way.
 *
 *  (b) Windows npm-global `.cmd` shim (the codex install shape) — a `.cmd`/`.bat`
 *      shim must be launched via `cmd.exe /c`, never handed to ConPTY directly.
 *      The planner's isCmdShim branch covers this; this asserts the shell-wrap
 *      shape so the codex Windows spawn path can't silently regress.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCliSpawnPlanFromParts } from '../../src/cli-adapters/provider-cli-runtime.js';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('spawn planner -- binary resolution', () => {
    it('(a) follows a symlink to a NATIVE binary and spawns it directly (no shell wrap)', () => {
        if (os.platform() === 'win32') return; // symlink + native-magic assertion is unix-only
        const dir = mkTmp('spawn-symlink-native-');
        // /bin/echo is a real Mach-O/ELF native binary on every CI box.
        const linkPath = path.join(dir, 'antigravity');
        fs.symlinkSync('/bin/echo', linkPath);

        const plan = resolveCliSpawnPlanFromParts({
            command: linkPath,
            workingDir: dir,
        });

        // Symlink target is native → direct (non-shell) spawn of the absolute
        // symlink path; the OS resolves the link at exec time.
        expect(plan.useShell).toBe(false);
        expect(plan.shellCmd).toBe(linkPath);
        expect(plan.binaryPath).toBe(linkPath);
    });

    it('(a) follows a symlink to a SHEBANG script and login-shell wraps it', () => {
        if (os.platform() === 'win32') return; // unix-only
        const dir = mkTmp('spawn-symlink-script-');
        const scriptPath = path.join(dir, 'agy-real.sh');
        fs.writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("hi");\n');
        fs.chmodSync(scriptPath, 0o755);
        const linkPath = path.join(dir, 'antigravity');
        fs.symlinkSync(scriptPath, linkPath);

        const plan = resolveCliSpawnPlanFromParts({
            command: linkPath,
            baseArgs: ['chat'],
            workingDir: dir,
        });

        // Symlink target is a shebang script → wrap in a login shell so the
        // interpreter resolves; the wrapped command carries the absolute path.
        expect(plan.useShell).toBe(true);
        expect(plan.shellCmd).toBe(process.env.SHELL || '/bin/zsh');
        const joined = plan.shellArgs.join(' ');
        expect(joined).toContain('-l');
        expect(joined).toContain('-c');
        expect(joined).toContain(linkPath);
        expect(joined).toContain('chat');
    });

    it('(b) launches a Windows npm-global .cmd shim via cmd.exe /c', () => {
        if (os.platform() !== 'win32') return; // win32-only spawn shape
        const dir = mkTmp('spawn-cmd-shim-');
        // An absolute .cmd shim (the npm-global codex install shape).
        const shimPath = path.join(dir, 'codex.cmd');
        fs.writeFileSync(shimPath, '@echo off\r\n');

        const plan = resolveCliSpawnPlanFromParts({
            command: shimPath,
            baseArgs: ['--version'],
            workingDir: dir,
        });

        // .cmd/.bat shims MUST go through cmd.exe /c, never straight to ConPTY.
        expect(plan.useShell).toBe(true);
        expect(plan.shellCmd).toBe('cmd.exe');
        expect(plan.shellArgs[0]).toBe('/c');
        expect(plan.shellArgs).toContain(shimPath);
        expect(plan.shellArgs).toContain('--version');
    });
});
