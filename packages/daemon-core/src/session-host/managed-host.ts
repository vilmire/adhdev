import { execFileSync, spawn, type StdioOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getDefaultSessionHostEndpoint,
    sanitizeSpawnEnv,
    type SessionHostEndpoint,
    type SessionHostRequestType,
} from '@adhdev/session-host-core';
import { getProcessCommandLine, parseNodeScriptPath } from '../commands/process-lifecycle.js';
import { findPortableNode22 } from '../commands/windows-atomic-upgrade.js';
import { resolveInstanceDir } from '../commands/upgrade-helper.js';
import { LOG } from '../logging/logger.js';
import { ensureSessionHostReady as ensureSharedSessionHostReady } from './runtime-support.js';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../runtime-defaults.js';

/**
 * Shared managed-session-host process helpers.
 *
 * The cloud (`packages/daemon-cloud`) and standalone (`oss/packages/daemon-standalone`)
 * daemons carried byte-for-byte copies of `buildSessionHostEnv`, `resolveSessionHostEntry`,
 * `getSessionHostPidFile`, `killPid`, a base `stopManagedSessionHostProcess`, and the
 * `ensureSessionHostReady` retry-wrapper. Those live here now. The pieces that genuinely
 * differ between the two daemons (kill windowsHide, quarantine preamble, spawn stdio,
 * required request types, cloud's socket-owner sweep) are injected via options so the
 * observable behavior of each daemon is preserved exactly.
 */
export interface ManagedSessionHostOptions {
    /** Session-host namespace (app name). Drives the socket endpoint and pidfile path. */
    appName: string;
    /** Capability probe: request types the host must advertise before it's considered ready. */
    requiredRequestTypes: readonly SessionHostRequestType[];
    /** Ready timeout for the spawn/poll loop. Defaults to the shared runtime default. */
    timeoutMs?: number;
    /**
     * `killPid` on win32 uses `taskkill /T /F`. Cloud passes `windowsHide: true`; standalone
     * historically did not. Kept as a flag to preserve each daemon's exact spawn options.
     */
    killWindowsHide?: boolean;
    /**
     * How the detached host child's stdio is wired. 'ignore' matches standalone; 'logfile'
     * matches cloud (append to `~/.adhdev/logs/session-host.log`).
     */
    spawnStdio?: 'ignore' | 'logfile';
    /**
     * Optional preamble run at the start of `ensureReady` (before the first connect probe).
     * Cloud uses this to quarantine legacy standalone runtime files.
     */
    beforeEnsureReady?: () => void;
    /**
     * Optional extra stop pass appended to `stopManagedSessionHostProcess`. Cloud sweeps
     * managed session-host processes that own the default socket but predate pidfile tracking.
     * Returns true if it stopped anything.
     */
    extraStop?: (endpoint: SessionHostEndpoint) => boolean;
    /**
     * Optional guard applied to a pidfile-tracked pid before killing it in
     * `stopManagedSessionHostProcess`. Cloud verifies the command line is an ADHDev
     * session-host daemon; standalone kills unconditionally (returns true here).
     */
    isManagedPid?: (pid: number) => boolean;
}

export interface ManagedSessionHost {
    readonly appName: string;
    readonly endpoint: SessionHostEndpoint;
    getPidFile(): string;
    getPid(): number | null;
    buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    resolveEntry(): string;
    killPid(pid: number): boolean;
    spawnHost(): void;
    stopManagedSessionHostProcess(): boolean;
    ensureReady(): Promise<SessionHostEndpoint>;
    getStatusPaths(): { pidFile: string; endpoint: SessionHostEndpoint };
}

