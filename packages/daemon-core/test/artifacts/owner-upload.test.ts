/**
 * Owner uploads as project artifacts (mission ed23a6a1): import validation
 * (size/type/hash), staged → committed binding, and the OD-4 ACL over a
 * committed owner upload (foreign mesh / worker without an input grant denied).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import {
    OWNER_UPLOAD_ATTACH_TTL_MS,
    commitUploadsToMesh,
    loadStagedUploads,
    renderAttachmentBlock,
    stageOwnerUploads,
    toWireAttachments,
    validateWireAttachments,
} from '../../src/artifacts/owner-upload.js';
import { OWNER_UPLOAD_MAX_FILE_BYTES, validateOwnerUploadImage } from '../../src/artifacts/owner-upload-image.js';
import { ensureSessionArtifactsSchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { authorizeCrossSessionArtifactAccess } from '../../src/commands/med-family/artifact-sharing.js';

export const PNG_1X1 = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
);
const b64 = (b: Buffer) => b.toString('base64');

/** A PNG header claiming the given size (bytes after IHDR are irrelevant to the header check). */
function pngClaiming(width: number, height: number, padTo = 64): Buffer {
    const buf = Buffer.alloc(Math.max(padTo, 33));
    PNG_1X1.copy(buf, 0, 0, 33);
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
}

let tmp: string;
let db: Database.Database;
let store: ArtifactStore;
const AS = 'assistant-session-1';

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-owner-upload-'));
    db = new Database(':memory:');
    ensureSessionArtifactsSchema(db as any);
    store = new ArtifactStore(db as any);
});
afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('import validation (size / type)', () => {
    it('accepts a real PNG and records its dimensions and hash', () => {
        const r = validateOwnerUploadImage({ mimeType: 'image/png', data: b64(PNG_1X1) });
        expect(r).toMatchObject({ ok: true, mime: 'image/png', ext: 'png', width: 1, height: 1 });
    });

    it('refuses SVG, HTML, non-images and mislabelled bytes', () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        expect(validateOwnerUploadImage({ mimeType: 'image/svg+xml', data: b64(svg) })).toMatchObject({ ok: false, code: 'upload_unsupported_type' });
        expect(validateOwnerUploadImage({ data: b64(Buffer.from('<html></html>')) })).toMatchObject({ ok: false, code: 'upload_unsupported_type' });
        expect(validateOwnerUploadImage({ mimeType: 'image/jpeg', data: b64(PNG_1X1) })).toMatchObject({ ok: false, code: 'upload_type_mismatch' });
    });

    it('enforces the 4 MiB per-file cap on the encoded string before decoding, and exactly at the edge', () => {
        expect(validateOwnerUploadImage({ data: 'A'.repeat(5_592_408 + 4) })).toMatchObject({ ok: false, code: 'upload_too_large' });
        const atCap = Buffer.alloc(OWNER_UPLOAD_MAX_FILE_BYTES);
        PNG_1X1.copy(atCap);
        expect(validateOwnerUploadImage({ data: b64(atCap) })).toMatchObject({ ok: true });
        const over = Buffer.alloc(OWNER_UPLOAD_MAX_FILE_BYTES + 1);
        PNG_1X1.copy(over);
        expect(validateOwnerUploadImage({ data: b64(over) })).toMatchObject({ ok: false, code: 'upload_too_large' });
    });

    it('refuses non-canonical base64, empty data, corrupt headers and pixel bombs', () => {
        expect(validateOwnerUploadImage({ data: 'not base64!!' })).toMatchObject({ ok: false, code: 'upload_invalid_encoding' });
        expect(validateOwnerUploadImage({ data: '' })).toMatchObject({ ok: false, code: 'upload_empty' });
        expect(validateOwnerUploadImage({ data: b64(PNG_1X1.subarray(0, 12)) })).toMatchObject({ ok: false, code: 'upload_corrupt_image' });
        expect(validateOwnerUploadImage({ data: b64(pngClaiming(60_000, 60_000)) })).toMatchObject({ ok: false, code: 'upload_dimensions_exceeded' });
        expect(validateOwnerUploadImage({ data: b64(pngClaiming(10_000, 10_000)) })).toMatchObject({ ok: false, code: 'upload_dimensions_exceeded' });
    });

    it('stageOwnerUploads reports per-image refusals without throwing and caps the message at 5 images / 8 MiB', () => {
        const images = [
            { index: 0, mimeType: 'image/png', data: b64(PNG_1X1) },
            { index: 1, mimeType: 'image/svg+xml', data: b64(Buffer.from('<svg/>')) },
        ];
        const r = stageOwnerUploads(store, { rootDir: tmp, assistantSessionId: AS, ownerMessageId: 'm1', images });
        expect(r.imported.map((i) => i.index)).toEqual([0]);
        expect(r.refused).toEqual([expect.objectContaining({ index: 1, code: 'upload_unsupported_type' })]);

        const many = Array.from({ length: 7 }, (_, i) => ({ index: i, mimeType: 'image/png', data: b64(pngClaiming(1, 1, 100 + i)) }));
        const capped = stageOwnerUploads(store, { rootDir: tmp, assistantSessionId: AS, ownerMessageId: 'm2', images: many });
        expect(capped.imported).toHaveLength(5);
        expect(capped.refused.map((x) => x.code)).toEqual(['upload_too_many', 'upload_too_many']);
    });

    it('stages idempotently: the same owner message + index yields the same artifact id', () => {
        const input = { rootDir: tmp, assistantSessionId: AS, ownerMessageId: 'm1', images: [{ index: 0, mimeType: 'image/png', data: b64(PNG_1X1) }] };
        const a = stageOwnerUploads(store, input);
        const b = stageOwnerUploads(store, input);
        expect(b.imported[0].artifactId).toBe(a.imported[0].artifactId);
        const stat = fs.statSync(path.join(tmp, fs.readdirSync(tmp)[0]));
        expect(stat.mode & 0o777).toBe(0o700);
    });
});

