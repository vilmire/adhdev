/**
 * Release objects: lifecycle, explicit mission membership, moves and deploy recording
 * (docs/design/2026-11-01-release-objects.md §3–§5).
 *
 * Invariants:
 *  - Membership exists ONLY because a caller said so (`add` / `move`). Git state and deploy
 *    heads are suggestions (`suggestMissionsForRelease`), never members.
 *  - A mission is an active member of at most one release; `add`/`move` to another release
 *    ends the old row (`moved_out`) in the same transaction.
 *  - Changing scope after `frozen` is allowed and recorded (`afterFreeze`), never refused.
 *  - Nothing here changes a mission's status or outcome. `verified` is only ever SUGGESTED.
 */
import {
    RELEASE_LIMITS, isMeshReleaseChannel, isReleaseStatus,
    type MeshReleaseChannel, type ReleaseActor, type ReleaseStatus, type ReleaseTargets,
} from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMeshMission, getMeshMissions } from './mesh-missions.js';
import { readMissionGitStates } from './mesh-mission-git-eval.js';
import { meshReleases, newReleaseId, type MeshReleaseRecord, type MeshReleaseStore, type ReleaseMemberRow } from './mesh-release-store.js';

export type ReleaseOpError = { ok: false; code: string; error: string };
export type ReleaseOpResult<T> = ({ ok: true } & T) | ReleaseOpError;

const err = (code: string, error: string): ReleaseOpError => ({ ok: false, code, error });

/** Allowed manual status transitions (terminal states have none). */
const TRANSITIONS: Readonly<Record<ReleaseStatus, readonly ReleaseStatus[]>> = {
    planned: ['frozen', 'deployed', 'superseded', 'cancelled'],
    frozen: ['planned', 'deployed', 'superseded', 'cancelled'],
    deployed: ['verified', 'superseded', 'cancelled'],
    verified: ['superseded'],
    superseded: [],
    cancelled: [],
};
const AFTER_FREEZE: ReadonlySet<ReleaseStatus> = new Set(['frozen', 'deployed', 'verified']);
const CLOSED_RELEASE: ReadonlySet<ReleaseStatus> = new Set(['superseded', 'cancelled']);

function clamp(text: unknown, max: number): string | undefined {
    if (typeof text !== 'string') return undefined;
    const t = text.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : undefined;
}

function tx<T>(fn: () => T): T {
    return MeshRuntimeStore.getInstance().transaction(fn);
}

function missionEvent(meshId: string, missionId: string, type: 'release_attached' | 'release_moved' | 'release_detached', actor: ReleaseActor, payload: Record<string, unknown>): void {
    MeshRuntimeStore.getInstance().missionItems().appendEvent(meshId, missionId, type, actor, payload);
}

// ─── upsert ──────────────────────────────────────────────────────────────────

export interface ReleaseUpsertInput {
    releaseId?: string;
    name?: string;
    channel?: string;
    status?: string;
    version?: string;
    note?: string;
}

