import { describe, expect, it } from 'vitest';
import {
    MESH_JOIN_HTTP_PATH,
    MESH_RPC_WS_PATH,
    MESH_SEQSCRIBE_WS_PATH,
    meshHostHttpUrl,
    meshHostWsUrl,
    parseMeshHostAddress,
    computeMeshHostAddressCandidates,
} from '../../src/shared/mesh-host-endpoints.js';
import { normalizeStandaloneHostJoinUrl } from '../../src/commands/med-family/mesh-host-pairing.js';
import { meshWsUrlForHostAddress, WS_MESH_RPC_PATH } from '../../src/mesh/transport/ws-mesh-transport.js';
import { STANDALONE_MESH_SEQSCRIBE_WS_PATH } from '../../src/seqscribe/standalone-mesh-seqscribe.js';

describe('mesh host endpoints — one source for paths', () => {
    it('every module re-exports the shared path constants', () => {
        expect(MESH_RPC_WS_PATH).toBe('/ws/mesh');
        expect(MESH_SEQSCRIBE_WS_PATH).toBe('/ws/mesh-seqscribe');
        expect(MESH_JOIN_HTTP_PATH).toBe('/api/v1/mesh/join');
        expect(WS_MESH_RPC_PATH).toBe(MESH_RPC_WS_PATH);
        expect(STANDALONE_MESH_SEQSCRIBE_WS_PATH).toBe(MESH_SEQSCRIBE_WS_PATH);
    });
});

describe('parseMeshHostAddress / join + dial URLs', () => {
    const cases: Array<[string, string, string]> = [
        // [input, HTTP join URL, WS rpc URL]
        ['192.168.1.5:3847', 'http://192.168.1.5:3847/api/v1/mesh/join', 'ws://192.168.1.5:3847/ws/mesh'],
        ['100.64.1.2:3847', 'http://100.64.1.2:3847/api/v1/mesh/join', 'ws://100.64.1.2:3847/ws/mesh'],
        ['myhost:3847', 'http://myhost:3847/api/v1/mesh/join', 'ws://myhost:3847/ws/mesh'],
        ['host.tail.ts.net:3847', 'http://host.tail.ts.net:3847/api/v1/mesh/join', 'ws://host.tail.ts.net:3847/ws/mesh'],
        ['http://myhost:3847', 'http://myhost:3847/api/v1/mesh/join', 'ws://myhost:3847/ws/mesh'],
        ['http://myhost:3847/', 'http://myhost:3847/api/v1/mesh/join', 'ws://myhost:3847/ws/mesh'],
        ['  192.168.1.5:3847/  ', 'http://192.168.1.5:3847/api/v1/mesh/join', 'ws://192.168.1.5:3847/ws/mesh'],
        ['https://host.example', 'https://host.example/api/v1/mesh/join', 'wss://host.example/ws/mesh'],
        ['https://user:pw@host.example:8443/dash?x=1#y', 'https://host.example:8443/api/v1/mesh/join', 'wss://host.example:8443/ws/mesh'],
        ['wss://host.example/', 'https://host.example/api/v1/mesh/join', 'wss://host.example/ws/mesh'],
        ['ws://10.0.0.2:3847/ws?x=1', 'http://10.0.0.2:3847/api/v1/mesh/join', 'ws://10.0.0.2:3847/ws/mesh'],
        ['[::1]:3847', 'http://[::1]:3847/api/v1/mesh/join', 'ws://[::1]:3847/ws/mesh'],
        ['fd7a:115c::1', 'http://[fd7a:115c::1]/api/v1/mesh/join', 'ws://[fd7a:115c::1]/ws/mesh'],
        ['https://h:80', 'https://h:80/api/v1/mesh/join', 'wss://h:80/ws/mesh'],
    ];

    it.each(cases)('%s', (input, join, ws) => {
        expect(normalizeStandaloneHostJoinUrl(input)).toBe(join);
        expect(meshHostHttpUrl(input, MESH_JOIN_HTTP_PATH)).toBe(join);
        expect(meshWsUrlForHostAddress(input)).toBe(ws);
        expect(meshHostWsUrl(input, MESH_RPC_WS_PATH)).toBe(ws);
    });

    it('maps the scheme to secure / insecure', () => {
        expect(parseMeshHostAddress('https://h:1').secure).toBe(true);
        expect(parseMeshHostAddress('wss://h:1').secure).toBe(true);
        expect(parseMeshHostAddress('http://h:1').secure).toBe(false);
        expect(parseMeshHostAddress('h:1').secure).toBe(false);
    });

    it.each([
        ['', /hostAddress required/],
        ['   ', /hostAddress required/],
        ['ftp://host:21', /unsupported/],
        ['javascript://x', /unsupported/],
        ['host:99999', /invalid/],
        ['host name:3847', /invalid/],
        ['http://', /invalid/],
        ['[::1', /invalid/],
    ])('rejects %j', (input, error) => {
        expect(() => normalizeStandaloneHostJoinUrl(input)).toThrow(error);
        expect(() => meshWsUrlForHostAddress(input)).toThrow(error);
    });
});

describe('computeMeshHostAddressCandidates', () => {
    const interfaces = {
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
        en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
        utun4: [{ address: '100.101.2.3', family: 'IPv4', internal: false }],
        cgnatButNotTailscale: [{ address: '100.10.0.1', family: 4, internal: false }],
        dup: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
    };

    it('wildcard bind: non-internal IPv4, Tailscale first, then LAN, de-duplicated', () => {
        expect(computeMeshHostAddressCandidates({ host: '0.0.0.0', port: 3847 }, interfaces)).toEqual({
            addressCandidates: ['100.101.2.3:3847', '192.168.1.5:3847', '100.10.0.1:3847'],
        });
        expect(computeMeshHostAddressCandidates({ host: '::', port: 4000 }, interfaces).addressCandidates[0]).toBe('100.101.2.3:4000');
    });

    it('loopback bind: no candidates and a loopback_only warning', () => {
        for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
            expect(computeMeshHostAddressCandidates({ host, port: 3847 }, interfaces)).toEqual({ addressCandidates: [], bindWarning: 'loopback_only' });
        }
    });

    it('specific bind address: only that address', () => {
        expect(computeMeshHostAddressCandidates({ host: '100.101.2.3', port: 3847 }, interfaces)).toEqual({ addressCandidates: ['100.101.2.3:3847'] });
        expect(computeMeshHostAddressCandidates({ host: 'fd7a::1', port: 3847 }, interfaces)).toEqual({ addressCandidates: ['[fd7a::1]:3847'] });
    });

    it('invalid port: nothing', () => {
        expect(computeMeshHostAddressCandidates({ host: '0.0.0.0', port: 0 }, interfaces)).toEqual({ addressCandidates: [] });
    });
});
