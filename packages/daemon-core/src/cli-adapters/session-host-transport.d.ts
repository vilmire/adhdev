import { type SessionHostEndpoint, type SessionHostCategory } from '@adhdev/session-host-core';
import type { PtyRuntimeTransport, PtySpawnOptions, PtyTransportFactory } from './pty-transport.js';
interface SessionHostPtyTransportFactoryOptions {
    endpoint?: SessionHostEndpoint;
    appName?: string;
    ensureReady?: () => Promise<void>;
    clientId: string;
    runtimeId: string;
    providerType: string;
    category?: SessionHostCategory;
    workspace: string;
    meta?: Record<string, unknown>;
    attachExisting?: boolean;
}
export declare class SessionHostPtyTransportFactory implements PtyTransportFactory {
    private readonly options;
    constructor(options: SessionHostPtyTransportFactoryOptions);
    spawn(command: string, args: string[], spawnOptions: PtySpawnOptions): PtyRuntimeTransport;
}
export {};
