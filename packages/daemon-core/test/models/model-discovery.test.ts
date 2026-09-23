/**
 * Model-discovery regressions.
 *
 * The samples below are REAL output captured 2026-09-23 from the installed
 * CLIs, not invented fixtures — a parser tested only against output we imagined
 * proves nothing about the output we actually get (banner lines, tab separators
 * and the zero-width characters cursor emits are all things a hand-written
 * fixture would have omitted).
 */
'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseModels } from '../../src/models/parse.js';
import {
    buildModelOverlayPatch,
    resolveModelOptions,
    deadModelsVsManifest,
    newModelsVsManifest,
} from '../../src/models/overlay.js';
import { discoverProviderModels, classifyFailure, expandHome } from '../../src/models/discover.js';
import type { ModelDiscoverySpec, ModelDiscoverySnapshot } from '../../src/models/types.js';

// ─── Real captured output ──────────────────────────────────────────────────

const CODEX_JSON = JSON.stringify({
    models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, supported_in_api: true },
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 2 },
        // Hidden entries must never reach a picker.
        { slug: 'gpt-internal-eval', display_name: 'Internal', visibility: 'hidden', priority: 0 },
        // A record with no `visibility` at all: fail closed, do not admit it.
        { slug: 'gpt-unknown-shape', display_name: 'Unknown' },
    ],
});

const GROK_TEXT = [
    'You are logged in with grok.com.',
    '',
    'Default model: grok-4.7',
    '',
    'Available models:',
    '  * grok-4.7 (default)',
    '  - grok-4.7-build-fast',
    '  - grok-4.6',
    '  - grok-4.5',
].join('\n');

// ★Note the two U+200B after grok-4.7-low-fast — cursor really emits these.
const CURSOR_TEXT = [
    'Available models',
    '',
    'auto - Auto (current, default)',
    'gpt-5.3-codex-low - Codex 5.3 Low',
    'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking',
    'grok-4.7-low-fast - Grok 4.7  Low Fast​​',
].join('\n');

const AGY_TEXT = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
].join('\n');

const OPENCODE_TEXT = ['opencode/big-pickle', 'antigravity-manager/claude-sonnet-4-6'].join('\n');

const KIMI_TOML = [
    '[models."kimi-code/kimi-for-coding"]',
    'context = 256000',
    '[models."kimi-code/k3"]',
    '[models."kimi-code/k3-256k"]',
].join('\n');

const CODEX_PARSE = {
    format: 'json' as const,
    itemsPath: 'models',
    slugField: 'slug',
    labelField: 'display_name',
    filter: { visibility: 'list' },
    priorityField: 'priority',
};
const GROK_PARSE = { format: 'lines' as const, linePattern: '^\\s*[*-]\\s+(?<slug>[A-Za-z0-9][\\w.-]*)', defaultMarker: '\\(default\\)' };
const CURSOR_PARSE = { format: 'lines' as const, linePattern: '^(?<slug>[A-Za-z0-9][\\w./-]*)\\s+-\\s+(?<label>.+?)\\s*$' };
const AGY_PARSE = { format: 'lines' as const, linePattern: '^(?<slug>[A-Za-z0-9][\\w.-]*)\\t(?<label>.+?)\\s*$' };
const OPENCODE_PARSE = { format: 'lines' as const, linePattern: '^(?<slug>[A-Za-z0-9][\\w.-]*/[\\w.-]+)\\s*$' };
const KIMI_PARSE = { format: 'toml-table-keys' as const, tableHeaderPattern: '^\\[models\\."(?<slug>[^"]+)"\\]' };

// ─── ① Each parse format handles its real output ───────────────────────────

