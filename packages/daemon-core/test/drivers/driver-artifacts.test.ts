import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DRIVER_INLINE_CAP, MAX_DRIVER_ARTIFACTS_PER_CALL, captureDriverArtifacts, decodeDriverImage, sniffImageMime,
    type DriverArtifactPort, type DriverArtifactSink,
} from '../../src/drivers/driver-artifacts.js';
import { MAX_ARTIFACT_BYTES } from '../../src/artifacts/types.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('driver-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('driver-jpeg-body')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const identity = { meshId: 'mesh', taskId: 'task', sessionId: 'session' };
const image = (bytes: Buffer, mimeType: string) => ({ type: 'image', data: bytes.toString('base64'), mimeType });

let ws: string;
let registered: Array<{ relPath: string; kind: string; mime: string; title: string }>;
let failRegister: Error | null;
const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, encoding: 'utf8', windowsHide: true });
const port = (): DriverArtifactPort => ({
    resolve: async () => ({
        workspaceRoot: ws,
        register: async input => {
            if (failRegister) throw failRegister;
            registered.push(input);
            const bytes = readFileSync(join(ws, input.relPath));
            return { artifactId: `art_${registered.length}`, sha256: 'ab'.repeat(32), sizeBytes: bytes.length };
        },
    } satisfies DriverArtifactSink),
});
const capture = (content: unknown[], p: DriverArtifactPort | null = port(), extra: Record<string, unknown> = {}) =>
    captureDriverArtifacts({ result: { content, ...extra }, identity, invocationId: 'inv-1', title: 'browser.screenshot', ...(p ? { port: p } : {}) });
const files = () => existsSync(join(ws, '.adhdev/driver-results')) ? readdirSync(join(ws, '.adhdev/driver-results'), { recursive: true }).map(String) : [];

beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'driver-artifacts-'));
    git('init', '-q'); writeFileSync(join(ws, 'README.md'), 'x'); git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    registered = []; failRegister = null;
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('image blocks', () => {
    it('registers a png as an artifact, replaces base64, keeps the checkout clean', async () => {
        const r = await capture([{ type: 'text', text: 'ok' }, image(PNG, 'image/png')]);
        expect(r.artifacts).toEqual([{ type: 'image', artifactId: 'art_1', digest: `sha256:${'ab'.repeat(32)}`, relPath: '.adhdev/driver-results/inv-1/image-1.png' }]);
        expect(r.artifactError).toBeUndefined();
        expect(JSON.stringify(r.output)).not.toContain(PNG.toString('base64'));
        expect((r.output as any).content[1]).toEqual({ type: 'image', artifactId: 'art_1', relPath: '.adhdev/driver-results/inv-1/image-1.png', mime: 'image/png', sizeBytes: PNG.length, sha256: 'ab'.repeat(32) });
        expect(registered).toEqual([{ relPath: '.adhdev/driver-results/inv-1/image-1.png', kind: 'image', mime: 'image/png', title: 'browser.screenshot' }]);
        expect(readFileSync(join(ws, registered[0]!.relPath)).equals(PNG)).toBe(true);
        expect(git('status', '--porcelain')).toBe('');
        expect(git('check-ignore', '.adhdev/driver-results/inv-1/image-1.png').trim()).toBe('.adhdev/driver-results/inv-1/image-1.png');
    });
    it('does not ignore the rest of .adhdev', async () => {
        await capture([image(PNG, 'image/png')]);
        mkdirSync(join(ws, '.adhdev'), { recursive: true }); writeFileSync(join(ws, '.adhdev', 'refine.json'), '{}');
        expect(git('status', '--porcelain', '-uall')).toContain('.adhdev/refine.json');
    });
    it('refuses bytes that do not match the declared mime (magic number, not the label)', async () => {
        const r = await capture([image(JPEG, 'image/png')]);
        expect(r.artifacts).toEqual([]);
        expect(r.artifactError).toMatchObject({ code: 'mime_mismatch' });
        expect(registered).toEqual([]); expect(files()).toEqual([]);
        expect(JSON.stringify(r.output)).not.toContain(JPEG.toString('base64'));
        expect((r.output as any).content[0]).toMatchObject({ type: 'image', omitted: true, code: 'mime_mismatch' });
    });
    it('refuses SVG both as declared mime and as bytes labelled png', async () => {
        const declared = await capture([image(SVG, 'image/svg+xml')]);
        expect(declared.artifactError).toMatchObject({ code: 'unsupported_mime_or_kind' });
        const disguised = await capture([image(SVG, 'image/png')]);
        expect(disguised.artifactError).toMatchObject({ code: 'mime_mismatch' });
        expect(registered).toEqual([]); expect(files()).toEqual([]);
        expect(JSON.stringify([declared.output, disguised.output])).not.toContain(SVG.toString('base64'));
    });
    it('refuses non-base64 and over-limit images without decoding them', async () => {
        expect((await capture([{ type: 'image', data: 'not base64!!', mimeType: 'image/png' }])).artifactError).toMatchObject({ code: 'image_invalid' });
        const huge = { type: 'image', data: 'A'.repeat(Math.ceil((MAX_ARTIFACT_BYTES + 100) / 3) * 4), mimeType: 'image/png' };
        const r = await capture([huge]);
        expect(r.artifactError).toMatchObject({ code: 'artifact_too_large' });
        expect(JSON.stringify(r.output).length).toBeLessThan(500);
        expect(registered).toEqual([]);
    });
    it('ignores any name, path or uri the driver puts on the block', async () => {
        const hostile = { ...image(PNG, 'image/png'), name: '../../evil.png', filename: '/etc/passwd', path: '../x', uri: 'file:///etc/hosts' };
        const r = await capture([hostile]);
        expect(r.artifacts).toHaveLength(1);
        expect(files().sort()).toEqual(['inv-1', 'inv-1/image-1.png']);
        expect(existsSync(join(ws, '..', 'evil.png'))).toBe(false);
        expect(registered[0]!.relPath).toBe('.adhdev/driver-results/inv-1/image-1.png');
    });
    it('refuses a symlinked results directory and writes nothing outside the workspace', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'driver-outside-'));
        try {
            mkdirSync(join(ws, '.adhdev')); symlinkSync(outside, join(ws, '.adhdev', 'driver-results'));
            const r = await capture([image(PNG, 'image/png')]);
            expect(r.artifactError).toMatchObject({ code: 'unsafe_path' });
            expect(readdirSync(outside)).toEqual([]); expect(registered).toEqual([]);
            expect(lstatSync(join(ws, '.adhdev', 'driver-results')).isSymbolicLink()).toBe(true);
        } finally { rmSync(outside, { recursive: true, force: true }); }
    });
    it('caps the artifacts of one call', async () => {
        const r = await capture(Array.from({ length: MAX_DRIVER_ARTIFACTS_PER_CALL + 2 }, () => image(PNG, 'image/png')));
        expect(r.artifacts).toHaveLength(MAX_DRIVER_ARTIFACTS_PER_CALL);
        expect(r.artifactError).toMatchObject({ code: 'too_many_artifacts' });
        expect((r.output as any).content.slice(-2).every((c: any) => c.omitted)).toBe(true);
    });
});

