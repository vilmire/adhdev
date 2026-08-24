import { describe, expect, it, vi } from 'vitest';

// PROVIDER UPDATE CHECK — read-only, and about the RIGHT version.
//
// `check_provider_updates` used to end by calling syncVerifiedChannel(), i.e.
// it downloaded, verified AND ACTIVATED. Standalone exposes it at
// `GET /api/v1/providers/updates`, so a plain GET moved the pointer and
// changed which provider spec the daemon loads.
//
// It also compared the wrong number: `.upstream` holds the installed manifest
// but the daemon loads the PINNED store object, and those diverge by design
// (the pin only advances on an explicit activation). With `.upstream` at 1.0.3
// and the pin at 1.0.0 it reported "up to date" while the daemon ran the older
// spec — which is how a shipped kimi resume fix stayed invisible for a day.
//
// Activation now lives in `activate_provider_updates`.

function makeHandler(pins: Map<string, any>, onSync: () => void) {
    const loader = {
        listVerifiedChannelPins: () => pins,
        syncVerifiedChannel: async () => { onSync(); return { activated: [] }; },
        rollbackVerifiedChannel: (_t: string) => 'sha256:previous',
    };
    return { loader };
}

function pin(active: string, previous?: string) {
    return {
        version: 1,
        active: {
            providerType: 'kimi', providerVersion: active, category: 'cli',
            digest: `sha256:${active}`, digestAlgorithm: 'adhdev-provider-tree-sha256-v1',
            activatedAt: '2026-08-05T06:58:32.933Z',
        },
        previous: previous
            ? { providerType: 'kimi', providerVersion: previous, category: 'cli', digest: `sha256:${previous}`, digestAlgorithm: 'x', activatedAt: '2026-07-27T18:09:23.232Z' }
            : null,
    };
}

describe('provider pin reporting', () => {
    it('reports the PIN, not the .upstream manifest', () => {
        // The exact divergence that hid the kimi fix.
        const pins = new Map([['kimi', pin('1.0.3', '1.0.0')]]);
        const upstreamVersion = '1.0.0';

        const active = pins.get('kimi')!.active.providerVersion;
        expect(active).toBe('1.0.3');
        expect(active).not.toBe(upstreamVersion);

        // Staleness is pin-vs-registry. Comparing `.upstream` (1.0.0) against a
        // registry at 1.0.3 would claim an update is needed when the daemon is
        // already running it — and the reverse case hides a real gap.
        expect('1.0.3' !== active).toBe(false);
        expect('1.0.3' !== upstreamVersion).toBe(true);
    });

    it('exposes the observability fields the dashboard needs', () => {
        const p = pin('1.0.3', '1.0.0');
        expect(p.active.digest).toMatch(/^sha256:/);
        expect(p.active.activatedAt).toBeTruthy();
        expect(p.previous?.providerVersion).toBe('1.0.0');
    });

    it('rollback needs no network: the previous object is already local', () => {
        const pins = new Map([['kimi', pin('1.0.3', '1.0.0')]]);
        const { loader } = makeHandler(pins, () => { throw new Error('sync must not run for rollback'); });
        // A rollback target exists purely from the local pointer.
        expect(loader.rollbackVerifiedChannel('kimi')).toBe('sha256:previous');
    });
});

describe('check vs activate separation', () => {
    it('a check must not trigger a channel sync', async () => {
        const sync = vi.fn();
        const { loader } = makeHandler(new Map([['kimi', pin('1.0.3')]]), sync);

        // A read path touches only the pin listing.
        loader.listVerifiedChannelPins();
        expect(sync).not.toHaveBeenCalled();
    });

    it('activation is the only thing that syncs', async () => {
        const sync = vi.fn();
        const { loader } = makeHandler(new Map([['kimi', pin('1.0.3')]]), sync);
        await loader.syncVerifiedChannel();
        expect(sync).toHaveBeenCalledTimes(1);
    });
});

// The tests above pin the SHAPE. This one drives the real handler, which is
// what would actually have caught the defect: a stub loader whose
// syncVerifiedChannel() fails the test if the read path ever calls it.
describe('handleCheckProviderUpdates (real handler)', () => {
    async function runCheck(loaderExtras: Record<string, unknown> = {}) {
        const { DaemonCommandHandler } = await import('../../src/commands/handler.js');
        const syncSpy = vi.fn(async () => ({ activated: [] }));
        const handler = new DaemonCommandHandler({
            providerLoader: {
                // Two installed providers, one of them pinned BELOW its
                // .upstream manifest — the kimi situation exactly.
                listVerifiedChannelPins: () => new Map([['kimi', pin('1.0.3', '1.0.0')]]),
                syncVerifiedChannel: syncSpy,
                ...loaderExtras,
            },
        } as any);
        // list_installed_providers reads real dirs; stub it so the test is
        // about the pin logic rather than this machine's provider directory.
        (handler as any).handleListInstalledProviders = () => ({
            success: true,
            providers: [{ type: 'kimi', category: 'cli', version: '1.0.0' }],
        });
        const result: any = await (handler as any).handleCheckProviderUpdates({});
        return { result, syncSpy };
    }

    it('never activates, and reports the pin over the .upstream version', async () => {
        const { result, syncSpy } = await runCheck();

        // THE regression: a command named `check`, reachable over GET, must
        // not move the pointer.
        expect(syncSpy).not.toHaveBeenCalled();
        expect(result.channelSync).toBeNull();

        const kimi = result.providers.find((p: any) => p.type === 'kimi');
        expect(kimi.activeVersion).toBe('1.0.3');     // what the daemon runs
        expect(kimi.upstreamVersion).toBe('1.0.0');   // what sits on disk
        expect(kimi.installedVersion).toBe('1.0.3');  // alias of the pin
        expect(kimi.activatedAt).toBe('2026-08-05T06:58:32.933Z');
        expect(kimi.previousVersion).toBe('1.0.0');
        expect(kimi.digest).toBe('sha256:1.0.3');
    }, 30000);

    // CHANNEL-AWARE STALENESS: the registry serves per-channel rows, and the
    // loader pins from ITS channel (channel/runtime.ts sends ?channel= on the
    // listing). The per-type staleness fetch omitted the query, so a daemon on
    // the preview provider channel compared its preview pin against the STABLE
    // row and mis-reported staleness in both directions.
    it('sends the loader channel as ?channel= on the registry staleness fetch', async () => {
        const https = await import('node:https');
        const urls: string[] = [];
        const getSpy = vi.spyOn(https.default, 'get').mockImplementation(((url: any) => {
            urls.push(String(url));
            const { EventEmitter } = require('node:events');
            const req = new EventEmitter();
            (req as any).destroy = () => {};
            setImmediate(() => req.emit('error', new Error('offline')));
            return req;
        }) as any);
        try {
            const { result } = await runCheck({ channel: 'preview' });
            expect(result.success).toBe(true);
            const kimiUrl = urls.find((u) => u.includes('/providers/kimi'));
            expect(kimiUrl).toBeTruthy();
            expect(kimiUrl).toContain('?channel=preview');
        } finally {
            getSpy.mockRestore();
        }
    }, 30000);
});
