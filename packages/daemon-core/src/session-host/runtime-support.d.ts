import { type SessionHostEndpoint } from '@adhdev/session-host-core';
import type { HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
export declare function ensureSessionHostReady(options: {
    appName?: string;
    spawnHost: () => void;
    timeoutMs?: number;
}): Promise<SessionHostEndpoint>;
export declare function listHostedCliRuntimes(endpoint: SessionHostEndpoint): Promise<HostedCliRuntimeDescriptor[]>;
