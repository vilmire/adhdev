import type { SessionTransport } from '../shared-types.js';
export interface SessionRuntimeTarget {
    sessionId: string;
    parentSessionId: string | null;
    providerType: string;
    transport: SessionTransport;
    cdpManagerKey?: string;
    adapterKey?: string;
    instanceKey?: string;
}
export declare class SessionRegistry {
    private readonly bySessionId;
    private readonly byManagerKey;
    private readonly byInstanceKey;
    private readonly byParentSessionId;
    register(target: SessionRuntimeTarget): void;
    get(sessionId: string | undefined | null): SessionRuntimeTarget | undefined;
    unregister(sessionId: string | undefined | null): void;
    unregisterByManagerKey(managerKey: string): void;
    unregisterByInstanceKey(instanceKey: string): void;
    listChildren(parentSessionId: string): SessionRuntimeTarget[];
    private addIndex;
    private removeIndex;
}
