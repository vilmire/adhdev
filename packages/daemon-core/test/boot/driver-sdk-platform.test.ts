import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { probeDriverList } from '../../../../../scripts/check-daemon-boot-smoke.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { hiddenSpawn } from '../../src/process/hidden-spawn.js';
const events = vi.hoisted(() => [] as string[]);
vi.mock('../../src/drivers/mcp-client-sdk.js', () => {
    events.push('sdk-module-evaluated');
    return { primeDriverMcpSdk: () => events.push('sdk-client-constructed') };
});
vi.mock('../../src/boot/process-hardening.js', () => ({ applyProcessHardening: () => events.push('hardening') }));
vi.mock('../../src/logging/logger.js', () => ({ LOG: { info() {}, warn() {} }, installGlobalInterceptor() {} }));
vi.mock('../../src/config/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../../src/config/env-overrides.js', () => ({ applyDaemonEnvOverrides: () => ({ applied: {} }) }));
vi.mock('../../src/commands/upgrade-failure-notice.js', () => ({ readUpgradeFailureNotice: () => null }));
vi.mock('../../src/providers/sdk/v1/sandbox/require-whitelist.js', () => ({ installProviderProcessShim() {} }));
vi.mock('../../src/providers/channel/channel-migration.js', () => ({ migrateProviderChannelConfig: () => ({ migrated: false }) }));
import { bootPlatform } from '../../src/boot/stages/platform.js';

describe('driver SDK boot platform boundary', () => {
    it('evaluates the SDK eagerly and constructs its client before hardening', async () => {
        expect(events).toEqual(['sdk-module-evaluated']); await bootPlatform({} as any);
        expect(events).toEqual(['sdk-module-evaluated', 'sdk-client-constructed', 'hardening']);
    });
    it('keeps imports static and managed spawning asynchronous', () => {
        const platform = readFileSync(new URL('../../src/boot/stages/platform.ts', import.meta.url), 'utf8');
        const adapter = readFileSync(new URL('../../src/drivers/mcp-client-sdk.ts', import.meta.url), 'utf8');
        const managed = readFileSync(new URL('../../src/drivers/managed-mcp-process.ts', import.meta.url), 'utf8');
        expect(platform).toMatch(/import \{ primeDriverMcpSdk \} from '..\/..\/drivers\/mcp-client-sdk.js'/);
        expect(platform).not.toMatch(/import\([^)]*mcp-client-sdk/); expect(adapter).not.toMatch(/import\(/);
        expect(managed).toContain('hiddenSpawn('); expect(managed).not.toMatch(/\b\w+Sync\s*\(/);
    });
    it('the smoke probe calls driver_list once over each existing transport and refuses command failure', async () => {
        const commands: string[] = [];
        const server = createServer((req, res) => {
            let body = ''; req.on('data', chunk => { body += chunk; });
            req.on('end', () => { commands.push(JSON.parse(body).type); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true })); });
        });
        const ws = new WebSocketServer({ server, path: '/ipc' });
        let success = true;
        ws.on('connection', socket => socket.on('message', raw => {
            const message = JSON.parse(raw.toString()); commands.push(message.payload.command);
            socket.send(JSON.stringify({ type: 'ext:command_result', payload: { requestId: message.payload.requestId, success, result: { success } } }));
        }));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
            expect(await probeDriverList('standalone', port)).toBe(true);
            expect(await probeDriverList('cloud', port)).toBe(true);
            success = false;
            expect(await probeDriverList('cloud', port)).toBe(false);
            expect(commands).toEqual(['driver_list', 'driver_list', 'driver_list']);
        } finally {
            for (const client of ws.clients) client.terminate();
            await new Promise<void>(resolve => ws.close(() => resolve()));
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
    it('completes a real round trip after freezing prototypes in an isolated process', async () => {
        const adapter = new URL('../../src/drivers/mcp-client-sdk.ts', import.meta.url).href;
        const managed = new URL('../../src/drivers/managed-mcp-process.ts', import.meta.url).href;
        const hardening = new URL('../../src/boot/process-hardening.ts', import.meta.url).href;
        const fixture = fileURLToPath(new URL('../drivers/fixtures/fake-mcp-server.mjs', import.meta.url));
        const source = `import adapterModule from ${JSON.stringify(adapter)};
            import managedModule from ${JSON.stringify(managed)};
            import hardeningModule from ${JSON.stringify(hardening)};
            const { primeDriverMcpSdk } = adapterModule;
            const { ManagedMcpProcess } = managedModule;
            const { applyProcessHardening } = hardeningModule;
            primeDriverMcpSdk(); applyProcessHardening();
            const driver = new ManagedMcpProcess({kind:'mcp-stdio', command:process.execPath, args:[${JSON.stringify(fixture)}]}, {cwd:process.cwd()});
            try { await driver.start(); const tools = await driver.listTools();
              const result = await driver.callTool('echo', {frozen:true});
              if (JSON.parse(result.content[0].text).frozen !== true) throw Error('call failed');
              if (tools[0]?.name !== 'echo' || !Object.isFrozen(Object.prototype)) throw Error('failed');
              console.log('SDK_AFTER_HARDENING_OK');
            } finally { await driver.close(); }`;
        const child = hiddenSpawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        expect({ code, output }).toMatchObject({ code: 0, output: expect.stringContaining('SDK_AFTER_HARDENING_OK') });
    });
});
