import {
    SessionHostClient,
    type SessionHostEndpoint,
    type SessionHostEvent,
    type SessionHostCategory,
    type SessionHostRecord,
} from '@adhdev/session-host-core';
import { LOG } from '../logging/logger.js';
import type { PtyRuntimeMetadata, PtyRuntimeTransport, PtySpawnOptions, PtyTransportFactory } from './pty-transport.js';

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

interface SessionHostRuntimeOptions extends SessionHostPtyTransportFactoryOptions {
    command: string;
    args: string[];
    spawnOptions: PtySpawnOptions;
}

export function shouldResumeAttachedSession(record: SessionHostRecord | null | undefined): boolean {
    if (!record) return false;
    if (record.lifecycle === 'interrupted') return true;
    if (record.lifecycle !== 'stopped') return false;
    if (record.meta?.restoredFromStorage === true) return true;
    return typeof record.meta?.runtimeRecoveryState === 'string' && String(record.meta.runtimeRecoveryState).trim().length > 0;
}

class SessionHostRuntimeTransport implements PtyRuntimeTransport {
    readonly ready: Promise<void>;
    readonly terminalQueriesHandled = true;

    private readonly client: SessionHostClient;
    private readonly dataCallbacks = new Set<(data: string) => void>();
    private readonly exitCallbacks = new Set<(info: { exitCode: number }) => void>();
    private readonly pendingOutput: string[] = [];
    private operationChain = Promise.resolve();
    private unsubscribe: (() => void) | null = null;
    private currentPid = 0;
    private closed = false;
    private metadata: PtyRuntimeMetadata | null = null;

    constructor(private readonly options: SessionHostRuntimeOptions) {
        this.client = new SessionHostClient({
            endpoint: options.endpoint,
            appName: options.appName,
        });
        this.ready = this.boot();
    }

    get pid(): number {
        return this.currentPid;
    }

    getMetadata(): PtyRuntimeMetadata | null {
        return this.metadata ? {
            ...this.metadata,
            writeOwner: this.metadata.writeOwner ? { ...this.metadata.writeOwner } : null,
            attachedClients: this.metadata.attachedClients?.map((client) => ({ ...client })) || [],
        } : null;
    }

    onData(callback: (data: string) => void): void {
        this.dataCallbacks.add(callback);
        if (this.pendingOutput.length > 0) {
            for (const chunk of this.pendingOutput.splice(0)) {
                callback(chunk);
            }
        }
    }

    onExit(callback: (info: { exitCode: number }) => void): void {
        this.exitCallbacks.add(callback);
    }

    write(data: string): Promise<void> {
        return this.enqueue(async () => {
            let response = await this.client.request({
                type: 'send_input',
                payload: {
                    sessionId: this.options.runtimeId,
                    clientId: this.options.clientId,
                    data,
                },
            });
            if (!response.success && response.error?.startsWith('Write owned by ')) {
                const ownerResponse = await this.client.request<SessionHostRecord>({
                    type: 'acquire_write',
                    payload: {
                        sessionId: this.options.runtimeId,
                        clientId: this.options.clientId,
                        ownerType: 'user',
                        force: true,
                    },
                });
                if (ownerResponse.success && ownerResponse.result) {
                    this.updateMetadata(ownerResponse.result);
                    response = await this.client.request({
                        type: 'send_input',
                        payload: {
                            sessionId: this.options.runtimeId,
                            clientId: this.options.clientId,
                            data,
                        },
                    });
                }
            }
            if (!response.success) {
                throw new Error(response.error || `Failed to write to runtime ${this.options.runtimeId}`);
            }
        });
    }

    resize(cols: number, rows: number): void {
        this.enqueue(async () => {
            await this.client.request({
                type: 'resize_session',
                payload: {
                    sessionId: this.options.runtimeId,
                    cols,
                    rows,
                },
            });
        });
    }

    kill(): void {
        this.enqueue(async () => {
            await this.client.request({
                type: 'stop_session',
                payload: { sessionId: this.options.runtimeId },
            });
            await this.closeClient(false);
        });
    }

    clearBuffer(): void {
        this.enqueue(async () => {
            const response = await this.client.request<SessionHostRecord>({
                type: 'clear_session_buffer',
                payload: {
                    sessionId: this.options.runtimeId,
                },
            });
            if (!response.success) {
                throw new Error(response.error || `Failed to clear runtime buffer ${this.options.runtimeId}`);
            }
            if (response.result) {
                this.updateMetadata(response.result);
            }
        });
    }

