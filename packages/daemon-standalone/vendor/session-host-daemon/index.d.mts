#!/usr/bin/env node
import { EventEmitter } from 'events';
import * as net from 'net';
import { SessionHostEndpoint, SessionHostRegistry, SessionHostRequest, SessionHostResponse } from '@adhdev/session-host-core';

interface HostUpgradeBinding {
    /** Trusted packaged helper; supplied hash must come from an immutable artifact pin. */
    helperPath: string;
    helperSha256: string;
    helperProtocol?: 1;
    helperFileIdentity?: string;
    stateDir: string;
}

declare function sessionHostInstanceArg(configDir: string): string;
declare function isManagedSessionHostCommandLine(commandLine: string | null | undefined, configDir?: string): boolean;
interface SessionHostReplacementProvenance {
    expectedPid: number;
    expectedBirth: string;
    instanceConfigDir?: string;
    instanceConfigKey?: string;
    expectedEndpointInode?: bigint;
    expectedBootId?: string;
    expectedEpoch?: number;
    expectedOwner?: string;
    expectedTokenHash?: string;
    activeRuntimeCount?: number;
    isCancelled?: () => boolean;
}
declare function readVerifiedReplacementProvenance(options: {
    provenanceFile?: string;
    provenanceFilePath?: string;
    instanceConfigDir: string;
    appName?: string;
    endpointPath: string;
    leaseStateDir?: string;
    nowMs?: () => number;
    skipDynamicWrap?: boolean;
}): SessionHostReplacementProvenance | undefined;

interface SessionHostServerOptions {
    endpoint?: SessionHostEndpoint;
    /** Opt-in pinned native binding; absent hosts cannot attest an upgrade idle lease. */
    upgradeBinding?: HostUpgradeBinding;
    appName?: string;
    /** Explicit session-host state root (runtime records + tombstones). */
    storageRootDir?: string;
    /** Instance config directory used to verify single matching --instance-config-key on prior owners. */
    instanceConfigDir?: string;
    /** Optional pidfile path checked before unlinking/rebinding a unix socket endpoint. */
    pidFilePath?: string;
    /** Optional predicate override for testing whether a prior pid is alive. */
    isPidAlive?: (pid: number) => boolean;
    /** Optional predicate override for testing whether a prior pid is a managed session-host. */
    isManagedOwnerPid?: (pid: number) => boolean;
    /** Unsupported legacy replacement context; ordinary startup rejects its presence. */
    replacementProvenance?: SessionHostReplacementProvenance | (() => SessionHostReplacementProvenance | undefined);
    /** Optional native birth probe override (`ps -o lstart=`). */
    getOwnerBirth?: (pid: number) => string | null;
    /** Optional unix socket owner PID probe override (`lsof -t`). */
    getSocketOwnerPids?: (endpointPath: string) => number[] | null;
    /** Cancellation is checked after blocking reads and before startup effects. */
    isCancelled?: () => boolean;
    /** Optional process command-line probe override (`ps -o args=`). */
    readOwnerArgs?: (pid: number) => string | null;
    /** Legacy option retained for source compatibility; automatic live eviction is unsupported. */
    evictGraceMs?: number;
}
declare class SessionHostServer extends EventEmitter {
    readonly endpoint: SessionHostEndpoint;
    readonly registry: SessionHostRegistry;
    private runtimes;
    private readonly storage;
    private readonly upgradeLease;
    private readonly instanceConfigDir;
    private readonly pidFilePath;
    private readonly isPidAliveOverride?;
    private readonly getOwnerBirth?;
    private readonly getSocketOwnerPids?;
    private readonly isCancelled?;
    private startupFence;
    private readonly hasReplacementContext;
    private restorePending;
    private mutatingRequests;
    private endpointInode;
    private ipcServer;
    private sockets;
    private socketSessions;
    private persistTimers;
    private readonly startedAt;
    private recentLogs;
    private recentRequests;
    private recentTransitions;
    private exitWaiters;
    private lastNoOutputInputWarnAt;
    private stopRequests;
    private stopPromise;
    constructor(options?: SessionHostServerOptions);
    private isPidAlive;
    private readProcessBirth;
    private readSocketOwnerPids;
    private assertNoAutomaticReplacementContext;
    private evictPriorEndpointOwners;
    start(): Promise<void>;
    stop(): Promise<void>;
    private runStop;
    handleRequest(request: SessionHostRequest, sourceSocket?: net.Socket): Promise<SessionHostResponse>;
    private requireRuntime;
    private getAttachedClient;
    private emitEvent;
    private subscribeSocketToSession;
    private handleIncomingRequest;
    private writeEnvelopeSafely;
    private schedulePersist;
    /**
     * @param allowTerminal - write even if the record is terminal. Only the exit
     * handler sets this, to stamp the final terminated record for the brief
     * post-mortem window before cleanup.
     */
    private persistNow;
    private getHostDiagnostics;
    private recordHostLog;
    private recordRequestTrace;
    private scheduleNoOutputInputDiagnostic;
    private recordRuntimeTransition;
    private waitForRuntimeExit;
    private resolveExitWaiters;
    private getSnapshot;
    private getSnapshotForRequest;
    flushAllPersistence(): void;
    private restartRuntime;
    private pruneDuplicateSessions;
    private restorePersistedRuntimes;
    private pruneDuplicateRuntime;
    private startRuntime;
    /**
     * Handle a PTY termination: classify the (exitCode, signal) pair, stamp the
     * record + tombstone, emit exactly one structured diagnostic, and schedule
     * cleanup of the live persistence file (the tombstone is retained).
     */
    private handleRuntimeExit;
}