export function upsertRelease(meshId: string, input: ReleaseUpsertInput, actor: ReleaseActor): ReleaseOpResult<{ release: MeshReleaseRecord; created: boolean }> {
    const store = meshReleases();
    const now = new Date().toISOString();
    const name = clamp(input.name, RELEASE_LIMITS.name);
    const note = input.note === undefined ? undefined : (clamp(input.note, RELEASE_LIMITS.note) ?? '');
    if (input.channel !== undefined && !isMeshReleaseChannel(input.channel)) return err('invalid_channel', `channel must be 'preview' or 'stable'`);
    if (input.status !== undefined && !isReleaseStatus(input.status)) return err('invalid_status', `invalid release status '${input.status}'`);
    return tx(() => {
        if (!input.releaseId) {
            if (!name) return err('name_required', 'name is required to create a release');
            if (!input.channel) return err('channel_required', 'channel is required to create a release');
            if (store.list(meshId).some(r => r.name === name && r.channel === input.channel && !CLOSED_RELEASE.has(r.status))) {
                return err('release_name_exists', `an open ${input.channel} release named '${name}' already exists on this mesh`);
            }
            const status = (input.status as ReleaseStatus | undefined) ?? 'planned';
            const rec: Omit<MeshReleaseRecord, 'versionSeq'> = {
                id: newReleaseId(), meshId, name, channel: input.channel as MeshReleaseChannel, status,
                ...(clamp(input.version, 80) ? { version: clamp(input.version, 80) } : {}),
                ...(note ? { note } : {}), createdBy: actor, createdAt: now, updatedAt: now,
            };
            store.insert(rec);
            store.appendEvent(meshId, rec.id, 'created', actor, { name, channel: rec.channel, status });
            return { ok: true, release: store.get(meshId, rec.id)!, created: true };
        }
        const cur = store.get(meshId, input.releaseId);
        if (!cur) return err('release_not_found', `release '${input.releaseId}' does not exist on this mesh`);
        const patch: Parameters<MeshReleaseStore['update']>[2] = {};
        if (name && name !== cur.name) patch.name = name;
        if (input.channel && input.channel !== cur.channel) patch.channel = input.channel as MeshReleaseChannel;
        if (input.version !== undefined) patch.version = clamp(input.version, 80) ?? null;
        if (note !== undefined) patch.note = note || null;
        if (input.status && input.status !== cur.status) {
            if (!TRANSITIONS[cur.status].includes(input.status as ReleaseStatus)) {
                return err('invalid_transition', `release status cannot go from '${cur.status}' to '${input.status}' (allowed: ${TRANSITIONS[cur.status].join(', ') || 'none'})`);
            }
            patch.status = input.status as ReleaseStatus;
        }
        if (Object.keys(patch).length > 0) {
            store.update(meshId, cur.id, patch, now);
            if (patch.status) store.appendEvent(meshId, cur.id, 'status_changed', actor, { from: cur.status, to: patch.status });
        }
        return { ok: true, release: store.get(meshId, cur.id)!, created: false };
    });
}

// ─── scope ───────────────────────────────────────────────────────────────────

export interface ReleaseScopeInput {
    add?: readonly string[];
    move?: ReadonlyArray<{ missionId: string; toReleaseId: string }>;
    remove?: readonly string[];
    note?: string;
}

export interface ReleaseScopeChange {
    missionId: string;
    op: 'added' | 'moved' | 'removed' | 'unchanged';
    fromReleaseId?: string;
    toReleaseId?: string;
    afterFreeze?: true;
    error?: string;
    code?: string;
}

export interface ReleaseScopeResult {
    release: MeshReleaseRecord;
    changes: ReleaseScopeChange[];
    warnings: string[];
    suggestedMissions: SuggestedMission[];
}

function uniq(list: readonly unknown[] | undefined, cap: number): string[] {
    const out: string[] = [];
    for (const v of list ?? []) {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !out.includes(s)) out.push(s);
        if (out.length >= cap) break;
    }
    return out;
}

/** Make `missionId` an active member of `target`, ending any other active membership first. */
function attach(store: MeshReleaseStore, meshId: string, target: MeshReleaseRecord, missionId: string, actor: ReleaseActor, note: string | undefined, now: string, viaMove: boolean): ReleaseScopeChange {
    const current = store.activeMembership(missionId);
    if (current?.releaseId === target.id) return { missionId, op: 'unchanged' };
    const afterFreeze = AFTER_FREEZE.has(target.status) || (current ? AFTER_FREEZE.has(store.get(meshId, current.releaseId)?.status ?? 'planned') : false);
    if (current) {
        store.endMember(missionId, 'moved_out', now, target.id);
        store.addMember({ releaseId: target.id, meshId, missionId, addedBy: actor, ...(note ? { note } : {}), addedAt: now });
        const payload = { missionId, fromReleaseId: current.releaseId, toReleaseId: target.id, ...(afterFreeze ? { afterFreeze: true } : {}) };
        store.appendEvent(meshId, current.releaseId, 'scope_moved', actor, payload, now);
        store.appendEvent(meshId, target.id, 'scope_moved', actor, payload, now);
        missionEvent(meshId, missionId, 'release_moved', actor, { fromReleaseId: current.releaseId, toReleaseId: target.id, toName: target.name });
        return { missionId, op: 'moved', fromReleaseId: current.releaseId, toReleaseId: target.id, ...(afterFreeze ? { afterFreeze: true as const } : {}) };
    }
    store.addMember({ releaseId: target.id, meshId, missionId, addedBy: actor, ...(note ? { note } : {}), addedAt: now });
    store.appendEvent(meshId, target.id, 'scope_added', actor, { missionId, ...(afterFreeze ? { afterFreeze: true } : {}), ...(viaMove ? { viaMove: true } : {}) }, now);
    missionEvent(meshId, missionId, 'release_attached', actor, { releaseId: target.id, name: target.name });
    return { missionId, op: 'added', toReleaseId: target.id, ...(afterFreeze ? { afterFreeze: true as const } : {}) };
}