describe('staged → committed binding', () => {
    function stage(): string {
        const r = stageOwnerUploads(store, { rootDir: tmp, assistantSessionId: AS, ownerMessageId: 'm1', images: [{ index: 0, mimeType: 'image/png', data: b64(PNG_1X1) }] });
        return r.imported[0].artifactId;
    }

    it('loads only this assistant session\'s fresh, unbound uploads', () => {
        const id = stage();
        expect(loadStagedUploads(store, [id], { assistantSessionId: AS })).toMatchObject({ ok: true });
        // Another assistant session, an unknown id and a stale upload are all refused (no existence oracle).
        expect(loadStagedUploads(store, [id], { assistantSessionId: 'other' })).toMatchObject({ ok: false, code: 'attachment_not_found' });
        expect(loadStagedUploads(store, ['art_nope'], { assistantSessionId: AS })).toMatchObject({ ok: false, code: 'attachment_not_found' });
        expect(loadStagedUploads(store, [id], { assistantSessionId: AS, now: Date.now() + OWNER_UPLOAD_ATTACH_TTL_MS + 1000 })).toMatchObject({ ok: false, code: 'attachment_expired' });
    });

    it('refuses a staged file swapped on disk after the owner uploaded it', () => {
        const id = stage();
        const rec = store.getById(id)!;
        const file = path.join(rec.workspaceRoot, rec.relPath);
        fs.writeFileSync(file, pngClaiming(2, 2, 80));
        expect(loadStagedUploads(store, [id], { assistantSessionId: AS })).toMatchObject({ ok: false });
    });

    it('commit binds a mesh-scoped copy, idempotently per (mesh, clientId)', () => {
        const loaded = loadStagedUploads(store, [stage()], { assistantSessionId: AS });
        if (!loaded.ok) throw new Error('load');
        const images = loaded.uploads.map((u) => u.image);
        const a = commitUploadsToMesh(store, { rootDir: tmp, meshId: 'mesh_a', clientId: 'c1', images, originDaemonId: 'daemon_mach_self' });
        const b = commitUploadsToMesh(store, { rootDir: tmp, meshId: 'mesh_a', clientId: 'c1', images, originDaemonId: 'daemon_mach_self' });
        if (!a.ok || !b.ok) throw new Error('commit');
        expect(b.refs[0].artifactId).toBe(a.refs[0].artifactId);
        expect(store.getById(a.refs[0].artifactId)).toMatchObject({ meshId: 'mesh_a', producerRole: 'user', originDaemonId: 'daemon_mach_self', kind: 'image' });
        // Staging copy stays unbound and distinct.
        expect(a.refs[0].artifactId).not.toBe(loaded.uploads[0].ref.artifactId);
        expect(renderAttachmentBlock(a.refs)).toContain(a.refs[0].artifactId);
        expect(renderAttachmentBlock(a.refs)).not.toContain(images[0].bytes.toString('base64'));
    });

    it('validates wire attachments strictly (keys, hash, type) before anything is written', () => {
        const loaded = loadStagedUploads(store, [stage()], { assistantSessionId: AS });
        if (!loaded.ok) throw new Error('load');
        const wire = toWireAttachments(loaded.uploads);
        expect(validateWireAttachments(wire)).toMatchObject({ ok: true });
        expect(validateWireAttachments([{ ...wire[0], sha256: 'f'.repeat(64) }])).toMatchObject({ ok: false, code: 'upload_hash_mismatch' });
        expect(validateWireAttachments([{ ...wire[0], path: '/etc/passwd' }])).toMatchObject({ ok: false, code: 'invalid_args' });
        expect(validateWireAttachments([{ ...wire[0], mimeType: 'image/gif' }])).toMatchObject({ ok: false, code: 'upload_type_mismatch' });
        expect(validateWireAttachments([])).toMatchObject({ ok: false, code: 'invalid_args' });
    });
});

