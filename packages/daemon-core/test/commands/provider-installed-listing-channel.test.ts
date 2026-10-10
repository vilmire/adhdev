import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// CHANNEL-STORE INSTALLED LISTING (live, preview fleet 2026-10-10).
//
// `list_installed_providers` used to read ONLY `<config>/providers/.upstream`.
// A daemon that installs through the verified channel store (every fresh
// config since the store became the default) has an EMPTY `.upstream`, so the
// listing returned `providers: []` and `check_provider_updates` — which builds
// its rows from that listing — returned no rows either (measured on MainPC and
// MoltBook: `providers: []`). The Providers tab then had no pin for any row: no
// active version, no inline Update when the channel had a newer bundle, no
// rollback, and none of the new auto-update verdict lines. Standalone's
// first-run gate (`GET /api/v1/providers/installed`, "0 installed → onboarding")
// also read it as "nothing installed".
//
// The listing now merges both sources: `.upstream` rows stay exactly as they
// were (legacy daemons), and every verified-channel pin without an `.upstream`
// row is added from the pin itself.

const tmpDirs: string[] = [];
afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function pin(type: string, version: string, category = 'cli', previous?: string) {
    return {
        version: 1,
        active: {
            providerType: type, providerVersion: version, category,
            digest: `sha256:${type}-${version}`, digestAlgorithm: 'adhdev-provider-tree-sha256-v1',
            activatedAt: '2026-10-09T15:45:46.592Z',
        },
        previous: previous
            ? { providerType: type, providerVersion: previous, category, digest: `sha256:${type}-${previous}`, digestAlgorithm: 'x', activatedAt: '2026-10-09T08:47:26.423Z' }
            : null,
    };
}

function upstreamRoot(entries: Array<{ type: string; version: string; category?: string; modelOptions?: string[] }>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
    tmpDirs.push(root);
    for (const e of entries) {
        const dir = path.join(root, e.category ?? 'cli', e.type);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'provider.v1.json'), JSON.stringify({
            type: e.type, providerVersion: e.version, ...(e.modelOptions ? { modelOptions: e.modelOptions } : {}),
        }));
    }
    return root;
}

async function makeHandler(opts: {
    upstream: string;
    pins: Map<string, any>;
    meta?: Record<string, any>;
    autoUpdate?: any;
    channel?: string;
}) {
    const { DaemonCommandHandler } = await import('../../src/commands/handler.js');
    const handler = new DaemonCommandHandler({
        providerLoader: {
            channel: opts.channel ?? 'preview',
            listVerifiedChannelPins: () => opts.pins,
            getMeta: (type: string) => opts.meta?.[type],
            getAutoUpdateStatus: () => opts.autoUpdate ?? null,
            checkVerifiedChannelStaleness: async () => ({ channel: opts.channel ?? 'preview', staleTypes: [], newTypes: [] }),
            syncVerifiedChannel: async () => { throw new Error('a read path must not sync'); },
        },
    } as any);
    (handler as any).getUpstreamInstallRoot = () => opts.upstream;
    return handler as any;
}

const NO_UPSTREAM = path.join(os.tmpdir(), `no-upstream-${process.pid}-${Date.now()}`);

describe('check_provider_updates rows — channel store + .upstream merge', () => {
    async function rows(handler: any) {
        const https = await import('node:https');
        vi.spyOn(https.default, 'get').mockImplementation(((_url: any) => {
            const { EventEmitter } = require('node:events');
            const req = new EventEmitter();
            (req as any).destroy = () => {};
            setImmediate(() => req.emit('error', new Error('offline')));
            return req;
        }) as any);
        const res = await handler.handleCheckProviderUpdates({});
        expect(res.success).toBe(true);
        return Object.fromEntries(res.providers.map((p: any) => [p.type, p]));
    }

    it('channel-store only (.upstream absent): one row per pin, from the pin', async () => {
        const handler = await makeHandler({
            upstream: NO_UPSTREAM,
            pins: new Map([
                ['antigravity-cli', pin('antigravity-cli', '1.2.18')],
                ['claude-cli', pin('claude-cli', '1.2.15')],
                ['antigravity', pin('antigravity', '1.0.1', 'ide')],
            ]),
        });
        const byType = await rows(handler);
        expect(Object.keys(byType).sort()).toEqual(['antigravity', 'antigravity-cli', 'claude-cli']);
        expect(byType['antigravity-cli']).toMatchObject({ category: 'cli', activeVersion: '1.2.18', installedVersion: '1.2.18', upstreamVersion: '1.2.18' });
        expect(byType['antigravity']).toMatchObject({ category: 'ide', activeVersion: '1.0.1' });
    }, 30000);

    it('legacy only (no pins): rows come from .upstream exactly as before', async () => {
        const handler = await makeHandler({
            upstream: upstreamRoot([{ type: 'kimi', version: '1.0.0' }]),
            pins: new Map(),
        });
        const byType = await rows(handler);
        expect(Object.keys(byType)).toEqual(['kimi']);
        expect(byType.kimi).toMatchObject({ activeVersion: '1.0.0', upstreamVersion: '1.0.0', digest: null });
    }, 30000);

    it('mixed: an .upstream type keeps its row (pin wins activeVersion), pin-only types are added once', async () => {
        const handler = await makeHandler({
            upstream: upstreamRoot([{ type: 'kimi', version: '1.0.0' }]),
            pins: new Map([
                ['kimi', pin('kimi', '1.0.3', 'cli', '1.0.0')],
                ['codex-cli', pin('codex-cli', '1.1.28')],
            ]),
        });
        const res = await (async () => rows(handler))();
        expect(Object.keys(res).sort()).toEqual(['codex-cli', 'kimi']);
        expect(res.kimi).toMatchObject({ activeVersion: '1.0.3', upstreamVersion: '1.0.0', previousVersion: '1.0.0' });
        expect(res['codex-cli']).toMatchObject({ activeVersion: '1.1.28' });
    }, 30000);

    it('list_installed_providers itself stays .upstream-only (standalone onboarding gate reads it)', async () => {
        const handler = await makeHandler({
            upstream: NO_UPSTREAM,
            pins: new Map([['antigravity-cli', pin('antigravity-cli', '1.2.18')]]),
        });
        expect(handler.handleListInstalledProviders({})).toEqual({ success: true, providers: [] });
    }, 30000);
});

