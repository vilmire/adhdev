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

async function assertRequiredRequestTypes(
    client: SessionHostClient,
    requiredRequestTypes: readonly SessionHostRequestType[],
): Promise<void> {
    if (requiredRequestTypes.length === 0) return;

    const response = await client.request<SessionHostDiagnostics>({
        type: 'get_host_diagnostics',
        payload: { includeSessions: false },
    });
    const missing = getMissingRequestTypes(response.success ? response.result : undefined, requiredRequestTypes);
    if (missing.length > 0) {
        const detail = response.success ? '' : ` (${response.error || 'capability probe failed'})`;
        throw new SessionHostCompatibilityError(
            `Session host does not support required request types: ${missing.join(', ')}${detail}`,
        );
    }
}

async function probeExistingClient(
    client: SessionHostClient,
    requiredRequestTypes: readonly SessionHostRequestType[] = [],
): Promise<
    | { status: 'ok' }
    | { status: 'disconnected' }
    | { status: 'transient_error'; error: unknown }
    | { status: 'unresponsive'; error: unknown }
> {
    if (typeof (client as { isConnected?: () => boolean }).isConnected === 'function' && !client.isConnected()) {
        return { status: 'disconnected' };
    }
    try {
        const response = await client.request<SessionHostDiagnostics>({
            type: 'get_host_diagnostics',
            payload: { includeSessions: false },
        });
        if (requiredRequestTypes.length > 0) {
            const missing = getMissingRequestTypes(response.success ? response.result : undefined, requiredRequestTypes);
            if (missing.length > 0) {
                const detail = response.success ? '' : ` (${response.error || 'capability probe failed'})`;
                throw new SessionHostCompatibilityError(
                    `Session host does not support required request types: ${missing.join(', ')}${detail}`,
                );
            }
        } else if (!response.success) {
            return {
                status: 'unresponsive',
                error: new Error(response.error || 'Session host diagnostics probe failed'),
            };
        }
        return { status: 'ok' };
    } catch (error) {
        if (error instanceof SessionHostCompatibilityError) throw error;
        if (isResourceExhaustionError(error)) {
            return { status: 'transient_error', error };
        }
        return { status: 'unresponsive', error };
    }
}

async function probeNewConnection(
    endpoint: SessionHostEndpoint,
    requiredRequestTypes: readonly SessionHostRequestType[] = [],
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const client = new SessionHostClient({ endpoint });
    try {
        await client.connect();
        await assertRequiredRequestTypes(client, requiredRequestTypes);
        return { ok: true };
    } catch (error) {
        if (error instanceof SessionHostCompatibilityError) throw error;
        return { ok: false, error };
    } finally {
        await client.close().catch(() => {});
    }
}

async function canConnect(
    endpoint: SessionHostEndpoint,
    requiredRequestTypes: readonly SessionHostRequestType[] = [],
): Promise<boolean> {
    const result = await probeNewConnection(endpoint, requiredRequestTypes);
    return result.ok;
}

async function waitForReady(
    endpoint: SessionHostEndpoint,
    timeoutMs = STARTUP_TIMEOUT_MS,
    requiredRequestTypes: readonly SessionHostRequestType[] = [],
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect(endpoint, requiredRequestTypes)) return;
        await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }
    throw new Error(`Session host did not become ready within ${timeoutMs}ms`);
}