    detach(): void {
        this.enqueue(async () => {
            await this.client.request({
                type: 'release_write',
                payload: {
                    sessionId: this.options.runtimeId,
                    clientId: this.options.clientId,
                },
            }).catch(() => ({ success: false }));
            await this.client.request({
                type: 'detach_session',
                payload: {
                    sessionId: this.options.runtimeId,
                    clientId: this.options.clientId,
                },
            }).catch(() => ({ success: false }));
            await this.closeClient(false);
        });
    }

    updateMeta(meta: Record<string, unknown>, replace = false): void {
        this.enqueue(async () => {
            const response = await this.client.request<SessionHostRecord>({
                type: 'update_session_meta',
                payload: {
                    sessionId: this.options.runtimeId,
                    meta,
                    replace,
                },
            });
            if (!response?.success) {
                throw new Error(response.error || `Failed to update runtime meta ${this.options.runtimeId}`);
            }
            if (response.result) {
                this.updateMetadata(response.result);
            }
        });
    }

    private async boot(): Promise<void> {
        if (typeof this.options.ensureReady === 'function') {
            await this.options.ensureReady();
        }
        try {
            await this.client.connect();
        } catch (error) {
            if (typeof this.options.ensureReady !== 'function') {
                throw error;
            }
            await this.options.ensureReady();
            await this.client.connect();
        }
        this.unsubscribe = this.client.onEvent((event: SessionHostEvent) => this.handleEvent(event));

        let record: SessionHostRecord | null = null;
        if (this.options.attachExisting) {
            const existingRecords = await this.client.request<SessionHostRecord[]>({
                type: 'list_sessions',
                payload: {},
            });
            const existingRecord = existingRecords.success && existingRecords.result
                ? existingRecords.result.find((item) => item.sessionId === this.options.runtimeId) || null
                : null;
            if (shouldResumeAttachedSession(existingRecord)) {
                const resumeResponse = await this.client.request<SessionHostRecord>({
                    type: 'resume_session',
                    payload: {
                        sessionId: this.options.runtimeId,
                    },
                });
                if (!resumeResponse.success) {
                    LOG.warn('CLI', `[session-host:${this.options.runtimeId}] resume failed: ${resumeResponse.error || 'unknown error'}`);
                }
            }
            const attachResponse = await this.client.request<SessionHostRecord>({
                type: 'attach_session',
                payload: {
                    sessionId: this.options.runtimeId,
                    clientId: this.options.clientId,
                    clientType: 'daemon',
                    readOnly: false,
                },
            });
            if (!attachResponse.success || !attachResponse.result) {
                throw new Error(attachResponse.error || `Failed to attach runtime ${this.options.runtimeId}`);
            }
            record = attachResponse.result;
        } else {
            const createResponse = await this.client.request<SessionHostRecord>({
                type: 'create_session',
                payload: {
                    sessionId: this.options.runtimeId,
                    providerType: this.options.providerType,
                    category: this.options.category || 'cli',
                    workspace: this.options.workspace,
                    launchCommand: {
                        command: this.options.command,
                        args: this.options.args,
                        env: this.options.spawnOptions.env,
                    },
                    cols: this.options.spawnOptions.cols,
                    rows: this.options.spawnOptions.rows,
                    clientId: this.options.clientId,
                    clientType: 'daemon',
                    meta: this.options.meta,
                },
            });
            if (!createResponse.success || !createResponse.result) {
                throw new Error(createResponse.error || `Failed to create runtime ${this.options.runtimeId}`);
            }
            record = createResponse.result;
        }

        this.currentPid = record.osPid || 0;
        this.updateMetadata(record);

        const ownerResponse = await this.client.request<SessionHostRecord>({
            type: 'acquire_write',
            payload: {
                sessionId: this.options.runtimeId,
                clientId: this.options.clientId,
                ownerType: 'agent',
                force: !this.options.attachExisting,
            },
        });
        if (!ownerResponse.success) {
            if (this.options.attachExisting && ownerResponse.error?.startsWith('Write owned by ')) {
                LOG.info('CLI', `[session-host:${this.options.runtimeId}] attached without write ownership (${ownerResponse.error})`);
            } else {
                throw new Error(ownerResponse.error || `Failed to acquire write owner for ${this.options.runtimeId}`);
            }
        } else if (ownerResponse.result) {
            this.updateMetadata(ownerResponse.result);
        }

        if (this.options.attachExisting) {
            const snapshotResponse = await this.client.request<{ seq: number; text: string; truncated: boolean }>({
                type: 'get_snapshot',
                payload: {
                    sessionId: this.options.runtimeId,
                },
            });
            if (!snapshotResponse.success) {
                throw new Error(snapshotResponse.error || `Failed to load snapshot for ${this.options.runtimeId}`);
            }
            const text = snapshotResponse.result?.text || '';
            if (text) {
                this.emitData(text);
            }
        }
    }

