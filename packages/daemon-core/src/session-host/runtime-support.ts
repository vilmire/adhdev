import * as fs from 'fs';
import {
    SessionHostClient,
    getDefaultSessionHostEndpoint,
    type SessionHostDiagnostics,
    type SessionHostEndpoint,
    type SessionHostRecord,
    type SessionHostRequestType,
} from '@adhdev/session-host-core';
import type { HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../runtime-defaults.js';
import { resolveSessionHostAppName } from './app-name.js';

const STARTUP_TIMEOUT_MS = DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;
const STARTUP_POLL_MS = 200;

export const SESSION_HOST_UNAVAILABLE_TRANSIENT_CODE = 'session_host_unavailable_transient' as const;

export class SessionHostUnavailableTransientError extends Error {
    readonly code = SESSION_HOST_UNAVAILABLE_TRANSIENT_CODE;
    readonly endpoint: SessionHostEndpoint;
    readonly causeError?: unknown;

    constructor(endpoint: SessionHostEndpoint, causeError?: unknown) {
        const detail = causeError instanceof Error && causeError.message
            ? `: ${causeError.message}`
            : '';
        super(`Session host at ${endpoint.path} is temporarily unavailable (host process is alive)${detail}`);
        this.name = 'SessionHostUnavailableTransientError';
        this.endpoint = endpoint;
        this.causeError = causeError;
    }
}

export function isSessionHostUnavailableTransientError(
    error: unknown,
): error is SessionHostUnavailableTransientError {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === SESSION_HOST_UNAVAILABLE_TRANSIENT_CODE,
    );
}

const RESOURCE_EXHAUSTION_CODES = new Set(['ENFILE', 'EMFILE', 'EAGAIN', 'ENOBUFS']);
const RESOURCE_EXHAUSTION_MESSAGE_RE = /\b(ENFILE|EMFILE|EAGAIN|ENOBUFS)\b|file table overflow|too many open files|resource temporarily unavailable|no buffer space available/i;

export function isResourceExhaustionError(error: unknown): boolean {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const record = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown; causeError?: unknown };
        if (typeof record.code === 'string' && RESOURCE_EXHAUSTION_CODES.has(record.code.toUpperCase())) {
            return true;
        }
        if (typeof record.errno === 'string' && RESOURCE_EXHAUSTION_CODES.has(record.errno.toUpperCase())) {
            return true;
        }
        if (typeof record.message === 'string' && RESOURCE_EXHAUSTION_MESSAGE_RE.test(record.message)) {
            return true;
        }
        current = record.cause ?? record.causeError;
    }
    if (typeof error === 'string' && RESOURCE_EXHAUSTION_MESSAGE_RE.test(error)) {
        return true;
    }
    return false;
}

export function isExistingSocketPathPresent(endpoint: SessionHostEndpoint): boolean {
    if (endpoint.kind !== 'unix' || !endpoint.path) return false;
    try {
        return fs.existsSync(endpoint.path);
    } catch {
        return false;
    }
}

class SessionHostCompatibilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionHostCompatibilityError';
    }
}

/** The persisted evidence attempt ref (`meshActiveAttemptRef` record meta), or undefined when absent/cleared/malformed. */
export function readPersistedAttemptRef(value: unknown): { attemptId: string; generation: number } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { attemptId, generation } = value as { attemptId?: unknown; generation?: unknown };
    if (typeof attemptId !== 'string' || !attemptId.trim()) return undefined;
    return {
        attemptId: attemptId.trim(),
        generation: typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    };
}

function getMissingRequestTypes(
    diagnostics: SessionHostDiagnostics | undefined,
    requiredRequestTypes: readonly SessionHostRequestType[],
): SessionHostRequestType[] {
    const supported = new Set(diagnostics?.supportedRequestTypes || []);
    return requiredRequestTypes.filter((requestType) => !supported.has(requestType));
}

