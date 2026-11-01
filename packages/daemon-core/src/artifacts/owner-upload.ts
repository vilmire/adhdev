/**
 * Owner uploads as project artifacts (mission ed23a6a1).
 *
 * Reuses the one artifact store — no parallel store. An owner-uploaded image is
 * written into a daemon-managed directory (`<configDir>/owner-uploads/<bucket>/`,
 * 0700 dir / 0600 file, generated names) and REGISTERED through
 * `ArtifactStore.register`, so listing, paging, hashing, the path guard and the
 * OD-4 ACL all apply unchanged:
 *
 *   staged     session `owner-upload:<assistantSessionId>:<ownerMessageId>`, no mesh.
 *              Created only at trusted owner ingress (see owner-upload-ingress.ts).
 *              Reachable by no coordinator/worker (a mesh-less record is never
 *              granted through a worker task, and a coordinator needs a mesh match).
 *   committed  session `owner-upload:<meshId>:<digest(clientId)>`, bound to the
 *              target mesh on the daemon that hosts it. Reachable by that mesh's
 *              coordinator and by workers whose task names it in inputArtifactIds.
 *
 * Bytes never cross the server: a remote host receives them over the existing
 * authenticated mesh RPC (`assistant_remote_project` `send`, direct P2P / paired
 * standalone WS) and commits its own copy.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArtifactStore } from './artifact-store.js';
import type { ArtifactRecord } from './types.js';
import {
    OWNER_UPLOAD_MAX_FILES,
    OWNER_UPLOAD_MAX_TOTAL_BYTES,
    validateOwnerUploadBytes,
    validateOwnerUploadImage,
    type ValidatedOwnerUploadImage,
} from './owner-upload-image.js';

export const OWNER_UPLOAD_SESSION_PREFIX = 'owner-upload:';
/** A staged upload can be attached for this long after the owner sent it. */
export const OWNER_UPLOAD_ATTACH_TTL_MS = 60 * 60 * 1000;
export const OWNER_UPLOAD_WIRE_MAX_CHARS = 12_000_000;

export interface OwnerUploadRef {
    artifactId: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    title: string;
}

export interface OwnerUploadWireAttachment {
    mimeType: string;
    sha256: string;
    dataBase64: string;
}

export interface OwnerUploadFailure {
    ok: false;
    code: string;
    error: string;
    index?: number;
    artifactId?: string;
}

const digest = (s: string, len = 24): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, len);

export const stagedUploadSessionId = (assistantSessionId: string, ownerMessageId: string): string =>
    `${OWNER_UPLOAD_SESSION_PREFIX}${assistantSessionId}:${ownerMessageId}`;

export const committedUploadSessionId = (meshId: string, clientId: string): string =>
    `${OWNER_UPLOAD_SESSION_PREFIX}${meshId}:${digest(clientId, 16)}`;

function toRef(record: ArtifactRecord): OwnerUploadRef {
    return { artifactId: record.artifactId, mime: record.mime, sizeBytes: record.sizeBytes, sha256: record.sha256, title: record.title };
}

interface WriteOptions {
    rootDir: string;
    sessionId: string;
    index: number;
    image: ValidatedOwnerUploadImage;
    meshId: string | null;
    missionId?: string | null;
    originDaemonId?: string | null;
    now?: number;
}

