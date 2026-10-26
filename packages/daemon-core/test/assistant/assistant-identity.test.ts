import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionHostClient, getDefaultSessionHostEndpoint, resolveSessionHostIpcKey } from '@adhdev/session-host-core';
import { persistedAssistantRuntimeIds } from '../../src/assistant/assistant-identity.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'assistant-evidence-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function seed(id: string, assistant = true, snapshot = '{}') {
    const record = { sessionId: id, providerType: 'claude-cli', category: 'cli', lifecycle: 'running',
        meta: { assistant }, launchCommand: { args: ['quoted " { } \\ text'] } };
    const runtimes = join(dir, 'session-host', 'foreign', 'runtimes');
    mkdirSync(runtimes, { recursive: true });
    writeFileSync(join(runtimes, `${id}.json`), `{"record":${JSON.stringify(record)},"snapshot":${snapshot}}`);
    return record;
}
function host(sessions: any[], extra = {}) {
    const endpoint = getDefaultSessionHostEndpoint('foreign', { ipcKey: resolveSessionHostIpcKey(dir) });
    return vi.spyOn(SessionHostClient.prototype, 'request').mockResolvedValue({ success: true, result: {
        endpoint: endpoint.path, hostStartedAt: 1, hostEntryPath: '/opt/adhdev/session-host-daemon/dist/index.js', sessions, ...extra,
    } });
}
const scan = (options: Partial<Parameters<typeof persistedAssistantRuntimeIds>[1]> = {}) =>
    persistedAssistantRuntimeIds(dir, { ipcKey: resolveSessionHostIpcKey(dir), ...options });

it('checks provenance before probing, and verifies a namespace only once for multiple assistants', async () => {
    const one = seed('one'), two = seed('two');
    seed('ordinary', false);
    const request = host([one, two]);
    expect(await scan()).toEqual(new Set(['one', 'two']));
    expect(request).toHaveBeenCalledTimes(1);
});

it('does not probe a namespace containing only ordinary sessions', async () => {
    seed('ordinary', false);
    const request = host([]);
    expect(await scan()).toEqual(new Set());
    expect(request).not.toHaveBeenCalled();
});

it('reads bounded metadata without parsing a large or torn terminal snapshot', async () => {
    const record = seed('one', true, '"' + 'scrollback'.repeat(300_000));
    host([record]);
    expect(await scan()).toEqual(new Set(['one']));
});

it('never bypasses unverifiable identity even for a trusted owner', async () => {
    seed('stale');
    writeFileSync(join(dir, 'foreign-session-host.pid'), String(process.pid));
    host([], { hostEntryPath: '/opt/unrelated/index.js' });
    expect(await scan()).toEqual(new Set(['stale']));
    const audit = vi.fn();
    expect(await scan({ allowUnverified: true, onUnverified: audit })).toEqual(new Set(['stale']));
    expect(audit).toHaveBeenCalledWith('foreign');
});

it.each(['/opt/adhdev/session-host-daemon/dist/index.js', 'C:\\Apps\\adhdev\\session-host-daemon\\dist\\index.js'])('never bypasses RPC-verified live assistants from %s, even with owner override', async hostEntryPath => {
    const record = seed('live');
    host([record], { hostEntryPath });
    expect(await scan({ allowUnverified: true })).toEqual(new Set(['live']));
});

it('uses a verified empty census to dismiss a stale runtime even when both stored PIDs are reused', async () => {
    seed('stale');
    writeFileSync(join(dir, 'foreign-session-host.pid'), String(process.pid));
    host([]);
    expect(await scan()).toEqual(new Set());
});

it('bounds an unresponsive host probe, retaining uncertainty even for owner force', async () => {
    seed('stale');
    vi.spyOn(SessionHostClient.prototype, 'request').mockImplementation(() => new Promise(() => {}));
    expect(await scan()).toEqual(new Set(['stale']));
    expect(await scan({ allowUnverified: true })).toEqual(new Set(['stale']));
});

it('ignores unrelated test and other-track namespaces, reporting exact conflict provenance', async () => {
    seed('uncertain');
    const root = join(dir, 'session-host');
    for (const ns of ['adhdev-test-term-once', 'adhdev-input-ann-42', 'adhdev']) {
        mkdirSync(join(root, ns, 'runtimes'), { recursive: true });
        writeFileSync(join(root, ns, 'test.json'), '{broken');
    }
    host([], { hostEntryPath: '/opt/unrelated/index.js' });
    const evidence = vi.fn();
    expect(await scan({ currentNamespace: 'adhdev-preview', onConflictEvidence: evidence })).toEqual(new Set(['uncertain']));
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'foreign', sessionId: 'uncertain', reason: expect.stringContaining('unverifiable') }));
});