export function createManagedSessionHost(options: ManagedSessionHostOptions): ManagedSessionHost {
    const appName = options.appName;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;
    const endpoint = getDefaultSessionHostEndpoint(appName);
    const isManagedPid = options.isManagedPid ?? (() => true);

    function buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const env = sanitizeSpawnEnv(baseEnv) as NodeJS.ProcessEnv;
        env.ADHDEV_SESSION_HOST_NAME = appName;
        return env;
    }

    function resolveEntry(): string {
        const packagedCandidates = [
            path.resolve(__dirname, '../vendor/session-host-daemon/index.js'),
            path.resolve(__dirname, '../../vendor/session-host-daemon/index.js'),
        ];
        for (const candidate of packagedCandidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return require.resolve('@adhdev/session-host-daemon');
    }

    function pathsEquivalent(left: string, right: string): boolean {
        return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    }

    function getRunningSessionHostScriptPath(pid: number): string | null {
        const commandLine = getProcessCommandLine(pid);
        if (!commandLine || !/session-host-daemon/i.test(commandLine)) return null;
        return parseNodeScriptPath(commandLine);
    }

    function getPidFile(): string {
        return path.join(os.homedir(), '.adhdev', `${appName}-session-host.pid`);
    }

    function getPid(): number | null {
        try {
            const pidFile = getPidFile();
            if (!fs.existsSync(pidFile)) return null;
            const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            return Number.isFinite(pid) ? pid : null;
        } catch {
            return null;
        }
    }

    function killPid(pid: number): boolean {
        try {
            if (process.platform === 'win32') {
                const spawnOpts: { stdio: 'ignore'; windowsHide?: boolean } = { stdio: 'ignore' };
                if (options.killWindowsHide) spawnOpts.windowsHide = true;
                execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], spawnOpts);
            } else {
                process.kill(pid, 'SIGTERM');
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Resolve the node binary used to launch the session-host-daemon child.
     *
     * The session-host process `require()`s node-pty, whose Windows conpty.node
     * prebuild only ships for the bundled portable Node 22 (matching node-pty's
     * shipped win32-x64 prebuild). If the parent daemon happens to run under a
     * different node (e.g. the box's SYSTEM node 24 on a fresh install), spawning
     * the session-host with raw `process.execPath` would load node-pty under that
     * node — and if the prebuild is missing there, every session start crashes
     * with `Cannot find module ./prebuilds/win32-x64/conpty.node`.
     *
     * On win32 we therefore resolve the portable Node 22 the atomic-upgrade path
     * already uses (`findPortableNode22`) and spawn the child with it. If no
     * portable Node 22 is staged we fall back to `process.execPath` (never crash
     * a working setup) but warn loudly so the misconfiguration is diagnosable.
     *
     * On every other platform this returns `process.execPath` unchanged — the
     * session-host runtime selection is win32-only.
     */
    function resolveSessionHostNode(): string {
        if (process.platform !== 'win32') {
            return process.execPath;
        }
        let portableNode: string | null = null;
        try {
            portableNode = findPortableNode22(os.homedir(), process.execPath, resolveInstanceDir());
        } catch (error) {
            LOG.warn(
                'SessionHost',
                `Failed to resolve portable Node 22 for the session-host spawn: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (portableNode) {
            return portableNode;
        }
        LOG.warn(
            'SessionHost',
            `Portable Node 22 not found; spawning the session-host with ${process.execPath}. ` +
                'node-pty may fail to load its conpty.node prebuild under a non-22 Node on win32.',
        );
        return process.execPath;
    }

    function spawnHost(): void {
        const entry = resolveEntry();
        const nodeExecutable = resolveSessionHostNode();
        let stdio: StdioOptions = 'ignore';
        let logFd: number | null = null;
        if (options.spawnStdio === 'logfile') {
            const logDir = path.join(os.homedir(), '.adhdev', 'logs');
            fs.mkdirSync(logDir, { recursive: true });
            logFd = fs.openSync(path.join(logDir, 'session-host.log'), 'a');
            stdio = ['ignore', logFd, logFd];
        }
        const child = spawn(nodeExecutable, [entry], {
            detached: true,
            stdio,
            windowsHide: true,
            env: buildEnv(process.env),
        });
        child.unref();
        if (logFd !== null) {
            try { fs.closeSync(logFd); } catch { /* noop */ }
        }
    }

    function stopManagedSessionHostProcess(): boolean {
        let stopped = false;
        const pidFile = getPidFile();
        try {
            if (fs.existsSync(pidFile)) {
                const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
                if (Number.isFinite(pid) && pid !== process.pid && isManagedPid(pid)) {
                    stopped = killPid(pid) || stopped;
                }
            }
        } catch {
            // noop
        } finally {
            try {
                fs.unlinkSync(pidFile);
            } catch {
                // noop
            }
        }

        if (options.extraStop) {
            stopped = options.extraStop(endpoint) || stopped;
        }

        return stopped;
    }

    async function ensureReady(): Promise<SessionHostEndpoint> {
        options.beforeEnsureReady?.();

        // Defensive guard: on Windows the daemon may have been restarted from a
        // new versioned prefix while a session-host from the old prefix is still
        // running. Because the old host is reachable on the same socket endpoint,
        // `ensureSharedSessionHostReady` would reuse it and lazy requires would
        // resolve against the deleted tree. Detect the mismatch and stop the stale
        // host before it can be reused; a matching or unreadable host is left alone.
        if (process.platform === 'win32') {
            const existingPid = getPid();
            if (existingPid !== null) {
                const runningPath = getRunningSessionHostScriptPath(existingPid);
                const currentEntry = resolveEntry();
                if (runningPath && !pathsEquivalent(runningPath, currentEntry)) {
                    LOG.warn(
                        'SessionHost',
                        `Detected stale host pid ${existingPid} running from ${runningPath}; restarting from ${currentEntry}`,
                    );
                    stopManagedSessionHostProcess();
                }
            }
        }

        try {
            return await ensureSharedSessionHostReady({
                appName,
                spawnHost,
                timeoutMs,
                requiredRequestTypes: options.requiredRequestTypes,
            });
        } catch (error) {
            stopManagedSessionHostProcess();
            return ensureSharedSessionHostReady({
                appName,
                spawnHost,
                timeoutMs,
                requiredRequestTypes: options.requiredRequestTypes,
            }).catch((retryError) => {
                const initialMessage = error instanceof Error ? error.message : String(error);
                const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                throw new Error(`Session host failed to start after retry (${initialMessage}; retry: ${retryMessage})`);
            });
        }
    }

    return {
        appName,
        endpoint,
        getPidFile,
        getPid,
        buildEnv,
        resolveEntry,
        killPid,
        spawnHost,
        stopManagedSessionHostProcess,
        ensureReady,
        getStatusPaths() {
            return { pidFile: getPidFile(), endpoint };
        },
    };
}