describe('ACL over a committed owner upload (OD-4 rules, unchanged)', () => {
    function committed(meshId = 'mesh_a') {
        const staged = stageOwnerUploads(store, { rootDir: tmp, assistantSessionId: AS, ownerMessageId: 'm1', images: [{ index: 0, mimeType: 'image/png', data: b64(PNG_1X1) }] });
        const loaded = loadStagedUploads(store, [staged.imported[0].artifactId], { assistantSessionId: AS });
        if (!loaded.ok) throw new Error('load');
        const r = commitUploadsToMesh(store, { rootDir: tmp, meshId, clientId: 'c1', images: loaded.uploads.map((u) => u.image), originDaemonId: 'daemon_mach_self' });
        if (!r.ok) throw new Error('commit');
        return { staged: store.getById(staged.imported[0].artifactId)!, record: store.getById(r.refs[0].artifactId)! };
    }
    const ctx = (queue: Record<string, unknown> | null) => ({
        deps: { statusInstanceId: 'daemon_mach_self' },
        getMeshRuntimeStore: undefined,
        __queue: queue,
    }) as any;

    it('the owning mesh\'s coordinator can read; a foreign mesh\'s coordinator and the staged copy are denied', async () => {
        const { staged, record } = committed();
        const coordinator = (meshId: string) => ({ sessionId: 'coord-1', producerRole: 'coordinator', isCoordinator: true, meshId, workspaceRoot: '/ws' }) as any;
        const ok = await authorizeCrossSessionArtifactAccess(ctx(null), coordinator('mesh_a'), record);
        expect(ok.ok).toBe(true);
        const foreign = await authorizeCrossSessionArtifactAccess(ctx(null), coordinator('mesh_b'), record);
        expect(foreign).toMatchObject({ ok: false, result: { code: 'artifact_session_mismatch' } });
        // The staged (mesh-less) copy is not reachable through any mesh's coordinator authority either.
        const stagedRead = await authorizeCrossSessionArtifactAccess(ctx(null), coordinator('mesh_a'), staged);
        expect(stagedRead.ok).toBe(false);
    });

    it('a worker reads it only through inputArtifactIds on its own task in the same mesh', async () => {
        const { record } = committed();
        const worker = (meshId: string, inputs: string[]) => ({ sessionId: 'w1', producerRole: 'worker', isCoordinator: false, meshId, taskId: 't1', workspaceRoot: '/ws', remoteInputArtifactIds: inputs }) as any;
        // No queue row → falls back to remoteInputArtifactIds (the host-resolved scope).
        const granted = await authorizeCrossSessionArtifactAccess(ctx(null), worker('mesh_a', [record.artifactId]), record);
        expect(granted.ok).toBe(true);
        const noGrant = await authorizeCrossSessionArtifactAccess(ctx(null), worker('mesh_a', []), record);
        expect(noGrant).toMatchObject({ ok: false, result: { code: 'artifact_access_denied' } });
        const foreignMission = await authorizeCrossSessionArtifactAccess(ctx(null), worker('mesh_b', [record.artifactId]), record);
        expect(foreignMission).toMatchObject({ ok: false, result: { code: 'artifact_access_denied' } });
    });
});
