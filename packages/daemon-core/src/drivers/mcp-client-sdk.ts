/** The daemon's ONLY SDK import boundary. Eagerly evaluated by boot S1.
 * The official stdio transport owns spawning and cannot accept hiddenSpawn.
 * This stream adapter uses the SDK's framing/validation with our managed child;
 * the official Client still owns initialization, Tools, ids and cancellation. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ChildProcess } from 'node:child_process';
import { DriverMcpError, type DriverCall, type DriverMcpClient } from './mcp-client.js';

class ManagedStdioTransport implements Transport {
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    onmessage?: Transport['onmessage'];
    private readonly buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
    private closed = false;
    constructor(private readonly child: ChildProcess) {}
    async start(): Promise<void> {
        if (!this.child.stdin || !this.child.stdout) throw new Error('Missing driver stdio pipes');
        this.child.stdout.on('data', this.onData);
        this.child.stdout.on('error', this.onError);
        this.child.stdin.on('error', this.onError);
        this.child.on('close', this.onClose);
    }
    private onData = (chunk: Buffer) => {
        if (this.closed) return;
        try {
            this.buffer.append(chunk);
            for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
        } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
    };
    private onError = (error: Error) => { if (!this.closed) this.onerror?.(error); };
    private onClose = () => { void this.close(); };
    async send(message: JSONRPCMessage): Promise<void> {
        if (this.closed || !this.child.stdin?.writable) throw new DriverMcpError('connection_closed', 'Driver stdio is closed');
        await new Promise<void>((resolve, reject) => this.child.stdin!.write(serializeMessage(message), error => error ? reject(error) : resolve()));
    }
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.child.stdout?.off('data', this.onData);
        this.child.stdout?.off('error', this.onError);
        this.child.stdin?.off('error', this.onError);
        this.child.off('close', this.onClose);
        this.buffer.clear();
        this.onclose?.();
    }
}

export function createSdkDriverClient(child: ChildProcess, options: {
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    onFailure: (error: Error) => void;
    stopProcess: () => Promise<void>;
}): { client: DriverMcpClient; connect: () => Promise<void> } {
    const sdk = new Client({ name: 'adhdev-driver-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new ManagedStdioTransport(child);
    const calls = new Map<string, AbortController>();
    let closing = false;
    let sequence = 0;
    sdk.onerror = error => { if (!closing) options.onFailure(error); };
    sdk.onclose = () => { if (!closing) options.onFailure(new DriverMcpError('connection_closed', 'Driver connection closed')); };
    const normalize = (error: unknown): Error => {
        if (error instanceof DriverMcpError) return error;
        const e = error as { code?: number; name?: string; message?: string };
        if (e?.code === -32001) return new DriverMcpError('timeout', e.message ?? 'Driver request timed out');
        if (e?.code === -32000) return new DriverMcpError('connection_closed', e.message ?? 'Driver connection closed');
        return error instanceof Error ? error : new Error(String(error));
    };
    const client: DriverMcpClient = {
        async listTools() {
            const tools = [];
            let cursor: string | undefined;
            do {
                const page = await sdk.listTools(cursor ? { cursor } : undefined, { timeout: options.requestTimeoutMs }).catch(error => { throw normalize(error); });
                tools.push(...page.tools);
                cursor = page.nextCursor;
            } while (cursor);
            return tools;
        },
        callTool(name, args, signal) {
            const id = `driver-call-${++sequence}`;
            const controller = new AbortController();
            const abort = () => controller.abort(new DriverMcpError('cancelled', 'Driver call cancelled'));
            calls.set(id, controller);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const promise = sdk.callTool({ name, arguments: args }, undefined,
                { signal: controller.signal, timeout: options.requestTimeoutMs })
                .catch(error => { throw controller.signal.aborted ? controller.signal.reason : normalize(error); })
                .finally(() => { calls.delete(id); signal?.removeEventListener('abort', abort); });
            return Object.assign(promise, { id }) as DriverCall;
        },
        cancel(id) { calls.get(id)?.abort(new DriverMcpError('cancelled', 'Driver call cancelled')); },
        async close() {
            closing = true;
            try { await sdk.close(); } finally { await options.stopProcess(); }
        },
    };
    return { client, connect: () => sdk.connect(transport, { timeout: options.startupTimeoutMs }).catch(error => { throw normalize(error); }) };
}

/** Boot S1 constructs a client as well as evaluating SDK/Zod dependencies.
 * No child, transport or network connection is created here. */
export function primeDriverMcpSdk(): void {
    new Client({ name: 'adhdev-driver-boot-check', version: '1.0.0' }, { capabilities: {} });
}
