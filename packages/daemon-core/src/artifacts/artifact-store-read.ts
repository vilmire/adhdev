/**
 * Artifact content read / paging helpers (file-size split from artifact-store).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readVerifiedArtifactFile, type ArtifactTestRaceHooks } from './artifact-path-guard.js';
import {
    ArtifactGuardError,
    MAX_ARTIFACT_MCP_PAGE_BYTES,
    type ArtifactRecord,
} from './types.js';

export interface FetchArtifactContentOptions {
    sessionId?: string;
    trustedWorkspaceRoot?: string;
    _testHooks?: ArtifactTestRaceHooks;
}

export interface FetchArtifactContentResult {
    artifactId: string;
    sessionId: string;
    relPath: string;
    kind: ArtifactRecord['kind'];
    mime: string;
    title: string;
    content: string;
    encoding: 'utf8' | 'base64';
    sizeBytes: number;
    sha256: string;
    registeredSha256: string;
    sha256Changed: boolean;
    hashChanged: boolean;
}

export interface ReadArtifactContentOptions extends FetchArtifactContentOptions {
    offset?: number;
    limit?: number;
}

export interface ReadArtifactContentResult extends FetchArtifactContentResult {
    /** Exact page bytes, including split UTF-8 sequences. Text display is not a byte receipt. */
    byteContentBase64: string;
    totalBytes: number;
    offset: number;
    pageBytes: number;
    hasMore: boolean;
    nextOffset: number | null;
}

export function verifyAndReadArtifactBuffer(
    record: ArtifactRecord,
    options?: FetchArtifactContentOptions,
) {
    if (options?.sessionId !== undefined && record.sessionId !== options.sessionId) {
        throw new ArtifactGuardError(
            'artifact_session_mismatch',
            `Artifact "${record.artifactId}" does not belong to session "${options.sessionId}" (artifact_session_mismatch)`,
        );
    }

    const pinnedCanonicalRoot = path.resolve(record.workspaceRoot);
    let storedRootLstat: fs.Stats;
    let currentRealStoredRoot: string;
    try {
        storedRootLstat = fs.lstatSync(pinnedCanonicalRoot);
        currentRealStoredRoot = fs.realpathSync(pinnedCanonicalRoot);
    } catch {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Stored canonical workspace root is missing or inaccessible (path_outside_workspace)',
        );
    }
    if (
        storedRootLstat.isSymbolicLink() ||
        !storedRootLstat.isDirectory() ||
        currentRealStoredRoot !== pinnedCanonicalRoot
    ) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Stored canonical workspace root was redirected or replaced by a symbolic link (path_outside_workspace)',
        );
    }

    if (options?.trustedWorkspaceRoot !== undefined) {
        let realTrustedRoot: string;
        try {
            realTrustedRoot = fs.realpathSync(options.trustedWorkspaceRoot);
        } catch {
            throw new ArtifactGuardError(
                'invalid_workspace_root',
                'Trusted workspace root cannot be resolved (invalid_workspace_root)',
            );
        }
        if (realTrustedRoot !== pinnedCanonicalRoot) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Artifact workspace root does not match trusted workspace root (path_outside_workspace)',
            );
        }
    }

    return readVerifiedArtifactFile(pinnedCanonicalRoot, record.relPath, {
        declaredKind: record.kind,
        declaredMime: record.mime,
        title: record.title,
        pinnedCanonicalWorkspaceRoot: pinnedCanonicalRoot,
        _testHooks: options?._testHooks,
    });
}

export function readArtifactRecordPaged(
    record: ArtifactRecord,
    options?: ReadArtifactContentOptions,
): ReadArtifactContentResult {
    const verified = verifyAndReadArtifactBuffer(record, options);

    const encoding: 'utf8' | 'base64' = record.kind === 'image' ? 'base64' : 'utf8';
    const rawTotalBytes = verified.buffer.byteLength;
    const rawOffsetOpt =
        typeof options?.offset === 'number'
            ? options.offset
            : typeof (options as { pageOffset?: unknown } | undefined)?.pageOffset === 'number'
              ? ((options as { pageOffset?: number }).pageOffset as number)
              : undefined;
    const requestedOffset =
        typeof rawOffsetOpt === 'number' && Number.isFinite(rawOffsetOpt) && rawOffsetOpt >= 0
            ? Math.trunc(rawOffsetOpt)
            : 0;
    const requestedLimit =
        typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
            ? Math.min(Math.trunc(options.limit), MAX_ARTIFACT_MCP_PAGE_BYTES)
            : MAX_ARTIFACT_MCP_PAGE_BYTES;

    const safeOffset = Math.min(requestedOffset, rawTotalBytes);
    const endOffset = Math.min(safeOffset + requestedLimit, rawTotalBytes);
    const slice = verified.buffer.subarray(safeOffset, endOffset);
    const pageBytes = slice.byteLength;
    const hasMore = endOffset < rawTotalBytes;
    const nextOffset = hasMore ? endOffset : null;
    const content = encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8');
    const sha256Changed = verified.sha256 !== record.sha256;

    return {
        artifactId: record.artifactId,
        sessionId: record.sessionId,
        relPath: record.relPath,
        kind: record.kind,
        mime: record.mime,
        title: record.title,
        content,
        byteContentBase64: slice.toString('base64'),
        encoding,
        sizeBytes: verified.sizeBytes,
        totalBytes: rawTotalBytes,
        offset: safeOffset,
        pageBytes,
        hasMore,
        nextOffset,
        sha256: verified.sha256,
        registeredSha256: record.sha256,
        sha256Changed,
        hashChanged: sha256Changed,
    };
}

export function buildFetchArtifactContentResult(
    record: ArtifactRecord,
    options?: FetchArtifactContentOptions,
): FetchArtifactContentResult {
    const verified = verifyAndReadArtifactBuffer(record, options);
    const encoding: 'utf8' | 'base64' = record.kind === 'image' ? 'base64' : 'utf8';
    const content =
        encoding === 'base64'
            ? verified.buffer.toString('base64')
            : verified.buffer.toString('utf8');
    const sha256Changed = verified.sha256 !== record.sha256;
    return {
        artifactId: record.artifactId,
        sessionId: record.sessionId,
        relPath: record.relPath,
        kind: record.kind,
        mime: record.mime,
        title: record.title,
        content,
        encoding,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        registeredSha256: record.sha256,
        sha256Changed,
        hashChanged: sha256Changed,
    };
}
