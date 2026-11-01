/**
 * `project_status.releases` — the assistant's data for "what is in rc.34?"
 * (design 2026-11-01-release-objects §7): the newest releases of a mesh with their status,
 * deploy facts and member missions. Pure reads over the release store; no writes, no git.
 *
 * Content boundary: ids, release names/versions/enums, commit SHAs, mission titles (<= 60 chars,
 * as the status view already carries them) and the operator-written `release_note` (<= 400
 * chars). No transcript or chat text. A remote host's block is re-projected by allow-list.
 */
import { isMeshReleaseChannel, isReleaseStatus, type MeshReleaseChannel, type ReleaseStatus } from '@adhdev/mesh-shared';
import { meshReleases } from '../mesh/mesh-release-store.js';
import { describeReleaseMissions, verifiedSuggestion } from '../mesh/mesh-releases.js';

export interface ReleaseDigestMission { missionId: string; title: string; outcome?: string; releaseNote?: string; openLiveChecks: number }
export interface ReleaseDigestEntry {
    id: string;
    name: string;
    channel: MeshReleaseChannel;
    status: ReleaseStatus;
    version?: string;
    headCommit?: string;
    deployedAt?: string;
    missionCount: number;
    needsNote: number;
    openLiveChecks: number;
    verifiedSuggested?: boolean;
    missions: ReleaseDigestMission[];
}

const RELEASES_MAX = 3;
const MISSIONS_MAX = 12;
const TITLE_MAX = 60;

export function collectReleaseDigest(meshId: string): ReleaseDigestEntry[] {
    const releases = meshReleases().list(meshId).filter(r => r.status !== 'cancelled').slice(0, RELEASES_MAX);
    return releases.map(r => {
        const views = describeReleaseMissions(meshId, r);
        const deployedAt = r.targets ? Object.values(r.targets).map(t => t?.deployedAt).filter((v): v is string => typeof v === 'string').sort().pop() : undefined;
        return {
            id: r.id, name: r.name, channel: r.channel, status: r.status,
            ...(r.version ? { version: r.version } : {}),
            ...(r.headCommit ? { headCommit: r.headCommit } : {}),
            ...(deployedAt ? { deployedAt } : {}),
            missionCount: views.length,
            needsNote: views.filter(v => !v.releaseNote).length,
            openLiveChecks: views.reduce((n, v) => n + v.openLiveChecks, 0),
            ...(verifiedSuggestion(r, views).suggested ? { verifiedSuggested: true } : {}),
            missions: views.slice(0, MISSIONS_MAX).map(v => ({
                missionId: v.missionId, title: (v.title ?? '').slice(0, TITLE_MAX),
                ...(v.outcome ? { outcome: v.outcome } : {}),
                ...(v.releaseNote ? { releaseNote: v.releaseNote.slice(0, 400) } : {}),
                openLiveChecks: v.openLiveChecks,
            })),
        };
    });
}

/** `project_status` field: only present when the mesh has releases. */
export function releaseStatusFields(meshId: string): { releases?: ReleaseDigestEntry[] } {
    try {
        const d = collectReleaseDigest(meshId);
        return d.length > 0 ? { releases: d } : {};
    } catch {
        return {};
    }
}

function text(v: unknown, max: number): string {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function count(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Allow-list re-projection of a REMOTE host's `releases` (a followed project's payload is never spread). */
export function sanitizeReleaseFields(raw: Record<string, unknown>): { releases?: ReleaseDigestEntry[] } {
    if (!Array.isArray(raw.releases)) return {};
    const out: ReleaseDigestEntry[] = [];
    for (const item of raw.releases.slice(0, RELEASES_MAX)) {
        const r = item && typeof item === 'object' ? item as Record<string, unknown> : null;
        const id = text(r?.id, 40);
        const name = text(r?.name, 80);
        if (!r || !id || !name || !isMeshReleaseChannel(r.channel) || !isReleaseStatus(r.status)) continue;
        const missions: ReleaseDigestMission[] = [];
        for (const m of (Array.isArray(r.missions) ? r.missions : []).slice(0, MISSIONS_MAX)) {
            const mr = m && typeof m === 'object' ? m as Record<string, unknown> : null;
            const missionId = text(mr?.missionId, 100);
            if (!mr || !missionId) continue;
            missions.push({
                missionId, title: text(mr.title, TITLE_MAX),
                ...(text(mr.outcome, 30) ? { outcome: text(mr.outcome, 30) } : {}),
                ...(text(mr.releaseNote, 400) ? { releaseNote: text(mr.releaseNote, 400) } : {}),
                openLiveChecks: count(mr.openLiveChecks),
            });
        }
        out.push({
            id, name, channel: r.channel, status: r.status,
            ...(text(r.version, 80) ? { version: text(r.version, 80) } : {}),
            ...(text(r.headCommit, 80) ? { headCommit: text(r.headCommit, 80) } : {}),
            ...(text(r.deployedAt, 40) ? { deployedAt: text(r.deployedAt, 40) } : {}),
            missionCount: count(r.missionCount), needsNote: count(r.needsNote), openLiveChecks: count(r.openLiveChecks),
            ...(r.verifiedSuggested === true ? { verifiedSuggested: true } : {}),
            missions,
        });
    }
    return out.length > 0 ? { releases: out } : {};
}