// Three connected RPC timeouts must span >=30s and >=2 ensure invocations.
// Keep evidence for 90s so ordinary retry cadence recovers a persistent wedge
// within about two minutes, while a single 10s stall cannot trigger eviction.
export const SESSION_HOST_PROBE_TIMEOUT_MS = 3_000;
export const SESSION_HOST_UNRESPONSIVE_MIN_SPAN_MS = 30_000;
export const SESSION_HOST_MAX_OBSERVER_LAG_MS = 1_500;
const UNRESPONSIVE_WINDOW_MS = 90_000;
const UNRESPONSIVE_TIMEOUT_COUNT = 3;
const UNRESPONSIVE_INVOCATION_COUNT = 2;

export interface SessionHostReplacementAuthorization {
    /** Explicit reason for authorized replacement (e.g., idle_maintenance_upgrade). */
    reason?: 'idle_maintenance_upgrade' | 'verified_foreign_prefix';
    /** Expected host identity (e.g. pid-<pid>:birth-<birth>) that was verified idle. */
    expectedIdentity?: string;
    /** Expected PID of the live host authorized for replacement. */
    expectedPid?: number;
    /** Expected native process birth string (`ps -o lstart=`) of the live host. */
    expectedBirth?: string | null;
    /** Expected instance config directory for the managed host. */
    expectedInstanceConfigDir?: string;
    /** Expected boot / rollout / lease provenance metadata. */
    expectedBootId?: string;
    expectedEpoch?: number;
    expectedOwner?: string;
    /** Expected hostStartedAt from diagnostics, if observed. */
    expectedHostStartedAt?: number;
    /** Confirmed active runtime/PTY session count at authorization time (must be 0). */
    activeRuntimeCount: number;
    /** Cancellation fence: returns true if the operation/lease epoch was cancelled or superseded. */
    isCancelled?: () => boolean;
}

const probeEvidence = new Map<string, {
    identity?: string;
    count: number;
    firstWallAt: number;
    firstMonotonicAt: number;
    invocations: Set<number>;
}>();
let probeInvocationSequence = 0;
export function createSessionHostProbeInvocation(): number { return ++probeInvocationSequence; }
const hostIdentities = new Map<string, string>();
const inFlightReplacements = new Map<string, Promise<SessionHostEndpoint>>();
let spawnGeneration = 0;
const endpointKey = (endpoint: SessionHostEndpoint): string => `${endpoint.kind}:${endpoint.path}`;

export function getObservedSessionHostIdentity(endpoint: SessionHostEndpoint): string | undefined {
    return hostIdentities.get(endpointKey(endpoint));
}

function isDiagnosticsRequestTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || isResourceExhaustionError(error)) return false;
    const record = error as { code?: unknown; requestType?: unknown; message?: unknown };
    if (typeof record.code === 'string') {
        return record.code === 'SESSION_HOST_REQUEST_TIMEOUT' && record.requestType === 'get_host_diagnostics';
    }
    return error instanceof Error && /Session host request timed out.*get_host_diagnostics/.test(error.message);
}

function isObserverStarvedTimeout(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as { observerLagMs?: unknown; actualElapsedMs?: unknown; scheduledTimeoutMs?: unknown };
    if (typeof record.observerLagMs === 'number' && record.observerLagMs > SESSION_HOST_MAX_OBSERVER_LAG_MS) {
        return true;
    }
    if (
        typeof record.actualElapsedMs === 'number'
        && typeof record.scheduledTimeoutMs === 'number'
        && record.actualElapsedMs - record.scheduledTimeoutMs > SESSION_HOST_MAX_OBSERVER_LAG_MS
    ) {
        return true;
    }
    return false;
}

