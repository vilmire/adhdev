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

const STARTUP_TIMEOUT_MS = DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;
const STARTUP_POLL_MS = 200;

class SessionHostCompatibilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionHostCompatibilityError';
    }
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

async function canConnect(
    endpoint: SessionHostEndpoint,
    requiredRequestTypes: readonly SessionHostRequestType[] = [],
): Promise<boolean> {
    const client = new SessionHostClient({ endpoint });
    try {
        await client.connect();
        await assertRequiredRequestTypes(client, requiredRequestTypes);
        return true;
    } catch (error) {
        if (error instanceof SessionHostCompatibilityError) throw error;
        return false;
    } finally {
        await client.close().catch(() => {});
    }
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
    spawnHost: () => void;
    timeoutMs?: number;
    requiredRequestTypes?: readonly SessionHostRequestType[];
}): Promise<SessionHostEndpoint> {
    const endpoint = getDefaultSessionHostEndpoint(options.appName || 'adhdev');
    const requiredRequestTypes = options.requiredRequestTypes || [];
    if (await canConnect(endpoint, requiredRequestTypes)) return endpoint;
    options.spawnHost();
    await waitForReady(endpoint, options.timeoutMs, requiredRequestTypes);
    return endpoint;
}

export async function listHostedCliRuntimes(endpoint: SessionHostEndpoint): Promise<HostedCliRuntimeDescriptor[]> {
    const client = new SessionHostClient({ endpoint });
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
            }));
    } finally {
        await client.close().catch(() => {});
    }
}
