import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { LaunchDefaultsStore, type LaunchDefaultsDocument, type LaunchDefaultsWrite,
    type LaunchDefaultsWriteResult, type LaunchValidationPorts } from '../../src/launch-defaults/index.js';

// Real fixture files with only failure boundaries mocked. No daemon config paths.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync),
        fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const native = await vi.importActual<typeof import('node:fs')>('node:fs');
const ports: LaunchValidationPorts = {
    resolveAlias: value => value === 'claude' ? 'claude-cli' : value,
    getProvider: type => type === 'claude-cli' ? {
        type, category: 'cli', enabled: true, detected: true,
        assistant: { supported: true, toolRestriction: 'enforced' }, coordinator: 'supported',
        modelLaunchArgs: ['--model', '{{model}}'], thinkingLaunchArgs: ['--effort', '{{level}}'],
        thinkingLevelOptions: ['low', 'high'],
    } : undefined,
};
let dir: string;
let store: LaunchDefaultsStore;
function request(overrides: Partial<LaunchDefaultsWrite> = {}): LaunchDefaultsWrite {
    return { role: 'assistant', selection: { provider: 'claude-cli' }, expectedRevision: 0,
        by: 'owner', origin: 'owner', ...overrides };
}
function saved(overrides: Partial<LaunchDefaultsWrite> = {}) {
    const result = store.write(request(overrides));
    expect(result).toMatchObject({ ok: true, durable: true });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
}
function document(): LaunchDefaultsDocument {
    const result = store.read();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    return result.document;
}
beforeEach(() => {
    vi.mocked(fs.readFileSync).mockImplementation(native.readFileSync);
    vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);
    vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
    dir = fs.mkdtempSync(join(tmpdir(), 'launch-defaults-store-'));
    store = new LaunchDefaultsStore(join(dir, 'config'), ports);
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('launch defaults disk schema and explicit writes', () => {
    it('does not create a config directory or default on construction/read', () => {
        expect(store.read().status).toBe('missing');
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('explicitly bootstraps, canonicalizes and persists a 0600 versioned document', () => {
        const result = saved({ selection: { provider: 'claude', model: 'opus', thinkingLevel: 'high' } });
        expect(result.previous).toBeNull();
        expect(result.document).toMatchObject({ version: 1, revision: 1,
            assistant: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high',
                revision: 1, setBy: 'owner', setAt: expect.any(Number) },
            history: [{ role: 'assistant', by: 'owner', origin: 'owner', from: null, to: result.document.assistant }] });
        expect(JSON.parse(fs.readFileSync(store.path, 'utf8'))).toEqual(result.document);
        expect(new LaunchDefaultsStore(join(dir, 'config'), ports).read()).toEqual({ status: 'ok', document: result.document });
        if (process.platform !== 'win32') expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(join(dir, 'config'))).toEqual(['launch-defaults.json']);
    });
    it.each([
        ['unknown provider', { provider: 'missing-cli' }, 'provider_unknown'],
        ['unknown field', { provider: 'claude-cli', approvalMode: 'auto' }, 'invalid_schema'],
        ['blank model', { provider: 'claude-cli', model: '' }, 'invalid_schema'],
        ['null thinking', { provider: 'claude-cli', thinkingLevel: null }, 'invalid_schema'],
    ])('refuses %s without persisting', (_name, selection, reason) => {
        expect(store.write(request({ selection: selection as LaunchDefaultsWrite['selection'] })))
            .toMatchObject({ ok: false, code: 'launch_default_invalid', reason, committed: false });
        expect(store.read().status).toBe('missing');
        expect(fs.readdirSync(join(dir, 'config'))).toEqual([]);
    });
    it.each([
        { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: undefined },
        { role: 'worker' }, { by: 'browser' }, { origin: 'unknown' }, { approvalMode: true },
    ])('rejects malformed write metadata %j before creating state', patch => {
        expect(store.write({ ...request(), ...patch } as LaunchDefaultsWrite))
            .toMatchObject({ ok: false, code: 'invalid_args', committed: false });
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it.each([
        ['invalid JSON', '{truncated', 'launch_defaults_json_invalid'],
        ['unknown version', JSON.stringify({ version: 2, revision: 1, history: [] }), 'launch_defaults_schema_invalid'],
        ['unknown root key', JSON.stringify({ version: 1, revision: 1, history: [], fallback: 'claude-cli' }), 'launch_defaults_schema_invalid'],
        ['null entry', JSON.stringify({ version: 1, revision: 1, history: [], assistant: null }), 'launch_defaults_schema_invalid'],
    ])('preserves %s evidence across reads and rejected writes', (_name, bytes, reason) => {
        fs.mkdirSync(join(dir, 'config'));
        fs.writeFileSync(store.path, bytes);
        expect(store.read()).toEqual({ status: 'invalid', reason });
        expect(store.write(request())).toMatchObject({ ok: false, code: 'store_unavailable', reason, committed: false });
        expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
        expect(fs.readdirSync(join(dir, 'config'))).toEqual(['launch-defaults.json']);
    });
    it.each([
        ['future entry revision', (d: LaunchDefaultsDocument) => { d.assistant!.revision = 2; }],
        ['unknown entry key', (d: LaunchDefaultsDocument) => { Object.assign(d.assistant!, { cliType: 'claude-cli' }); }],
        ['negative timestamp', (d: LaunchDefaultsDocument) => { d.assistant!.setAt = -1; }],
        ['invalid history origin', (d: LaunchDefaultsDocument) => { Object.assign(d.history[0], { origin: 'browser' }); }],
        ['missing history endpoint', (d: LaunchDefaultsDocument) => { Reflect.deleteProperty(d.history[0], 'from'); }],
        ['oversized history', (d: LaunchDefaultsDocument) => { d.history = Array(21).fill(d.history[0]); }],
    ])('rejects %s in an otherwise valid document', (_name, mutate) => {
        const d = saved().document;
        mutate(d);
        const bytes = JSON.stringify(d);
        fs.writeFileSync(store.path, bytes);
        expect(store.read()).toEqual({ status: 'invalid', reason: 'launch_defaults_schema_invalid' });
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'store_unavailable', committed: false });
        expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
    });
    it('reports unreadable state distinctly and does not overwrite it', () => {
        saved();
        const before = fs.readFileSync(store.path);
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
        expect(store.read()).toEqual({ status: 'unreadable', reason: 'launch_defaults_read_failed' });
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'store_unavailable', committed: false });
        expect(native.readFileSync(store.path)).toEqual(before);
    });
});

