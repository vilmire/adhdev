/**
 * Artifact storage admission: soft list-window counts stay advisory;
 * hard budgets gate NEW metadata/payload growth without deleting existing rows.
 *
 * Billing is conservative (not equal to on-disk SQLite/WAL size):
 * - metadata: max(4 KiB, UTF-8 of key columns) per row
 * - payload: registered size_bytes (duplicate content still billed per row)
 */

import {
    ARTIFACT_METADATA_BUDGET_BYTES,
    ARTIFACT_METADATA_ROW_FLOOR_BYTES,
    ARTIFACT_PAYLOAD_BUDGET_BYTES,
    ArtifactGuardError,
} from './types.js';

export interface ArtifactAdmissionDb {
    prepare<Row = any>(sql: string): {
        get(...params: unknown[]): Row | undefined;
    };
}

export interface ArtifactAdmissionTotals {
    rowCount: number;
    metadataBytes: number;
    payloadBytes: number;
}

export interface ArtifactAdmissionDelta {
    metadataBytes: number;
    payloadBytes: number;
}

export function estimateArtifactMetadataBytes(fields: {
    artifactId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    meshId?: string | null;
    missionId?: string | null;
    producerRole?: string | null;
    originDaemonId?: string | null;
    workspaceRoot?: string | null;
    relPath?: string | null;
    kind?: string | null;
    mime?: string | null;
    title?: string | null;
    sha256?: string | null;
    previewText?: string | null;
}): number {
    const parts = [
        fields.artifactId,
        fields.sessionId,
        fields.taskId,
        fields.meshId,
        fields.missionId,
        fields.producerRole,
        fields.originDaemonId,
        fields.workspaceRoot,
        fields.relPath,
        fields.kind,
        fields.mime,
        fields.title,
        fields.sha256,
        fields.previewText,
    ];
    let utf8 = 0;
    for (const part of parts) {
        if (typeof part === 'string' && part.length > 0) {
            utf8 += Buffer.byteLength(part, 'utf8');
        }
    }
    // Integer columns + conservative index/row overhead.
    utf8 += 48;
    return Math.max(ARTIFACT_METADATA_ROW_FLOOR_BYTES, utf8);
}

/** SQLite UTF-8 byte length — LENGTH(TEXT) is character count and under-bills Unicode. */
function sqlUtf8ByteLen(column: string): string {
    return `LENGTH(CAST(COALESCE(${column}, '') AS BLOB))`;
}

const SQL_METADATA_UTF8_SUM = [
    'artifact_id',
    'session_id',
    'task_id',
    'mesh_id',
    'mission_id',
    'producer_role',
    'origin_daemon_id',
    'workspace_root',
    'rel_path',
    'kind',
    'mime',
    'title',
    'sha256',
    'preview_text',
]
    .map(sqlUtf8ByteLen)
    .join(' + ');

export function readArtifactAdmissionTotals(db: ArtifactAdmissionDb): ArtifactAdmissionTotals {
    const row = db
        .prepare<{
            row_count: number | null;
            payload_bytes: number | null;
            metadata_bytes: number | null;
        }>(
            `SELECT
                COUNT(*) AS row_count,
                COALESCE(SUM(size_bytes), 0) AS payload_bytes,
                COALESCE(SUM(
                    CASE
                        WHEN (
                            48
                            + ${SQL_METADATA_UTF8_SUM}
                        ) < ${ARTIFACT_METADATA_ROW_FLOOR_BYTES}
                        THEN ${ARTIFACT_METADATA_ROW_FLOOR_BYTES}
                        ELSE (
                            48
                            + ${SQL_METADATA_UTF8_SUM}
                        )
                    END
                ), 0) AS metadata_bytes
             FROM session_artifacts`,
        )
        .get();
    return {
        rowCount: Math.max(0, Math.trunc(Number(row?.row_count ?? 0))),
        payloadBytes: Math.max(0, Math.trunc(Number(row?.payload_bytes ?? 0))),
        metadataBytes: Math.max(0, Math.trunc(Number(row?.metadata_bytes ?? 0))),
    };
}

export function assertArtifactAdmissionAllows(
    totals: ArtifactAdmissionTotals,
    delta: ArtifactAdmissionDelta,
): void {
    const nextMetadata = totals.metadataBytes + Math.max(0, Math.trunc(delta.metadataBytes));
    const nextPayload = totals.payloadBytes + Math.max(0, Math.trunc(delta.payloadBytes));
    if (nextMetadata > ARTIFACT_METADATA_BUDGET_BYTES) {
        throw new ArtifactGuardError(
            'artifact_storage_budget_exceeded',
            `Artifact metadata budget exceeded (${nextMetadata} > ${ARTIFACT_METADATA_BUDGET_BYTES}) (artifact_storage_budget_exceeded)`,
            {
                scope: 'metadata',
                currentBytes: totals.metadataBytes,
                deltaBytes: delta.metadataBytes,
                limitBytes: ARTIFACT_METADATA_BUDGET_BYTES,
                counts: { rows: totals.rowCount },
                preserved: true,
                retryable: false,
            },
        );
    }
    if (nextPayload > ARTIFACT_PAYLOAD_BUDGET_BYTES) {
        throw new ArtifactGuardError(
            'artifact_storage_budget_exceeded',
            `Artifact payload budget exceeded (${nextPayload} > ${ARTIFACT_PAYLOAD_BUDGET_BYTES}) (artifact_storage_budget_exceeded)`,
            {
                scope: 'payload',
                currentBytes: totals.payloadBytes,
                deltaBytes: delta.payloadBytes,
                limitBytes: ARTIFACT_PAYLOAD_BUDGET_BYTES,
                counts: { rows: totals.rowCount },
                preserved: true,
                retryable: false,
            },
        );
    }
}

export function mapStorageErrnoToArtifactError(err: unknown): ArtifactGuardError | null {
    const anyErr = err as { code?: string; message?: string; errno?: number } | null;
    const code = String(anyErr?.code ?? '');
    const message = String(anyErr?.message ?? err ?? '');
    const upper = `${code} ${message}`.toUpperCase();
    if (
        code === 'ENOSPC' ||
        code === 'SQLITE_FULL' ||
        code === 'SQLITE_IOERR' ||
        upper.includes('ENOSPC') ||
        upper.includes('SQLITE_FULL') ||
        upper.includes('SQLITE_IOERR') ||
        upper.includes('NO SPACE')
    ) {
        return new ArtifactGuardError(
            'artifact_storage_unavailable',
            `Artifact storage unavailable (${code || 'io'}) (artifact_storage_unavailable)`,
            {
                errno: anyErr?.errno ?? (code || null),
                preserved: true,
                retryable: false,
            },
        );
    }
    return null;
}
