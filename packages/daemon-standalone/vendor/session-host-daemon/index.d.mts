#!/usr/bin/env node
import { EventEmitter } from 'events';
import { SessionHostEndpoint, SessionHostRegistry, SessionHostRequest, SessionHostResponse } from '@adhdev/session-host-core';

interface HostUpgradeBinding {
    /** Trusted packaged helper; supplied hash must come from an immutable artifact pin. */
    helperPath: string;
    helperSha256: string;
    helperProtocol?: 1;
    helperFileIdentity?: string;
    stateDir: string;
}

interface SessionHostServerOptions {
    endpoint?: SessionHostEndpoint;
    /** Opt-in pinned native binding; absent hosts cannot attest an upgrade idle lease. */
    upgradeBinding?: HostUpgradeBinding;
    appName?: string;
    /** Explicit session-host state root (runtime records + tombstones). */
    storageRootDir?: string;
}
declare class SessionHostServer extends EventEmitter {
    readonly endpoint: SessionHostEndpoint;
    readonly registry: SessionHostRegistry;
    private runtimes;
    private readonly storage;
    private readonly upgradeLease;
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
    start(): Promise<void>;
    stop(): Promise<void>;
    private runStop;
    handleRequest(request: SessionHostRequest): Promise<SessionHostResponse>;
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

declare function createUncaughtExceptionLimiter(windowMs?: number, limit?: number): (now: number) => {
    exit: boolean;
    countInWindow: number;
};

export { type GuardianArtifactPins, type HostUpgradeBinding, SessionHostServer, type SessionHostServerOptions, createUncaughtExceptionLimiter, resolveGuardianArtifact };
