/**
 * CHANGELOG draft for a release (docs/design/2026-11-01-release-objects.md §6).
 *
 * One entry per member mission. Sentence source: the mission's `release_note`, else its
 * summary (or title) carrying the needs-wording marker and listed in `needsNote`. A draft
 * is a stored artifact only — nothing here writes CHANGELOG.md (that is the explicit
 * `scripts/release-changelog.mjs --apply`). Evidence (git state, SHAs, outcome) stays in
 * the draft JSON and never reaches the CHANGELOG text. Classification is a suggestion.
 */
import {
    NEEDS_WORDING_MARKER, RELEASE_LIMITS, changelogMissionMarker, classifyChangelogSection, lintChangelogText,
    type ChangelogDraft, type ChangelogDraftEntry,
} from '@adhdev/mesh-shared';
import { getMeshMission } from './mesh-missions.js';
import { readMissionGitStates } from './mesh-mission-git-eval.js';
import { meshReleases, type MeshReleaseRecord } from './mesh-release-store.js';

const NOT_SHIPPED_OUTCOMES = new Set(['superseded', 'not_needed', 'owner_abandoned']);

export function buildChangelogDraft(meshId: string, release: MeshReleaseRecord, nowIso: string = new Date().toISOString()): ChangelogDraft {
    const store = meshReleases();
    const members = store.members(release.id, ['member']);
    const gitStates = readMissionGitStates(meshId, members.map(m => m.missionId));
    const entries: ChangelogDraftEntry[] = [];
    const needsNote: string[] = [];
    const excluded: ChangelogDraft['excluded'] = [];
    const warnings: ChangelogDraft['warnings'] = [];

    for (const member of members) {
        const m = getMeshMission(meshId, member.missionId);
        if (!m) { excluded.push({ missionId: member.missionId, reason: 'mission no longer exists' }); continue; }
        if (m.status === 'abandoned' || (m.outcome && NOT_SHIPPED_OUTCOMES.has(m.outcome))) {
            excluded.push({ missionId: m.id, reason: m.outcome ? `outcome ${m.outcome}` : 'mission abandoned' });
            continue;
        }
        const git = gitStates.get(m.id);
        if (git && (git.state === 'not_landed' || git.state === 'unknown')) {
            warnings.push({ missionId: m.id, gitState: git.state, message: 'in the release scope, but its refs are not confirmed on the default branch' });
        }
        const note = (m.releaseNote ?? '').trim();
        const hasNote = note.length > 0;
        if (!hasNote) needsNote.push(m.id);
        const rawText = hasNote ? note : ((m.summary ?? '').trim() || m.title.trim());
        const { section, text: classified } = classifyChangelogSection(rawText, hasNote ? undefined : m.title);
        const text = hasNote ? classified : `${classified} ${NEEDS_WORDING_MARKER}`.trim();
        const shas = (git?.refs ?? []).filter(r => r.kind === 'commit').map(r => r.value.slice(0, 12)).slice(0, 8);
        const lint = lintChangelogText(classified);
        entries.push({
            missionId: m.id,
            marker: changelogMissionMarker(m.id),
            section,
            text,
            source: hasNote ? 'release_note' : 'summary',
            ...(hasNote ? {} : { needsWording: true }),
            evidence: { ...(git ? { gitState: git.state } : {}), ...(m.outcome ? { outcome: m.outcome } : {}), ...(shas.length ? { shas } : {}) },
            ...(lint.length ? { lint } : {}),
        });
        if (entries.length >= RELEASE_LIMITS.changelogEntries) break;
    }
    return { generatedAt: nowIso, entries, needsNote, excluded, warnings };
}

/** Generate, store and log a draft. `markApplied` stamps `appliedAt` on the stored draft (the script reports it after `--apply`). */
export function draftReleaseChangelog(meshId: string, releaseId: string, actor: string, opts: { markApplied?: boolean } = {}): { release: MeshReleaseRecord; draft: ChangelogDraft } | { error: string; code: string } {
    const store = meshReleases();
    const release = store.get(meshId, releaseId);
    if (!release) return { code: 'release_not_found', error: `release '${releaseId}' does not exist on this mesh` };
    if (opts.markApplied) {
        if (!release.changelog) return { code: 'no_draft', error: 'no draft stored for this release; generate one first' };
        const draft: ChangelogDraft = { ...release.changelog, appliedAt: new Date().toISOString() };
        store.update(meshId, release.id, { changelog: draft });
        store.appendEvent(meshId, release.id, 'changelog_applied', actor, { entries: draft.entries.length });
        return { release: store.get(meshId, release.id)!, draft };
    }
    const draft = buildChangelogDraft(meshId, release);
    store.update(meshId, release.id, { changelog: draft });
    store.appendEvent(meshId, release.id, 'changelog_drafted', actor, { entries: draft.entries.length, needsNote: draft.needsNote.length, excluded: draft.excluded.length, warnings: draft.warnings.length });
    return { release: store.get(meshId, release.id)!, draft };
}