export function scopeRelease(meshId: string, releaseId: string, input: ReleaseScopeInput, actor: ReleaseActor): ReleaseOpResult<ReleaseScopeResult> {
    const store = meshReleases();
    const cur = store.get(meshId, releaseId);
    if (!cur) return err('release_not_found', `release '${releaseId}' does not exist on this mesh`);
    const note = clamp(input.note, RELEASE_LIMITS.note);
    const add = uniq(input.add, RELEASE_LIMITS.missionsPerCall);
    const remove = uniq(input.remove, RELEASE_LIMITS.missionsPerCall);
    const moves = (input.move ?? []).slice(0, RELEASE_LIMITS.missionsPerCall)
        .map(m => ({ missionId: String(m?.missionId ?? '').trim(), toReleaseId: String(m?.toReleaseId ?? '').trim() }))
        .filter(m => m.missionId && m.toReleaseId);
    if (add.length + remove.length + moves.length === 0) return err('empty_scope_change', 'pass add, move and/or remove with at least one mission id');
    const now = new Date().toISOString();
    const warnings: string[] = [];
    const changes: ReleaseScopeChange[] = [];

    tx(() => {
        for (const missionId of add) {
            if (!getMeshMission(meshId, missionId)) { changes.push({ missionId, op: 'unchanged', code: 'mission_not_found', error: 'mission does not exist on this mesh' }); continue; }
            if (CLOSED_RELEASE.has(cur.status)) { changes.push({ missionId, op: 'unchanged', code: 'release_closed', error: `release is ${cur.status}` }); continue; }
            changes.push(attach(store, meshId, cur, missionId, actor, note, now, false));
        }
        for (const m of moves) {
            const target = store.get(meshId, m.toReleaseId);
            if (!getMeshMission(meshId, m.missionId)) { changes.push({ missionId: m.missionId, op: 'unchanged', code: 'mission_not_found', error: 'mission does not exist on this mesh' }); continue; }
            if (!target) { changes.push({ missionId: m.missionId, op: 'unchanged', code: 'release_not_found', error: `target release '${m.toReleaseId}' does not exist on this mesh` }); continue; }
            if (CLOSED_RELEASE.has(target.status)) { changes.push({ missionId: m.missionId, op: 'unchanged', code: 'release_closed', error: `target release is ${target.status}` }); continue; }
            const change = attach(store, meshId, target, m.missionId, actor, note, now, true);
            changes.push(change);
            if (change.op === 'moved' && change.fromReleaseId) {
                const from = store.get(meshId, change.fromReleaseId);
                if (from && (from.status === 'deployed' || from.status === 'verified')) warnings.push(`mission ${m.missionId.slice(0, 8)} left release '${from.name}' after it was ${from.status}: it was deployed but is no longer in its scope`);
            }
        }
        for (const missionId of remove) {
            const active = store.activeMembership(missionId);
            if (!active || active.releaseId !== cur.id) { changes.push({ missionId, op: 'unchanged', code: 'not_member', error: 'mission is not an active member of this release' }); continue; }
            store.endMember(missionId, 'removed', now);
            const afterFreeze = AFTER_FREEZE.has(cur.status);
            store.appendEvent(meshId, cur.id, 'scope_removed', actor, { missionId, ...(afterFreeze ? { afterFreeze: true } : {}) }, now);
            missionEvent(meshId, missionId, 'release_detached', actor, { releaseId: cur.id, name: cur.name });
            changes.push({ missionId, op: 'removed', fromReleaseId: cur.id, ...(afterFreeze ? { afterFreeze: true as const } : {}) });
            if (cur.status === 'deployed' || cur.status === 'verified') warnings.push(`mission ${missionId.slice(0, 8)} removed from release '${cur.name}' after it was ${cur.status}: it was deployed but is no longer in its scope`);
        }
        if (changes.some(c => c.op !== 'unchanged')) store.update(meshId, cur.id, {}, now);
    });
    if (changes.some(c => c.afterFreeze)) warnings.push(`scope changed after the release was frozen or deployed (recorded with afterFreeze)`);
    return { ok: true, release: store.get(meshId, cur.id)!, changes, warnings: [...new Set(warnings)], suggestedMissions: suggestMissionsForRelease(meshId) };
}