export async function ensureSessionHostReady(options: {
    appName?: string;
    /**
     * Explicit endpoint to probe/await. The managed-host factory passes its
     * instance-namespaced endpoint here so the connect probe, the spawned
     * child, and the wait loop all target the SAME namespace; when omitted the
     * legacy default endpoint for appName is derived (no instance key).
     */
    endpoint?: SessionHostEndpoint;
    existingClient?: SessionHostClient | null;
    spawnHost: () => void;
    beforeSpawnHost?: (endpoint: SessionHostEndpoint) => Promise<void> | void;
    onHostReplaced?: (endpoint: SessionHostEndpoint) => Promise<void> | void;
    isExistingHostAlive?: () => boolean;
    isExistingSocketPresent?: (endpoint: SessionHostEndpoint) => boolean;
    canConnectRetries?: number;
    verifyRetries?: number;
    canConnectRetryDelayMs?: number;
    verifyRetryDelayMs?: number;
    timeoutMs?: number;
    requiredRequestTypes?: readonly SessionHostRequestType[];
}): Promise<SessionHostEndpoint> {
    const endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || resolveSessionHostAppName());
    const requiredRequestTypes = options.requiredRequestTypes || [];
    const resolveExistingClient = (): SessionHostClient | null => (
        options.existingClient
        ?? (SessionHostClient as { findConnectedClient?: (ep?: SessionHostEndpoint) => SessionHostClient | null }).findConnectedClient?.(endpoint)
        ?? null
    );

    let provenUnresponsiveViaExistingClient = false;
    let lastError: unknown;

    const existing = resolveExistingClient();
    if (existing) {
        const existingResult = await probeExistingClient(existing, requiredRequestTypes);
        if (existingResult.status === 'ok') return endpoint;
        if (existingResult.status === 'unresponsive') {
            provenUnresponsiveViaExistingClient = true;
            lastError = existingResult.error;
        } else if (existingResult.status === 'transient_error') {
            lastError = existingResult.error;
        }
    }

    if (!provenUnresponsiveViaExistingClient) {
        const initialProbe = await probeNewConnection(endpoint, requiredRequestTypes);
        if (initialProbe.ok) return endpoint;
        lastError = initialProbe.error;
    }

    if (!provenUnresponsiveViaExistingClient && (options.isExistingHostAlive?.() || isResourceExhaustionError(lastError))) {
        const retries = Math.max(1, options.canConnectRetries ?? options.verifyRetries ?? 2);
        const defaultDelay = Math.min(150, Math.max(10, Math.floor((options.timeoutMs ?? STARTUP_TIMEOUT_MS) / 6)));
        const baseDelayMs = options.canConnectRetryDelayMs ?? options.verifyRetryDelayMs ?? defaultDelay;
        for (let attempt = 0; attempt < retries; attempt += 1) {
            if (options.isExistingHostAlive && !options.isExistingHostAlive() && !isResourceExhaustionError(lastError)) {
                break;
            }
            const backoffMs = Math.min(250, baseDelayMs * Math.pow(2, attempt));
            await new Promise((resolve) => setTimeout(resolve, backoffMs));

            const retryExisting = resolveExistingClient();
            if (retryExisting) {
                const retryExistingResult = await probeExistingClient(retryExisting, requiredRequestTypes);
                if (retryExistingResult.status === 'ok') return endpoint;
                if (retryExistingResult.status === 'unresponsive') {
                    provenUnresponsiveViaExistingClient = true;
                    lastError = retryExistingResult.error;
                    break;
                }
            }

            const retryProbe = await probeNewConnection(endpoint, requiredRequestTypes);
            if (retryProbe.ok) return endpoint;
            lastError = retryProbe.error;
        }
    }

    const hostAlive = Boolean(options.isExistingHostAlive?.());
    const socketPresent = options.isExistingSocketPresent
        ? Boolean(options.isExistingSocketPresent(endpoint))
        : isExistingSocketPathPresent(endpoint);

    if (!provenUnresponsiveViaExistingClient && (isResourceExhaustionError(lastError) || (hostAlive && socketPresent))) {
        throw new SessionHostUnavailableTransientError(endpoint, lastError);
    }

    (SessionHostClient as { disconnectClients?: (ep?: SessionHostEndpoint) => void }).disconnectClients?.(endpoint);
    await options.beforeSpawnHost?.(endpoint);
    options.spawnHost();
    await waitForReady(endpoint, options.timeoutMs, requiredRequestTypes);
    await options.onHostReplaced?.(endpoint);
    return endpoint;
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
        if (!response.success || !response.result) {
            return [];
        }
        return response.result
            .filter((record) => record.category === 'cli' && ['running', 'interrupted'].includes(record.lifecycle))
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