export function recordSessionHostProbeFailure(endpoint: SessionHostEndpoint, error: unknown, identity?: string, invocation?: number): boolean {
    const key = endpointKey(endpoint);
    if (!isDiagnosticsRequestTimeoutError(error)) {
        probeEvidence.delete(key);
        return false;
    }
    if (isObserverStarvedTimeout(error)) {
        return false;
    }
    const wallNow = Date.now();
    const monotonicNow = performance.now();
    // Prune expired endpoints as well as the current one; app namespaces can vary.
    for (const [other, evidence] of probeEvidence) {
        if (
            monotonicNow - evidence.firstMonotonicAt > UNRESPONSIVE_WINDOW_MS
            || wallNow - evidence.firstWallAt > UNRESPONSIVE_WINDOW_MS
        ) {
            probeEvidence.delete(other);
        }
    }
    const prior = probeEvidence.get(key);
    const evidence = prior && prior.identity === identity
        ? prior
        : { identity, count: 0, firstWallAt: wallNow, firstMonotonicAt: monotonicNow, invocations: new Set<number>() };
    evidence.count++;
    // Only two distinct calls are needed; keep evidence bounded during long wedges.
    if (invocation !== undefined && evidence.invocations.size < UNRESPONSIVE_INVOCATION_COUNT) {
        evidence.invocations.add(invocation);
    }
    probeEvidence.set(key, evidence);
    const monotonicSpanMs = monotonicNow - evidence.firstMonotonicAt;
    const wallSpanMs = wallNow - evidence.firstWallAt;
    return evidence.count >= UNRESPONSIVE_TIMEOUT_COUNT
        && evidence.invocations.size >= UNRESPONSIVE_INVOCATION_COUNT
        && monotonicSpanMs >= SESSION_HOST_UNRESPONSIVE_MIN_SPAN_MS
        && wallSpanMs >= SESSION_HOST_UNRESPONSIVE_MIN_SPAN_MS;
}

export function recordSessionHostProbeSuccess(endpoint: SessionHostEndpoint, diagnostics?: SessionHostDiagnostics): void {
    probeEvidence.delete(endpointKey(endpoint));
    if (typeof diagnostics?.hostStartedAt === 'number') {
        hostIdentities.set(endpointKey(endpoint), `started:${diagnostics.hostStartedAt}`);
    }
}

async function probeHost(
    endpoint: SessionHostEndpoint,
    requiredRequestTypes: readonly SessionHostRequestType[],
    timeoutMs: number,
    identity?: string,
    invocation?: number,
): Promise<{ ok: true } | { ok: false; error: unknown; proven: boolean }> {
    const client = new SessionHostClient({ endpoint, requestTimeoutMs: timeoutMs, registerAsShared: false });
    const deadline = Date.now() + timeoutMs;
    let connected = false;
    let requestTimeoutMs = timeoutMs;
    let requestStartMonotonic = 0;
    let requestStartWall = 0;
    try {
        await client.connect(timeoutMs); connected = true;
        requestTimeoutMs = Math.max(1, deadline - Date.now());
        requestStartMonotonic = performance.now();
        requestStartWall = Date.now();
        // Always send an RPC, even without required capabilities: connect alone
        // cannot distinguish an accepting socket from a wedged userland host.
        const response = await client.request<SessionHostDiagnostics>({
            type: 'get_host_diagnostics', payload: { includeSessions: false },
        }, { timeoutMs: requestTimeoutMs });
        recordSessionHostProbeSuccess(endpoint, response.success ? response.result : undefined);
        if (!response.success) throw new Error(response.error || 'Session host diagnostics probe failed');
        const missing = getMissingRequestTypes(response.result, requiredRequestTypes);
        if (missing.length > 0) {
            throw new SessionHostCompatibilityError(`Session host does not support required request types: ${missing.join(', ')}`);
        }
        return { ok: true };
    } catch (error) {
        if (error instanceof SessionHostCompatibilityError) throw error;
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
        const proven = recordSessionHostProbeFailure(endpoint, connected ? error : undefined, identity, invocation);
        return { ok: false, error, proven };
    } finally {
        await client.close().catch(() => {});
    }
}

