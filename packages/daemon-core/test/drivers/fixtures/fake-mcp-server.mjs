// Deliberately dependency-free JSON-RPC peer: tests the official client on a wire.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const flags = new Set(process.argv.slice(2));
const timers = new Map();
let cancelled = 0;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const success = (id, result) => send({ id, result });
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
        if (flags.has('--crash-init')) process.exit(7);
        if (flags.has('--delay-init')) return;
        success(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-driver', version: '1.0.0' } });
    } else if (msg.method === 'tools/list') {
        success(msg.id, { tools: [{ name: 'echo', description: 'Test echo', inputSchema: { type: 'object' } }] });
    } else if (msg.method === 'tools/call') {
        if (msg.params.name === 'crash' || flags.has('--crash')) process.exit(9);
        if (msg.params.name === 'malformed' || flags.has('--malformed')) { process.stdout.write('{bad json\n'); return; }
        if (msg.params.name === 'cancel-count') { success(msg.id, content(cancelled)); return; }
        if (msg.params.name === 'env') { success(msg.id, content(process.env)); return; }
        if (msg.params.name === 'write-cwd') {
            const filename = String(msg.params.arguments?.filename ?? '.playwright-mcp-trace.json');
            writeFileSync(join(process.cwd(), filename), JSON.stringify({ written: true }));
            success(msg.id, content({ cwd: process.cwd(), packageDir: process.env.ADHDEV_DRIVER_PACKAGE_DIR, stateDir: process.env.ADHDEV_DRIVER_STATE_DIR }));
            return;
        }
        if (msg.params.name === 'delay' || flags.has('--delay')) {
            const timer = setTimeout(() => { timers.delete(msg.id); success(msg.id, content(msg.params.arguments)); }, msg.params.arguments?.delayMs ?? 5000);
            timers.set(msg.id, timer);
        } else success(msg.id, content(msg.params.arguments));
    } else if (msg.method === 'notifications/cancelled') {
        cancelled++;
        clearTimeout(timers.get(msg.params.requestId));
        timers.delete(msg.params.requestId);
        // Send evidence back on stdout without using a filesystem side effect.
        send({ method: 'notifications/message', params: { level: 'info', data: { cancelled: msg.params.requestId } } });
    }
});
process.stdin.on('end', () => { for (const timer of timers.values()) clearTimeout(timer); });