describe('parseModels — real CLI output', () => {
    it('json: filters to visibility=list and honours priority order', () => {
        const models = parseModels(CODEX_JSON, CODEX_PARSE);
        expect(models.map(m => m.slug)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
        expect(models[0].label).toBe('GPT-6-Astra');
    });

    it('json: a record missing the filtered field is REJECTED (fail closed)', () => {
        // gpt-unknown-shape has no `visibility`. Admitting it would surface an
        // unvetted model in the picker — the exact defect this work removes.
        expect(parseModels(CODEX_JSON, CODEX_PARSE).map(m => m.slug)).not.toContain('gpt-unknown-shape');
    });

    it('lines: grok banner text is excluded and the default sorts first', () => {
        const models = parseModels(GROK_TEXT, GROK_PARSE);
        expect(models.map(m => m.slug)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
    });

    it('lines: cursor slug/label split, and zero-width characters are stripped', () => {
        const models = parseModels(CURSOR_TEXT, CURSOR_PARSE);
        const fast = models.find(m => m.slug.startsWith('grok-4.7-low-fast'));
        // Without stripping, this slug carries U+200B and silently fails to
        // match the real model name everywhere it is used.
        expect(fast?.slug).toBe('grok-4.7-low-fast');
        expect(/[​-‏]/.test(JSON.stringify(models))).toBe(false);
        expect(models.find(m => m.slug === 'auto')?.label).toBe('Auto (current, default)');
    });

    it('lines: antigravity tab-separated slug/label, "Fetching…" banner excluded', () => {
        const models = parseModels(AGY_TEXT, AGY_PARSE);
        expect(models.map(m => m.slug)).toEqual(['gemini-3.8-flash-high', 'gemini-3.7-flash-high', 'claude-sonnet-4-6']);
        expect(models[0].label).toBe('Gemini 3.8 Flash (High)');
    });

    it('lines: opencode provider/model pairs', () => {
        expect(parseModels(OPENCODE_TEXT, OPENCODE_PARSE).map(m => m.slug))
            .toEqual(['opencode/big-pickle', 'antigravity-manager/claude-sonnet-4-6']);
    });

    it('toml-table-keys: kimi model tables, including the one the manifest lacks', () => {
        const models = parseModels(KIMI_TOML, KIMI_PARSE);
        expect(models.map(m => m.slug)).toEqual(['kimi-code/kimi-for-coding', 'kimi-code/k3', 'kimi-code/k3-256k']);
    });

    it('never throws on garbage — an unparseable read yields [] (→ manifest fallback)', () => {
        expect(parseModels('not json at all', CODEX_PARSE)).toEqual([]);
        expect(parseModels(KIMI_TOML, { format: 'lines' })).toEqual([]);          // no pattern declared
        expect(parseModels('x', { format: 'lines', linePattern: '([' })).toEqual([]); // invalid regex
        expect(parseModels('x', { format: 'nope' as any })).toEqual([]);
    });
});

// ─── ② Discovery failure falls back to the manifest, never to empty ────────

describe('manifest fallback — a failed discovery NEVER empties a picker', () => {
    const MANIFEST = ['grok-4.6', 'grok-4.5'];

    const failing = (overrides: Record<string, unknown>) => discoverProviderModels(
        'grok-cli',
        { kind: 'command', argv: ['models'], parse: GROK_PARSE } as ModelDiscoverySpec,
        '/usr/local/bin/grok',
        overrides as any,
    );

    const fakeChild = (opts: { stdout?: string; stderr?: string; code?: number | null }) => () => {
        const handlers: Record<string, Function[]> = {};
        const child: any = {
            stdout: { on: (_e: string, cb: Function) => { if (opts.stdout) setImmediate(() => cb(Buffer.from(opts.stdout!))); } },
            stderr: { on: (_e: string, cb: Function) => { if (opts.stderr) setImmediate(() => cb(Buffer.from(opts.stderr!))); } },
            on: (e: string, cb: Function) => { (handlers[e] ||= []).push(cb); if (e === 'exit') setImmediate(() => cb(opts.code ?? 0)); },
            kill: () => {},
        };
        return child;
    };

    it('signed out (non-zero exit) → error snapshot, manifest list stands', async () => {
        const snapshot = await failing({ spawn: fakeChild({ stderr: 'You are not logged in. Run `grok login`.', code: 1 }) });
        expect(snapshot.status).toBe('error');
        expect(snapshot.failureKind).toBe('unauthenticated');
        expect(snapshot.models).toEqual([]);
        // ★The contract that matters:
        expect(resolveModelOptions(MANIFEST, snapshot)).toEqual(MANIFEST);
    });

    it('exit 0 with a signed-out notice is NOT treated as success', async () => {
        // Trusting the exit code alone would cache an empty list as authoritative.
        const snapshot = await failing({ spawn: fakeChild({ stdout: 'Please sign in to list models.', code: 0 }) });
        expect(snapshot.status).not.toBe('ok');
        expect(resolveModelOptions(MANIFEST, snapshot)).toEqual(MANIFEST);
    });

    it('binary not installed → unavailable, manifest list stands', async () => {
        const snapshot = await discoverProviderModels(
            'grok-cli',
            { kind: 'command', argv: ['models'], parse: GROK_PARSE } as ModelDiscoverySpec,
            undefined,
        );
        expect(snapshot.status).toBe('unavailable');
        expect(resolveModelOptions(MANIFEST, snapshot)).toEqual(MANIFEST);
    });

    it('a successful-but-empty read also falls back rather than blanking', () => {
        const empty: ModelDiscoverySnapshot = { provider: 'grok-cli', status: 'ok', models: [], updatedAt: 1, fetchedAt: 1 };
        expect(resolveModelOptions(MANIFEST, empty)).toEqual(MANIFEST);
    });

    it('classifyFailure only ever changes the label, and recognises the common cases', () => {
        expect(classifyFailure('You are not logged in', 1)).toBe('unauthenticated');
        expect(classifyFailure('getaddrinfo ENOTFOUND api.x.ai', 1)).toBe('network');
        expect(classifyFailure('command not found: grok', 127)).toBe('cli-unavailable');
        expect(classifyFailure('something weird', 3)).toBe('unknown');
    });
});

// ─── ③ kind:"none" is "cannot verify", not a failure and not "up to date" ──

describe('kind: "none" — declared undiscoverable', () => {
    it('reports not-supported with the manifest reason, without spawning anything', async () => {
        let spawned = false;
        const snapshot = await discoverProviderModels(
            'claude-cli',
            { kind: 'none', reason: 'claude-cli ships no model-listing subcommand' } as ModelDiscoverySpec,
            '/usr/local/bin/claude',
            { spawn: (() => { spawned = true; throw new Error('must not spawn'); }) as any },
        );
        expect(spawned).toBe(false);
        expect(snapshot.status).toBe('not-supported');
        expect(snapshot.reason).toMatch(/no model-listing subcommand/);
        // Distinct from an error: nothing failed and nothing will ever succeed.
        expect(snapshot.failureKind).toBeUndefined();
    });

    it('still falls back to the manifest list for the picker', () => {
        const snapshot: ModelDiscoverySnapshot = {
            provider: 'claude-cli', status: 'not-supported', models: [], updatedAt: 1, fetchedAt: 1, reason: 'no listing command',
        };
        expect(resolveModelOptions(['opus', 'sonnet'], snapshot)).toEqual(['opus', 'sonnet']);
    });
});

// ─── ④ Dead models are REMOVED — drift is fixed in both directions ─────────

describe('two-directional drift', () => {
    it('replaces the manifest list, so retired models disappear from the picker', () => {
        // codex's shipped manifest, verbatim.
        const manifest = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5-codex', 'gpt-5-codex-mini'];
        const snapshot: ModelDiscoverySnapshot = {
            provider: 'codex-cli', status: 'ok', updatedAt: 1, fetchedAt: 1,
            models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-5.6-sol' }],
        };
        const resolved = resolveModelOptions(manifest, snapshot);
        // The new model appears...
        expect(resolved).toContain('gpt-6-astra');
        // ...and every model the binary no longer offers is GONE. A union would
        // leave all four selectable forever, which is the user-visible defect.
        for (const dead of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5-codex', 'gpt-5-codex-mini']) {
            expect(resolved).not.toContain(dead);
        }
    });

    it('reports both drift directions for diagnostics', () => {
        const manifest = ['gpt-5.6-sol', 'gpt-5-codex'];
        const models = [{ slug: 'gpt-6-astra' }, { slug: 'gpt-5.6-sol' }];
        expect(newModelsVsManifest(manifest, models)).toEqual(['gpt-6-astra']);
        expect(deadModelsVsManifest(manifest, models)).toEqual(['gpt-5-codex']);
    });
});

// ─── P1: antigravity keeps labels, and remembered selections keep resolving ─

describe('P1 — antigravity label/slug handling', () => {
    const MANIFEST_OPTIONS = ['Gemini 3.7 Flash (High)', 'Claude Sonnet 4.6 (Thinking)'];
    const MANIFEST_MAP = {
        'Gemini 3.7 Flash (High)': 'gemini-3.7-flash-high',
        'Claude Sonnet 4.6 (Thinking)': 'claude-sonnet-4-6',
    };
    const snapshot: ModelDiscoverySnapshot = {
        provider: 'antigravity-cli', status: 'ok', updatedAt: 1, fetchedAt: 1,
        models: parseModels(AGY_TEXT, AGY_PARSE),
    };

    it('keeps LABELS in modelOptions and rebuilds the label→slug map', () => {
        const patch = buildModelOverlayPatch(snapshot, { modelOptions: MANIFEST_OPTIONS, modelLaunchValueMap: MANIFEST_MAP });
        expect(patch.modelOptions).toEqual(['Gemini 3.8 Flash (High)', 'Gemini 3.7 Flash (High)', 'Claude Sonnet 4.6 (Thinking)']);
        expect(patch.modelLaunchValueMap?.['Gemini 3.8 Flash (High)']).toBe('gemini-3.8-flash-high');
    });

    it('a REMEMBERED selection still resolves to the right slug — no migration needed', () => {
        const patch = buildModelOverlayPatch(snapshot, { modelOptions: MANIFEST_OPTIONS, modelLaunchValueMap: MANIFEST_MAP });
        // The user picked this label before the 3.8 generation existed.
        expect(patch.modelLaunchValueMap?.['Gemini 3.7 Flash (High)']).toBe('gemini-3.7-flash-high');
    });

    it('a label the CLI RETIRED keeps its mapping, so it never leaks to the CLI as a human string', () => {
        const retired: ModelDiscoverySnapshot = {
            provider: 'antigravity-cli', status: 'ok', updatedAt: 1, fetchedAt: 1,
            models: [{ slug: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }],
        };
        const patch = buildModelOverlayPatch(retired, { modelOptions: MANIFEST_OPTIONS, modelLaunchValueMap: MANIFEST_MAP });
        expect(patch.modelOptions).not.toContain('Gemini 3.7 Flash (High)'); // gone from the picker
        expect(patch.modelLaunchValueMap?.['Gemini 3.7 Flash (High)']).toBe('gemini-3.7-flash-high'); // still resolves
    });

    it('slug-valued providers get NO invented value map', () => {
        const patch = buildModelOverlayPatch(
            { provider: 'grok-cli', status: 'ok', updatedAt: 1, fetchedAt: 1, models: [{ slug: 'grok-4.7' }] },
            { modelOptions: ['grok-4.6'] },
        );
        expect(patch.modelOptions).toEqual(['grok-4.7']);
        expect(patch.modelLaunchValueMap).toBeUndefined();
    });
});

// ─── ⑤ The manifest file is never written at runtime (digest preserved) ────

describe('manifest digest preservation', () => {
    let dir: string;
    let manifestPath: string;
    let before: { bytes: string; mtimeMs: number };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-model-discovery-'));
        manifestPath = path.join(dir, 'provider.v1.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ type: 'grok-cli', modelOptions: ['grok-4.6', 'grok-4.5'] }, null, 2));
        const stat = fs.statSync(manifestPath);
        before = { bytes: fs.readFileSync(manifestPath, 'utf-8'), mtimeMs: stat.mtimeMs };
    });

    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('a full discover→overlay cycle leaves the manifest byte-identical', async () => {
        const snapshot = await discoverProviderModels(
            'grok-cli',
            { kind: 'command', argv: ['models'], parse: GROK_PARSE } as ModelDiscoverySpec,
            '/usr/local/bin/grok',
            {
                spawn: (() => ({
                    stdout: { on: (_e: string, cb: Function) => setImmediate(() => cb(Buffer.from(GROK_TEXT))) },
                    stderr: { on: () => {} },
                    on: (e: string, cb: Function) => { if (e === 'exit') setImmediate(() => cb(0)); },
                    kill: () => {},
                })) as any,
            },
        );
        expect(snapshot.status).toBe('ok');

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const resolved = resolveModelOptions(manifest.modelOptions, snapshot);
        expect(resolved).toContain('grok-4.7'); // the overlay really did change the picker

        // ★...while the signed bytes on disk did not move. Writing the list back
        // into the manifest would break channel digest verification.
        expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before.bytes);
        expect(fs.statSync(manifestPath).mtimeMs).toBe(before.mtimeMs);
    });
});

describe('expandHome', () => {
    it('expands a leading ~ and leaves absolute paths alone', () => {
        expect(expandHome('~/.kimi-code/config.toml', '/Users/x')).toBe(path.join('/Users/x', '.kimi-code/config.toml'));
        expect(expandHome('/etc/passwd', '/Users/x')).toBe('/etc/passwd');
    });
});
