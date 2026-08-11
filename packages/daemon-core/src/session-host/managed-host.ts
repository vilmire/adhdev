import { execFileSync, spawn, type StdioOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SessionHostClient,
    getDefaultSessionHostEndpoint,
    sanitizeSpawnEnv,
    type SessionHostDiagnostics,
    type SessionHostEndpoint,
    type SessionHostRequestType,
} from '@adhdev/session-host-core';
import { getProcessCommandLine, parseNodeScriptPath } from '../commands/process-lifecycle.js';
import { findPortableNode22, resolveConptyPrebuildCandidates } from '../commands/windows-atomic-upgrade.js';
import { resolveInstanceDir } from '../commands/upgrade-helper.js';
import { getProcessInstanceContext } from '../config/instance-context.js';
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
    /**
     * Optional companion to `isManagedPid`, used only to decide whether a
     * pidfile may be retained after a failed stop.
     *
     * `isManagedPid` collapses two very different negatives into `false`: "the
     * command line could not be read" and "the command line was read and this is
     * clearly not our process". Return `true` here when the pid was positively
     * IDENTIFIED (its command line was readable), regardless of whether it turned
     * out to be ours. A pid that is identified but unmanaged is a recycled pid
     * owned by a stranger, so its pidfile is dropped instead of retained.
     */
    identifiesPid?: (pid: number) => boolean;
    /**
     * Test-only override for the resolved session-host entry path.
     *
     * `resolveEntry()` derives the packaged-install candidates from this
     * module's own `__dirname`, which in any test process is the real
     * daemon-core src tree. That makes the one condition the conpty guards act
     * on — a PACKAGED prefix whose prebuild is missing — impossible to stage
     * in-process, so without this seam those guards cannot be covered at all.
     * Production never sets it and behavior is unchanged when omitted.
     */
    resolveEntryOverride?: () => string;
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
    const isManagedPid = options.isManagedPid ?? (() => true);
    // Pid whose command line could not be read and which was therefore stopped
    // defensively. Bounds the unverifiable-host restart to once per pid per
    // process so a permanently unreadable host can never be killed in a loop.
    let unverifiedStopPid: number | null = null;

    // Instance context is resolved lazily (per call, cached per process) rather
    // than at factory creation: entrypoints like daemon-standalone pin
    // ADHDEV_CONFIG_DIR during their bootstrap import, which can run after this
    // module is first evaluated. Every derivation below must follow the SAME
    // resolved instance — never a re-derived or hardcoded ~/.adhdev.
    const instance = () => getProcessInstanceContext();
    const getEndpoint = (): SessionHostEndpoint =>
        getDefaultSessionHostEndpoint(appName, { ipcKey: instance().ipcKey });

    function buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const env = sanitizeSpawnEnv(baseEnv) as NodeJS.ProcessEnv;
        env.ADHDEV_SESSION_HOST_NAME = appName;
        // Pin the instance identity across the detached child: the spawned host
        // derives its socket/pid/storage namespace from ADHDEV_CONFIG_DIR, and a
        // pinned env can never be retargeted by another install editing a shared
        // config file. For the default instance this pins `<home>/.adhdev`,
        // which canonicalizes back to the legacy (unkeyed) endpoint.
        env.ADHDEV_CONFIG_DIR = instance().configDir;
        return env;
    }

    function resolveEntry(): string {
        if (options.resolveEntryOverride) return options.resolveEntryOverride();
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
        return path.join(instance().configDir, `${appName}-session-host.pid`);
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

    /**
     * Re-verify node-pty's conpty.node prebuild survives in the ACTIVE prefix,
     * right before every session-host spawn on win32.
     *
     * The install-time gate (`verifyStagedConptyPrebuild` in windows-atomic-
     * upgrade.ts) only proves the prebuild existed at staging time. A live
     * production incident showed it can vanish from the activated prefix
     * afterward through a mechanism that gate cannot see (root cause
     * unconfirmed after investigation — env-var casing, AV/EDR quarantine, and
     * a stray npm config were all checked and ruled out). Re-checking at spawn
     * time is the only remaining defense against that class of failure, and it
     * turns the prior symptom (a 4ms `Cannot find module './prebuilds/win32-x64/
     * conpty.node'` require crash inside the session-host child, with no hint
     * of which prefix was checked) into an immediate, actionable daemon-side
     * error that names the exact paths that were checked.
     *
     * Only applies to the packaged install layout `resolveEntry()` returns
     * (`<activePrefix>/node_modules/adhdev/vendor/session-host-daemon/index.js`,
     * matched by locating the `node_modules` segment that precedes it). In a
     * monorepo dev/test checkout `resolveEntry()` falls through to
     * `require.resolve('@adhdev/session-host-daemon')`, which resolves to a
     * workspace package path with no such segment — there is no "active
     * prefix" to check there, so the check is skipped rather than guessing.
     */
    function verifyConptyPrebuildBeforeSpawn(entry: string): void {
        if (process.platform !== 'win32') return;
        // Normalize both separators explicitly (not path.sep, which reflects the
        // HOST platform running this check, not necessarily the separator style
        // baked into `entry`) so the marker match is robust regardless of how
        // the path string was assembled upstream.
        const normalized = entry.replace(/\\/g, '/');
        const marker = '/node_modules/adhdev/vendor/session-host-daemon/';
        const markerIndex = normalized.lastIndexOf(marker);
        if (markerIndex === -1) return;
        const activePrefix = entry.slice(0, markerIndex);
        const candidates = resolveConptyPrebuildCandidates(activePrefix);
        const found = candidates.find((candidate) => fs.existsSync(candidate));
        if (!found) {
            throw new Error(
                'conpty.node missing at boot despite passing the install-time gate — likely deleted ' +
                    `post-install (checked: ${candidates.join(', ')}). Every session-host spawn would crash ` +
                    'requiring node-pty; refusing to spawn.',
            );
        }
        LOG.info('SessionHost', `conpty prebuild verified before spawn at ${found}`);
    }

    function spawnHost(): void {
        const entry = resolveEntry();
        verifyConptyPrebuildBeforeSpawn(entry);
        const nodeExecutable = resolveSessionHostNode();
        let stdio: StdioOptions = 'ignore';
        let logFd: number | null = null;
        if (options.spawnStdio === 'logfile') {
            const logDir = path.join(instance().configDir, 'logs');
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

    /**
     * Is `pid` still alive? Signal 0 performs the permission/existence check
     * without delivering a signal, so this never terminates anything.
     *
     * Unlike `getProcessCommandLine` (PowerShell/wmic, blocked outright on the
     * boxes this fix targets) this is a plain kernel call that always answers.
     * `EPERM` means the process exists but is owned by someone else — alive for
     * our purposes, and a pid we could not have killed anyway.
     */
    function isPidAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException)?.code === 'EPERM';
        }
    }

    function stopManagedSessionHostProcess(): boolean {
        let stopped = false;
        const pidFile = getPidFile();
        // Keep the pidfile when a tracked host is still alive but we failed to
        // kill it. Unconditionally deleting it is what disarmed the D1
        // stale-prefix guard in production: `isManagedPid` returns false when the
        // command line is unreadable (fail-closed), so the kill was skipped — yet
        // the pidfile was removed anyway, so the NEXT `ensureReady` read
        // `getPid() === null` and skipped the whole unverified-host block. The
        // zombie then survived every restart with nothing left tracking it.
        // Retaining the pidfile keeps the survivor visible to that guard.
        let keepPidFile = false;
        try {
            if (fs.existsSync(pidFile)) {
                const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
                if (Number.isFinite(pid) && pid !== process.pid) {
                    const managed = isManagedPid(pid);
                    if (managed) {
                        stopped = killPid(pid) || stopped;
                    }
                    // Retain the pidfile only for a pid that survived AND that we
                    // could not positively attribute to someone else.
                    //
                    // `isManagedPid` is three-valued in practice: true (proven
                    // ours), false-because-unreadable (the blocked-probe case this
                    // fix exists for), and false-because-proven-unrelated (a
                    // recycled pid now owned by an unrelated process). Only the
                    // first two may be retained — retaining a proven-unrelated pid
                    // would make the stale-host guard treat a stranger's process
                    // as our zombie host on the next start. `identifiesPid` lets a
                    // caller distinguish the last case; without it we fall back to
                    // liveness alone, which matches the previous behavior for
                    // hosts that are genuinely ours.
                    const provenUnrelated = !managed && options.identifiesPid?.(pid) === true;
                    keepPidFile = !provenUnrelated && isPidAlive(pid);
                    if (keepPidFile) {
                        LOG.warn(
                            'SessionHost',
                            `Session-host pid ${pid} is still alive after the stop attempt; keeping ${pidFile} ` +
                                'so the stale-host guard can still see it on the next start.',
                        );
                    }
                }
            }
        } catch {
            // noop
        } finally {
            if (!keepPidFile) {
                try {
                    fs.unlinkSync(pidFile);
                } catch {
                    // noop
                }
            }
        }

        if (options.extraStop) {
            stopped = options.extraStop(getEndpoint()) || stopped;
        }

        return stopped;
    }

    /**
     * Ask a reachable session-host for its own entry path and stop it when it
     * does not match this install's.
     *
     * Deliberately independent of every process-inspection API: the answer comes
     * from the host itself over the socket it is already serving. That is the
     * whole point — the boxes where this defect reproduces are exactly the ones
     * where `getProcessCommandLine` cannot answer.
     *
     * Conservative by construction. It only stops the host on a POSITIVE
     * mismatch (both paths known and different). A connect failure, a
     * diagnostics error, or a host too old to report the field all leave the
     * host untouched, so this can never take down a healthy setup and can never
     * loop: the replacement host reports the current entry and matches.
     */
    async function stopHostRunningFromForeignEntry(): Promise<void> {
        let currentEntry: string;
        try {
            currentEntry = resolveEntry();
        } catch {
            return; // Cannot determine our own entry — nothing to compare against.
        }

        const client = new SessionHostClient({ endpoint: getEndpoint() });
        let reported: string | undefined;
        try {
            await client.connect();
            const response = await client.request<SessionHostDiagnostics>({
                type: 'get_host_diagnostics',
                payload: { includeSessions: false },
            });
            if (!response.success || !response.result) return;
            const value = response.result.hostEntryPath;
            reported = typeof value === 'string' && value.trim() ? value : undefined;
        } catch {
            // No host listening, or it cannot answer. Either way there is nothing
            // to stop here; the normal spawn/ready path handles it.
            return;
        } finally {
            await client.close().catch(() => {});
        }

        if (!reported) return; // Pre-D5 host: unknown, not mismatched.
        if (pathsEquivalent(reported, currentEntry)) return;

        const reportedExists = fs.existsSync(reported);
        LOG.warn(
            'SessionHost',
            `Reachable session-host reports it is running from ${reported}` +
                `${reportedExists ? '' : ' (which no longer exists)'}, but this install runs from ${currentEntry}. ` +
                'That host would fail every create_session loading node-pty from its own prefix; stopping it so a ' +
                'current one is spawned in its place.',
        );
        stopManagedSessionHostProcess();
    }

    async function ensureReady(): Promise<SessionHostEndpoint> {
        options.beforeEnsureReady?.();

        // Defensive guard: on Windows the daemon may have been restarted from a
        // new versioned prefix while a session-host from the old prefix is still
        // running. Because the old host is reachable on the same socket endpoint,
        // `ensureSharedSessionHostReady` would reuse it and lazy requires would
        // resolve against the deleted tree. Detect the mismatch and stop the stale
        // host before it can be reused.
        //
        // The command line is not always readable: `getProcessCommandLine` shells
        // out to PowerShell (Get-CimInstance) with a wmic fallback, and AV/EDR
        // policy, a locked-down execution policy or a 5s timeout make BOTH fail —
        // structurally, every single time on an affected box. Treating that
        // `null` as "looks fine" is what let a stale host from a deleted prefix
        // survive for 9 days and take `create_session` down with
        // `Failed to load native module: conpty.node`. So an unverifiable host is
        // treated as possibly-stale and stopped: a wrong kill costs one immediate
        // respawn, a missed kill costs a long-latent outage.
        //
        // Anti-loop: the unverifiable-host stop is allowed at most once per pid
        // per process. If the freshly spawned host is *also* unreadable, the
        // second `ensureReady` leaves it alone, so this can never degrade into a
        // kill/respawn loop. A genuine prefix mismatch (readable command line) is
        // not rate-limited — that evidence is conclusive.
        if (process.platform === 'win32') {
            const existingPid = getPid();
            if (existingPid !== null) {
                const runningPath = getRunningSessionHostScriptPath(existingPid);
                const currentEntry = resolveEntry();
                if (runningPath === null) {
                    if (unverifiedStopPid !== existingPid) {
                        unverifiedStopPid = existingPid;
                        LOG.warn(
                            'SessionHost',
                            `Could not read the command line of host pid ${existingPid}; cannot prove it runs from ${currentEntry}. ` +
                                'Stopping it once and respawning rather than risking reuse of a stale-prefix host.',
                        );
                        stopManagedSessionHostProcess();
                    } else {
                        LOG.warn(
                            'SessionHost',
                            `Host pid ${existingPid} is still unverifiable; leaving it alone (already restarted once this process) ` +
                                'to avoid a kill/respawn loop.',
                        );
                    }
                } else if (!pathsEquivalent(runningPath, currentEntry)) {
                    LOG.warn(
                        'SessionHost',
                        `Detected stale host pid ${existingPid} running from ${runningPath}; restarting from ${currentEntry}`,
                    );
                    stopManagedSessionHostProcess();
                }
            }
        }

        // D5: ask the reachable host WHICH install it is running from.
        //
        // Every earlier stale-host guard (D1 above, `isManagedSessionHostPid`,
        // `listOwnedNodeProcesses`) routes through `getProcessCommandLine`, which
        // is blocked outright on the boxes this defect keeps recurring on: AV/EDR
        // denies `Get-CimInstance`, and `wmic` no longer ships. On those boxes all
        // three silently answer "nothing to see" and the stale host is reused.
        //
        // D4-b below catches the case where the CURRENT prefix lost its prebuild,
        // but not this one: after a successful upgrade the current prefix is
        // perfectly healthy — it is the HOST that is running from a prefix the
        // upgrade deleted. Its lazy `require` of node-pty then fails inside
        // create_session with `Cannot find module './prebuilds/win32-x64/
        // conpty.node'`, in ~1ms, naming a directory that no longer exists.
        //
        // The host itself always knows its own path, so ask it. No privileges
        // required, so it works exactly where the process probe does not. A host
        // too old to report `hostEntryPath` yields undefined and is left alone —
        // unknown is never treated as a mismatch.
        if (process.platform === 'win32') {
            await stopHostRunningFromForeignEntry();
        }

        // D4-b: re-verify conpty on the REUSE path, not just the spawn path.
        //
        // `ensureSharedSessionHostReady` returns the endpoint immediately when a
        // host answers on the socket, so `spawnHost()` — and with it the D4-a
        // pre-spawn conpty gate — is never reached. A zombie session-host from a
        // deleted prefix answers that socket perfectly well: it only fails later,
        // inside `create_session`, when it lazily requires node-pty and the
        // conpty.node under its own (now deleted) prefix is gone. That is the
        // exact production incident this guards: a host spawned from a prefix
        // deleted on 07-24 kept serving the socket and failing every session
        // start in 4ms, and manually killing it restored service.
        //
        // The pid-based guards above cannot catch it, because all three of them
        // (`getRunningSessionHostScriptPath`, `isManagedPid`, and
        // `listOwnedNodeProcesses`) depend on `getProcessCommandLine`, which
        // fails structurally on the affected boxes (`Get-CimInstance` access
        // denied plus no `wmic`). This check deliberately uses an INDEPENDENT
        // signal — the presence of conpty.node in the currently active prefix —
        // so it works with no process-inspection privileges at all.
        //
        // `resolveEntry()` always names the CURRENT install's entry (recomputed
        // from this module's own location), so on a healthy install this passes
        // and nothing is stopped. It only fires when the active prefix genuinely
        // has no usable conpty prebuild, i.e. when every session start is already
        // doomed — see the loop-safety note below.
        if (process.platform === 'win32') {
            try {
                verifyConptyPrebuildBeforeSpawn(resolveEntry());
            } catch (error) {
                // Anti-loop: stopping here does NOT create a kill/respawn cycle.
                // The subsequent spawn runs the same check inside `spawnHost()`
                // (D4-a) and throws before spawning, so `ensureReady` fails fast
                // and loudly instead of respawning. And in this state the host is
                // useless by construction — every `create_session` would crash
                // requiring node-pty — so stopping it costs nothing that was
                // working. Repair means restoring the prebuild, not retrying.
                LOG.warn(
                    'SessionHost',
                    `conpty prebuild missing in the active prefix; a reachable session-host would fail every ` +
                        `create_session. Stopping it rather than reusing it: ${error instanceof Error ? error.message : String(error)}`,
                );
                stopManagedSessionHostProcess();
            }
        }

        try {
            return await ensureSharedSessionHostReady({
                appName,
                endpoint: getEndpoint(),
                spawnHost,
                timeoutMs,
                requiredRequestTypes: options.requiredRequestTypes,
            });
        } catch (error) {
            stopManagedSessionHostProcess();
            return ensureSharedSessionHostReady({
                appName,
                endpoint: getEndpoint(),
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
        get endpoint() {
            return getEndpoint();
        },
        getPidFile,
        getPid,
        buildEnv,
        resolveEntry,
        killPid,
        spawnHost,
        stopManagedSessionHostProcess,
        ensureReady,
        getStatusPaths() {
            return { pidFile: getPidFile(), endpoint: getEndpoint() };
        },
    };
}
