export interface PtySpawnOptions {
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
}
export interface PtyRuntimeWriteOwner {
    clientId: string;
    ownerType: 'agent' | 'user';
}
export interface PtyRuntimeClientInfo {
    clientId: string;
    type: 'daemon' | 'web' | 'local-terminal';
    readOnly: boolean;
}
export interface PtyRuntimeMetadata {
    runtimeId: string;
    runtimeKey?: string;
    displayName?: string;
    workspaceLabel?: string;
    writeOwner?: PtyRuntimeWriteOwner | null;
    attachedClients?: PtyRuntimeClientInfo[];
    restoredFromStorage?: boolean;
    recoveryState?: string | null;
    recoveryError?: string | null;
}
export interface PtyRuntimeTransport {
    readonly pid: number;
    readonly ready: Promise<void>;
    readonly terminalQueriesHandled?: boolean;
    write(data: string): void | Promise<void>;
    resize(cols: number, rows: number): void;
    kill(): void;
    clearBuffer?(): void;
    detach?(): void;
    updateMeta?(meta: Record<string, unknown>, replace?: boolean): void;
    getMetadata?(): PtyRuntimeMetadata | null;
    onData(callback: (data: string) => void): void;
    onExit(callback: (info: {
        exitCode: number;
    }) => void): void;
}
export interface PtyTransportFactory {
    spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport;
}
export declare class NodePtyTransportFactory implements PtyTransportFactory {
    spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport;
}