export async function ensureSessionHostReady(options: {
    appName?: string;
    /** Share one invocation with the managed-host preflight. */
    probeInvocation?: number;
    endpoint?: SessionHostEndpoint;
    /** Retained for callers; diagnostic probes always use an isolated client. */
    existingClient?: SessionHostClient | null;
    spawnHost: () => void;
    beforeSpawnHost?: (endpoint: SessionHostEndpoint) => Promise<void> | void;
    onHostReplaced?: (endpoint: SessionHostEndpoint) => Promise<void> | void;
    isExistingHostAlive?: () => boolean;
    existingHostState?: () => 'alive' | 'dead' | 'unknown';
    existingHostIdentity?: () => string | undefined;
    isExistingSocketPresent?: (endpoint: SessionHostEndpoint) => boolean;
    replacementAuthority?: SessionHostReplacementAuthorization | (() => SessionHostReplacementAuthorization | undefined);
    canConnectRetries?: number;
    verifyRetries?: number;
    canConnectRetryDelayMs?: number;
    verifyRetryDelayMs?: number;
    timeoutMs?: number;
    requiredRequestTypes?: readonly SessionHostRequestType[];
}): Promise<SessionHostEndpoint> {
    const endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || resolveSessionHostAppName());
    const key = endpointKey(endpoint);
    const timeoutMs = Math.max(1, options.timeoutMs ?? STARTUP_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const required = options.requiredRequestTypes || [];
    const invocation = options.probeInvocation ?? createSessionHostProbeInvocation();

    const endpointMayExist = (): boolean => endpoint.kind === 'pipe' || (options.isExistingSocketPresent
        ? options.isExistingSocketPresent(endpoint) : isExistingSocketPathPresent(endpoint));

    const resolveHostState = (): 'alive' | 'dead' | 'unknown' => {
        if (options.existingHostState) return options.existingHostState();
        if (options.isExistingHostAlive) return options.isExistingHostAlive() && endpointMayExist() ? 'alive' : 'dead';
        return 'dead';
    };

    const isReplacementAuthorized = (): boolean => {
        const auth = typeof options.replacementAuthority === 'function'
            ? options.replacementAuthority()
            : options.replacementAuthority;
        if (!auth) return false;
        if (auth.isCancelled?.()) return false;
        if (typeof auth.activeRuntimeCount !== 'number' || auth.activeRuntimeCount !== 0) return false;
        if (auth.expectedIdentity !== undefined) {
            const currentIdentity = options.existingHostIdentity?.();
            if (!currentIdentity || currentIdentity !== auth.expectedIdentity) return false;
        }
        if (auth.expectedHostStartedAt !== undefined) {
            const observed = getObservedSessionHostIdentity(endpoint);
            if (observed && observed.startsWith('started:') && observed !== `started:${auth.expectedHostStartedAt}`) {
                return false;
            }
        }
        return true;
    };

    let lastError: unknown;
    let proven = false;
    const retries = Math.max(0, options.canConnectRetries ?? options.verifyRetries ?? 2);
    const delay = options.canConnectRetryDelayMs ?? options.verifyRetryDelayMs ?? 150;
    for (let attempt = 0; attempt <= retries && remaining() > 0; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(remaining(), 250, delay * 2 ** (attempt - 1))));
            if (remaining() <= 0) break;
        }
        const result = await probeHost(endpoint, required,
            Math.min(SESSION_HOST_PROBE_TIMEOUT_MS, remaining()), options.existingHostIdentity?.(), invocation);
        if (result.ok) return endpoint;
        lastError = result.error;
        proven = result.proven;
        const state = options.existingHostState
            ? options.existingHostState()
            : (options.isExistingHostAlive?.() ? 'alive' : 'dead');
        if (proven || (state === 'dead' && !isResourceExhaustionError(lastError))) break;
    }

    const activeReplacement = inFlightReplacements.get(key);
    if (activeReplacement) return activeReplacement;

    const hostState = resolveHostState();
    const authorizedLiveReplacement = hostState === 'alive' && isReplacementAuthorized();
    if (
        isResourceExhaustionError(lastError)
        || remaining() <= 0
        || hostState === 'unknown'
        || (hostState === 'alive' && !authorizedLiveReplacement)
    ) {
        throw new SessionHostUnavailableTransientError(endpoint, lastError);
    }

    const replacementTask = (async (): Promise<SessionHostEndpoint> => {
        if (hostState === 'alive' && !isReplacementAuthorized()) {
            throw new SessionHostUnavailableTransientError(endpoint, lastError);
        }
        (SessionHostClient as { disconnectClients?: (ep: SessionHostEndpoint) => void }).disconnectClients?.(endpoint);
        await options.beforeSpawnHost?.(endpoint);
        // Eviction may consume the remaining budget. Never start another unbounded
        // probe loop (or a second replacement) in this ensure call.
        const postEvictionAuth = typeof options.replacementAuthority === 'function'
            ? options.replacementAuthority()
            : options.replacementAuthority;
        if (remaining() <= 0 || (hostState === 'alive' && (!postEvictionAuth || postEvictionAuth.isCancelled?.()))) {
            throw new SessionHostUnavailableTransientError(endpoint, lastError);
        }
        options.spawnHost();
        probeEvidence.delete(key);
        hostIdentities.set(key, `spawn:${++spawnGeneration}`);
        while (remaining() > 0) {
            const result = await probeHost(endpoint, required, Math.min(SESSION_HOST_PROBE_TIMEOUT_MS, remaining()));
            if (result.ok) {
                await options.onHostReplaced?.(endpoint);
                return endpoint;
            }
            lastError = result.error;
            await new Promise(resolve => setTimeout(resolve, Math.min(STARTUP_POLL_MS, remaining())));
        }
        throw new SessionHostUnavailableTransientError(endpoint, lastError);
    })();

    inFlightReplacements.set(key, replacementTask);
    try {
        return await replacementTask;
    } finally {
        if (inFlightReplacements.get(key) === replacementTask) {
            inFlightReplacements.delete(key);
        }
    }
}

