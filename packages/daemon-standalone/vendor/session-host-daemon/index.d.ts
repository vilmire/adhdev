#!/usr/bin/env node
import { EventEmitter } from 'events';
import { SessionHostEndpoint, SessionHostRegistry, SessionHostRequest, SessionHostResponse } from '@adhdev/session-host-core';

interface SessionHostServerOptions {
    endpoint?: SessionHostEndpoint;
    appName?: string;
    /** Explicit session-host state root (runtime records + tombstones). */
    storageRootDir?: string;
}
declare class SessionHostServer extends EventEmitter {
    readonly endpoint: SessionHostEndpoint;
    readonly registry: SessionHostRegistry;
    private runtimes;
    private readonly storage;
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
    constructor(options?: SessionHostServerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
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

export { SessionHostServer, type SessionHostServerOptions };
