import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveWin32ExecFileSpawn } from '../../cli-adapters/resolve-executable.js';

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
export type TransportExitReason = 'requested' | 'process_exit' | 'transport_error' | 'protocol_error' | 'timeout';

/** Dedicated stdio runtime, never a connection to an existing owner process. */
export class CodexStdioTransport {
    private child?: ChildProcessWithoutNullStreams;
    private pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private buffer = '';
    private closed = true;
    readonly generation = randomUUID();

    constructor(private readonly options: {
        command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
        onMessage: (message: RpcMessage) => void; onExit: (error: Error, reason: TransportExitReason) => void;
    }) {}

    start(): void {
        if (this.child) throw new Error('Codex runtime already started');
        this.closed = false;
        const launch = resolveWin32ExecFileSpawn(this.options.command, this.options.args);
        this.child = spawn(launch.file, launch.args, {
            cwd: this.options.cwd, env: this.options.env, stdio: 'pipe', windowsHide: true,
            ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.read(chunk));
        // Stderr can contain private provider diagnostics. Drain without logging/persisting it.
        this.child.stderr.resume();
        this.child.on('error', () => this.close(new Error('Codex app-server process failed'), 'transport_error'));
        this.child.on('exit', () => this.close(new Error('Codex app-server runtime exited'), 'process_exit'));
        this.child.stdin.on('error', () => this.close(new Error('Codex app-server input closed'), 'transport_error'));
    }

    private read(chunk: string): void {
        if (this.closed) return;
        this.buffer += chunk;
        if (this.buffer.length > 8 * 1024 * 1024) { this.stop('protocol_error'); return; }
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            let message: RpcMessage;
            try { message = JSON.parse(line); } catch { this.stop('protocol_error'); return; }
            if (!message || typeof message !== 'object' || Array.isArray(message)) { this.stop('protocol_error'); return; }
            if ((message.id !== undefined && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id))))
                || (message.method !== undefined && typeof message.method !== 'string')) { this.stop('protocol_error'); return; }
            if (message.method) this.options.onMessage(message);
            else if (message.id !== undefined) {
                const pending = this.pending.get(message.id);
                if (!pending) continue;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'));
                else pending.resolve(message.result);
            }
        }
    }

    write(message: RpcMessage): void {
        if (this.closed || !this.child?.stdin.writable) throw new Error('Codex runtime unavailable');
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }

    request(method: string, params: unknown): Promise<unknown> {
        const id = `adhdev:${this.generation}:${randomUUID()}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex ${method} timed out`));
                // A timed-out state mutation has an unknown outcome; invalidate the runtime.
                if (['initialize', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method)) this.stop('timeout');
            }, 15_000);
            this.pending.set(id, { resolve, reject, timer });
            try { this.write({ id, method, params }); }
            catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }

    isAlive(): boolean { return !this.closed && !!this.child; }
    stop(reason: TransportExitReason = 'requested'): void {
        this.child?.kill();
        this.close(new Error(reason === 'protocol_error' ? 'Codex emitted an invalid native protocol frame' : 'Codex app-server runtime closed'), reason);
    }
    private close(error: Error, reason: TransportExitReason): void {
        if (this.closed) return;
        this.closed = true;
        this.buffer = '';
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.options.onExit(error, reason);
    }
}