/** Exclusive-create the bytes under the managed root, then register the file. */
function writeAndRegister(store: ArtifactStore, opts: WriteOptions): ArtifactRecord {
    const bucket = path.join(opts.rootDir, digest(opts.sessionId));
    fs.mkdirSync(bucket, { recursive: true, mode: 0o700 });
    const canonicalBucket = fs.realpathSync(bucket);
    const fileName = `img-${opts.index + 1}-${opts.image.sha256.slice(0, 12)}.${opts.image.ext}`;
    const filePath = path.join(canonicalBucket, fileName);
    try {
        fs.writeFileSync(filePath, opts.image.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Idempotent replay: the generated name embeds the content hash, so an
        // existing file must hold the same bytes — anything else is tampering.
        const existing = fs.lstatSync(filePath);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('owner upload target is not a regular file');
        const prior = fs.readFileSync(filePath);
        if (createHash('sha256').update(prior).digest('hex') !== opts.image.sha256) throw new Error('owner upload target holds different bytes');
    }
    return store.register({
        sessionId: opts.sessionId,
        workspaceRoot: canonicalBucket,
        path: fileName,
        meshId: opts.meshId,
        missionId: opts.missionId ?? null,
        producerRole: 'user',
        originDaemonId: opts.originDaemonId ?? null,
        kind: 'image',
        mime: opts.image.mime,
        // Names/alt text are untrusted display data; the title is generated.
        title: `Owner upload ${opts.index + 1}`,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
    }).record;
}

export interface IngressImage { mimeType?: string; data: string }

export interface StageResult {
    imported: Array<OwnerUploadRef & { index: number }>;
    refused: Array<{ index: number; code: string; error: string }>;
}

/**
 * Trusted owner ingress → staged artifacts. Per-image refusals never fail the
 * chat send; they are reported so the assistant is told why an image cannot be
 * forwarded. Deterministic ids per (assistant session, owner message, index).
 */
export function stageOwnerUploads(store: ArtifactStore, input: {
    rootDir: string;
    assistantSessionId: string;
    ownerMessageId: string;
    images: ReadonlyArray<IngressImage & { index: number }>;
    originDaemonId?: string | null;
    now?: number;
}): StageResult {
    const out: StageResult = { imported: [], refused: [] };
    const sessionId = stagedUploadSessionId(input.assistantSessionId, input.ownerMessageId);
    let total = 0;
    for (const item of input.images) {
        if (out.imported.length >= OWNER_UPLOAD_MAX_FILES) {
            out.refused.push({ index: item.index, code: 'upload_too_many', error: `at most ${OWNER_UPLOAD_MAX_FILES} images can be forwarded per message` });
            continue;
        }
        const image = validateOwnerUploadImage({ mimeType: item.mimeType, data: item.data });
        if (!image.ok) { out.refused.push({ index: item.index, code: image.code, error: image.error }); continue; }
        if (total + image.bytes.length > OWNER_UPLOAD_MAX_TOTAL_BYTES) {
            out.refused.push({ index: item.index, code: 'upload_too_large', error: `message images exceed ${OWNER_UPLOAD_MAX_TOTAL_BYTES} bytes in total` });
            continue;
        }
        try {
            const record = writeAndRegister(store, { rootDir: input.rootDir, sessionId, index: item.index, image, meshId: null, originDaemonId: input.originDaemonId, now: input.now });
            total += image.bytes.length;
            out.imported.push({ ...toRef(record), index: item.index });
        } catch (error) {
            out.refused.push({ index: item.index, code: 'upload_store_failed', error: error instanceof Error ? error.message : String(error) });
        }
    }
    return out;
}

export interface LoadedUpload { ref: OwnerUploadRef; image: ValidatedOwnerUploadImage }

/**
 * Resolve staged artifact ids for the bound assistant session: exact ownership
 * (session prefix carries the assistant session), unbound, owner-produced and
 * fresh; the bytes are re-read through the store's verified reader and
 * re-validated, so a file swapped on disk after staging is refused.
 */
export function loadStagedUploads(store: ArtifactStore, artifactIds: readonly string[], input: { assistantSessionId: string; now?: number }): { ok: true; uploads: LoadedUpload[] } | OwnerUploadFailure {
    const ids = [...new Set(artifactIds.map((id) => (typeof id === 'string' ? id.trim() : '')))];
    if (ids.length === 0 || ids.some((id) => !id)) return { ok: false, code: 'invalid_args', error: 'attachments must be non-empty artifact ids' };
    if (ids.length > OWNER_UPLOAD_MAX_FILES) return { ok: false, code: 'invalid_args', error: `at most ${OWNER_UPLOAD_MAX_FILES} attachments` };
    const now = input.now ?? Date.now();
    const ownedPrefix = `${OWNER_UPLOAD_SESSION_PREFIX}${input.assistantSessionId}:`;
    const uploads: LoadedUpload[] = [];
    let total = 0;
    for (const artifactId of ids) {
        const record = store.getById(artifactId);
        // One code for "unknown" and "someone else's" — no existence oracle.
        if (!record || !record.sessionId.startsWith(ownedPrefix) || record.producerRole !== 'user' || record.meshId) {
            return { ok: false, code: 'attachment_not_found', error: `attachment ${artifactId} is not an owner upload available to this assistant`, artifactId };
        }
        if (now - record.createdAt > OWNER_UPLOAD_ATTACH_TTL_MS) {
            return { ok: false, code: 'attachment_expired', error: `attachment ${artifactId} expired; ask the owner to upload it again`, artifactId };
        }
        let fetched;
        try {
            fetched = store.fetchArtifactContent(artifactId, { sessionId: record.sessionId });
        } catch (error) {
            return { ok: false, code: 'attachment_unreadable', error: error instanceof Error ? error.message : String(error), artifactId };
        }
        const bytes = Buffer.from(fetched.content, 'base64');
        const image = validateOwnerUploadBytes(bytes, record.mime);
        if (!image.ok || image.sha256 !== record.sha256) {
            return { ok: false, code: 'attachment_changed', error: `attachment ${artifactId} no longer matches what the owner uploaded`, artifactId };
        }
        total += image.bytes.length;
        if (total > OWNER_UPLOAD_MAX_TOTAL_BYTES) return { ok: false, code: 'upload_too_large', error: `attachments exceed ${OWNER_UPLOAD_MAX_TOTAL_BYTES} bytes in total` };
        uploads.push({ ref: toRef(record), image });
    }
    return { ok: true, uploads };
}

/** Bind validated images to a mesh on THIS daemon (the host). Idempotent per (mesh, clientId, index). */
export function commitUploadsToMesh(store: ArtifactStore, input: {
    rootDir: string;
    meshId: string;
    clientId: string;
    images: readonly ValidatedOwnerUploadImage[];
    originDaemonId: string | null;
    missionId?: string | null;
    now?: number;
}): { ok: true; refs: OwnerUploadRef[] } | OwnerUploadFailure {
    if (!input.meshId) return { ok: false, code: 'invalid_args', error: 'meshId required' };
    if (input.images.length === 0 || input.images.length > OWNER_UPLOAD_MAX_FILES) return { ok: false, code: 'invalid_args', error: `1-${OWNER_UPLOAD_MAX_FILES} attachments required` };
    const sessionId = committedUploadSessionId(input.meshId, input.clientId);
    const refs: OwnerUploadRef[] = [];
    try {
        input.images.forEach((image, index) => {
            refs.push(toRef(writeAndRegister(store, { rootDir: input.rootDir, sessionId, index, image, meshId: input.meshId, missionId: input.missionId, originDaemonId: input.originDaemonId, now: input.now })));
        });
    } catch (error) {
        return { ok: false, code: 'upload_store_failed', error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, refs };
}

export function toWireAttachments(uploads: readonly LoadedUpload[]): OwnerUploadWireAttachment[] {
    return uploads.map((u) => ({ mimeType: u.image.mime, sha256: u.image.sha256, dataBase64: u.image.bytes.toString('base64') }));
}

/** Host side of a remote send: validate every wire attachment (type, size, declared hash) before anything is written. */
export function validateWireAttachments(raw: unknown): { ok: true; images: ValidatedOwnerUploadImage[] } | OwnerUploadFailure {
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: 'invalid_args', error: 'attachments must be a non-empty array' };
    if (raw.length > OWNER_UPLOAD_MAX_FILES) return { ok: false, code: 'invalid_args', error: `at most ${OWNER_UPLOAD_MAX_FILES} attachments` };
    const images: ValidatedOwnerUploadImage[] = [];
    let total = 0;
    for (let index = 0; index < raw.length; index++) {
        const item = raw[index] as Record<string, unknown> | null;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'invalid_args', error: 'attachment must be an object', index };
        const keys = Object.keys(item).sort().join(',');
        if (keys !== 'dataBase64,mimeType,sha256') return { ok: false, code: 'invalid_args', error: 'attachment keys must be exactly mimeType, sha256, dataBase64', index };
        const image = validateOwnerUploadImage({ mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined, data: item.dataBase64 });
        if (!image.ok) return { ok: false, code: image.code, error: image.error, index };
        if (image.sha256 !== item.sha256) return { ok: false, code: 'upload_hash_mismatch', error: 'attachment bytes do not match the declared sha256', index };
        total += image.bytes.length;
        if (total > OWNER_UPLOAD_MAX_TOTAL_BYTES) return { ok: false, code: 'upload_too_large', error: `attachments exceed ${OWNER_UPLOAD_MAX_TOTAL_BYTES} bytes in total`, index };
        images.push(image);
    }
    return { ok: true, images };
}

/**
 * The block appended to the message the coordinator receives. Metadata only —
 * no bytes, no names. The wording tells the coordinator to pass ids onward and
 * to read sparingly.
 */
export function renderAttachmentBlock(refs: readonly OwnerUploadRef[]): string {
    const lines = refs.map((r) => `- ${r.artifactId} (${r.mime}, ${r.sizeBytes} bytes, sha256 ${r.sha256.slice(0, 12)})`);
    return [
        'Owner-attached images (project artifacts, read-only):',
        ...lines,
        'Pass these ids unchanged in input_artifact_ids when a worker needs them; do not copy their bytes into messages. Read an attachment yourself only when your own routing needs it, and then a small page (artifact_read limit) — workers read them with their own grant.',
    ].join('\n');
}
