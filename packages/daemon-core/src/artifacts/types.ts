/**
 * Artifact Viewer domain types, allowlists, and bounds (Task A).
 *
 * Security & content-boundary invariants:
 * - Only 5 kinds are allowed: 'markdown' | 'image' | 'diff' | 'json' | 'text'.
 * - HTML/iframe ('text/html', 'application/xhtml+xml') and SVG ('image/svg+xml')
 *   are strictly forbidden to prevent stored/inline XSS in the dashboard.
 * - Single-file size is capped at 4 MiB (MAX_ARTIFACT_BYTES). No chunking,
 *   ZIP bundling, bidirectional upload, or R2 fallback in v1.1.
 * - Artifacts and attachment metadata are local/P2P only and must never appear
 *   in server-bound cloud status, UserSession compact payloads, or shortcuts.
 */

import * as path from 'node:path';

export type ArtifactKind = 'markdown' | 'image' | 'diff' | 'json' | 'text';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = Object.freeze([
    'markdown',
    'image',
    'diff',
    'json',
    'text',
]);

/** Maximum allowed size of a registered or fetched artifact file (4 MiB). */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Maximum number of UTF-8 characters (Unicode code points) in previewText. */
export const MAX_PREVIEW_TEXT_CHARS = 600;

/** Maximum number of distinct artifacts allowed per session. */
export const MAX_ARTIFACTS_PER_SESSION = 50;

/** Maximum number of distinct artifacts allowed per mission (OD-7 / brief d6a3c57e). */
export const MAX_ARTIFACTS_PER_MISSION = 200;

/** Maximum number of distinct artifacts allowed per mesh (OD-7 / brief d6a3c57e). */
export const MAX_ARTIFACTS_PER_MESH = 500;

/** Maximum page size for MCP / assistant / follower artifact reads (256 KiB, OD-7). */
export const MAX_ARTIFACT_MCP_PAGE_BYTES = 256 * 1024;

/** Metadata retention horizon for session_artifacts (30 days, OD-7). */
export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ArtifactProducerRole = 'worker' | 'coordinator' | 'assistant' | 'user' | 'session';

export const UNTRUSTED_ARTIFACT_OPEN_TAG = '<untrusted_artifact_content>';
export const UNTRUSTED_ARTIFACT_CLOSE_TAG = '</untrusted_artifact_content>';

/** Wrap untrusted artifact content in `<untrusted_artifact_content>` tags, defanging inner closing tags. */
export function wrapUntrustedArtifactContent(content: string): string {
    const safeBody = String(content ?? '').replace(
        /<\/\s*untrusted_artifact_content\s*>/gi,
        '<\\/untrusted_artifact_content>',
    );
    return `${UNTRUSTED_ARTIFACT_OPEN_TAG}\n${safeBody}\n${UNTRUSTED_ARTIFACT_CLOSE_TAG}`;
}

/** Allowed MIME types per ArtifactKind. SVG and HTML are intentionally excluded. */
export const MIME_BY_KIND: Readonly<Record<ArtifactKind, readonly string[]>> = Object.freeze({
    markdown: Object.freeze(['text/markdown', 'text/plain']),
    image: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    diff: Object.freeze(['text/x-diff', 'text/x-patch', 'text/plain']),
    json: Object.freeze(['application/json']),
    text: Object.freeze(['text/plain']),
});

export interface ExtensionKindMimeSpec {
    readonly kind: ArtifactKind;
    readonly mime: string;
}

/** Canonical lowercase file-extension allowlist mapped to (kind, canonical mime). */
export const ARTIFACT_EXTENSION_MAP: Readonly<Record<string, ExtensionKindMimeSpec>> = Object.freeze({
    '.md': Object.freeze({ kind: 'markdown', mime: 'text/markdown' }),
    '.markdown': Object.freeze({ kind: 'markdown', mime: 'text/markdown' }),
    '.png': Object.freeze({ kind: 'image', mime: 'image/png' }),
    '.jpg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
    '.jpeg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
    '.webp': Object.freeze({ kind: 'image', mime: 'image/webp' }),
    '.gif': Object.freeze({ kind: 'image', mime: 'image/gif' }),
    '.diff': Object.freeze({ kind: 'diff', mime: 'text/x-diff' }),
    '.patch': Object.freeze({ kind: 'diff', mime: 'text/x-patch' }),
    '.json': Object.freeze({ kind: 'json', mime: 'application/json' }),
    '.txt': Object.freeze({ kind: 'text', mime: 'text/plain' }),
    '.log': Object.freeze({ kind: 'text', mime: 'text/plain' }),
});

/** Persisted metadata record in `session_artifacts` (no raw file content stored in DB). */
export interface ArtifactRecord {
    artifactId: string;
    sessionId: string;
    taskId: string | null;
    meshId?: string | null;
    missionId?: string | null;
    producerRole?: ArtifactProducerRole | string | null;
    originDaemonId?: string | null;
    workspaceRoot: string;
    relPath: string;
    kind: ArtifactKind;
    mime: string;
    title: string;
    sizeBytes: number;
    sha256: string;
    previewText: string | null;
    createdAt: number;
    updatedAt: number;
}

/** Wire-safe attachment metadata projected onto keyed chat transcript messages. */
export interface ChatAttachmentMeta {
    artifactId: string;
    kind: ArtifactKind;
    mime: string;
    filename: string;
    title: string;
    sizeBytes: number;
    sha256: string;
    previewText?: string;
    createdAt: number;
    updatedAt: number;
}

export type ArtifactErrorCode =
    | 'invalid_workspace_root'
    | 'path_outside_workspace'
    | 'not_a_regular_file'
    | 'artifact_too_large'
    | 'unsupported_mime_or_kind'
    | 'secret_file_refused'
    | 'session_artifact_limit_reached'
    | 'mission_artifact_limit_exceeded'
    | 'mission_artifact_limit_reached'
    | 'mesh_artifact_limit_exceeded'
    | 'mesh_artifact_limit_reached'
    | 'artifact_not_found'
    | 'artifact_session_mismatch'
    | 'artifact_access_denied';

export class ArtifactGuardError extends Error {
    readonly code: ArtifactErrorCode;

    constructor(code: ArtifactErrorCode, message: string) {
        super(message.includes(code) ? message : `${message} (${code})`);
        this.name = 'ArtifactGuardError';
        this.code = code;
    }
}

/** Convert an ArtifactRecord into wire-safe ChatAttachmentMeta. */
export function toChatAttachmentMeta(record: ArtifactRecord): ChatAttachmentMeta {
    const normalizedRel = record.relPath.replace(/\\/g, '/');
    const filename = path.posix.basename(normalizedRel) || normalizedRel;
    const meta: ChatAttachmentMeta = {
        artifactId: record.artifactId,
        kind: record.kind,
        mime: record.mime,
        filename,
        title: record.title,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
    if (record.previewText !== null) {
        meta.previewText = record.previewText;
    }
    return meta;
}