describe('document CAS and history', () => {
    it('rejects stale writes across instances and roles without changing bytes', () => {
        saved();
        const bytes = fs.readFileSync(store.path);
        const peer = new LaunchDefaultsStore(join(dir, 'config'), ports);
        expect(peer.write(request({ role: 'coordinator' }))).toEqual({ ok: false, code: 'revision_conflict',
            reason: 'document_revision_changed', actualRevision: 1, committed: false });
        expect(fs.readFileSync(store.path)).toEqual(bytes);
        saved({ role: 'coordinator', expectedRevision: 1 });
        expect(document()).toMatchObject({ revision: 2, assistant: { revision: 1 }, coordinator: { revision: 2 } });
    });
    it('clears advance the document token and cannot revive a stale pre-clear edit', () => {
        const initial = saved().document.assistant;
        const cleared = saved({ selection: null, expectedRevision: 1 });
        expect(cleared.previous).toEqual(initial);
        expect(cleared.document).not.toHaveProperty('assistant');
        expect(cleared.document).toMatchObject({ revision: 2,
            history: [expect.anything(), { role: 'assistant', from: initial, to: null }] });
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(store.write(request())).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(saved({ expectedRevision: 2 }).document.assistant?.revision).toBe(3);
    });
    it('replaces the entire role triple while preserving the other role', () => {
        const assistant = saved({ selection: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' } }).document.assistant;
        saved({ role: 'coordinator', expectedRevision: 1, selection: { provider: 'claude-cli', model: 'sonnet' } });
        saved({ role: 'coordinator', expectedRevision: 2, by: 'assistant', origin: 'human' });
        expect(document()).toMatchObject({ revision: 3, assistant,
            coordinator: { provider: 'claude-cli', revision: 3, setBy: 'assistant' } });
        expect(document().coordinator).not.toHaveProperty('model');
        expect(document().coordinator).not.toHaveProperty('thinkingLevel');
    });
    it('retains the last 20 transitions without resetting revisions', () => {
        for (let rev = 0; rev < 24; rev++) saved({ expectedRevision: rev,
            selection: rev % 2 ? null : { provider: 'claude-cli' } });
        const d = document();
        expect(d.revision).toBe(24);
        expect(d.history).toHaveLength(20);
        expect(d.history[0]).toMatchObject({ from: null, to: { revision: 5 } });
        expect(d.history.at(-1)).toMatchObject({ from: { revision: 23 }, to: null });
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'revision_conflict', actualRevision: 24 });
    });
    it('does not silently break an abandoned lock; explicit recovery permits CAS', () => {
        saved();
        const bytes = fs.readFileSync(store.path);
        fs.mkdirSync(`${store.path}.lock`);
        const old = new Date(0);
        fs.utimesSync(`${store.path}.lock`, old, old);
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'store_busy', committed: false });
        expect(fs.readFileSync(store.path)).toEqual(bytes);
        expect(store.read().status).toBe('ok');
        fs.rmdirSync(`${store.path}.lock`);
        expect(saved({ expectedRevision: 1 }).document.revision).toBe(2);
    });
    it('allows exactly one replacement from concurrent processes sharing a CAS token', async () => {
        const tsx = createRequire(import.meta.url).resolve('tsx/cli');
        const modulePath = fileURLToPath(new URL('../../src/launch-defaults/index.ts', import.meta.url));
        const childPath = join(dir, 'writer.ts');
        fs.writeFileSync(childPath, `
            import { LaunchDefaultsStore } from ${JSON.stringify(modulePath)};
            const ports = { resolveAlias: p => p, getProvider: type => ({ type, category: 'cli',
                enabled: true, detected: true, assistant: { supported: true, toolRestriction: 'enforced' }, coordinator: 'supported' }) };
            const store = new LaunchDefaultsStore(${JSON.stringify(join(dir, 'config'))}, ports);
            process.stdin.once('data', () => {
                console.log(JSON.stringify(store.write({role: process.argv[2], selection: {provider:'claude-cli'},
                    expectedRevision:0, by:'owner', origin:'owner'})));
                process.stdin.destroy();
            });
            console.log('ready');
        `);
        const children = ['assistant', 'coordinator'].map(role =>
            spawn(process.execPath, [tsx, childPath, role], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
        try {
            let readyCount = 0;
            const results = await Promise.all(children.map(child => new Promise<LaunchDefaultsWriteResult>((resolve, reject) => {
                let out = '', err = '', ready = false;
                const deadline = setTimeout(() => { child.kill(); reject(new Error(`child timeout: ${out} ${err}`)); }, 15_000);
                child.stderr.on('data', chunk => { err += chunk; });
                child.stdout.on('data', chunk => {
                    out += chunk;
                    if (!ready && out.includes('ready\n')) {
                        ready = true;
                        if (++readyCount === children.length) children.forEach(c => c.stdin.end('write\n'));
                    }
                });
                child.on('error', error => { clearTimeout(deadline); reject(error); });
                child.on('close', code => {
                    clearTimeout(deadline);
                    if (code !== 0) return reject(new Error(`child exit ${code}: ${err} ${out}`));
                    try { resolve(JSON.parse(out.trim().split('\n').at(-1)!)); } catch (error) { reject(error); }
                });
            })));
            expect(results.filter(result => result.ok)).toHaveLength(1);
            const loser = results.find(result => !result.ok);
            expect(loser).toMatchObject({ ok: false, committed: false });
            if (!loser || loser.ok) throw new Error('expected one CAS loser');
            expect(['revision_conflict', 'store_busy']).toContain(loser.code);
            const winner = results.find(result => result.ok);
            if (!winner?.ok) throw new Error('expected one durable writer');
            expect(document()).toEqual(winner.document);
            expect(document().revision).toBe(1);
            expect(document().history).toHaveLength(1);
            expect(fs.readdirSync(join(dir, 'config'))).toEqual(['launch-defaults.json']);
        } finally {
            children.forEach(child => { if (child.exitCode === null) child.kill(); });
        }
    }, 20_000);
});

