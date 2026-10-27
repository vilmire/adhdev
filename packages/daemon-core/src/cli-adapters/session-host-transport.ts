import { assertMaintenanceAdmission, captureMaintenanceAdmission, withMaintenanceAdmission } from '../maintenance/cooperative-gate.js';
import {
    SessionHostClient,
    type SessionHostEndpoint,
    type SessionHostEvent,
    type SessionHostCategory,
    type SessionHostRecord,
    type SessionHostRequest,
    type SessionHostResponse,
} from '@adhdev/session-host-core';
import { LOG } from '../logging/logger.js';
import { resolveWin32Executable } from './resolve-executable.js';
import type { PtyRuntimeExitInfo, PtyRuntimeMetadata, PtyRuntimeTransport, PtySpawnOptions, PtyTransportFactory } from './pty-transport.js';

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

    private readonly client: SessionHostClient;
    private readonly dataCallbacks = new Set<(data: string) => void>();
    private readonly exitCallbacks = new Set<(info: PtyRuntimeExitInfo) => void>();
    private readonly pendingOutput: string[] = [];
    private operationChain = Promise.resolve();
    private unsubscribe: (() => void) | null = null;
    private unsubscribeDisconnect: (() => void) | null = null;
    private reconnecting = false;
    private recovery: Promise<void> | null = null;
    private readonly cancellationListeners = new Set<() => void>();
    private readonly pendingStages = new Set<Promise<unknown>>();
    private cleanup: Promise<void> | null = null;
    private attached = false;
    private ownsWrite = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectWake: (() => void) | null = null;
    private currentPid = 0;
    private closed = false;
    private metadata: PtyRuntimeMetadata | null = null;
    /**
     * Host input provenance (see inputProvenance). `supported` is set only by a
     * successful `get_input_state` — a host that rejects that request type
     * cannot be trusted even if a record it passes through carries inputSeq.
     * `connected` drops the moment the socket does (announcements may be lost).
     */
    private readonly input = {
        supported: false, connected: true, epoch: null as string | null,
        lastEventSeq: null as number | null, highestSeq: 0, foreign: 0, ownerAway: 0, gaps: 0,
    };
    private bootFailure: PtyRuntimeExitInfo | null = null;
    private lostRuntimeReported = false;
    private booting = true;
    private retainedIncarnation: { runtimeKey: string; startedAt: number } | null = null;

    constructor(private readonly options: SessionHostRuntimeOptions) {
        this.client = new SessionHostClient({
            endpoint: options.endpoint,
            appName: options.appName,
        });
        this.ready = this.boot();
        // A runtime that never started must END, not sit there. Nothing awaits
        // `ready` except the write queue, so a failed create_session (2026-10-01:
        // a stale session-host whose install was deleted answered every spawn with
        // `posix_spawn failed: No such file or directory`) left the session to
        // fall through startup-grace into 'idle' — the dashboard showed a healthy
        // idle agent that could never receive input. Report it as a failed exit
        // through the same path a real exit takes.
        this.ready.catch((error: unknown) => this.failBoot(error));
    }

    private failBoot(error: unknown): void {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        LOG.warn('CLI', `[session-host:${this.options.runtimeId}] runtime failed to start: ${message}`);
        const termination = {
            exitCode: null,
            signal: null,
            reason: 'failed' as const,
            lifecycle: 'failed' as const,
            terminatedAt: Date.now(),
            error: message,
        };
        this.bootFailure = { exitCode: null, signal: null, termination };
        for (const callback of this.exitCallbacks) {
            callback(this.bootFailure);
        }
        void this.closeClient(false);
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

    /** See PtyRuntimeTransport.otherWritableClients. */
    otherWritableClients(): boolean | null {
        const clients = this.metadata?.attachedClients;
        if (!Array.isArray(clients)) return null;
        // The host lets an UNATTACHED client take ownership and write (review
        // R7-1), so a foreign owner counts whether or not it is in the list.
        const owner = this.metadata?.writeOwner;
        if (owner && owner.clientId !== this.options.clientId) return true;
        return clients.some((client) => client.clientId !== this.options.clientId && client.type !== 'daemon' && client.readOnly !== true);
    }

    /** See PtyRuntimeTransport.inputProvenance. */
    inputProvenance(): { foreign: number; ownerAway: number; gaps: number; complete: boolean } | null {
        const s = this.input;
        if (!s.supported) return null;
        return {
            foreign: s.foreign, ownerAway: s.ownerAway, gaps: s.gaps,
            complete: s.connected && s.lastEventSeq !== null && s.lastEventSeq >= s.highestSeq,
        };
    }

    /** Start counting afresh from (epoch, seq) — after a counter we cannot
     *  relate to the one we followed. Counted as a gap, so any key taken
     *  before it never matches one taken after (review R8-2). */
    private rebaselineInput(epoch: string, seq: number): void {
        const s = this.input;
        if (s.epoch !== null) s.gaps += 1;
        s.epoch = epoch;
        s.lastEventSeq = seq;
        s.highestSeq = seq;
    }

    /** A host record's (inputEpoch, inputSeq): how far the host has counted. */
    private noteRecordInputSeq(record: Partial<SessionHostRecord> | undefined): void {
        const seq = record?.inputSeq;
        if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return;
        const s = this.input;
        if (s.epoch === null) return; // not yet established by get_input_state
        const epoch = typeof record?.inputEpoch === 'string' ? record.inputEpoch : null;
        if (epoch !== s.epoch) { this.rebaselineInput(epoch ?? `unknown:${Date.now()}`, seq); return; }
        if (seq < s.highestSeq) { this.rebaselineInput(epoch, seq); return; } // went backwards
        if (seq > s.highestSeq) s.highestSeq = seq;
    }

    /**
     * Ask the host for its input counter (connect / reconnect). A host that
     * does not know `get_input_state` never becomes trusted; one that does
     * re-establishes the account — as a NEW baseline after a reconnect, since
     * announcements during the outage may have been lost.
     */
    private async refreshInputState(): Promise<void> {
        const s = this.input;
        try {
            const res = await this.request<{ inputSeq: number; inputEpoch: string }>({ type: 'get_input_state', payload: { sessionId: this.options.runtimeId } });
            const r = res.success ? res.result : undefined;
            if (!r || typeof r.inputSeq !== 'number' || typeof r.inputEpoch !== 'string') { s.supported = false; return; }
            this.rebaselineInput(r.inputEpoch, r.inputSeq);
            s.supported = true;
            s.connected = true;
        } catch (error) {
            if (this.closed) throw error;
            s.supported = false;
        }
    }

    /**
     * SUBMIT-UNCONFIRMED-RECLAIM (review R8-1, R9-1): write `data` only if the
     * host's input stream is still exactly where this transport accounted it
     * at the moment the caller decided to write. That (epoch, seq) is captured
     * BEFORE the queue wait. An announcement that arrives while this write
     * waits — a human's 'X' — must not be adopted as the expected sequence, or
     * the host would accept the write and a guarded DEL would delete their
     * text. The host then checks that same decision-time pair and writes in
     * one step (`send_input_if_seq`). No ownership is taken. Resolves false
     * when the stream moved, on any refusal, or when provenance is not known
     * and complete; a host without the request refuses it.
     */
    writeIfInputUnchanged(data: string): Promise<boolean> {
        const check = captureMaintenanceAdmission();
        const decidedEpoch = this.input.epoch;
        const decidedSeq = this.input.lastEventSeq;
        const decided = this.inputProvenance();
        return withMaintenanceAdmission(() => this.enqueue(async () => {
            check();
            if (!decided || !decided.complete || decidedEpoch === null || decidedSeq === null) return false;
            const s = this.input;
            const prov = this.inputProvenance();
            if (!prov || !prov.complete || s.epoch !== decidedEpoch || s.lastEventSeq !== decidedSeq) return false;
            const response = await this.request<SessionHostRecord>({
                type: 'send_input_if_seq',
                payload: { sessionId: this.options.runtimeId, clientId: this.options.clientId, data, expectedInputSeq: decidedSeq, expectedInputEpoch: decidedEpoch },
            });
            if (!response.success) return false;
            this.noteRecordInputSeq(response.result);
            return true;
        }));
    }

    onData(callback: (data: string) => void): void {
        this.dataCallbacks.add(callback);
        if (this.pendingOutput.length > 0) {
            for (const chunk of this.pendingOutput.splice(0)) {
                callback(chunk);
            }
        }
    }

    onExit(callback: (info: PtyRuntimeExitInfo) => void): void {
        this.exitCallbacks.add(callback);
        // Boot can fail before the owner subscribes; replay that exit once.
        if (this.bootFailure) queueMicrotask(() => callback(this.bootFailure!));
    }

    write(data: string): Promise<void> {
        const check = captureMaintenanceAdmission();
        return withMaintenanceAdmission(() => this.enqueue(async () => {
            check();
            let response = await this.request({
                type: 'send_input',
                payload: {
                    sessionId: this.options.runtimeId,
                    clientId: this.options.clientId,
                    data,
                },
            });
            if (!response.success && response.error?.startsWith('Write owned by ')) {
                check();
                const ownerResponse = await this.request<SessionHostRecord>({
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
                    check();
                    response = await this.request({
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
                if (isLostRuntimeError(response.error)) this.reportLostRuntime(response.error!);
                throw new Error(response.error || `Failed to write to runtime ${this.options.runtimeId}`);
            }
            this.noteRecordInputSeq(response.result as Partial<SessionHostRecord> | undefined);
        }));
    }

    /**
     * The host answered but no longer runs this runtime: it died and was respawned
     * (its PTYs died with it), or the record was removed. Nothing will ever send
     * `session_exit` for it, so without this the session sat 'generating' forever —
     * 2026-10-06 a Windows host exited with code 1 and its antigravity session stayed
     * generating for hours, re-injecting focus every 2 s and blocking the daemon's
     * own restart as a "busy" session. Report it through the normal exit path once.
     */
    private reportLostRuntime(error: string): void {
        if (this.closed || this.lostRuntimeReported) return;
        this.lostRuntimeReported = true;
        LOG.warn('CLI', `[session-host:${this.options.runtimeId}] runtime is gone from the session host (${error}) — ending the session`);
        const info: PtyRuntimeExitInfo = {
            exitCode: null,
            signal: null,
            termination: {
                exitCode: null,
                signal: null,
                reason: 'failed',
                lifecycle: 'failed',
                terminatedAt: Date.now(),
            },
        };
        for (const callback of this.exitCallbacks) callback(info);
    }

    resize(cols: number, rows: number): void {
        this.enqueueMutation(async () => {
            await this.request({
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
        this.enqueueMutation(async () => {
            assertMaintenanceAdmission();
            await this.request({
                type: 'stop_session',
                payload: { sessionId: this.options.runtimeId },
            });
            await this.closeClient(false);
        });
    }

    clearBuffer(): void {
        this.enqueueMutation(async () => {
            const response = await this.request<SessionHostRecord>({
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

    // Safe detach only releases ownership/observation; it sends no runtime input.
    detach(): void {
        void this.closeClient(false);
    }

    // Metadata does not resume, resize or signal the retained runtime.
    updateMeta(meta: Record<string, unknown>, replace = false): void {
        this.enqueue(async () => {
            const response = await this.request<SessionHostRecord>({
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

    async verifyMeta(expected: Record<string, unknown>): Promise<boolean> {
        const incarnation = this.metadata;
        if (!incarnation?.runtimeKey || !incarnation.startedAt) return false;
        try {
            await this.operationChain;
            await this.recovery;
            this.assertOpen();
            const reply = await this.request<SessionHostRecord>({ type: 'get_session', payload: { sessionId: this.options.runtimeId } });
            const record = reply.success ? reply.result : undefined;
            return !!record && record.sessionId === this.options.runtimeId && record.runtimeKey === incarnation.runtimeKey && record.startedAt === incarnation.startedAt
                && record.writeOwner?.clientId === this.options.clientId && record.writeOwner.ownerType === 'agent'
                && Object.entries(expected).every(([key, value]) => JSON.stringify(record.meta[key]) === JSON.stringify(value));
        } catch { return false; }
    }
    async stopMeshWriter(target: import('@adhdev/session-host-core').MeshWriterStopTarget): Promise<boolean> {
        try {
            assertMaintenanceAdmission();
            await this.operationChain;
            await this.recovery;
            this.assertOpen();
            assertMaintenanceAdmission();
            const result = await this.request({ type: 'stop_mesh_writer', payload: {
                ...target, sessionId: this.options.runtimeId, clientId: this.options.clientId,
            } });
            return result.success === true;
        } catch { return false; }
    }

    private checkRetainedIncarnation(record: SessionHostRecord): void {
        const previous = this.retainedIncarnation;
        if (record.sessionId !== this.options.runtimeId || (previous
            && (record.runtimeKey !== previous.runtimeKey || record.startedAt !== previous.startedAt))) {
            throw new Error(`Runtime not found for session: ${this.options.runtimeId} (incarnation changed)`);
        }
        if (record.runtimeKey && record.startedAt) this.retainedIncarnation = { runtimeKey: record.runtimeKey, startedAt: record.startedAt };
    }

    private async boot(): Promise<void> {
        try {
            let attempt = 0;
            while (!this.closed) {
                try {
                    // Release admission while deferred, so an unreachable host
                    // cannot hold maintenance ownership across retry sleeps.
                    await withMaintenanceAdmission(() => this.bootOnce());
                    return;
                } catch (error) {
                    if (this.closed) return;
                    // Reattachment must never certify a live writer dead merely
                    // because its host is slow/unreachable. Keep the same transport,
                    // identity and pending ready promise; never create a replacement.
                    if (!this.options.attachExisting || isLostRuntimeError(error instanceof Error ? error.message : String(error))) {
                        this.attached = false;
                        this.ownsWrite = false;
                        throw error;
                    }
                    LOG.warn('CLI', `[session-host:${this.options.runtimeId}] reattachment deferred: ${error instanceof Error ? error.message : String(error)}`);
                    await this.waitForRetry(attempt++);
                }
            }
        } finally { this.booting = false; }
    }

    private waitForRetry(attempt: number): Promise<void> {
        if (this.closed) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.reconnectWake = resolve;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.reconnectWake = null;
                resolve();
            }, Math.min(50 * Math.pow(2, Math.min(attempt, 4)), 500));
            this.reconnectTimer.unref?.();
        });
    }

    private async bootOnce(): Promise<void> {
        this.assertOpen();
        if (typeof this.options.ensureReady === 'function') {
            await this.stage(this.options.ensureReady(), false);
            this.assertOpen();
        }
        try {
            await this.stage(this.client.connect());
            this.assertOpen();
        } catch (error) {
            this.assertOpen();
            if (typeof this.options.ensureReady !== 'function') {
                throw error;
            }
            await this.stage(this.options.ensureReady(), false);
            this.assertOpen();
            await this.stage(this.client.connect());
            this.assertOpen();
        }
        this.unsubscribe ??= this.client.onEvent((event: SessionHostEvent) => this.handleEvent(event));
        this.unsubscribeDisconnect ??= this.client.onDisconnect(() => {
            // Announcements may be lost from here on: provenance is unknown
            // (and any earlier key void) until a fresh get_input_state (R8-3).
            this.input.connected = false;
            this.input.gaps += 1;
            if (this.closed || this.booting) return;
            this.recovery = this.reconnectAndReattach();
        });

        let record: SessionHostRecord | null = null;
        if (this.options.attachExisting) {
            const existing = await this.request<SessionHostRecord>({
                type: 'get_session',
                payload: { sessionId: this.options.runtimeId },
            });
            if (!existing.success && isLostRuntimeError(existing.error)) throw new Error(existing.error);
            // Older hosts may reject this read. attach_session is still the
            // authoritative fallback; never request an entire legacy inventory.
            const existingRecord = existing.success ? existing.result : null;
            if (existingRecord && !shouldResumeAttachedSession(existingRecord)) this.checkRetainedIncarnation(existingRecord);
            if (shouldResumeAttachedSession(existingRecord)) {
                assertMaintenanceAdmission();
                const resumeResponse = await this.request<SessionHostRecord>({
                    type: 'resume_session',
                    payload: {
                        sessionId: this.options.runtimeId,
                    },
                });
                if (!resumeResponse.success) {
                    LOG.warn('CLI', `[session-host:${this.options.runtimeId}] resume failed: ${resumeResponse.error || 'unknown error'}`);
                }
            }
            const attachResponse = await this.attachRetained();
            if (!attachResponse.success || !attachResponse.result) {
                throw new Error(attachResponse.error || `Failed to attach runtime ${this.options.runtimeId}`);
            }
            record = attachResponse.result;
            this.checkRetainedIncarnation(record);
        } else {
            assertMaintenanceAdmission();
            const createResponse = await this.request<SessionHostRecord>({
                type: 'create_session',
                payload: {
                    sessionId: this.options.runtimeId,
                    providerType: this.options.providerType,
                    category: this.options.category || 'cli',
                    workspace: this.options.workspace,
                    launchCommand: {
                        command: this.options.command,
                        args: this.options.args,
                        env: this.options.spawnOptions.envOverrides ?? {},
                        envMode: 'launch_overrides',
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
            this.checkRetainedIncarnation(record);
        }

        if (this.options.attachExisting && (record.lifecycle === 'stopped' || record.lifecycle === 'failed')) {
            const term = record.termination;
            this.bootFailure = { exitCode: term?.exitCode ?? null, signal: term?.signal ?? null, termination: term };
            for (const callback of this.exitCallbacks) callback(this.bootFailure);
            await this.closeClient(false);
            return;
        }
        this.currentPid = record.osPid || 0;
        await this.refreshInputState();
        this.updateMetadata(record);

        const ownerResponse = await this.request<SessionHostRecord>({
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
            const snapshotResponse = await this.request<{ seq: number; text: string; truncated: boolean }>({
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
        if (this.closed || this.reconnecting) return;
        if (!('sessionId' in event)) return;
        if (event.sessionId !== this.options.runtimeId) return;
        if ((event.type === 'session_started' || event.type === 'session_resumed') && typeof event.pid === 'number') {
            this.currentPid = event.pid;
            return;
        }
        if (event.type === 'write_owner_changed') {
            const ownerId = event.owner?.clientId;
            if (ownerId && ownerId !== this.options.clientId) this.input.ownerAway += 1;
            this.metadata = {
                ...(this.metadata || { runtimeId: this.options.runtimeId }),
                writeOwner: event.owner ? {
                    clientId: event.owner.clientId,
                    ownerType: event.owner.ownerType,
                } : null,
                // acquireWrite makes the host registry's client writable (and it
                // stays so after release): mirror it, or a promoted viewer would
                // still read as read-only here (review R7-2).
                ...(ownerId && this.metadata?.attachedClients ? {
                    attachedClients: this.metadata.attachedClients.map((client) => (client.clientId === ownerId ? { ...client, readOnly: false } : client)),
                } : {}),
            };
            return;
        }
        if (event.type === 'session_input') {
            const s = this.input;
            if (s.epoch !== null && event.epoch !== s.epoch) { this.rebaselineInput(event.epoch, event.seq); if (event.clientId !== this.options.clientId) s.foreign += 1; return; }
            if (s.lastEventSeq !== null && event.seq !== s.lastEventSeq + 1) s.gaps += 1;
            s.lastEventSeq = s.lastEventSeq === null ? event.seq : Math.max(s.lastEventSeq, event.seq);
            if (event.seq > s.highestSeq) s.highestSeq = event.seq;
            if (event.clientId !== this.options.clientId) s.foreign += 1;
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
            // Preserve the nullable/unknown exitCode and signal exactly as the
            // session host reported them — never collapse null to 0, which would
            // make a signal-terminated process indistinguishable from a clean exit.
            const exitCode = typeof event.exitCode === 'number' ? event.exitCode : null;
            const signal = typeof (event as any).signal === 'number' ? (event as any).signal : null;
            // TOMBSTONE-LEDGER-BRIDGE: forward the host's authoritative termination
            // classification alongside the raw pair. This used to be dropped here,
            // which is why an externally-killed session left no trace in the mesh
            // ledger — the tombstone had exitCode/signal/previousLifecycle/
            // lastOutputAt all along, but nothing downstream could see it.
            const termination = event.termination;
            for (const callback of this.exitCallbacks) {
                callback({ exitCode, signal, termination });
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
        this.noteRecordInputSeq(record);
        this.metadata = {
            osPid: record.osPid,
            startedAt: record.startedAt,
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

    private enqueueMutation(action: () => Promise<void>): void {
        const check = captureMaintenanceAdmission();
        // Void callers still own admission until the queued native ACK settles.
        void this.enqueue(() => withMaintenanceAdmission(async () => { check(); await action(); })).catch(() => {});
    }

    private enqueue<T = void>(action: () => Promise<T>): Promise<T> {
        const operation = this.operationChain
            .then(() => this.ready)
            .then(async () => {
                await this.recovery;
                this.assertOpen();
                return action();
            })
        this.operationChain = operation.then(() => undefined, (error) => {
            LOG.warn('CLI', `[session-host:${this.options.runtimeId}] ${error?.message || error}`);
        });
        return operation;
    }

    private reconnectAndReattach(): Promise<void> {
        if (this.closed || this.reconnecting) return this.recovery ?? Promise.resolve();
        this.reconnecting = true;
        this.input.connected = false;
        // Until the host proves the pin, cleanup must not target a reused ID.
        this.attached = false;
        this.ownsWrite = false;
        this.recovery = this.reconnectOnceValidated();
        return this.recovery;
    }

    private async reconnectOnceValidated(): Promise<void> {
        try {
            // Erase the client's automatic session-ID-only replay before connecting.
            // This transport owns validation of the original process incarnation.
            await this.stage(this.client.close());
            this.assertOpen();
            let attempt = 0;
            while (!this.closed) {
                if (attempt > 0) {
                    const delayMs = Math.min(50 * Math.pow(2, Math.min(attempt - 1, 4)), 500);
                    await new Promise<void>((resolve) => {
                        this.reconnectWake = resolve;
                        this.reconnectTimer = setTimeout(() => {
                            this.reconnectTimer = null;
                            this.reconnectWake = null;
                            resolve();
                        }, delayMs);
                        this.reconnectTimer.unref?.();
                    });
                }
                attempt += 1;
                if (this.closed) return;
                try {
                    await this.stage(this.client.connect());
                    this.assertOpen();
                    const existing = await this.request<SessionHostRecord>({
                        type: 'get_session', payload: { sessionId: this.options.runtimeId },
                    });
                    if (!existing.success || !existing.result) {
                        if (isLostRuntimeError(existing.error)) throw new Error(existing.error);
                        // An old/unreachable host cannot certify a pinned incarnation.
                        // Keep waiting without attaching or admitting queued input.
                        continue;
                    }
                    if (!this.retainedIncarnation) continue;
                    this.checkRetainedIncarnation(existing.result);
                    this.ownsWrite = existing.result.writeOwner?.clientId === this.options.clientId;
                    const attachResponse = await this.attachRetained();
                    if (!attachResponse.success) {
                        if (isLostRuntimeError(attachResponse.error)) {
                            throw new Error(attachResponse.error);
                        }
                        continue;
                    }
                    if (attachResponse.result) {
                        this.checkRetainedIncarnation(attachResponse.result);
                        await this.refreshInputState();
                        this.updateMetadata(attachResponse.result);
                        if (attachResponse.result.lifecycle === 'stopped' || attachResponse.result.lifecycle === 'failed') {
                            const term = attachResponse.result.termination;
                            for (const callback of this.exitCallbacks) {
                                callback({
                                    exitCode: term?.exitCode ?? null,
                                    signal: term?.signal ?? null,
                                    termination: term,
                                });
                            }
                            void this.closeClient(false);
                        }
                    }
                    return;
                } catch (error) {
                    if (this.closed) return;
                    if (isLostRuntimeError(error instanceof Error ? error.message : String(error))) {
                        this.attached = false;
                        this.ownsWrite = false;
                        this.reportLostRuntime(error instanceof Error ? error.message : String(error));
                        await this.closeClient(false);
                        return;
                    }
                    // Wait and retry on transient socket reconnect failure.
                }
            }
        } catch (error) {
            if (!this.closed) throw error;
        } finally {
            this.reconnecting = false;
        }
    }

    private attachRetained(): Promise<SessionHostResponse<SessionHostRecord>> {
        const payload = { sessionId: this.options.runtimeId, clientId: this.options.clientId, clientType: 'daemon' as const, readOnly: false };
        const pin = this.retainedIncarnation;
        return pin
            ? this.request({ type: 'attach_session_if_incarnation', payload: {
                ...payload, expectedIncarnation: { sessionId: this.options.runtimeId, ...pin },
            } })
            : this.request({ type: 'attach_session', payload });
    }

    private assertOpen(): void {
        if (this.closed) throw new Error(`Session host transport detached: ${this.options.runtimeId}`);
    }

    private async stage<T>(promise: Promise<T>, drain = true): Promise<T> {
        if (drain) {
            this.pendingStages.add(promise);
            void promise.then(() => this.pendingStages.delete(promise), () => this.pendingStages.delete(promise));
        }
        let cancel!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(new Error(`Session host transport detached: ${this.options.runtimeId}`));
            this.cancellationListeners.add(cancel);
        });
        try { return await Promise.race([promise, cancelled]); }
        finally { this.cancellationListeners.delete(cancel); }
    }

    private async request<T = unknown>(request: SessionHostRequest): Promise<SessionHostResponse<T>> {
        this.assertOpen();
        const response = await this.stage(this.client.request<T>(request).then(response => {
            // Remember late successes before the cancellation fence so teardown
            // releases an attach/ownership ACK that arrived after detach.
            if (response.success) {
                if (this.retainedIncarnation && (request.type === 'attach_session' || request.type === 'attach_session_if_incarnation' || request.type === 'acquire_write') && response.result) {
                    try { this.checkRetainedIncarnation(response.result as unknown as SessionHostRecord); }
                    catch (error) { this.attached = false; this.ownsWrite = false; throw error; }
                }
                if (request.type === 'attach_session' || request.type === 'attach_session_if_incarnation' || request.type === 'create_session') this.attached = true;
                if (request.type === 'acquire_write') this.ownsWrite = true;
            }
            return response;
        }));
        this.assertOpen();
        return response;
    }

    private closeClient(destroy = false): Promise<void> {
        if (this.cleanup) return this.cleanup;
        this.closed = true;
        for (const cancel of this.cancellationListeners) cancel();
        this.cancellationListeners.clear();
        this.input.connected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectWake?.();
        this.reconnectWake = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.unsubscribeDisconnect?.();
        this.unsubscribeDisconnect = null;
        this.cleanup = (async () => {
            // Do not close underneath an attach/acquire ACK: the host retains
            // registry ownership after socket close. Drain that one stage, then
            // release exactly the resources it actually granted. No later boot
            // or reconnect stage can pass assertOpen.
            await Promise.allSettled([...this.pendingStages]);
            try {
                if (this.ownsWrite && this.client.isConnected()) await this.client.request({ type: 'release_write', payload: {
                    sessionId: this.options.runtimeId, clientId: this.options.clientId,
                } }).catch(() => {});
                if (this.attached && this.client.isConnected()) await this.client.request({ type: 'detach_session', payload: {
                    sessionId: this.options.runtimeId, clientId: this.options.clientId,
                } }).catch(() => {});
            } finally {
                this.ownsWrite = false;
                this.attached = false;
                try { await this.client.close(); }
                catch (err) { if (destroy) throw err; }
            }
        })();
        return this.cleanup;
    }
}

export class SessionHostPtyTransportFactory implements PtyTransportFactory {
    constructor(private readonly options: SessionHostPtyTransportFactoryOptions) {}

    get attachesExistingRuntime(): boolean {
        return this.options.attachExisting === true;
    }

    spawn(command: string, args: string[], spawnOptions: PtySpawnOptions): PtyRuntimeTransport {
        return new SessionHostRuntimeTransport({
            ...this.options,
            command: resolveWin32Executable(command),
            args,
            spawnOptions,
        });
    }
}

/** Host errors that mean the runtime no longer exists there (server.ts requireRuntime / registry). */
export function isLostRuntimeError(error: string | undefined): boolean {
    return typeof error === 'string' && (/^(?:Runtime not found for session|Unknown session):/.test(error) || error === 'session_absent');
}