describe('check_provider_updates — rows on a channel-store daemon', () => {
    function mockRegistry(latest: Record<string, string | Error>) {
        return import('node:https').then((https) => vi.spyOn(https.default, 'get').mockImplementation(((url: any, _opts: any, cb: any) => {
            const { EventEmitter } = require('node:events');
            const req = new EventEmitter();
            (req as any).destroy = () => {};
            const type = decodeURIComponent(String(url).split('/providers/')[1]?.split('?')[0] ?? '');
            const v = latest[type];
            setImmediate(() => {
                if (v === undefined || v instanceof Error) { req.emit('error', v ?? new Error('offline')); return; }
                const res = new EventEmitter() as any;
                res.statusCode = 200;
                cb(res);
                res.emit('data', Buffer.from(JSON.stringify({ version: v })));
                res.emit('end');
            });
            return req;
        }) as any));
    }

    it('channel-store only: every pin is a row with updateAvailable and its auto-update verdict', async () => {
        await mockRegistry({ 'antigravity-cli': '1.2.19', 'claude-cli': '1.2.15' });
        const handler = await makeHandler({
            upstream: NO_UPSTREAM,
            pins: new Map([
                ['antigravity-cli', pin('antigravity-cli', '1.2.18', 'cli', '1.2.17')],
                ['claude-cli', pin('claude-cli', '1.2.15')],
            ]),
            autoUpdate: {
                enabled: true,
                lastRunAt: '2026-10-10T01:17:14.072Z',
                types: {
                    'antigravity-cli': { state: 'updated', from: '1.2.17', to: '1.2.18', at: '2026-10-10T01:17:14.072Z' },
                    'claude-cli': { state: 'blocked', to: '1.2.16', reason: 'rollback', code: 'ROLLBACK_PINNED' },
                },
            },
        });
        const res = await handler.handleCheckProviderUpdates({});
        expect(res.success).toBe(true);
        const byType = Object.fromEntries(res.providers.map((p: any) => [p.type, p]));
        expect(Object.keys(byType).sort()).toEqual(['antigravity-cli', 'claude-cli']);
        expect(byType['antigravity-cli']).toMatchObject({
            activeVersion: '1.2.18', latestVersion: '1.2.19', updateAvailable: true, stale: true,
            previousVersion: '1.2.17', digest: 'sha256:antigravity-cli-1.2.18',
        });
        expect(byType['antigravity-cli'].autoUpdate).toMatchObject({ state: 'updated', from: '1.2.17', to: '1.2.18' });
        expect(byType['claude-cli']).toMatchObject({ activeVersion: '1.2.15', updateAvailable: false });
        expect(byType['claude-cli'].autoUpdate).toMatchObject({ state: 'blocked' });
        expect(res.autoUpdate).toMatchObject({ enabled: true, lastRunAt: '2026-10-10T01:17:14.072Z' });
    }, 30000);

    it('a row whose registry read fails falls back to the staleness listing for updateAvailable', async () => {
        await mockRegistry({ 'antigravity-cli': new Error('offline') });
        const handler = await makeHandler({
            upstream: NO_UPSTREAM,
            pins: new Map([['antigravity-cli', pin('antigravity-cli', '1.2.18')]]),
        });
        handler._ctx.providerLoader.checkVerifiedChannelStaleness = async () => ({ channel: 'preview', staleTypes: ['antigravity-cli'], newTypes: [] });
        const res = await handler.handleCheckProviderUpdates({});
        const row = res.providers.find((p: any) => p.type === 'antigravity-cli');
        expect(row.latestVersion).toBeNull();
        expect(row.error).toBeTruthy();
        expect(row.updateAvailable).toBe(true);
        expect(row.stale).toBe(true);
    }, 30000);
});
