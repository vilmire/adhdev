/**
 * Owner-scoped mesh artifact listing for the dashboard "Artifacts" tab.
 *
 * A trusted OWNER (dashboard / standalone ingress) may list every artifact of a
 * mesh — including records indexed from other daemons via `artifact_index_forwarded`,
 * which live in the same `session_artifacts` table — without naming a session.
 * Worker / coordinator / MCP callers never reach this path: it only fires for a
 * trusted owner ingress that carries a `meshId` and no session or worker credential,
 * so every other caller keeps the existing authorization flow untouched.
 *
 * Pagination is a keyset cursor over the store's creation-order window:
 * results are newest-`limit` records (oldest-first, like every other listing) and
 * `nextCursor` points at the oldest returned record; pass it back to get the next
 * older page. No file content is ever returned — metadata and the bounded preview only.
 */

import {
    ARTIFACT_KINDS,
    MAX_ARTIFACTS_PER_MESH,
    toChatAttachmentMeta,
    type ArtifactKind,
    type ArtifactRecord,
    type ChatAttachmentMeta,
} from '../../artifacts/index.js';
import { hasWorkerCredentialInput } from './artifact-command-ingress.js';
import { getArtifactStore, type ArtifactCommandContext } from './artifact-runtime.js';
import type { CommandRouterResult } from '../router.js';

export const OWNER_MESH_LIST_DEFAULT_LIMIT = 100;

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** True when the args ask for the owner mesh-wide listing (and nothing that names a session/worker). */
export function isOwnerMeshListRequest(args: Record<string, unknown> | null | undefined, ownerTrusted: boolean): boolean {
    if (!ownerTrusted || !args) return false;
    if (!str(args.meshId)) return false;
    if (str(args.sessionId) || str(args.targetSessionId) || str(args.callerSessionId)) return false;
    return !hasWorkerCredentialInput(args);
}

interface Cursor {
    createdAt: number;
    artifactId: string;
}

function parseCursor(raw: unknown): Cursor | null {
    const text = str(raw);
    if (!text) return null;
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    const createdAt = Number(text.slice(0, sep));
    const artifactId = text.slice(sep + 1);
    if (!Number.isFinite(createdAt) || !artifactId) return null;
    return { createdAt, artifactId };
}

function encodeCursor(record: ArtifactRecord): string {
    return `${record.createdAt}:${record.artifactId}`;
}

export function handleOwnerMeshArtifactList(
    ctx: ArtifactCommandContext,
    args: Record<string, unknown>,
): CommandRouterResult & {
    meshId?: string;
    artifacts?: ArtifactRecord[];
    attachments?: ChatAttachmentMeta[];
    hasMore?: boolean;
    nextCursor?: string | null;
} {
    const meshId = str(args.meshId);
    const missionId = str(args.missionId);
    const kind = str(args.kind);
    if (kind && !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        return { success: false, code: 'invalid_kind', error: `Unsupported artifact kind "${kind}" (invalid_kind)` };
    }
    const rawLimit = args.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACTS_PER_MESH)
            : OWNER_MESH_LIST_DEFAULT_LIMIT;
    const cursor = parseCursor(args.cursor);

    const store = getArtifactStore(ctx);
    // Oldest-first list of the mesh's records (bounded by MAX_ARTIFACTS_PER_MESH).
    let records = store.listByMesh(meshId, { ...(missionId ? { missionId } : {}) });
    if (kind) records = records.filter((rec) => rec.kind === (kind as ArtifactKind));
    if (cursor) {
        const at = records.findIndex((rec) => rec.artifactId === cursor.artifactId);
        // Cursor record deleted between pages: fall back to the (createdAt, artifactId)
        // tuple so same-millisecond siblings are not skipped wholesale.
        records =
            at >= 0
                ? records.slice(0, at)
                : records.filter(
                      (rec) =>
                          rec.createdAt < cursor.createdAt ||
                          (rec.createdAt === cursor.createdAt && rec.artifactId < cursor.artifactId),
                  );
    }
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(records.length - limit) : records;
    return {
        success: true,
        meshId,
        artifacts: page,
        attachments: page.map((record) => toChatAttachmentMeta(record)),
        hasMore,
        nextCursor: hasMore && page.length > 0 ? encodeCursor(page[0]!) : null,
    };
}