// ─── suggestions (never members) ─────────────────────────────────────────────

export interface SuggestedMission {
    missionId: string;
    title: string;
    reason: 'git_landed';
    gitState: string;
}

const NOT_SHIPPED_OUTCOMES = new Set(['superseded', 'not_needed', 'owner_abandoned']);

/**
 * Missions whose refs are on the default branch but that belong to no release. Read-only,
 * cached git verdicts only; the caller decides whether to add any (design L7).
 */
export function suggestMissionsForRelease(meshId: string, limit = 20): SuggestedMission[] {
    const store = meshReleases();
    const taken = store.activeMembershipByMesh(meshId);
    const candidates = getMeshMissions(meshId, ['active', 'completed'])
        .filter(m => !taken.has(m.id) && !m.isCarryOver && !(m.outcome && NOT_SHIPPED_OUTCOMES.has(m.outcome)));
    if (candidates.length === 0) return [];
    const states = readMissionGitStates(meshId, candidates.map(m => m.id));
    const out: SuggestedMission[] = [];
    for (const m of candidates) {
        const g = states.get(m.id);
        if (g?.state === 'landed') out.push({ missionId: m.id, title: m.title, reason: 'git_landed', gitState: g.state });
        if (out.length >= limit) break;
    }
    return out;
}

// ─── read ────────────────────────────────────────────────────────────────────

export interface ReleaseMissionView {
    missionId: string;
    title?: string;
    status?: string;
    outcome?: string;
    releaseNote?: string;
    state: ReleaseMemberRow['state'];
    addedBy: string;
    addedAt: string;
    openLiveChecks: number;
    machines: string[];
    gitState?: string;
    movedToReleaseId?: string;
}

export interface VerifiedSuggestion {
    suggested: boolean;
    reason: string;
    openLiveChecks: number;
}

export function verifiedSuggestion(release: MeshReleaseRecord, views: readonly ReleaseMissionView[]): VerifiedSuggestion {
    if (release.status !== 'deployed') return { suggested: false, reason: `release is ${release.status}`, openLiveChecks: 0 };
    const members = views.filter(v => v.state === 'member');
    const open = members.reduce((n, v) => n + v.openLiveChecks, 0);
    if (members.length === 0) return { suggested: false, reason: 'no member missions', openLiveChecks: 0 };
    return open === 0
        ? { suggested: true, reason: 'every live check of the member missions is done or dropped; the coordinator/owner confirms', openLiveChecks: 0 }
        : { suggested: false, reason: `${open} live check(s) still open`, openLiveChecks: open };
}

export function describeReleaseMissions(meshId: string, release: MeshReleaseRecord, opts: { git?: boolean; includeEnded?: boolean } = {}): ReleaseMissionView[] {
    const store = meshReleases();
    const items = MeshRuntimeStore.getInstance().missionItems();
    const rows = store.members(release.id, opts.includeEnded ? undefined : ['member']);
    const gitStates = opts.git ? readMissionGitStates(meshId, rows.map(r => r.missionId)) : null;
    return rows.map(r => {
        const m = getMeshMission(meshId, r.missionId);
        const liveChecks = items.listItems(meshId, r.missionId, { kinds: ['live_check'], states: ['open'] });
        return {
            missionId: r.missionId,
            ...(m ? { title: m.title, status: m.status } : {}),
            ...(m?.outcome ? { outcome: m.outcome } : {}),
            ...(m?.releaseNote ? { releaseNote: m.releaseNote } : {}),
            state: r.state,
            addedBy: r.addedBy,
            addedAt: r.addedAt,
            openLiveChecks: liveChecks.length,
            machines: [...new Set(liveChecks.map(i => i.machine).filter((v): v is string => !!v))],
            ...(gitStates ? { gitState: gitStates.get(r.missionId)?.state } : {}),
            ...(r.movedToReleaseId ? { movedToReleaseId: r.movedToReleaseId } : {}),
        };
    });
}

// ─── deploy recording ────────────────────────────────────────────────────────

export interface RecordDeployInput {
    releaseId?: string | 'auto';
    channel: string;
    version?: string;
    commit?: string;
    baseCommit?: string;
    targets?: unknown;
    name?: string;
}

