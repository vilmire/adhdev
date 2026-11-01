// Release-object tool schemas (docs/design/2026-11-01-release-objects.md §5).
// A release groups MISSIONS (explicit membership) and records deploy facts; it is distinct from
// the vendor release stamp and from the per-checkout `.adhdev/preview-deploy.json` it snapshots.

const MEMBERSHIP_NOTE = 'Membership is only ever created by an explicit mesh_release_scope call — git state and deploy heads only produce `suggestedMissions`, never members.';

export const MESH_RELEASE_UPSERT_TOOL = {
    name: 'mesh_release_upsert',
    description: 'Create or update a release of this mesh (a named group of missions plus the deploy facts, e.g. "1.0.82-rc.34"). '
        + 'Omit release_id to create (name + channel required); pass release_id to rename, set the version/note or move its status: '
        + 'planned → frozen → deployed → verified, or superseded/cancelled at any time. `deployed` is normally set by the deploy script (mesh_release_record_deploy); '
        + '`verified` is YOUR confirmation after the live checks — the daemon only suggests it. Changing the status never changes a mission. ' + MEMBERSHIP_NOTE,
    inputSchema: {
        type: 'object' as const,
        properties: {
            release_id: { type: 'string', description: 'Existing release id (rel_…). Omit to create.' },
            name: { type: 'string', description: 'Display name, ≤80 chars (e.g. "1.0.82-rc.34"). Required on create.' },
            channel: { type: 'string', enum: ['preview', 'stable'], description: 'Required on create.' },
            status: { type: 'string', enum: ['planned', 'frozen', 'deployed', 'verified', 'superseded', 'cancelled'], description: 'Defaults to planned on create. Terminal states (superseded/cancelled) are final.' },
            version: { type: 'string', description: 'Published version, once known.' },
            note: { type: 'string', description: 'Free note, ≤500 chars. Empty string clears it.' },
        },
        required: [],
    },
};

export const MESH_RELEASE_SCOPE_TOOL = {
    name: 'mesh_release_scope',
    description: 'Change which missions belong to a release. `add` makes missions members; `move` transfers a mission to another release in ONE step (a mission is a member of at most one release, so adding a mission that is in another release moves it and records the move on both releases and the mission); `remove` takes it out. '
        + 'Changing scope after the release was frozen/deployed is allowed — it is recorded with afterFreeze and a warning says when a deployed release lost a mission. Whole missions only (no per-item membership). '
        + 'The reply lists each change plus `suggestedMissions`: missions whose refs are already on the default branch but that belong to no release — suggestions to review, never added for you. Not available to workers.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            release_id: { type: 'string', description: 'The release to change (the source of `remove`, the target of `add`).' },
            add: { type: 'array', items: { type: 'string' }, description: 'Mission ids to add (≤100). A mission already in another release is moved here.' },
            move: { type: 'array', description: 'Move missions out of their current release into another.', items: { type: 'object', properties: { mission_id: { type: 'string' }, to_release_id: { type: 'string' } }, required: ['mission_id', 'to_release_id'] } },
            remove: { type: 'array', items: { type: 'string' }, description: 'Mission ids to take out of this release.' },
            note: { type: 'string', description: 'Why (≤500 chars), recorded with an add.' },
        },
        required: ['release_id'],
    },
};

export const MESH_RELEASE_LIST_TOOL = {
    name: 'mesh_release_list',
    description: 'Read releases of this mesh. Without release_id: every release with its status, version, deploy facts, member count and a `membership` map (mission id → release). '
        + 'With release_id: the release, its member missions (title, outcome, release_note, open live checks and their machines), the `verified` suggestion (true only when every live check of the members is closed — you still confirm), and `suggestedMissions`. '
        + 'include: "git" adds each member\'s gitState (is its work on the default branch), "changelog" the stored CHANGELOG draft, "events" the release history. Read-only.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            release_id: { type: 'string' },
            status: { type: 'array', items: { type: 'string', enum: ['planned', 'frozen', 'deployed', 'verified', 'superseded', 'cancelled'] }, description: 'Filter the list.' },
            include: { type: 'array', items: { type: 'string', enum: ['missions', 'git', 'changelog', 'events', 'suggestions'] } },
        },
        required: [],
    },
};

export const MESH_RELEASE_RECORD_DEPLOY_TOOL = {
    name: 'mesh_release_record_deploy',
    description: 'Record that a deploy happened on a release: marks it deployed and stores the deploy facts (commit, version, per-target snapshot). Called by the deploy scripts after a successful deploy (best-effort); you may call it too. '
        + 'release_id "auto" (default) picks the open planned/frozen release of the channel, or the one that already carries this version, or creates one named after the version. Repeated calls (npm, then server, then web) merge their targets. '
        + 'The reply warns when member missions have no release_note or the CHANGELOG draft is missing/unapplied (warnings only — nothing is blocked).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            release_id: { type: 'string', description: 'Release id or "auto" (default).' },
            channel: { type: 'string', enum: ['preview', 'stable'] },
            version: { type: 'string' },
            commit: { type: 'string', description: 'Deployed root HEAD.' },
            base_commit: { type: 'string', description: 'Previous deployed head, when known.' },
            targets: { type: 'object', description: 'Snapshot of the deploy record targets: { npm|server|web: { commit, deployedAt, previewVersion? } }.' },
            name: { type: 'string', description: 'Name when a release has to be created.' },
            actor: { type: 'string', enum: ['script'], description: 'Set by deploy scripts.' },
        },
        required: ['channel'],
    },
};

export const MESH_RELEASE_CHANGELOG_DRAFT_TOOL = {
    name: 'mesh_release_changelog_draft',
    description: 'Generate and store a CHANGELOG draft for a release from its member missions: one entry per mission using the mission\'s release_note (set it via mesh_mission_upsert release_note, ≤400 chars, user-facing wording, English). '
        + 'Missions without a release_note get their summary plus a "[needs user-facing wording]" marker and are listed in `needsNote`; superseded/not_needed/abandoned missions are excluded with a reason; members whose refs are not confirmed on the default branch are warned about. '
        + 'The section (Added/Fixed/Changed) is a suggestion — prefix a release_note with [Added]/[Fixed]/[Changed] to pin it. This tool never writes CHANGELOG.md: apply the draft with `node scripts/release-changelog.mjs --release <id> --apply`.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            release_id: { type: 'string' },
            mark_applied: { type: 'boolean', description: 'Stamp the stored draft as applied (the apply script does this).' },
        },
        required: ['release_id'],
    },
};
