import { provisionRecoveryHostChannel, forgetRecoveryHostChannel } from './recovery-owner-channel.js';
import { loadConfig } from '../config/config.js';
import { readCooperativeMaintenance, assertMaintenanceLifecycle, verifyRetainedMaintenanceHost } from '../maintenance/cooperative-gate.js';
import { assertWorkerBridgeLifecycleAdmission } from '../commands/worker-bridge-lifecycle-admission.js';
import { spawn, type StdioOptions } from 'child_process';
import { hiddenExecFileSync } from '../process/hidden-spawn.js';
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
import { getProcessCommandLine, isManagedSessionHostCommandLine, sessionHostInstanceArg, parseNodeScriptPath } from '../commands/process-lifecycle.js';
import { findPortableNode22, resolveConptyPrebuildCandidates } from '../commands/windows-atomic-upgrade.js';
import { resolveInstanceDir } from '../commands/upgrade-log.js';
import { getProcessInstanceContext } from '../config/instance-context.js';
import { LOG } from '../logging/logger.js';
import { preflightDiskSpace } from '../diagnostics/disk-space-preflight.js';
import {
    ensureSessionHostReady as ensureSharedSessionHostReady,
    isResourceExhaustionError,
    SESSION_HOST_PROBE_TIMEOUT_MS,
    recordSessionHostProbeFailure,
    recordSessionHostProbeSuccess,
    SessionHostUnavailableTransientError,
    createSessionHostProbeInvocation,
    type SessionHostReplacementAuthorization,
} from './runtime-support.js';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../runtime-defaults.js';
import { isPidAlive } from '../system/process-utils.js';

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
     * Additional PID guard, defaulting to false. Every signal also requires
     * a session-host argv identity matching this instance's config directory.
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
    /**
     * Legacy option retained for source compatibility; automatic live eviction
     * and escalation are unsupported.
     */
    evictGraceMs?: number;
    /**
     * Callback invoked whenever a replacement session-host is spawned so the
     * caller can immediately reconcile or terminate sessions from the old host.
     */
    onHostReplaced?: (endpoint: SessionHostEndpoint) => Promise<void> | void;
    /**
     * Legacy option retained for compatibility. It never authorizes automatic
     * replacement of a live or unknown host.
     */
    replacementAuthority?: SessionHostReplacementAuthorization | (() => SessionHostReplacementAuthorization | undefined);
    /** Optional process birth probe override (`ps -o lstart=`). */
    getProcessBirth?: (pid: number) => string | null;
    /** Optional unix socket owner PID probe override (`lsof -t`). */
    getSocketOwnerPids?: (endpointPath: string) => number[] | null;
    /**
     * Optional unix socket connect probe override. 'refused' (ECONNREFUSED) and
     * 'absent' (ENOENT) are the only results that prove no listener exists.
     */
    probeSocketConnect?: (endpointPath: string) => 'refused' | 'absent' | 'connected' | 'timeout' | 'error';
}

export interface ManagedSessionHost {
    readonly appName: string;
    readonly endpoint: SessionHostEndpoint;
    getPidFile(): string;
    getReplacementProvenanceFile(): string;
    getPid(): number | null;
    buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    resolveEntry(): string;
    killPid(pid: number): boolean;
    spawnHost(): void;
    stopManagedSessionHostProcess(): boolean;
    acquireIdleReplacementAuthority(options: {
        owner: string;
        token: string;
        timeoutMs?: number;
        isCancelled?: () => boolean;
    }): Promise<SessionHostReplacementAuthorization>;
    ensureReady(ensureOptions?: {
        replacementAuthority?: SessionHostReplacementAuthorization | (() => SessionHostReplacementAuthorization | undefined);
    }): Promise<SessionHostEndpoint>;
    getStatusPaths(): { pidFile: string; endpoint: SessionHostEndpoint };
}