function normalizeTargets(raw: unknown): ReleaseTargets | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: ReleaseTargets = {};
    for (const [key, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const t: Record<string, string> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 8)) {
            if (typeof val === 'string' && val.length <= 200) t[k] = val;
        }
        if (Object.keys(t).length) out[key.slice(0, 40)] = t;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Record a successful deploy against a release (script- or coordinator-driven). `releaseId`
 * absent or `'auto'` picks the newest open planned/frozen release of the channel, or creates
 * one named after the version. Target snapshots merge across calls (stage-by-stage deploys).
 */
export function recordReleaseDeploy(meshId: string, input: RecordDeployInput, actor: ReleaseActor): ReleaseOpResult<{ release: MeshReleaseRecord; created: boolean; warnings: string[]; needsNote: string[] }> {
    if (!isMeshReleaseChannel(input.channel)) return err('invalid_channel', `channel must be 'preview' or 'stable'`);
    const channel = input.channel;
    const store = meshReleases();
    const now = new Date().toISOString();
    const version = clamp(input.version, 80);
    const commit = clamp(input.commit, 80);
    const targets = normalizeTargets(input.targets);
    let created = false;
    let releaseId: string | undefined;
    const resolved = tx((): ReleaseOpError | { id: string } => {
        let cur: MeshReleaseRecord | null = null;
        if (input.releaseId && input.releaseId !== 'auto') {
            cur = store.get(meshId, input.releaseId);
            if (!cur) return err('release_not_found', `release '${input.releaseId}' does not exist on this mesh`);
        } else {
            const live = store.list(meshId, { channel, statuses: ['planned', 'frozen', 'deployed', 'verified'] });
            // A later stage of the same deploy (npm, then server, then web) finds its release by version/name.
            cur = version ? live.find(r => r.version === version || r.name === version) ?? null : null;
            if (!cur) cur = live.find(r => (r.status === 'planned' || r.status === 'frozen') && (!version || !r.version)) ?? null;
            if (!cur) {
                const name = clamp(input.name, RELEASE_LIMITS.name) ?? version ?? `${channel}-${now.slice(0, 10)}`;
                const rec: Omit<MeshReleaseRecord, 'versionSeq'> = { id: newReleaseId(), meshId, name, channel, status: 'planned', createdBy: actor, createdAt: now, updatedAt: now, ...(version ? { version } : {}) };
                store.insert(rec);
                store.appendEvent(meshId, rec.id, 'created', actor, { name, channel, auto: true }, now);
                cur = store.get(meshId, rec.id)!;
                created = true;
            }
        }
        if (CLOSED_RELEASE.has(cur.status)) return err('release_closed', `release '${cur.name}' is ${cur.status}`);
        const patch: Parameters<MeshReleaseStore['update']>[2] = {};
        if (version) patch.version = version;
        if (commit) patch.headCommit = commit;
        if (clamp(input.baseCommit, 80)) patch.baseCommit = clamp(input.baseCommit, 80)!;
        if (targets) patch.targets = { ...(cur.targets ?? {}), ...targets };
        if (cur.status === 'planned' || cur.status === 'frozen') patch.status = 'deployed';
        store.update(meshId, cur.id, patch, now);
        if (patch.status) store.appendEvent(meshId, cur.id, 'status_changed', actor, { from: cur.status, to: 'deployed' }, now);
        store.appendEvent(meshId, cur.id, 'deploy_recorded', actor, { channel, ...(version ? { version } : {}), ...(commit ? { commit } : {}), targets: targets ? Object.keys(targets) : [] }, now);
        return { id: cur.id };
    });
    if ('ok' in resolved) return resolved;
    releaseId = resolved.id;
    const release = store.get(meshId, releaseId)!;
    const members = describeReleaseMissions(meshId, release);
    const needsNote = members.filter(v => !v.releaseNote).map(v => v.missionId);
    const warnings: string[] = [];
    if (members.length === 0) warnings.push('release has no member missions: nothing will appear in the CHANGELOG draft');
    if (!release.changelog) warnings.push('no CHANGELOG draft yet (mesh_release_changelog_draft / scripts/release-changelog.mjs)');
    else if (!release.changelog.appliedAt) warnings.push('CHANGELOG draft was generated but not applied (scripts/release-changelog.mjs --apply)');
    if (needsNote.length > 0) warnings.push(`${needsNote.length} member mission(s) have no release_note`);
    return { ok: true, release, created, warnings, needsNote };
}
