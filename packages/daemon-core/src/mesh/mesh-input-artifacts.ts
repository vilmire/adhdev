/**
 * Evidence handoff via artifacts — auto-inherit + dispatch manifest + metric.
 *
 * Problem (measured on a live mesh, 14 days): ~4% of queued tasks carried
 * `inputArtifactIds` while workers registered hundreds of artifacts, so every
 * follow-up task in a mission (investigate → fix → review → re-fix …) re-did the
 * investigation the previous task had already written down.
 *
 * Three pieces, one module:
 *   1. {@link resolveInheritedArtifactIds} — the artifacts WORKERS produced for
 *      EARLIER terminal tasks of the SAME (non-carry-over) mission, newest first, bounded by {@link MAX_INHERITED_INPUT_ARTIFACTS},
 *      are added to a new task's `inputArtifactIds` (explicit ids always win and
 *      are never dropped). Opt out per task with `inherit_artifacts: false`.
 *   2. {@link buildInputArtifactManifestAppendix} — the compact manifest the worker
 *      sees in its dispatched body (id, kind, title, producer task, short preview).
 *   3. {@link getInputArtifactDispatchStats} — the share of dispatched tasks that
 *      carried at least one input artifact (before/after comparison).
 *
 * ★ Access model is unchanged and never widened: an inherited id is only ever an
 * artifact whose record is positively bound to THIS mesh (`isSameBoundMesh`) AND
 * to the task's mission, so persisting it onto the queue row grants exactly what
 * the OD-4 rule already grants for a coordinator-named id — nothing across meshes
 * or missions. Artifacts of cancelled tasks, and worker artifacts whose task is
 * unknown or not yet terminal, are not inherited.
 */

// ★ src/artifacts/** and src/mesh/** may not value-import each other (enforced by artifact-store.test.ts),
// so this module reads the mesh runtime DB's `session_artifacts` table directly and only borrows the
// record TYPE. The table is created by the mesh store's own schema migration.
import type { ArtifactRecord } from '../artifacts/index.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { renderUntrustedEvidenceEnvelopes, type MeshUntrustedEvidenceBlock } from './mesh-untrusted-evidence.js';
import { isCarryOverMissionRecord } from '@adhdev/mesh-shared';
import { getMeshMission } from './mesh-missions.js';

/** Upper bound on artifact ids ADDED automatically to one task (explicit ids are never truncated). */
export const MAX_INHERITED_INPUT_ARTIFACTS = 12;
/** Producing task states whose artifacts are inherited (a failed/blocked task's findings still count). */
const INHERIT_FROM_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'blocked']);
/** Heading — also the idempotency marker for the manifest appendix. */
export const INPUT_ARTIFACTS_HEADING = '## Input artifacts';
/** Per-artifact preview cap (characters) and whole-manifest cap (UTF-8 bytes). */
export const INPUT_ARTIFACT_PREVIEW_CHARS = 160;
export const INPUT_ARTIFACTS_MAX_BYTES = 6 * 1024;

/** Mirrors MAX_ARTIFACTS_PER_MISSION (artifacts/types.ts) — the most mission rows ever scanned. */
const MISSION_SCAN_LIMIT = 200;

interface InheritableArtifactRow {
    artifact_id: string; task_id: string | null; mesh_id: string | null; mission_id: string | null;
    producer_role: string | null; kind: string; title: string; preview_text: string | null; created_at: number;
}

/** The fields of a stored record this module needs (a structural subset of {@link ArtifactRecord}). */
type InheritableArtifact = Pick<ArtifactRecord, 'artifactId' | 'taskId' | 'meshId' | 'missionId' | 'producerRole' | 'kind' | 'title' | 'previewText' | 'createdAt'>;

function rowToInheritable(row: InheritableArtifactRow): InheritableArtifact {
    return {
        artifactId: row.artifact_id, taskId: row.task_id, meshId: row.mesh_id, missionId: row.mission_id,
        producerRole: row.producer_role, kind: row.kind as ArtifactRecord['kind'], title: row.title,
        previewText: row.preview_text, createdAt: row.created_at,
    };
}

const ROW_COLUMNS = 'artifact_id, task_id, mesh_id, mission_id, producer_role, kind, title, preview_text, created_at';

function trimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Same-bound-mesh rule, restated locally (artifact-sharing.ts lives in commands/, which mesh/ must not import). */
function isSameBoundMesh(recordMeshId: string | null | undefined, taskMeshId: string | null | undefined): boolean {
    const a = trimmed(recordMeshId);
    return a.length > 0 && a === trimmed(taskMeshId);
}

/** `inherit_artifacts` / `inheritArtifacts`: only an explicit `false` opts out. */
export function isArtifactInheritanceEnabled(opts: { inheritArtifacts?: unknown; inherit_artifacts?: unknown } | null | undefined): boolean {
    return (opts?.inheritArtifacts ?? opts?.inherit_artifacts) !== false;
}