/**
 * Detects a wedged libuv thread pool and reports it once.
 *
 * node-pty writes to the PTY with `fs.write`, which runs on the libuv thread
 * pool. On 2026-10-21 a preview host was found with every pool request
 * (`fs.*`, `crypto.pbkdf2`, `dns.lookup`) never completing while the main loop
 * still served IPC: the host acknowledged every `send_input`, the PTY write
 * queue grew without draining, and no hosted session could receive input for
 * hours. Nothing in that state recovers on its own, and a host that answers
 * IPC never looks dead to the daemon, so the host has to notice it itself.
 *
 * One probe is in flight at a time. A probe that does not complete within
 * `stallMs` means the pool is not making progress; `onStall` fires once and
 * the watchdog stops. Timers are unref'd so the watchdog never keeps the
 * process alive.
 */
interface ThreadpoolWatchdogOptions {
    /** How often to start a probe when none is in flight. */
    intervalMs?: number;
    /** How long one probe may stay in flight before the pool counts as wedged. */
    stallMs?: number;
    /** A thread-pool operation that calls `done` when it completes. */
    probe?: (done: () => void) => void;
    onStall: (stalledForMs: number) => void;
    now?: () => number;
}
interface ThreadpoolWatchdog {
    stop(): void;
    /** Runs one check immediately; exposed for tests. */
    tick(): void;
}
declare function startThreadpoolWatchdog(options: ThreadpoolWatchdogOptions): ThreadpoolWatchdog;

interface GuardianArtifactPins {
    packageRoot: string;
    manifestPath: string;
    manifestSha256: string;
    version: string;
    commit: string;
    nodePath: string;
    daemonEntryPath: string;
    cliEntryPath: string;
    hostEntryPath: string;
    stateDir: string;
}
/** The manifest pin must come from the supervisor's immutable artifact plan. */
declare function resolveGuardianArtifact(pins: GuardianArtifactPins): HostUpgradeBinding;

declare function getSessionHostReplacementProvenanceFile(appName: string, configDir?: string): string;
declare function removeSessionHostReplacementProvenance(appName: string, configDir?: string): void;
declare function createUncaughtExceptionLimiter(windowMs?: number, limit?: number): (now: number) => {
    exit: boolean;
    countInWindow: number;
};

export { type GuardianArtifactPins, type HostUpgradeBinding, type SessionHostReplacementProvenance, SessionHostServer, type SessionHostServerOptions, createUncaughtExceptionLimiter, getSessionHostReplacementProvenanceFile, isManagedSessionHostCommandLine, readVerifiedReplacementProvenance, removeSessionHostReplacementProvenance, resolveGuardianArtifact, sessionHostInstanceArg, startThreadpoolWatchdog };