export function createManagedSessionHost(options: ManagedSessionHostOptions): ManagedSessionHost {
    const appName = options.appName;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;
    const isManagedPid = options.isManagedPid ?? (() => false);
    const canSignalPid = (pid: number): boolean => pid > 0 && pid !== process.pid
        && isManagedPid(pid)
        && isManagedSessionHostCommandLine(getProcessCommandLine(pid), instance().configDir);
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
        if (
            typeof baseEnv.ADHDEV_WORKER_GUARDIAN_PINS_FILE === 'string'
            && baseEnv.ADHDEV_WORKER_GUARDIAN_PINS_FILE.trim()
        ) {
            env.ADHDEV_WORKER_GUARDIAN_PINS_FILE = baseEnv.ADHDEV_WORKER_GUARDIAN_PINS_FILE.trim();
        }
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
        if (!isManagedSessionHostCommandLine(commandLine, instance().configDir)) return null;
        return parseNodeScriptPath(commandLine);
    }

    function getPidFile(): string {
        return path.join(instance().configDir, `${appName}-session-host.pid`);
    }

    function getReplacementProvenanceFile(): string {
        return path.join(instance().configDir, `${appName}-session-host-replacement.json`);
    }

    function assertManagedHostBridgeAdmission(operation: string): void {
        // The canonical gate checks current AND target namespaces and remembers
        // strict observations even after their on-disk artifacts disappear.
        assertWorkerBridgeLifecycleAdmission(operation, instance().configDir);
    }

    function pathIdentity(file: string): string {
        try {
            const stat = fs.lstatSync(file, { bigint: true });
            return `${stat.dev}:${stat.ino}:${stat.mode}`;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
            throw error;
        }
    }

    function getExistingHostGeneration(): string {
        const context = instance();
        const endpoint = getEndpoint();
        const pidState = readPidFileState();
        const pid = pidState.status === 'ok' ? pidState.pid : null;
        return JSON.stringify([
            context.configDir, context.canonicalConfigDir, context.ipcKey,
            pathIdentity(context.configDir), pidState,
            pid === null ? null : getProcessBirth(pid),
            pid === null ? false : isPidAlive(pid),
            endpoint.kind, endpoint.path, pathIdentity(endpoint.path),
            instance().canonicalConfigDir, readPidFileState(),
        ]);
    }

    function assertAutomaticStart(generation: string, isCancelled?: () => boolean, deadline = Infinity): void {
        assertManagedHostBridgeAdmission('session_host_spawn');
        const state = inspectExistingHostState();
        const currentGeneration = getExistingHostGeneration();
        assertManagedHostBridgeAdmission('session_host_spawn');
        // Check cancellation after all blocking native/disk reads, immediately
        // before the caller's effect. A dead receipt never authorizes a new PID.
        if (state !== 'dead' || generation !== currentGeneration || Date.now() >= deadline || isCancelled?.()) {
            throw new SessionHostUnavailableTransientError(getEndpoint());
        }
    }

    function readPidFileState(): { status: 'missing' } | { status: 'corrupt' } | { status: 'ok'; pid: number } {
        try {
            const pidFile = getPidFile();
            if (!fs.existsSync(pidFile)) return { status: 'missing' };
            const raw = fs.readFileSync(pidFile, 'utf8').trim();
            if (!/^\d+$/.test(raw)) return { status: 'corrupt' };
            const pid = Number.parseInt(raw, 10);
            return Number.isSafeInteger(pid) && pid > 0 ? { status: 'ok', pid } : { status: 'corrupt' };
        } catch {
            return { status: 'corrupt' };
        }
    }

    function getPid(): number | null {
        const state = readPidFileState();
        return state.status === 'ok' ? state.pid : null;
    }

    function getProcessBirth(pid: number): string | null {
        if (options.getProcessBirth) return options.getProcessBirth(pid);
        if (process.platform === 'win32') return null;
        try {
            const out = String(
                hiddenExecFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 2_000,
                }),
            ).trim();
            return out || null;
        } catch {
            return null;
        }
    }

    function getSocketOwnerPids(endpointPath: string): number[] | null {
        if (options.getSocketOwnerPids) return options.getSocketOwnerPids(endpointPath);
        if (process.platform === 'win32' || !fs.existsSync(endpointPath)) return null;
        const lsofBin = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
        try {
            const out = String(
                hiddenExecFileSync(lsofBin, ['-n', '-t', '--', endpointPath], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 2_000,
                }),
            );
            const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length === 0) return [];
            if (!lines.every((line) => /^\d+$/.test(line))) return null;
            const pids = lines.map((line) => Number.parseInt(line, 10));
            return pids.every(pid => Number.isSafeInteger(pid) && pid > 0) ? pids : null;
        } catch (error: any) {
            if (
                (error?.status === 1 && String(error?.stdout ?? '').trim() === '')
                || (error?.message === 'no socket owner' && error?.status === undefined && error?.code === undefined && error?.signal === undefined)
            ) {
                return [];
            }
            return null;
        }
    }

    /**
     * Synchronous connect probe, run in a short-lived child node (the callers
     * are synchronous and node has no sync socket API). Anything but a clean
     * ECONNREFUSED/ENOENT — success, hang, spawn failure, odd output — is
     * reported as non-proof.
     */
    function probeSocketConnect(endpointPath: string): 'refused' | 'absent' | 'connected' | 'timeout' | 'error' {
        if (options.probeSocketConnect) return options.probeSocketConnect(endpointPath);
        const script = "const s=require('net').connect(process.argv[1]);const f=(r)=>{process.stdout.write(r);process.exit(0)};"
            + "s.once('connect',()=>f('connected'));"
            + "s.once('error',(e)=>f(e&&e.code==='ECONNREFUSED'?'refused':e&&e.code==='ENOENT'?'absent':'error'));"
            + "setTimeout(()=>f('timeout'),1500)";
        try {
            const out = String(
                hiddenExecFileSync(process.execPath, ['-e', script, endpointPath], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 4_000,
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                }),
            ).trim();
            return out === 'refused' || out === 'absent' || out === 'connected' || out === 'timeout' ? out : 'error';
        } catch {
            return 'error';
        }
    }

    /**
     * No usable PID (missing/corrupt pidfile) but an endpoint file remains.
     * Reclaimable only with positive proof of absence: a real socket node, no
     * process holding it (lsof returns an empty list, not null), and connect
     * yields ECONNREFUSED. Hangs, accepted connections and unknowns stay refused.
     */
    function isOrphanUnixSocket(endpointPath: string): boolean {
        if (process.platform === 'win32') return false;
        try {
            if (!fs.lstatSync(endpointPath).isSocket()) return false;
        } catch {
            return false;
        }
        const owners = getSocketOwnerPids(endpointPath);
        if (owners === null || owners.length !== 0) return false;
        return probeSocketConnect(endpointPath) === 'refused';
    }

    function getExistingHostIdentity(): string {
        const pid = getPid();
        if (pid === null) return 'unknown';
        const birth = getProcessBirth(pid);
        return birth ? `pid-${pid}:birth-${birth}` : `pid-${pid}:birth-unknown`;
    }

    function isKnownDeadPid(pid: number): boolean {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }

    function inspectExistingHostState(): 'alive' | 'dead' | 'unknown' {
        const endpoint = getEndpoint();
        const pidState = readPidFileState();
        if (pidState.status === 'corrupt' || pidState.status === 'missing') {
            if (endpoint.kind === 'unix' && fs.existsSync(endpoint.path)) {
                return isOrphanUnixSocket(endpoint.path) ? 'dead' : 'unknown';
            }
            if (pidState.status === 'corrupt') return 'unknown';
            return fs.existsSync(endpoint.path) ? 'unknown' : 'dead';
        }
        const existingPid = pidState.pid;
        if (existingPid === process.pid) return 'unknown';
        if (isKnownDeadPid(existingPid)) {
            if (endpoint.kind === 'unix' && fs.existsSync(endpoint.path)) {
                if (process.platform !== 'win32') {
                    const owners = getSocketOwnerPids(endpoint.path);
                    if (owners === null) {
                        return 'unknown';
                    }
                    if (owners.length !== 0) {
                        return 'unknown';
                    }
                }
            }
            return 'dead';
        }
        if (!isPidAlive(existingPid) || !canSignalPid(existingPid)) return 'unknown';
        const birth = getProcessBirth(existingPid);
        if (!birth || birth.toLowerCase() === 'win32' || birth.toLowerCase() === 'unknown') return 'unknown';
        if (endpoint.kind === 'unix' && fs.existsSync(endpoint.path)) {
            if (process.platform !== 'win32') {
                const owners = getSocketOwnerPids(endpoint.path);
                if (owners === null) {
                    return 'unknown';
                }
                if (owners.length > 0 && !owners.includes(existingPid)) return 'unknown';
                if (owners.some((ownerPid) => ownerPid !== existingPid && isPidAlive(ownerPid))) return 'unknown';
            }
        }
        return 'alive';
    }

    function killPid(pid: number): boolean {
        assertMaintenanceLifecycle('session_host_kill', instance().configDir);
        try {
            if (!canSignalPid(pid)) return false;
            if (process.platform === 'win32') {
                hiddenExecFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
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

    function spawnHost(startFence?: { generation: string; isCancelled: () => boolean; deadline: number }): void {
        assertManagedHostBridgeAdmission('session_host_spawn');
        const generation = startFence?.generation ?? getExistingHostGeneration();
        const assertStart = () => assertAutomaticStart(generation, startFence?.isCancelled, startFence?.deadline);
        assertStart();
        assertMaintenanceLifecycle('session_host_spawn', instance().configDir);
        assertManagedHostBridgeAdmission('session_host_spawn');
        const entry = resolveEntry();
        verifyConptyPrebuildBeforeSpawn(entry);
        // Fail loudly on a full volume BEFORE spawning. A session host started
        // onto a full disk dies on its first write with an uncaught ENOSPC that
        // lands only in its own detached log — the failure then reappears
        // downstream as sessions that never report completion. Throwing here
        // puts the real cause in the daemon log and in the caller's error.
        preflightDiskSpace(instance().configDir, 'spawn the session host');
        const nodeExecutable = resolveSessionHostNode();
        let stdio: StdioOptions = 'ignore';
        let logFd: number | null = null;
        if (options.spawnStdio === 'logfile') {
            const logDir = path.join(instance().configDir, 'logs');
            assertStart();
            fs.mkdirSync(logDir, { recursive: true });
            assertStart();
            logFd = fs.openSync(path.join(logDir, 'session-host.log'), 'a');
            stdio = ['ignore', logFd, logFd];
        }
        // The host owns IPC/snapshots: keep it normal priority. Only its agent
        // PTY children are lowered in session-host-daemon/runtime.ts.
        assertStart();
        const recoveryEndpoint = getEndpoint();
        const recoveryPublicKey = provisionRecoveryHostChannel(recoveryEndpoint);
        stdio = Array.isArray(stdio) ? [...stdio, 'pipe'] : ['ignore', 'ignore', 'ignore', 'pipe'];
        const child = spawn(nodeExecutable, [entry, 'serve', sessionHostInstanceArg(instance().configDir)], {
            detached: true,
            stdio,
            windowsHide: true,
            env: { ...buildEnv(process.env), ADHDEV_RECOVERY_BOOT_FD: '3' },
        });

        const recoveryPipe = child.stdio?.[3] as import('node:stream').Writable | null;
        if (!recoveryPipe) throw new Error('recovery_host_bootstrap_pipe_missing');
        recoveryPipe.on('error', () => forgetRecoveryHostChannel(recoveryEndpoint, recoveryPublicKey));
        recoveryPipe.end(JSON.stringify({ publicKey: recoveryPublicKey, workerDaemonId: `daemon_${loadConfig().machineId}` }));
        child.once('exit', () => forgetRecoveryHostChannel(recoveryEndpoint, recoveryPublicKey));

        // Observe the child's death before unref'ing it.
        //
        // `unref()` only releases the event loop's hold on the handle — it does
        // NOT detach listeners, so these still fire for as long as this daemon
        // process lives. Previously the `child` handle was dropped on the floor
        // with zero listeners, which meant a session-host that died seconds after
        // spawn (ENOSPC on its first log write, a native module fault, OOM) left
        // *nothing* in the daemon log. The failure then surfaced only as its
        // downstream symptom — sessions that never report completion — and reads
        // as an application bug rather than "the host process is gone".
        //
        // Attached defensively: `spawn` is stubbed in several suites with a bare
        // object, and observability must never be the thing that breaks a spawn.
        if (typeof child?.on === 'function') {
            child.on('error', (error) => {
                LOG.error('SessionHost', `Failed to spawn session-host process: ${error?.message || error}`);
            });
            child.on('exit', (code, signal) => {
                const how = signal ? `signal ${signal}` : `code ${code}`;
                const detail = options.spawnStdio === 'logfile'
                    ? ` — see ${path.join(instance().configDir, 'logs', 'session-host.log')} for its stderr`
                    : '';
                // Any exit is notable: this host is meant to outlive the spawn
                // call. A zero exit is still an unexpected disappearance.
                LOG.error(
                    'SessionHost',
                    `Session-host process (pid ${child.pid ?? 'unknown'}) exited with ${how}${detail}`,
                );
            });
        }

        if (typeof child?.unref === 'function') child.unref();
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
    function stopManagedSessionHostProcess(): boolean {
        assertWorkerBridgeLifecycleAdmission('session_host_stop', instance().configDir);
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
                    const managed = canSignalPid(pid);
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

    /** Diagnose a reachable incompatible prefix without mutating its host. */
    async function checkHostRunningFromForeignEntry(deadline: number, probeInvocation: number, options: { onlyWhenEntryMissing?: boolean } = {}): Promise<void> {
        let currentEntry: string;
        try {
            currentEntry = resolveEntry();
        } catch {
            return; // Cannot determine our own entry — nothing to compare against.
        }

        const endpoint = getEndpoint();
        const probeTimeoutMs = Math.max(1, Math.min(SESSION_HOST_PROBE_TIMEOUT_MS, deadline - Date.now()));
        const probeDeadline = Date.now() + probeTimeoutMs;
        // A probe timeout disconnects its client; never borrow a controller
        // socket that may have a 30s list_sessions request in flight.
        const client = new SessionHostClient({ endpoint, requestTimeoutMs: probeTimeoutMs, registerAsShared: false });
        let reported: string | undefined;
        let connected = false;
        let requestTimeoutMs = probeTimeoutMs;
        let requestStartMonotonic = 0;
        let requestStartWall = 0;
        try {
            await client.connect(probeTimeoutMs);
            connected = true;
            requestTimeoutMs = Math.max(1, probeDeadline - Date.now());
            requestStartMonotonic = performance.now();
            requestStartWall = Date.now();
            const response = await client.request<SessionHostDiagnostics>({
                type: 'get_host_diagnostics',
                payload: { includeSessions: false },
            }, { timeoutMs: requestTimeoutMs });
            recordSessionHostProbeSuccess(endpoint, response.success ? response.result : undefined);
            if (!response.success || !response.result) return;
            const value = response.result.hostEntryPath;
            reported = typeof value === 'string' && value.trim() ? value : undefined;
        } catch (error) {
            if (connected && error && typeof error === 'object') {
                const actualElapsedMs = Math.max(0, Math.round(performance.now() - requestStartMonotonic));
                const wallElapsedMs = Math.max(0, Date.now() - requestStartWall);
                const observerLagMs = Math.max(0, actualElapsedMs - requestTimeoutMs);
                const record = error as Record<string, unknown>;
                if (typeof record.scheduledTimeoutMs !== 'number') record.scheduledTimeoutMs = requestTimeoutMs;
                if (typeof record.actualElapsedMs !== 'number') record.actualElapsedMs = actualElapsedMs;
                if (typeof record.wallElapsedMs !== 'number') record.wallElapsedMs = wallElapsedMs;
                if (typeof record.observerLagMs !== 'number') record.observerLagMs = observerLagMs;
            }
            // request() disconnects on timeout. Preserve the connected-RPC
            // evidence before ensure probes a fresh connection below.
            recordSessionHostProbeFailure(endpoint, connected ? error : undefined, getExistingHostIdentity(), probeInvocation);
            if (isResourceExhaustionError(error)) throw new SessionHostUnavailableTransientError(endpoint, error);
            return;
        } finally {
            await client.close().catch(() => {});
        }

        if (!reported) return; // Pre-D5 host: unknown, not mismatched.
        if (pathsEquivalent(reported, currentEntry)) return;

        const reportedExists = fs.existsSync(reported);
        // POSIX keeps a host from another install that still exists: node-pty
        // works from any intact prefix, and stopping it would end live sessions.
        if (options.onlyWhenEntryMissing && reportedExists) return;
        LOG.warn(
            'SessionHost',
            `Reachable session-host reports it is running from ${reported}` +
                `${reportedExists ? '' : ' (which no longer exists)'}, but this install runs from ${currentEntry}. ` +
                'Automatic replacement is unsupported; retaining the existing host.',
        );
        throw new SessionHostUnavailableTransientError(endpoint, new Error('session_host_foreign_entry'));
    }

    async function ensureReady(ensureOptions?: {
        replacementAuthority?: SessionHostReplacementAuthorization | (() => SessionHostReplacementAuthorization | undefined);
    }): Promise<SessionHostEndpoint> {
        const ensureDeadline = Date.now() + timeoutMs;
        const probeInvocation = createSessionHostProbeInvocation();
        const maintenance = readCooperativeMaintenance(instance().configDir);
        if (maintenance) {
            if (process.platform === 'win32') throw new Error('maintenance_windows_retained_host_unsupported');
            // Before quarantine, stale-prefix logic, retry or any native mutation.
            const h = maintenance.retainedHost, endpoint = getEndpoint();
            const nodePath = process.platform === 'linux' ? fs.realpathSync(`/proc/${h.pid}/exe`)
                : String(hiddenExecFileSync('/bin/ps', ['-o','comm=','-p',String(h.pid)], { encoding: 'utf8', timeout: 5000 })).trim();
            const birth = String(hiddenExecFileSync('/bin/ps', ['-o','lstart=','-p',String(h.pid)], { encoding: 'utf8', timeout: 5000 })).trim();
            const ownerText = String(hiddenExecFileSync(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof', ['-t', endpoint.path], { encoding: 'utf8', timeout: 5000 })).trim();
            if (!/^\d+$/.test(ownerText)) throw new Error('maintenance_retained_socket_owner_unknown');
            const client = new SessionHostClient({ endpoint, registerAsShared: false });
            try {
                await client.connect();
                const reply = await client.request<SessionHostDiagnostics>({ type: 'get_host_diagnostics', payload: { includeSessions: false } });
                if (!reply.success || !reply.result) throw new Error('maintenance_retained_host_unreachable');
                // The pid is pinned by the record (birth, socket owner, RPC entry), and the
                // verifier demands the exact pinned entry path, so read the script path raw:
                // the kill-safety classifier (isManagedSessionHostCommandLine) would refuse a
                // genuine retained host whose node binary is not literally named `node`.
                verifyRetainedMaintenanceHost(maintenance, { pid: getPid(), birth, nodePath, socketOwnerPid: Number(ownerText),
                    entryPath: parseNodeScriptPath(getProcessCommandLine(h.pid)), endpoint: endpoint.path,
                    hostEntryPath: reply.result.hostEntryPath, hostStartedAt: reply.result.hostStartedAt });
                const supported = reply.result.supportedRequestTypes ?? [];
                if (options.requiredRequestTypes.some(t => !supported.includes(t))) throw new Error('maintenance_retained_host_incompatible');
                return endpoint;
            } finally { await client.close().catch(() => {}); }
        }
        if (inspectExistingHostState() === 'dead') assertManagedHostBridgeAdmission('session_host_spawn');
        const generation = getExistingHostGeneration();
        options.beforeEnsureReady?.();

        // An argv mismatch diagnoses incompatibility without stopping the host.
        if (process.platform === 'win32') {
            const existingPid = getPid();
            if (existingPid !== null) {
                const runningPath = getRunningSessionHostScriptPath(existingPid);
                if (runningPath !== null && !pathsEquivalent(runningPath, resolveEntry())) {
                    LOG.warn('SessionHost', `Detected host pid ${existingPid} running from ${runningPath}; retaining the existing host`);
                    throw new SessionHostUnavailableTransientError(getEndpoint(), new Error('session_host_foreign_entry'));
                }
            }
        }

        // Probe through an isolated client; never disconnect retained clients.
        if (process.platform === 'win32') {
            await checkHostRunningFromForeignEntry(ensureDeadline, probeInvocation);
        } else {
            await checkHostRunningFromForeignEntry(ensureDeadline, probeInvocation, { onlyWhenEntryMissing: true });
        }

        // A missing local prebuild is an incompatibility, never stop authority.
        if (process.platform === 'win32') verifyConptyPrebuildBeforeSpawn(resolveEntry());

        const isExistingHostAlive = (): boolean => inspectExistingHostState() === 'alive';

        if (getExistingHostGeneration() !== generation) throw new SessionHostUnavailableTransientError(getEndpoint());
        const isCancelled = (): boolean => {
            const source = ensureOptions?.replacementAuthority ?? options.replacementAuthority;
            const auth = typeof source === 'function' ? source() : source;
            return Boolean(auth?.isCancelled?.());
        };
        const beforeSpawnHost = (): void => {
            assertAutomaticStart(generation, isCancelled, ensureDeadline);
            // Keep the verified-dead PID: the child must independently validate
            // it together with empty socket owners and endpoint dev/ino.
        };
        return ensureSharedSessionHostReady({
            appName, probeInvocation, endpoint: getEndpoint(),
            spawnHost: () => {
                assertAutomaticStart(generation, isCancelled, ensureDeadline);
                spawnHost({ generation, isCancelled, deadline: ensureDeadline });
            },
            beforeSpawnHost,
            assertLifecycleAdmission: beforeSpawnHost,
            onHostReplaced: options.onHostReplaced,
            isExistingHostAlive,
            existingHostState: inspectExistingHostState,
            existingHostIdentity: getExistingHostIdentity,
            existingHostGeneration: getExistingHostGeneration,
            isCancelled,
            timeoutMs: Math.max(1, ensureDeadline - Date.now()),
            requiredRequestTypes: options.requiredRequestTypes,
        });
    }

    async function acquireIdleReplacementAuthority(_leaseOptions: {
        owner: string;
        token: string;
        timeoutMs?: number;
        isCancelled?: () => boolean;
    }): Promise<SessionHostReplacementAuthorization> {
        // Explicit native RPC and retained-host maintenance remain separate.
        // Ordinary ensure/start has no supported live replacement authority.
        throw new Error('session_host_automatic_live_replacement_unsupported');
    }

    return {
        appName,
        get endpoint() {
            return getEndpoint();
        },
        getPidFile,
        getReplacementProvenanceFile,
        getPid,
        buildEnv,
        resolveEntry,
        killPid,
        spawnHost,
        stopManagedSessionHostProcess,
        acquireIdleReplacementAuthority,
        ensureReady,
        getStatusPaths() {
            return { pidFile: getPidFile(), endpoint: getEndpoint() };
        },
    };
}