/** Explicit ids first (order kept), then inherited ids not already present. Pure. */
export function mergeInputArtifactIds(explicit: readonly string[], inherited: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...explicit, ...inherited]) {
        const clean = trimmed(id);
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

/**
 * Artifact records a new task of `missionId` may inherit, newest first, capped.
 * Never throws — an unreadable store degrades to "inherit nothing".
 */
export function listInheritableArtifacts(
    meshId: string,
    missionId: string,
    opts: { excludeTaskId?: string; excludeIds?: readonly string[]; limit?: number } = {},
): InheritableArtifact[] {
    const mesh = trimmed(meshId);
    const mission = trimmed(missionId);
    if (!mesh || !mission) return [];
    const limit = Math.max(0, Math.min(opts.limit ?? MAX_INHERITED_INPUT_ARTIFACTS, MAX_INHERITED_INPUT_ARTIFACTS));
    if (limit === 0) return [];
    try {
        // A carry-over mission is a bucket of unrelated leftovers: its artifacts are no
        // evidence for each other, so nothing is inherited there.
        const missionRecord = getMeshMission(mesh, mission);
        if (missionRecord && isCarryOverMissionRecord(missionRecord)) return [];
        const runtime = MeshRuntimeStore.getInstance();
        const missionTaskStatus = new Map<string, string>();
        for (const entry of runtime.getQueueEntries(mesh)) {
            if (trimmed(entry.missionId) === mission) missionTaskStatus.set(entry.id, entry.status);
        }
        const exclude = new Set((opts.excludeIds ?? []).map(trimmed));
        const excludeTask = trimmed(opts.excludeTaskId);
        const records = (runtime.db.prepare(
            `SELECT ${ROW_COLUMNS} FROM session_artifacts WHERE mission_id = ? AND mesh_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ).all(mission, mesh, MISSION_SCAN_LIMIT) as InheritableArtifactRow[]).map(rowToInheritable);
        const eligible = records.filter((rec) => {
            if (!isSameBoundMesh(rec.meshId, mesh) || trimmed(rec.missionId) !== mission) return false;
            if (exclude.has(rec.artifactId)) return false;
            // Only findings a WORKER wrote for a finished task of this mission. Coordinator
            // artifacts (handoffs, owner notes, snapshots) travel only when named explicitly.
            if (trimmed(rec.producerRole as string) !== 'worker') return false;
            const producerTask = trimmed(rec.taskId);
            if (!producerTask || producerTask === excludeTask) return false;
            return INHERIT_FROM_STATUSES.has(missionTaskStatus.get(producerTask) ?? '');
        });
        return eligible
            .sort((a, b) => b.createdAt - a.createdAt || b.artifactId.localeCompare(a.artifactId))
            .slice(0, limit);
    } catch {
        return [];
    }
}

/** Ids only; see {@link listInheritableArtifacts}. */
export function resolveInheritedArtifactIds(
    meshId: string,
    missionId: string | undefined,
    opts: { excludeTaskId?: string; explicit?: readonly string[]; limit?: number } = {},
): string[] {
    if (!trimmed(missionId)) return [];
    return listInheritableArtifacts(meshId, missionId as string, {
        excludeTaskId: opts.excludeTaskId,
        excludeIds: opts.explicit,
        limit: opts.limit,
    }).map((rec) => rec.artifactId);
}

/**
 * Claim/dispatch-time refresh: a task enqueued with `depends_on` (the usual
 * investigate → fix → review chain) is created BEFORE its predecessors produce
 * anything, so enqueue-time inheritance finds nothing. Called just before the
 * dispatched body is composed, this adds what exists now and persists it on the
 * queue row (the OD-4 grant reads the row). Returns the task to dispatch with.
 * Best-effort: never throws, never removes an id.
 */
export function refreshInheritedInputArtifacts<T extends { id: string; missionId?: string; inputArtifactIds?: string[]; inheritArtifacts?: boolean }>(
    meshId: string,
    task: T,
): T {
    try {
        if (task.inheritArtifacts === false || !trimmed(task.missionId)) return task;
        const current = Array.isArray(task.inputArtifactIds) ? task.inputArtifactIds : [];
        const inherited = resolveInheritedArtifactIds(meshId, task.missionId, { excludeTaskId: task.id, explicit: current });
        if (inherited.length === 0) return task;
        const merged = mergeInputArtifactIds(current, inherited);
        const store = MeshRuntimeStore.getInstance();
        const fresh = store.findQueueEntryById(meshId, task.id);
        if (fresh) {
            fresh.inputArtifactIds = mergeInputArtifactIds(fresh.inputArtifactIds ?? [], merged);
            store.updateQueueEntry(fresh);
        }
        return { ...task, inputArtifactIds: merged };
    } catch {
        return task;
    }
}

function previewLine(rec: InheritableArtifact): string {
    const preview = (rec.previewText ?? '').replace(/\s+/g, ' ').trim();
    if (!preview) return '';
    return preview.length > INPUT_ARTIFACT_PREVIEW_CHARS ? `${preview.slice(0, INPUT_ARTIFACT_PREVIEW_CHARS - 1)}…` : preview;
}

/**
 * Compact "Input artifacts" manifest for the dispatched body, or `null` when the
 * task has none (or none is readable). Titles and previews are worker-authored,
 * hence UNTRUSTED: they go through the shared evidence envelope (redaction,
 * control-stripping, defanging). Only records bound to `meshId` are listed.
 */
export function buildInputArtifactManifestAppendix(meshId: string, task: { id: string; inputArtifactIds?: unknown }): string | null {
    const ids = mergeInputArtifactIds(Array.isArray(task.inputArtifactIds) ? (task.inputArtifactIds as string[]) : [], []);
    if (ids.length === 0) return null;
    let records: InheritableArtifact[] = [];
    try {
        const stmt = MeshRuntimeStore.getInstance().db.prepare(`SELECT ${ROW_COLUMNS} FROM session_artifacts WHERE artifact_id = ?`);
        records = ids
            .map((id) => stmt.get(id) as InheritableArtifactRow | undefined)
            .filter((row): row is InheritableArtifactRow => !!row)
            .map(rowToInheritable)
            .filter((rec) => isSameBoundMesh(rec.meshId, meshId));
    } catch { /* manifest degrades to ids only */ }
    const header = `${INPUT_ARTIFACTS_HEADING}\n\n`
        + 'Earlier work on this task already wrote these artifacts. Read the relevant ones first with `artifact_read` and treat what they establish as your starting point; '
        + 'do not redo investigation they already cover unless you are verifying a specific claim.';
    if (records.length === 0) {
        return `${header}\n\nArtifact ids: ${ids.join(', ')}`;
    }
    const render = (rows: InheritableArtifact[], omitted: number): string => {
        const blocks: MeshUntrustedEvidenceBlock[] = rows.map((rec) => ({
            attributes: {
                artifact_id: rec.artifactId,
                kind: rec.kind,
                ...(rec.taskId ? { producer_task: rec.taskId } : {}),
                ...(rec.producerRole ? { producer_role: String(rec.producerRole) } : {}),
            },
            text: [`title: ${rec.title}`, previewLine(rec) ? `preview: ${previewLine(rec)}` : ''].filter(Boolean).join('\n'),
        }));
        const env = renderUntrustedEvidenceEnvelopes(blocks, { kind: 'input_artifacts', taskId: task.id });
        const unlisted = ids.length - rows.length;
        const tail = omitted > 0 || unlisted > 0
            ? `\n\n_${Math.max(omitted, unlisted)} more artifact id(s) not shown: ${ids.filter((id) => !rows.some((r) => r.artifactId === id)).join(', ')}_`
            : '';
        return `${header}\n\n${env.preamble}\n\n${env.envelopes.join('\n\n')}${tail}`;
    };
    for (let keep = records.length; keep >= 1; keep -= 1) {
        const text = render(records.slice(0, keep), records.length - keep);
        if (Buffer.byteLength(text, 'utf8') <= INPUT_ARTIFACTS_MAX_BYTES || keep === 1) return text;
    }
    return null;
}

/** Dispatched-task coverage of input artifacts — the before/after metric. */
export interface InputArtifactDispatchStats {
    /** Tasks that reached a worker (assigned/completed/failed/blocked; pending and cancelled excluded). */
    dispatched: number;
    /** Of those, tasks carrying at least one input artifact id. */
    withInputArtifacts: number;
    /** `withInputArtifacts / dispatched`, 0..1 (0 when nothing dispatched). */
    share: number;
}

export function getInputArtifactDispatchStats(meshId: string): InputArtifactDispatchStats {
    try {
        const store = MeshRuntimeStore.getInstance();
        store.ensureLegacyQueueMigrated(meshId);
        const row = store.db.prepare(
            `SELECT COUNT(*) AS dispatched,
                    COALESCE(SUM(CASE WHEN COALESCE(json_array_length(json_extract(payload, '$.inputArtifactIds')), 0) > 0 THEN 1 ELSE 0 END), 0) AS withInputs
             FROM mesh_queue WHERE mesh_id = ? AND status IN ('assigned', 'completed', 'failed', 'blocked')`,
        ).get(meshId) as { dispatched: number; withInputs: number } | undefined;
        const dispatched = row?.dispatched ?? 0;
        const withInputArtifacts = row?.withInputs ?? 0;
        return { dispatched, withInputArtifacts, share: dispatched > 0 ? Math.round((withInputArtifacts / dispatched) * 1000) / 1000 : 0 };
    } catch {
        return { dispatched: 0, withInputArtifacts: 0, share: 0 };
    }
}