    private handleEvent(event: SessionHostEvent): void {
        if (!('sessionId' in event)) return;
        if (event.sessionId !== this.options.runtimeId) return;
        if ((event.type === 'session_started' || event.type === 'session_resumed') && typeof event.pid === 'number') {
            this.currentPid = event.pid;
            return;
        }
        if (event.type === 'write_owner_changed') {
            this.metadata = {
                ...(this.metadata || { runtimeId: this.options.runtimeId }),
                writeOwner: event.owner ? {
                    clientId: event.owner.clientId,
                    ownerType: event.owner.ownerType,
                } : null,
            };
            return;
        }
        if (event.type === 'client_attached') {
            const nextClients = new Map(
                (this.metadata?.attachedClients || []).map((client) => [client.clientId, client] as const),
            );
            nextClients.set(event.client.clientId, {
                clientId: event.client.clientId,
                type: event.client.type,
                readOnly: event.client.readOnly,
            });
            this.metadata = {
                ...(this.metadata || { runtimeId: this.options.runtimeId }),
                attachedClients: Array.from(nextClients.values()),
            };
            return;
        }
        if (event.type === 'client_detached') {
            this.metadata = {
                ...(this.metadata || { runtimeId: this.options.runtimeId }),
                attachedClients: (this.metadata?.attachedClients || []).filter((client) => client.clientId !== event.clientId),
            };
            return;
        }
        if (event.type === 'session_output') {
            this.emitData(event.data);
            return;
        }
        if (event.type === 'session_cleared') {
            this.pendingOutput.length = 0;
            return;
        }
        if (event.type === 'session_exit') {
            for (const callback of this.exitCallbacks) {
                callback({ exitCode: event.exitCode ?? 0 });
            }
            void this.closeClient(false);
        }
    }

    private emitData(data: string): void {
        if (this.dataCallbacks.size === 0) {
            this.pendingOutput.push(data);
            return;
        }
        for (const callback of this.dataCallbacks) {
            callback(data);
        }
    }

    private updateMetadata(record: SessionHostRecord): void {
        this.metadata = {
            runtimeId: record.sessionId,
            runtimeKey: record.runtimeKey,
            displayName: record.displayName,
            workspaceLabel: record.workspaceLabel,
            lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle : null,
            surfaceKind: record.surfaceKind,
            writeOwner: record.writeOwner ? {
                clientId: record.writeOwner.clientId,
                ownerType: record.writeOwner.ownerType,
            } : null,
            attachedClients: record.attachedClients.map((client: SessionHostRecord['attachedClients'][number]) => ({
                clientId: client.clientId,
                type: client.type,
                readOnly: client.readOnly,
            })),
            restoredFromStorage: record.meta?.restoredFromStorage === true,
            recoveryState: typeof record.meta?.runtimeRecoveryState === 'string'
                ? String(record.meta.runtimeRecoveryState)
                : null,
            recoveryError: typeof record.meta?.runtimeRecoveryError === 'string'
                ? String(record.meta.runtimeRecoveryError)
                : null,
        };
    }

    private enqueue(action: () => Promise<void>): Promise<void> {
        const operation = this.operationChain
            .then(() => this.ready)
            .then(action)
        this.operationChain = operation.catch((error) => {
            LOG.warn('CLI', `[session-host:${this.options.runtimeId}] ${error?.message || error}`);
        });
        return operation;
    }

    private async closeClient(destroy = false): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            this.unsubscribe?.();
            this.unsubscribe = null;
        } catch { /* noop */ }
        try {
            await this.client.close();
        } catch (err) {
            if (destroy) throw err instanceof Error ? err : new Error(`Failed to close session host client: ${this.options.runtimeId}`);
        }
    }
}

export class SessionHostPtyTransportFactory implements PtyTransportFactory {
    constructor(private readonly options: SessionHostPtyTransportFactoryOptions) {}

    spawn(command: string, args: string[], spawnOptions: PtySpawnOptions): PtyRuntimeTransport {
        return new SessionHostRuntimeTransport({
            ...this.options,
            command,
            args,
            spawnOptions,
        });
    }
}
