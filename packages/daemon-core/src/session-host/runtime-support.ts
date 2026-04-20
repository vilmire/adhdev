import {
    SessionHostClient,
    getDefaultSessionHostEndpoint,
    type SessionHostEndpoint,
    type SessionHostRecord,
} from '@adhdev/session-host-core';
import type { HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../runtime-defaults.js';

const STARTUP_TIMEOUT_MS = DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;
const STARTUP_POLL_MS = 200;

async function canConnect(endpoint: SessionHostEndpoint): Promise<boolean> {
    const client = new SessionHostClient({ endpoint });
    try {
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
}

async function waitForReady(endpoint: SessionHostEndpoint, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect(endpoint)) return;
        await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }
    throw new Error(`Session host did not become ready within ${timeoutMs}ms`);
}

export async function ensureSessionHostReady(options: {
    appName?: string;
    spawnHost: () => void;
    timeoutMs?: number;
}): Promise<SessionHostEndpoint> {
    const endpoint = getDefaultSessionHostEndpoint(options.appName || 'adhdev');
    if (await canConnect(endpoint)) return endpoint;
    options.spawnHost();
    await waitForReady(endpoint, options.timeoutMs);
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
