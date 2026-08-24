import { describe, expect, it } from 'vitest';
import { buildIpcStatusHttpResponse, type IpcStatusPayload } from '../../src/ipc/local-ipc-server.js';

// IPC HTTP ROUTE TABLE — must serve the upgrade version gate.
//
// windows-atomic-upgrade.ts fetchLocalStatusVersion() probes
// `GET /api/v1/status` and reads `payload.status.version` to decide whether the
// restarted daemon actually came up on the new version. The core IPC server
// used to serve only `/`, `/status` and `/health`, so the standalone daemon's
// self-upgrade version gate 404'd against core's own IPC surface. The route
// table now mirrors the cloud daemon responder: `/`, `/status`, `/health`,
// `/api/v1/status`, `/api/status` — query strings ignored.

function payload(version?: string): IpcStatusPayload {
    return {
        ok: true,
        pid: 4242,
        wsPath: '/ipc',
        port: 19222,
        status: version ? { version, sessions: [] } : null,
    };
}

describe('buildIpcStatusHttpResponse route table', () => {
    it.each(['/', '/status', '/health', '/api/v1/status', '/api/status'])(
        'serves 200 on %s',
        (route) => {
            const res = buildIpcStatusHttpResponse('GET', route, payload('1.2.3'));
            expect(res.statusCode).toBe(200);
            expect(res.body.ok).toBe(true);
        },
    );

    it('exposes status.version on /api/v1/status exactly as the upgrade gate reads it', () => {
        const res = buildIpcStatusHttpResponse('GET', '/api/v1/status', payload('1.2.3'));
        expect(res.statusCode).toBe(200);
        // Mirror of fetchLocalStatusVersion's parse: JSON body → status.version.
        const body = JSON.parse(JSON.stringify(res.body)) as { status?: { version?: unknown } };
        expect(body.status?.version).toBe('1.2.3');
    });

    it('ignores query strings when matching routes', () => {
        const res = buildIpcStatusHttpResponse('GET', '/api/v1/status?probe=1', payload('1.2.3'));
        expect(res.statusCode).toBe(200);
        expect((res.body as any).status?.version).toBe('1.2.3');
    });

    it('still 404s unknown paths', () => {
        const res = buildIpcStatusHttpResponse('GET', '/api/v1/other', payload('1.2.3'));
        expect(res.statusCode).toBe(404);
        expect(res.body.ok).toBe(false);
    });

    it('still 405s non-GET methods', () => {
        const res = buildIpcStatusHttpResponse('POST', '/api/v1/status', payload('1.2.3'));
        expect(res.statusCode).toBe(405);
    });

    it('keeps the legacy `/` and `/status` shape (backward compatibility)', () => {
        for (const route of ['/', '/status']) {
            const res = buildIpcStatusHttpResponse('GET', route, payload('1.2.3'));
            expect(res.statusCode).toBe(200);
            expect(res.body.pid).toBe(4242);
            expect(res.body.wsPath).toBe('/ipc');
        }
    });
});
