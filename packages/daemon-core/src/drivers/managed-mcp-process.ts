import type { ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { hiddenSpawn } from '../process/hidden-spawn.js';
import { sanitizeSpawnEnv } from '../cli-adapters/spawn-env.js';
import type { DriverManifest } from './contracts.js';
import { createSdkDriverClient } from './mcp-client-sdk.js';
import { DriverMcpError, type DriverCall, type DriverMcpClient, type DriverToolResult } from './mcp-client.js';

export type ManagedMcpState = 'stopped' | 'starting' | 'running' | 'failed';
const BASE_ENV = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']);
export function buildDriverEnv(runtime: DriverManifest['runtime'], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const normalize = (key: string) => process.platform === 'win32' ? key.toUpperCase() : key;
    const allowed = new Set([...BASE_ENV, ...(runtime.env ?? [])].map(normalize));
    return sanitizeSpawnEnv(Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(normalize(key)))));
}
async function resolvePackagePath(value: string, packageDir?: string): Promise<string> {
    if (!packageDir || !value || value.startsWith('-') || isAbsolute(value)) return value;
    const isExplicitRelative = value.startsWith('./') || value.startsWith('.\\');
    const candidate = resolve(packageDir, value);
    const rel = relative(packageDir, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) return value;
    if (isExplicitRelative) return candidate;
    try {
        await access(candidate);
        return candidate;
    } catch {
        return value;
    }
}

/** Owns one child and never restarts a failed process. Constructing is passive;
 * G1a-5 must pass its permission pipeline before calling start(). */
export class ManagedMcpProcess implements DriverMcpClient {
    state: ManagedMcpState = 'stopped';
    failure: Error | null = null;
    private child: ChildProcess | null = null;
    private sdkClient: DriverMcpClient | null = null;
    private starting: Promise<void> | null = null;
    private stopping: Promise<void> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private exited: Promise<void> = Promise.resolve();
    private active = 0;
    constructor(private readonly runtime: DriverManifest['runtime'], private readonly options: {
        cwd: string; packageDir?: string; requestTimeoutMs?: number; env?: NodeJS.ProcessEnv;
    }) {}
    get pid(): number | undefined { return this.child?.pid; }
    start(): Promise<void> {
        if (this.state === 'failed') return Promise.reject(this.failure ?? new DriverMcpError('failed', 'Driver failed'));
        if (this.state === 'running') return Promise.resolve();
        if (this.state === 'starting') return this.starting!;
        this.state = 'starting';
        this.starting = this.startInternal();
        return this.starting;
    }
    private async startInternal(): Promise<void> {
        const startupTimeoutMs = this.runtime.startupTimeoutMs ?? 15_000;
        try {
            if (this.stopping) await this.stopping;
            this.stopping = null;
            if (this.state !== 'starting') throw new DriverMcpError('connection_closed', 'Driver start was cancelled');
            if (this.runtime.platforms && !(this.runtime.platforms as readonly string[]).includes(process.platform)) throw new Error('Driver platform is unsupported');
            await mkdir(this.options.cwd, { recursive: true });
            const command = await resolvePackagePath(this.runtime.command, this.options.packageDir);
            const args = await Promise.all((this.runtime.args ?? []).map(arg => resolvePackagePath(arg, this.options.packageDir)));
            if (this.state !== 'starting') throw new DriverMcpError('connection_closed', 'Driver start was cancelled');
            const env = buildDriverEnv(this.runtime, this.options.env);
            if (this.options.packageDir) {
                env.ADHDEV_DRIVER_PACKAGE_DIR = this.options.packageDir;
                env.ADHDEV_DRIVER_STATE_DIR = this.options.cwd;
            }
            const child = hiddenSpawn(command, args, { cwd: this.options.cwd,
                env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
                detached: process.platform !== 'win32' });
            this.child = child;
            this.exited = new Promise(resolve => child.once('close', () => {
                resolve();
                if (this.child === child && !this.stopping && this.state !== 'stopped') this.fail(new DriverMcpError('connection_closed', 'Driver process exited'));
            }));
            child.on('error', error => this.fail(error));
            // Always consume stderr; an unread pipe can deadlock a verbose server.
            child.stderr?.on('data', () => {});
            child.stdin?.on('error', error => { if (!this.stopping) this.fail(error); });
            child.stdout?.on('error', error => { if (!this.stopping) this.fail(error); });
            const adapter = createSdkDriverClient(child, { startupTimeoutMs,
                requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
                onFailure: error => this.fail(error), stopProcess: () => this.stopProcess() });
            this.sdkClient = adapter.client;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([adapter.connect(), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new DriverMcpError('timeout', 'Driver startup timed out')), startupTimeoutMs);
                })]);
            } finally { clearTimeout(timer); }
            if (this.state !== 'starting') throw this.failure ?? new Error('Driver stopped during startup');
            this.state = 'running';
            this.armIdle();
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.fail(failure);
            await this.close();
            throw this.failure ?? failure;
        }
    }
    private fail(error: Error): void {
        if (this.state === 'failed' || this.state === 'stopped') return;
        this.state = 'failed';
        this.failure = error;
        this.clearIdle();
        // Event callbacks never throw/reject into the daemon's event loop.
        void this.close().catch(() => {});
    }
    private clearIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null; }
    private armIdle(): void {
        this.clearIdle();
        if (this.state === 'running' && this.active === 0) {
            this.idleTimer = setTimeout(() => { void this.close().catch(error => this.fail(error)); }, this.runtime.idleStopMs ?? 600_000);
            this.idleTimer.unref();
        }
    }
    private requireClient(): DriverMcpClient {
        if (this.state !== 'running' || !this.sdkClient) throw this.failure ?? new DriverMcpError('connection_closed', 'Driver is not running');
        this.clearIdle();
        return this.sdkClient;
    }
    async listTools() {
        const client = this.requireClient(); this.active++;
        try { return await client.listTools(); } finally { this.active--; this.armIdle(); }
    }
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): DriverCall {
        const client = this.requireClient(); this.active++;
        const call = client.callTool(name, args, signal);
        const promise: Promise<DriverToolResult> = call.finally(() => { this.active--; this.armIdle(); });
        return Object.assign(promise, { id: call.id });
    }
    cancel(id: string): void { this.sdkClient?.cancel(id); }
    async close(): Promise<void> {
        this.clearIdle();
        if (this.state !== 'failed') this.state = 'stopped';
        const client = this.sdkClient;
        this.sdkClient = null;
        if (client) await client.close(); else await this.stopProcess();
    }
    private stopProcess(): Promise<void> {
        if (this.stopping) return this.stopping;
        const child = this.child;
        if (!child) return Promise.resolve();
        this.stopping = (async () => {
            const signal = async (name: NodeJS.Signals) => {
                if (child.exitCode !== null || child.signalCode !== null) return;
                try {
                    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
                    else if (child.pid) {
                        // Kill the Windows process tree, including browser children.
                        await new Promise<void>(resolve => {
                            const killer = hiddenSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                            killer.once('error', () => { child.kill(name); resolve(); });
                            killer.once('close', () => resolve());
                        });
                    } else child.kill(name);
                } catch { /* already exited */ }
            };
            const wait = async (ms: number) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try { await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
                finally { clearTimeout(timer); }
            };
            child.stdin?.end();
            await signal('SIGTERM');
            await wait(2000);
            await signal('SIGKILL');
            await this.exited;
            if (this.child === child) this.child = null;
        })();
        return this.stopping;
    }
}
