import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { openCaptureLogFd, DAEMON_CAPTURE_LOG_NAME } from '../../src/logging/logger.js';

/**
 * Regression cover for the daemon's raw stdout/stderr capture wiring.
 *
 * ★These assert that BYTES REACH THE FILE, not that a spawn happened. That
 * distinction is the whole point: the defect this guards against left the
 * daemon perfectly healthy — it booted, bound its port, and filled the
 * structured `daemon-<date>.log` — while `daemon-service.log` stopped growing
 * entirely. Observed on Windows 2026-09-23: the file froze at 5,281,231 bytes
 * on "[Upgrade] Exiting daemon so detached upgrader can continue..." while the
 * replacement daemon (pid 3536, 1.0.60-rc.31) ran normally. Any test that only
 * checks "a child was started" passes happily against that bug.
 *
 * Cause: the console-flash fix replaced the old `start /B ... >> log 2>&1`
 * shell form with `spawn(..., { detached: true })` + an inherited append fd,
 * but only two of the four daemon-spawn sites were converted. The post-upgrade
 * respawn (`spawnDetachedDaemonRestart`) and the post-update CLI restart kept
 * `stdio: 'ignore'`, which discards the child's output. Bringing back a shell
 * redirect is NOT an option — `windowsHide` cannot suppress a window created by
 * a grandchild of a hidden shell, which is the original defect.
 */

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-capture-fd-'));
});

afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Wait until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return predicate();
}

function read(file: string): string {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

describe('openCaptureLogFd', () => {
    it('hands back a real append fd and creates the log directory', () => {
        const logPath = path.join(dir, 'nested', 'logs', DAEMON_CAPTURE_LOG_NAME);
        const { fd, close } = openCaptureLogFd(logPath);
        try {
            expect(typeof fd).toBe('number');
            expect(fs.existsSync(logPath)).toBe(true);
        } finally {
            close();
        }
    });

    it('appends rather than truncates, so restarts accumulate', () => {
        const logPath = path.join(dir, DAEMON_CAPTURE_LOG_NAME);
        fs.writeFileSync(logPath, 'PREVIOUS-BOOT\n');

        const { fd, close } = openCaptureLogFd(logPath);
        try {
            fs.writeSync(fd as number, 'THIS-BOOT\n');
        } finally {
            close();
        }

        const contents = read(logPath);
        expect(contents).toContain('PREVIOUS-BOOT');
        expect(contents).toContain('THIS-BOOT');
    });

    it('degrades to "ignore" instead of throwing when the log cannot be opened', () => {
        // A directory can never be opened for writing — stands in for any
        // permission/ENOSPC failure. Losing the capture log must never stop the
        // daemon from starting.
        const logPath = path.join(dir, 'as-a-directory');
        fs.mkdirSync(logPath);

        const { fd, close } = openCaptureLogFd(logPath);
        expect(fd).toBe('ignore');
        expect(() => close()).not.toThrow();
    });
});

describe('detached daemon spawn writes its stdout/stderr into daemon-service.log', () => {
    it('captures child output through the inherited fd', async () => {
        const logPath = path.join(dir, DAEMON_CAPTURE_LOG_NAME);
        const { fd, close } = openCaptureLogFd(logPath);

        try {
            const child = spawn(
                process.execPath,
                ['-e', "process.stdout.write('DAEMON-STDOUT\\n'); process.stderr.write('DAEMON-STDERR\\n');"],
                { detached: true, stdio: ['ignore', fd, fd], windowsHide: true },
            );
            child.unref();
        } finally {
            close();
        }

        const landed = await waitFor(() => read(logPath).includes('DAEMON-STDERR'));
        const contents = read(logPath);
        expect(landed, `capture log never received the child output. contents: ${JSON.stringify(contents)}`).toBe(true);
        // stderr must share the same target as stdout — the `2>&1` half of the
        // old shell redirect.
        expect(contents).toContain('DAEMON-STDOUT');
        expect(contents).toContain('DAEMON-STDERR');
    });

    it('keeps capturing after the spawning process exits and closes its fd copy', async () => {
        // ★The upgrade path is exactly this shape: the helper spawns the
        // replacement daemon and immediately exits. If the child's writes died
        // with the parent's fd, the capture log would end at the handoff — which
        // is precisely the reported symptom, so it must be asserted, not assumed.
        const logPath = path.join(dir, DAEMON_CAPTURE_LOG_NAME);

        // A parent that spawns the "daemon", drops its own fd, and exits.
        const parentScript = path.join(dir, 'parent.mjs');
        fs.writeFileSync(parentScript, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const fd = fs.openSync(${JSON.stringify(logPath)}, 'a');
const child = spawn(process.execPath, ['-e', \`
  process.stdout.write('BEFORE-PARENT-EXIT\\\\n');
  setTimeout(() => process.stdout.write('AFTER-PARENT-EXIT\\\\n'), 700);
\`], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
child.unref();
fs.closeSync(fd);
process.exit(0);
`);

        const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore' });
        await new Promise<void>((resolve) => parent.on('exit', () => resolve()));

        const landed = await waitFor(() => read(logPath).includes('AFTER-PARENT-EXIT'));
        const contents = read(logPath);
        expect(landed, `child stopped writing once the parent exited. contents: ${JSON.stringify(contents)}`).toBe(true);
        expect(contents).toContain('BEFORE-PARENT-EXIT');
    });
});
