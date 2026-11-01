/**
 * `project_send` attachments (mission ed23a6a1): the glue between the assistant
 * verb, the staged-upload store and the host that owns the project's mesh.
 *
 *   assistant daemon   loadSendAttachments  → verified staged uploads (this
 *                      assistant session only, fresh, bytes re-validated)
 *   local project      commitLocalAttachments → mesh-bound artifacts here + block
 *   remote project     the bytes ride the existing authenticated mesh RPC `send`
 *                      op as `attachments`; the host runs applyHostAttachments
 *                      and commits ITS OWN copy (origin = host), so later reads
 *                      never need the assistant daemon to be online.
 *
 * Neither path touches the cloud server (CLAUDE.md content boundary).
 */

import { ArtifactStore } from '../../artifacts/artifact-store.js';
import {
    commitUploadsToMesh,
    loadStagedUploads,
    renderAttachmentBlock,
    toWireAttachments,
    validateWireAttachments,
    OWNER_UPLOAD_WIRE_MAX_CHARS,
    type LoadedUpload,
    type OwnerUploadWireAttachment,
} from '../../artifacts/owner-upload.js';
import { OWNER_UPLOAD_MAX_FILES, type ValidatedOwnerUploadImage } from '../../artifacts/owner-upload-image.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { ownerUploadRootDir } from '../owner-upload-ingress.js';

export interface AttachmentFailure { ok: false; code: string; error: string; detail?: Record<string, unknown> }

const store = () => new ArtifactStore(MeshRuntimeStore.getInstance().db);

/** Shape-check the tool argument (array of artifact id strings) and load the staged uploads. */
export function loadSendAttachments(raw: unknown): { ok: true; uploads: LoadedUpload[] } | AttachmentFailure {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > OWNER_UPLOAD_MAX_FILES || raw.some((x) => typeof x !== 'string')) {
        return { ok: false, code: 'invalid_args', error: `attachments must be 1-${OWNER_UPLOAD_MAX_FILES} artifact id strings` };
    }
    const assistantSessionId = getAssistantRegistry().read()?.sessionId;
    if (!assistantSessionId) return { ok: false, code: 'attachment_not_found', error: 'no assistant session is bound' };
    const loaded = loadStagedUploads(store(), raw as string[], { assistantSessionId });
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error, ...(loaded.artifactId ? { detail: { artifactId: loaded.artifactId } } : {}) };
    return loaded;
}

/** Local project: commit mesh-bound copies on this daemon; returns the text block for the coordinator. */
export function commitLocalAttachments(uploads: readonly LoadedUpload[], meshId: string, clientId: string, selfDaemonId: string | null): { ok: true; block: string } | AttachmentFailure {
    const committed = commitUploadsToMesh(store(), { rootDir: ownerUploadRootDir(), meshId, clientId, images: uploads.map((u) => u.image), originDaemonId: selfDaemonId });
    if (!committed.ok) return { ok: false, code: committed.code, error: committed.error };
    return { ok: true, block: renderAttachmentBlock(committed.refs) };
}

export function wireAttachments(uploads: readonly LoadedUpload[]): OwnerUploadWireAttachment[] {
    return toWireAttachments(uploads);
}

/**
 * Host side of a remote `send` op. Returns the args with `attachments` removed
 * and the attachment block appended to `text`; refuses (before anything is
 * written) on any invalid attachment. Idempotent per (mesh, clientId): a retry
 * re-derives the same artifact ids and the same text.
 */
export function applyHostAttachments(args: Record<string, unknown>, meshId: string, selfDaemonId: string | null): { ok: true; args: Record<string, unknown> } | AttachmentFailure {
    if (args.attachments === undefined) return { ok: true, args };
    const { attachments, ...rest } = args;
    const clientId = typeof rest.clientId === 'string' ? rest.clientId : '';
    if (!clientId) return { ok: false, code: 'invalid_args', error: 'clientId required' };
    if (JSON.stringify(attachments ?? null).length > OWNER_UPLOAD_WIRE_MAX_CHARS) return { ok: false, code: 'upload_too_large', error: 'attachments exceed the transfer limit' };
    const checked = validateWireAttachments(attachments);
    if (!checked.ok) return { ok: false, code: checked.code, error: checked.error, ...(checked.index !== undefined ? { detail: { index: checked.index } } : {}) };
    const images: ValidatedOwnerUploadImage[] = checked.images;
    const committed = commitUploadsToMesh(store(), { rootDir: ownerUploadRootDir(), meshId, clientId, images, originDaemonId: selfDaemonId });
    if (!committed.ok) return { ok: false, code: committed.code, error: committed.error };
    const text = typeof rest.text === 'string' ? rest.text : '';
    return { ok: true, args: { ...rest, text: `${text}\n\n${renderAttachmentBlock(committed.refs)}`, attachmentsImported: committed.refs.length } };
}
