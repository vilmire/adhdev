import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionHostClient, createLineParser } from '../../../session-host-core/src/ipc.js';
import { SessionHostRegistry } from '../../../session-host-core/src/registry.js';

const sockets = vi.hoisted(() => ({ current: undefined as any }));
vi.mock('net', () => ({ createConnection: () => sockets.current }));

describe('rc32 session host control census', () => {
    it('drains a multi-MB response behind a throwing output observer on a long-lived client', async () => {
        const socket: any = new EventEmitter(); socket.destroyed = false;
        let parser: ReturnType<typeof createLineParser>;
        socket.destroy = () => { socket.destroyed = true; };
        socket.end = () => socket.destroy();
        socket.write = (wire: string) => { parser(wire); return true; };
        sockets.current = socket;
        const client = new SessionHostClient({ endpoint: { kind: 'unix', path: '/tmp/rc32-fake.sock' }, registerAsShared: false, requestTimeoutMs: 1000 });
        const connect = client.connect(); socket.emit('connect'); await connect;
        client.onEvent(() => { throw new Error('broken output observer'); });
        client.onEvent(() => {});
        const payload = '한글'.repeat(600_000);
        parser = createLineParser((request: any) => {
            const wire = JSON.stringify({ kind: 'event', event: { type: 'session_output', sessionId: 'x', data: 'output' } }) + '\n'
                + JSON.stringify({ kind: 'response', requestId: request.requestId, response: { success: true, result: payload } }) + '\n';
            // Many chunks, with the response following streamed output.
            for (let i = 0; i < wire.length; i += 8192) socket.emit('data', Buffer.from(wire.slice(i, i + 8192)));
        });
        try {
            for (let n = 0; n < 2; n++) expect((await client.request({ type: 'list_sessions' })).result).toBe(payload);
        } finally { await client.close(); }
    });
    it('lists compact summaries and preserves full launch details for an exact lookup', () => {
        const registry = new SessionHostRegistry();
        const record: any = { sessionId: 'live', runtimeKey: 'key', displayName: 'live', workspaceLabel: 'repo', transport: 'pty', providerType: 'codex-cli', category: 'cli', workspace: '/tmp/repo',
            launchCommand: { command: 'codex', args: ['--system-prompt', 'x'.repeat(96_000)], env: { TOKEN: 'secret' } },
            createdAt: 1, lastActivityAt: 1, lifecycle: 'running', writeOwner: null, attachedClients: [], buffer: { scrollbackBytes: 0, snapshotSeq: 0 }, meta: { assistant: true, cliArgs: ['x'.repeat(96_000)] } };
        registry.restoreSession(record); registry.restoreSession({ ...record, sessionId: 'stopped', lifecycle: 'stopped' });
        const all = registry.listSessionSummaries();
        expect(JSON.stringify(all).length).toBeLessThan(2000);
        expect(all[0].launchCommand).toEqual({ command: 'codex', args: [] });
        expect(registry.listSessionSummaries(true).map(r => r.sessionId)).toEqual(['live']);
        expect(registry.getSession('live')?.launchCommand.args[1]).toHaveLength(96_000);
    });
});
