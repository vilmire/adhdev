/**
 * Assistant local artifact list/read helpers — extracted from `./assistant.ts`
 * (behavior-preserving pure move).
 *
 * Caller authorization (`authorizeAssistantArtifactCaller` + `assistantToolGate`)
 * and remote-project relay routing stay in `./assistant.ts` on the verb entrypoints.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import {
    ArtifactStore,
    MAX_ARTIFACT_BYTES,
    MAX_ARTIFACT_MCP_PAGE_BYTES,
    maxBase64EncodedBytes,
    reassembleBase64ArtifactChunks,
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
} from '../../artifacts/index.js';
import type { AssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import type { HighFamilyContext } from './types.js';

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function localArtifactList(meshId: string, args: Record<string, unknown>) {
    const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
    const sessionId = str(args.sessionId ?? args.session_id) || undefined;
    const missionId = str(args.missionId ?? args.mission_id) || undefined;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
    const artifacts = store.listByMesh(meshId, { sessionId, missionId, limit });
    return { meshId, artifacts, attachments: artifacts.map(toChatAttachmentMeta) };
}

export async function localArtifactRead(
    ports: AssistantProjectPorts,
    meshId: string,
    args: Record<string, unknown>,
    ctx?: HighFamilyContext,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string; error: string }> {
    const artifactId = str(args.artifactId ?? args.artifact_id);
    if (!artifactId) return { ok: false, code: 'invalid_args', error: 'artifactId required' };
    const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
    const record = store.getById(artifactId);
    if (!record) return { ok: false, code: 'artifact_not_found', error: `Artifact '${artifactId}' not found.` };
    if (record.meshId !== meshId) {
        return { ok: false, code: 'cross_mesh_artifact_denied', error: `Artifact '${artifactId}' does not belong to mesh '${meshId}'.` };
    }
    const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.min(Math.max(1, Math.floor(args.limit)), MAX_ARTIFACT_MCP_PAGE_BYTES)
        : MAX_ARTIFACT_MCP_PAGE_BYTES;
    const self = ports.selfDaemonId();
    if (record.originDaemonId && (!self || !daemonIdsEquivalent(record.originDaemonId, self))) {
        if (!ctx?.deps?.dispatchMeshCommand) {
            return { ok: false, code: 'artifact_origin_unreachable', error: `Artifact '${artifactId}' resides on origin daemon '${record.originDaemonId}' and no P2P mesh transport is available.` };
        }
        try {
            const p2pRaw: any = await ctx.deps.dispatchMeshCommand(record.originDaemonId, 'artifact_fetch_origin', {
                artifactId, meshId, mode: 'read', offset: rawOffset, limit: rawLimit, asChunks: true,
            });
            const p2pRes = p2pRaw && typeof p2pRaw === 'object' && 'result' in p2pRaw && p2pRaw.result && typeof p2pRaw.result === 'object' ? p2pRaw.result : p2pRaw;
            if (!p2pRes || p2pRes.success === false) {
                return { ok: false, code: str(p2pRes?.code) || 'artifact_origin_unreachable', error: str(p2pRes?.error) || 'Failed to read artifact from origin daemon.' };
            }
            const isBase64Image = record.kind === 'image' || p2pRes.encoding === 'base64';
            const transportMaxBytes = isBase64Image
                ? maxBase64EncodedBytes(MAX_ARTIFACT_MCP_PAGE_BYTES)
                : MAX_ARTIFACT_MCP_PAGE_BYTES;
            if (
                (typeof p2pRes.totalBytes === 'number' && p2pRes.totalBytes > MAX_ARTIFACT_BYTES) ||
                (typeof p2pRes.pageBytes === 'number' && p2pRes.pageBytes > MAX_ARTIFACT_MCP_PAGE_BYTES)
            ) {
                return { ok: false, code: 'artifact_too_large', error: `Artifact page exceeds ${MAX_ARTIFACT_MCP_PAGE_BYTES} bytes (artifact_too_large)` };
            }
            let rawContent = '';
            if (Array.isArray(p2pRes.chunks) && p2pRes.chunks.length > 0) {
                const reassembled = reassembleBase64ArtifactChunks(p2pRes.chunks, transportMaxBytes);
                if (!reassembled.ok) return { ok: false, code: reassembled.code, error: reassembled.error };
                rawContent = reassembled.content;
            } else if (typeof p2pRes.content === 'string') {
                if (Buffer.byteLength(p2pRes.content, 'utf8') > transportMaxBytes) {
                    return { ok: false, code: 'artifact_too_large', error: `Artifact page exceeds ${MAX_ARTIFACT_MCP_PAGE_BYTES} bytes (artifact_too_large)` };
                }
                rawContent = p2pRes.content;
            }
            let decodedByteLength = Buffer.byteLength(rawContent, 'utf8');
            if (isBase64Image && rawContent.length > 0) {
                decodedByteLength = Buffer.from(rawContent, 'base64').byteLength;
                if (decodedByteLength > MAX_ARTIFACT_MCP_PAGE_BYTES || decodedByteLength > MAX_ARTIFACT_BYTES) {
                    return { ok: false, code: 'artifact_too_large', error: `Artifact page exceeds ${MAX_ARTIFACT_MCP_PAGE_BYTES} bytes (artifact_too_large)` };
                }
            }
            return {
                ok: true,
                result: {
                    artifactId,
                    artifact: record,
                    attachment: toChatAttachmentMeta(record),
                    content: wrapUntrustedArtifactContent(rawContent),
                    totalBytes: typeof p2pRes.totalBytes === 'number' ? p2pRes.totalBytes : record.sizeBytes,
                    offset: typeof p2pRes.offset === 'number' ? p2pRes.offset : rawOffset,
                    pageBytes: typeof p2pRes.pageBytes === 'number' ? p2pRes.pageBytes : decodedByteLength,
                    hasMore: Boolean(p2pRes.hasMore),
                    nextOffset: typeof p2pRes.nextOffset === 'number' ? p2pRes.nextOffset : null,
                    source: 'p2p_origin',
                    originDaemonId: record.originDaemonId,
                },
            };
        } catch (err) {
            return { ok: false, code: 'artifact_origin_unreachable', error: err instanceof Error ? err.message : String(err) };
        }
    }
    try {
        const readRes = store.readArtifactContent(artifactId, { offset: rawOffset, limit: rawLimit });
        return {
            ok: true,
            result: {
                artifactId,
                artifact: record,
                attachment: toChatAttachmentMeta(record),
                content: wrapUntrustedArtifactContent(readRes.content),
                totalBytes: readRes.totalBytes,
                offset: readRes.offset,
                pageBytes: readRes.pageBytes,
                hasMore: readRes.hasMore,
                nextOffset: readRes.nextOffset,
                source: 'local',
            },
        };
    } catch (err: any) {
        return { ok: false, code: str(err?.code) || 'artifact_read_failed', error: err instanceof Error ? err.message : String(err) };
    }
}
