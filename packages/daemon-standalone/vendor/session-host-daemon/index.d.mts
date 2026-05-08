#!/usr/bin/env node
import { EventEmitter } from 'events';
import { SessionHostEndpoint, SessionHostRegistry, SessionHostRequest, SessionHostResponse } from '@adhdev/session-host-core';

interface SessionHostServerOptions {
    endpoint?: SessionHostEndpoint;
    appName?: string;
}
declare class SessionHostServer extends EventEmitter {
    private static readonly MAX_RECENT_DIAGNOSTICS;
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
    private persistNow;
    private getSessionHostRecoveryLabel;
    private getSessionSurfaceKind;
    private annotateSessionSurface;
    private sanitizeDiagnosticsRecord;
    private getHostDiagnostics;
    private getRequestSessionId;
    private getRequestClientId;
    private pushRecent;
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
    private compareDuplicateCandidates;
    private pruneDuplicateRuntime;
    private buildPayloadFromRecord;
    private startRuntime;
}

export { SessionHostServer, type SessionHostServerOptions };