export async function listHostedCliRuntimes(endpoint: SessionHostEndpoint): Promise<HostedCliRuntimeDescriptor[]> {
    const existing = (SessionHostClient as { findConnectedClient?: (ep?: SessionHostEndpoint) => SessionHostClient | null }).findConnectedClient?.(endpoint) ?? null;
    const client = existing || new SessionHostClient({ endpoint });
    const shouldClose = !existing;
    try {
        const response = await client.request<SessionHostRecord[]>({
            type: 'list_sessions',
            payload: {},
        });
        if (!response.success || !Array.isArray(response.result)) {
            throw new Error(`session_host_inventory_unavailable: ${response.error || 'missing list_sessions result'}`);
        }
        return response.result
            .filter((record) => record.category === 'cli' && !record.termination && ['starting', 'running', 'stopping', 'interrupted'].includes(record.lifecycle))
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .map((record) => ({
                runtimeId: record.sessionId,
                runtimeKey: record.runtimeKey,
                displayName: record.displayName,
                workspaceLabel: record.workspaceLabel,
                lifecycle: record.lifecycle,
                recoveryState: typeof record.meta?.runtimeRecoveryState === 'string' ? String(record.meta.runtimeRecoveryState) : null,
                cliType: record.providerType,
                workspace: record.workspace,
                cliArgs: Array.isArray(record.meta?.cliArgs) ? (record.meta.cliArgs as string[]) : [],
                providerSessionId: typeof record.meta?.providerSessionId === 'string' ? String(record.meta.providerSessionId) : undefined,
                assistant: record.meta?.assistant === true ? true : undefined,
                startedAtMs: record.startedAt,
                managedBy: typeof record.meta?.managedBy === 'string' ? String(record.meta.managedBy) : undefined,
                // Session-level mesh membership (rc.20 rebound relay envelope) —
                // surfaced so restoreHostedSessions can re-apply it to the rebuilt
                // instance settings. Task-level markers stay out (see the descriptor).
                meshNodeFor: typeof record.meta?.meshNodeFor === 'string' && record.meta.meshNodeFor.trim()
                    ? String(record.meta.meshNodeFor).trim() : undefined,
                meshNodeId: typeof record.meta?.meshNodeId === 'string' && record.meta.meshNodeId.trim()
                    ? String(record.meta.meshNodeId).trim() : undefined,
                meshCoordinatorDaemonId: typeof record.meta?.meshCoordinatorDaemonId === 'string' && record.meta.meshCoordinatorDaemonId.trim()
                    ? String(record.meta.meshCoordinatorDaemonId).trim() : undefined,
                meshActiveAttemptRef: readPersistedAttemptRef(record.meta?.meshActiveAttemptRef),
                launchedByCoordinator: record.meta?.launchedByCoordinator === true ? true : undefined,
                autoApproveMode: typeof record.meta?.autoApproveMode === 'string' && record.meta.autoApproveMode.trim()
                    ? String(record.meta.autoApproveMode).trim() : undefined,
                // Phase E launch provenance written at spawn; validated on restore
                // (buildRestoredLaunchRecord), so it is passed through raw here.
                ...(record.meta?.launchRecord !== undefined ? { launchRecord: record.meta.launchRecord } : {}),
            }));
    } finally {
        if (shouldClose) {
            await client.close().catch(() => {});
        }
    }
}
