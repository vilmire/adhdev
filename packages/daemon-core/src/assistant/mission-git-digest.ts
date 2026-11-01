/**
 * Data-backed replacement for the assistant's "looks finished" guess about missions
 * (design 2026-11-01-mission-git-refs §6): two lists computed from the CACHED git verdicts
 * of a mesh's active missions and their item counts —
 *   - `landedStillOpen`   : active, every referenced commit/branch is on the default branch,
 *                           and no remaining / live_check / decision item is open;
 *   - `finishedNotLanded` : active, every task is terminal, yet the referenced changes are
 *                           (partly) NOT on the default branch.
 * `landed` only ever feeds this list, a badge and notice wording — it never closes a mission,
 * and `unknown` is never reported as "not landed". Pure reads: no git, no network, no writes.
 *
 * Content boundary: ids, titles (<= 60 chars, as the status view already carries), enums.
 */
import { isCarryOverMissionRecord } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { getActiveMeshMissionSummaries } from '../mesh/mesh-missions.js';
import { readMissionGitStates } from '../mesh/mesh-mission-git-eval.js';

export interface MissionGitDigestEntry { missionId: string; title: string; gitState: string; partialUnknown?: boolean }
export interface MissionGitDigest {
    counts: Record<string, number>;
    landedStillOpen: MissionGitDigestEntry[];
    finishedNotLanded: MissionGitDigestEntry[];
}

const LIST_MAX = 8;
const TITLE_MAX = 60;

export function collectMissionGitDigest(meshId: string): MissionGitDigest {
    const out: MissionGitDigest = { counts: {}, landedStillOpen: [], finishedNotLanded: [] };
    let missions;
    try { missions = getActiveMeshMissionSummaries(meshId).filter(m => !isCarryOverMissionRecord(m)); } catch { return out; }
    if (missions.length === 0) return out;
    const states = readMissionGitStates(meshId, missions.map(m => m.id));
    const open = MeshRuntimeStore.getInstance().missionItems().openCountsByMission(meshId);
    for (const m of missions) {
        const s = states.get(m.id);
        if (!s || s.state === 'no_refs') continue;
        out.counts[s.state] = (out.counts[s.state] ?? 0) + 1;
        const entry: MissionGitDigestEntry = { missionId: m.id, title: m.title.slice(0, TITLE_MAX), gitState: s.state, ...(s.partialUnknown ? { partialUnknown: true } : {}) };
        const c = open.get(m.id);
        const openWork = (c?.remaining ?? 0) + (c?.live_check ?? 0) + (c?.decision ?? 0);
        if (s.state === 'landed' && openWork === 0) out.landedStillOpen.push(entry);
        const t = m.tasks;
        const allTerminal = t.total > 0 && t.pending === 0 && t.assigned === 0;
        if (allTerminal && (s.state === 'not_landed' || s.state === 'partial')) out.finishedNotLanded.push(entry);
    }
    out.landedStillOpen = out.landedStillOpen.slice(0, LIST_MAX);
    out.finishedNotLanded = out.finishedNotLanded.slice(0, LIST_MAX);
    return out;
}

/** `project_status` field: only present when there is something to report. */
export function missionGitStatusFields(meshId: string): { missionGit?: MissionGitDigest } {
    try {
        const d = collectMissionGitDigest(meshId);
        return Object.keys(d.counts).length > 0 ? { missionGit: d } : {};
    } catch {
        return {};
    }
}

function sanitizeEntries(raw: unknown): MissionGitDigestEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: MissionGitDigestEntry[] = [];
    for (const item of raw.slice(0, LIST_MAX)) {
        const r = item && typeof item === 'object' ? item as Record<string, unknown> : null;
        const missionId = typeof r?.missionId === 'string' ? r.missionId.trim().slice(0, 100) : '';
        const gitState = typeof r?.gitState === 'string' ? r.gitState.trim().slice(0, 20) : '';
        if (!missionId || !gitState) continue;
        out.push({ missionId, title: typeof r?.title === 'string' ? r.title.trim().slice(0, TITLE_MAX) : '', gitState, ...(r?.partialUnknown === true ? { partialUnknown: true } : {}) });
    }
    return out;
}

/** Allow-list re-projection of a REMOTE host's `missionGit` (a followed project's payload is never spread). */
export function sanitizeMissionGitFields(raw: Record<string, unknown>): { missionGit?: MissionGitDigest } {
    const r = raw.missionGit && typeof raw.missionGit === 'object' ? raw.missionGit as Record<string, unknown> : null;
    if (!r) return {};
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.counts && typeof r.counts === 'object' ? r.counts as Record<string, unknown> : {})) {
        if (/^[a-z_]{1,20}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) counts[k] = Math.floor(v);
    }
    if (Object.keys(counts).length === 0) return {};
    return { missionGit: { counts, landedStillOpen: sanitizeEntries(r.landedStillOpen), finishedNotLanded: sanitizeEntries(r.finishedNotLanded) } };
}

/** The digest block (empty when nothing to say). Names git as the source so the assistant stops guessing. */
export function formatMissionGitDigestSection(perProject: ReadonlyArray<{ project: string; digest: MissionGitDigest }>): string {
    const lines: string[] = [];
    for (const { project, digest } of perProject) {
        for (const e of digest.landedStillOpen) lines.push(`- ${project}: "${e.title}" (${e.missionId.slice(0, 8)}) — commits are on the default branch and nothing is open, but the mission is still active (git evidence only; confirm live acceptance before closing).`);
        for (const e of digest.finishedNotLanded) lines.push(`- ${project}: "${e.title}" (${e.missionId.slice(0, 8)}) — all tasks ended, but its commits are ${e.gitState === 'partial' ? 'only partly' : 'NOT'} on the default branch${e.partialUnknown ? ' (some could not be checked)' : ''}.`);
    }
    if (lines.length === 0) return '';
    return ['Missions (from git, not guesses — use these instead of judging "finished" from chat):', ...lines.slice(0, 12)].join('\n');
}