describe('oversized text', () => {
    const big = (chars: number) => 'log line 000000\n'.repeat(Math.ceil(chars / 16));
    it('stores the full text as a text artifact and returns a preview plus id', async () => {
        const text = big(DRIVER_INLINE_CAP * 2);
        const r = await capture([{ type: 'text', text }]);
        expect(r.artifacts).toEqual([{ type: 'text', artifactId: 'art_1', digest: expect.stringMatching(/^sha256:/), relPath: '.adhdev/driver-results/inv-1/result.txt' }]);
        expect(r.output).toMatchObject({ truncated: true, artifactId: 'art_1', relPath: '.adhdev/driver-results/inv-1/result.txt' });
        expect((r.output as any).text.length).toBeLessThan(5000);
        expect(registered[0]).toMatchObject({ kind: 'text', mime: 'text/plain', relPath: '.adhdev/driver-results/inv-1/result.txt' });
        expect(readFileSync(join(ws, registered[0]!.relPath), 'utf8')).toBe(text);
    });
    it('uses a json artifact when the result has structured content', async () => {
        const r = await capture([{ type: 'text', text: big(DRIVER_INLINE_CAP * 2) }], port(), { structuredContent: { a: 1 } });
        expect(registered[0]).toMatchObject({ kind: 'json', mime: 'application/json' });
        expect(r.artifacts[0]!.type).toBe('json');
    });
    it('over the 4 MiB limit: refused with a code, the call still yields a bounded result', async () => {
        const r = await capture([{ type: 'text', text: big(MAX_ARTIFACT_BYTES + 1000) }]);
        expect(r.artifacts).toEqual([]);
        expect(r.artifactError).toMatchObject({ code: 'artifact_too_large' });
        expect((r.output as any).text.length).toBe(DRIVER_INLINE_CAP);
        expect((r.output as any).note).toMatch(/artifact_too_large/);
        expect(registered).toEqual([]);
    });
    it('small results stay inline and touch nothing', async () => {
        const r = await capture([{ type: 'text', text: 'hi' }]);
        expect(r.output).toEqual({ content: [{ type: 'text', text: 'hi' }] });
        expect(r.artifacts).toEqual([]); expect(files()).toEqual([]);
    });
});

describe('failure containment', () => {
    it('registration failure -> artifactError, file removed, no base64, result still returned', async () => {
        failRegister = Object.assign(new Error('store is locked'), { code: 'db_locked' });
        const r = await capture([image(PNG, 'image/png')]);
        expect(r.artifactError).toEqual({ code: 'db_locked', message: 'store is locked' });
        expect(r.artifacts).toEqual([]);
        expect(JSON.stringify(r.output)).not.toContain(PNG.toString('base64'));
        expect(files().filter(f => f.endsWith('.png'))).toEqual([]);
    });
    it('a resolver that throws or returns null leaves the result inline with a note, never base64', async () => {
        const throwing: DriverArtifactPort = { resolve: async () => { throw new Error('boom'); } };
        const none: DriverArtifactPort = { resolve: async () => null };
        for (const p of [throwing, none, null]) {
            const r = await capture([image(PNG, 'image/png')], p);
            expect(r.artifactError).toBeDefined();
            expect(JSON.stringify(r.output)).not.toContain(PNG.toString('base64'));
            expect((r.output as any).content[0]).toMatchObject({ type: 'image', omitted: true });
        }
        const text = await capture([{ type: 'text', text: 'x'.repeat(DRIVER_INLINE_CAP + 10) }], none);
        expect(text.artifactError).toMatchObject({ code: 'artifact_unavailable' });
        expect(text.output).toMatchObject({ truncated: true, note: expect.stringContaining('could not be stored') });
    });
    // Live 2026-11-08: a worker on a member machine (task owned by another daemon) got every screenshot
    // dropped as artifact_unavailable. The image now lands as a local file in its own workspace.
    it('a remote worker with a local workspace gets the image as a local file, never base64', async () => {
        const remote: DriverArtifactPort = { resolve: async () => null, resolveLocal: async () => ws };
        const r = await capture([image(PNG, 'image/png')], remote);
        const block = (r.output as any).content[0];
        expect(block).toMatchObject({ type: 'image', relPath: '.adhdev/driver-results/inv-1/image-1.png', mime: 'image/png', sizeBytes: PNG.length });
        expect(block.omitted).toBeUndefined();
        expect(readFileSync(block.localPath)).toEqual(PNG);
        expect(JSON.stringify(r.output)).not.toContain(PNG.toString('base64'));
        expect(r.artifacts).toEqual([]);
        expect(git('status', '--porcelain')).toBe('');
    });
});

describe('sniffing', () => {
    it('recognises the four raster types and nothing else', () => {
        expect(sniffImageMime(PNG)).toBe('image/png'); expect(sniffImageMime(JPEG)).toBe('image/jpeg');
        expect(sniffImageMime(Buffer.from('GIF89a....'))).toBe('image/gif');
        expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
        expect(sniffImageMime(SVG)).toBeNull();
        expect(() => decodeDriverImage({ data: '', mimeType: 'image/png' })).toThrow();
    });
});