describe('atomic replacement and durability outcomes', () => {
    it.each(['file fsync', 'rename'])('keeps old bytes and revision when %s fails before replacement', boundary => {
        saved();
        const bytes = fs.readFileSync(store.path);
        const fail = () => { throw Object.assign(new Error('injected failure'), { code: 'EIO' }); };
        if (boundary === 'file fsync') vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
        else vi.mocked(fs.renameSync).mockImplementationOnce(fail);
        expect(store.write(request({ expectedRevision: 1 }))).toEqual({ ok: false, code: 'persistence_failed',
            reason: 'atomic_replace_failed', committed: false });
        expect(fs.readFileSync(store.path)).toEqual(bytes);
        expect(document().revision).toBe(1);
        expect(fs.readdirSync(join(dir, 'config'))).toEqual(['launch-defaults.json']);
        expect(saved({ expectedRevision: 1 }).document.revision).toBe(2);
    });
    it('reports replacement without claiming durability when directory fsync is unsupported', () => {
        saved();
        const bytes = fs.readFileSync(store.path);
        vi.mocked(fs.fsyncSync).mockImplementation(fd => {
            if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported directory fsync'), { code: 'EINVAL' });
            native.fsyncSync(fd);
        });
        const result = store.write(request({ expectedRevision: 1, selection: { provider: 'claude-cli', model: 'sonnet' } }));
        expect(result).toMatchObject({ ok: false, code: 'persistence_failed', reason: 'durability_unconfirmed',
            committed: true, document: { revision: 2, assistant: { model: 'sonnet' } } });
        expect(result).not.toHaveProperty('durable');
        expect(fs.readFileSync(store.path)).not.toEqual(bytes);
        expect(result).toHaveProperty('document', document());
        expect(fs.readdirSync(join(dir, 'config'))).toEqual(['launch-defaults.json']);
        vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);
        expect(store.write(request({ expectedRevision: 1 }))).toMatchObject({ code: 'revision_conflict', actualRevision: 2 });
        expect(saved({ expectedRevision: 2 }).document.revision).toBe(3);
    });
});
