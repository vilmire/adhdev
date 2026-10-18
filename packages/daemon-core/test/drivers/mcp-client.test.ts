import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedMcpProcess, buildDriverEnv } from '../../src/drivers/managed-mcp-process.js';
import { validateDriverProviderManifest } from '../../src/providers/sdk/v1/validators/manifest.js';
import type { DriverManifest } from '../../src/drivers/contracts.js';
import type { DriverToolResult } from '../../src/drivers/mcp-client.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const processes: ManagedMcpProcess[] = [];
function driver(flags: string[] = [], runtime: Partial<DriverManifest['runtime']> = {}, requestTimeoutMs = 2000) {
    const instance = new ManagedMcpProcess({ kind: 'mcp-stdio', command: process.execPath,
        args: [fixture, ...flags], startupTimeoutMs: 2000, idleStopMs: 5000, ...runtime },
        { cwd: fileURLToPath(new URL('.', import.meta.url)), requestTimeoutMs });
    processes.push(instance); return instance;
}
const read = (result: DriverToolResult) => JSON.parse((result.content[0] as { text: string }).text);
afterEach(async () => { await Promise.all(processes.splice(0).map(instance => instance.close())); });

describe('official SDK driver MCP client', () => {
    it('constructs passively, initializes, lists and calls tools through stdio', async () => {
        const instance = driver();
        expect(instance.state).toBe('stopped'); expect(instance.pid).toBeUndefined();
        await instance.start();
        expect(instance.state).toBe('running');
        expect(await instance.listTools()).toMatchObject([{ name: 'echo', inputSchema: { type: 'object' } }]);
        expect(read(await instance.callTool('echo', { message: 'hello', n: 42 }))).toEqual({ message: 'hello', n: 42 });
        await instance.close(); expect(instance.state).toBe('stopped'); expect(instance.pid).toBeUndefined();
    });
    it('cancels by invocation id and sends the SDK cancellation notification', async () => {
        const instance = driver(); await instance.start();
        const call = instance.callTool('delay', { delayMs: 5000 });
        const rejected = expect(call).rejects.toMatchObject({ code: 'cancelled' });
        instance.cancel(call.id); await rejected;
        expect(read(await instance.callTool('cancel-count', {}))).toBe(1);
        expect(instance.state).toBe('running');
    });
    it('supports AbortSignal cancellation, including an already-aborted signal', async () => {
        const instance = driver(); await instance.start();
        const abort = new AbortController();
        const call = instance.callTool('delay', {}, abort.signal);
        const rejected = expect(call).rejects.toMatchObject({ code: 'cancelled' });
        abort.abort(); await rejected;
        await expect(instance.callTool('delay', {}, abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
        expect(read(await instance.callTool('echo', { still: 'alive' }))).toEqual({ still: 'alive' });
    });
    it('times out a call without killing the connection', async () => {
        const instance = driver([], {}, 80); await instance.start();
        await expect(instance.callTool('delay', { delayMs: 5000 })).rejects.toMatchObject({ code: 'timeout' });
        expect(instance.state).toBe('running');
        expect(read(await instance.callTool('echo', { after: 'timeout' }))).toEqual({ after: 'timeout' });
    });
    it('bounds initialization and terminates the child on startup timeout', async () => {
        const instance = driver(['--delay-init'], { startupTimeoutMs: 150 });
        await expect(instance.start()).rejects.toMatchObject({ code: 'timeout' });
        expect(instance.state).toBe('failed'); expect(instance.pid).toBeUndefined();
        await expect(instance.start()).rejects.toBeTruthy();
    });
    it('can stop during initialization without throwing null or leaving a child', async () => {
        const instance = driver(['--delay-init']);
        const starting = instance.start();
        const rejected = expect(starting).rejects.toBeInstanceOf(Error);
        await instance.close(); await rejected;
        expect(instance.state).toBe('stopped'); expect(instance.pid).toBeUndefined();
    });
    it('isolates a crash: pending call rejects, no daemon exception, failed state and no restart', async () => {
        const faults: unknown[] = []; const fault = (error: unknown) => faults.push(error);
        process.on('uncaughtExceptionMonitor', fault); process.on('unhandledRejection', fault);
        try {
            const instance = driver(); await instance.start();
            await expect(instance.callTool('crash', {})).rejects.toBeTruthy();
            await expect.poll(() => instance.state).toBe('failed'); await instance.close();
            expect(instance.pid).toBeUndefined();
            await expect(instance.start()).rejects.toBeTruthy();
            expect(instance.pid).toBeUndefined(); expect(faults).toEqual([]);
        } finally { process.off('uncaughtExceptionMonitor', fault); process.off('unhandledRejection', fault); }
    });
    it('handles a crash during initialization and a missing executable', async () => {
        const instance = driver(['--crash-init']);
        await expect(instance.start()).rejects.toBeTruthy(); expect(instance.state).toBe('failed');
        const missing = driver([], { command: '/nonexistent/adhdev-mcp-driver' });
        await expect(missing.start()).rejects.toBeTruthy(); expect(missing.state).toBe('failed');
    });
    it('fails closed on malformed JSON and terminates the child', async () => {
        const instance = driver(); await instance.start();
        await expect(instance.callTool('malformed', {})).rejects.toBeTruthy(); await instance.close();
        expect(instance.state).toBe('failed'); expect(instance.pid).toBeUndefined();
    });
    it('uses the manifest idle deadline while keeping active calls alive', async () => {
        const instance = driver([], { idleStopMs: 80 }); await instance.start();
        expect(read(await instance.callTool('delay', { delayMs: 160 }))).toEqual({ delayMs: 160 });
        expect(instance.state).toBe('running');
        await expect.poll(() => instance.state).toBe('stopped'); await instance.close();
        expect(instance.pid).toBeUndefined();
    });
    it('inherits only minimal env plus manifest allowlist, then sanitizes, with schema validation', async () => {
        const env = buildDriverEnv({ kind: 'mcp-stdio', command: 'node', env: ['DRIVER_ALLOWED', 'npm_config_bad'] },
            { PATH: '/usr/bin', HOME: '/fixture', DRIVER_ALLOWED: 'yes', driver_allowed: 'different-case', DRIVER_SECRET: 'no', NODE_OPTIONS: '--require bad', npm_config_bad: 'removed' });
        expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/fixture', DRIVER_ALLOWED: 'yes' });
        if (process.platform !== 'win32') expect(env).not.toHaveProperty('driver_allowed');
        for (const key of ['DRIVER_SECRET', 'NODE_OPTIONS', 'npm_config_bad']) expect(env).not.toHaveProperty(key);
        const manifest: DriverManifest = { type: 'test', name: 'Test', category: 'driver', providerVersion: '1.0.0',
            runtime: { kind: 'mcp-stdio', command: 'node', env: ['DRIVER_ALLOWED'] }, actions: [{ id: 'echo', tool: 'echo', risk: 'read' }] };
        expect(validateDriverProviderManifest(manifest).ok).toBe(true);
        expect(validateDriverProviderManifest({ ...manifest, runtime: { ...manifest.runtime, env: { TOKEN: 'secret' } } }).ok).toBe(false);
        const before = process.env.DRIVER_ALLOWED; const secretBefore = process.env.DRIVER_SECRET;
        process.env.DRIVER_ALLOWED = 'yes'; process.env.DRIVER_SECRET = 'no';
        try {
            const instance = driver([], { env: ['DRIVER_ALLOWED'] }); await instance.start();
            const actual = read(await instance.callTool('env', {}));
            expect(actual.DRIVER_ALLOWED).toBe('yes'); expect(actual.DRIVER_SECRET).toBeUndefined();
        } finally {
            if (before === undefined) delete process.env.DRIVER_ALLOWED; else process.env.DRIVER_ALLOWED = before;
            if (secretBefore === undefined) delete process.env.DRIVER_SECRET; else process.env.DRIVER_SECRET = secretBefore;
        }
    });
});
