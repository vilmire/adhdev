/**
 * Release-object commands (docs/design/2026-11-01-release-objects.md §5):
 *
 *   release_upsert            { meshId, releaseId?, name?, channel?, status?, version?, note? }
 *   release_scope             { meshId, releaseId, add?, move?, remove?, note? }
 *   release_list              { meshId, releaseId?, statuses?, include?: ('missions'|'changelog'|'git'|'events')[] }
 *   release_record_deploy     { meshId, releaseId?|'auto', channel, version?, commit?, baseCommit?, targets?, name?, actor? }
 *   release_changelog_draft   { meshId, releaseId, markApplied? }
 *
 * Authority (design §4): the coordinator, the owner (dashboard / CLI) and the assistant on the
 * owner's words may change release state; a WORKER credential never can. Like the owner-decision
 * commands, the caller is classified from the router-stamped source and the router-recorded MCP
 * capability (`MCP_ROLE_CLASSIFIED_COMMANDS`) — never from payload fields. A deploy script talks
 * to the local daemon over credential-less IPC and may state `actor: 'script'` on record_deploy.
 * The daemon itself never creates membership: there is no automatic caller in this file.
 */
import type { ReleaseActor } from '@adhdev/mesh-shared';
import { isReleaseStatus } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { COMMAND_SOURCE_ARG } from '../command-args.js';
import { readAuthenticatedMcpCommand, readAuthenticatedMcpScope } from '../mcp-command-ingress.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import type { HighFamilyHandler } from './types.js';
import { meshReleases, type MeshReleaseRecord } from '../../mesh/mesh-release-store.js';
import {
    describeReleaseMissions, recordReleaseDeploy, scopeRelease, suggestMissionsForRelease, upsertRelease, verifiedSuggestion,
} from '../../mesh/mesh-releases.js';
import { draftReleaseChangelog } from '../../mesh/mesh-release-changelog.js';

export const RELEASE_UPSERT = 'release_upsert';
export const RELEASE_SCOPE = 'release_scope';
export const RELEASE_LIST = 'release_list';
export const RELEASE_RECORD_DEPLOY = 'release_record_deploy';
export const RELEASE_CHANGELOG_DRAFT = 'release_changelog_draft';
export const RELEASE_COMMANDS = [RELEASE_UPSERT, RELEASE_SCOPE, RELEASE_LIST, RELEASE_RECORD_DEPLOY, RELEASE_CHANGELOG_DRAFT] as const;

/** Local MCP/CLI socket plus the owner's dashboard transports. `mesh`, `api`, `ws`, `internal` never reach these. */
export const RELEASE_COMMAND_SOURCES = ['p2p', 'standalone', 'ext', 'ipc'] as const;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export type ReleaseCaller =
    | { ok: true; actor: ReleaseActor }
    | { ok: false; code: 'release_not_allowed'; error: string };

function refuse(error: string): ReleaseCaller {
    return { ok: false, code: 'release_not_allowed', error };
}

/** Who is calling — exported for tests. */
export function classifyReleaseCaller(rawArgs: Record<string, unknown>, command: string): ReleaseCaller {
    const source = str(rawArgs[COMMAND_SOURCE_ARG]);
    if (rawArgs.bind !== undefined || rawArgs.token !== undefined || rawArgs.mcpSessionCredential !== undefined) {
        return refuse('worker credentials cannot change release state');
    }
    const mcp = readAuthenticatedMcpCommand(rawArgs, command);
    if (mcp.present) {
        const scope = mcp.valid ? readAuthenticatedMcpScope(rawArgs, command) : null;
        if (!scope?.sessionId) return refuse('worker or unrecognised MCP credentials cannot change release state — only the coordinator, the owner or the assistant can');
        if (scope.isCoordinator) {
            const meshId = str(rawArgs.meshId);
            if (scope.meshId && meshId && scope.meshId !== meshId) return refuse('this coordinator is bound to another mesh');
            return { ok: true, actor: 'coordinator' };
        }
        const assistantSid = str(getAssistantRegistry().read()?.sessionId);
        if (assistantSid && scope.sessionId === assistantSid) return { ok: true, actor: 'assistant' };
        return refuse('worker or unrecognised MCP credentials cannot change release state — only the coordinator, the owner or the assistant can');
    }
    if (source === 'ipc') {
        // No MCP credential behind a local call: the owner's CLI, or a deploy script (record_deploy only).
        if (command === RELEASE_RECORD_DEPLOY && str(rawArgs.actor) === 'script') return { ok: true, actor: 'script' };
        return { ok: true, actor: 'owner' };
    }
    if (source === 'p2p' || source === 'standalone' || source === 'ext') return { ok: true, actor: 'owner' };
    return refuse(`source '${source || 'unknown'}' cannot change release state`);
}

function fail(code: string, error: string) {
    return { success: false as const, code, error };
}

function releaseWire(r: MeshReleaseRecord, include: ReadonlySet<string>): Record<string, unknown> {
    return {
        id: r.id, meshId: r.meshId, name: r.name, channel: r.channel, status: r.status,
        ...(r.version ? { version: r.version } : {}),
        ...(r.baseCommit ? { baseCommit: r.baseCommit } : {}),
        ...(r.headCommit ? { headCommit: r.headCommit } : {}),
        ...(r.targets ? { targets: r.targets } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(include.has('changelog') && r.changelog ? { changelog: r.changelog } : {}),
        ...(!include.has('changelog') && r.changelog ? { changelog: { generatedAt: r.changelog.generatedAt, entries: r.changelog.entries.length, needsNote: r.changelog.needsNote.length, ...(r.changelog.appliedAt ? { appliedAt: r.changelog.appliedAt } : {}) } } : {}),
        createdAt: r.createdAt, updatedAt: r.updatedAt, version: r.versionSeq,
    };
}

function readMeshId(raw: Record<string, unknown>): string {
    return str(stripRouterInternalArgs(raw).meshId);
}

const upsert: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyReleaseCaller(raw, RELEASE_UPSERT);
    if (!caller.ok) return fail(caller.code, caller.error);
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = readMeshId(raw);
    if (!meshId) return fail('invalid_args', 'meshId is required');
    const res = upsertRelease(meshId, {
        ...(str(args.releaseId) ? { releaseId: str(args.releaseId) } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(typeof args.channel === 'string' ? { channel: args.channel } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
    }, caller.actor);
    if (!res.ok) return fail(res.code, res.error);
    return { success: true, meshId, created: res.created, release: releaseWire(res.release, new Set()) };
};

const scope: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyReleaseCaller(raw, RELEASE_SCOPE);
    if (!caller.ok) return fail(caller.code, caller.error);
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = readMeshId(raw);
    const releaseId = str(args.releaseId);
    if (!meshId || !releaseId) return fail('invalid_args', 'meshId and releaseId are required');
    const moves = Array.isArray(args.move)
        ? args.move.map((m: any) => ({ missionId: str(m?.missionId ?? m?.mission_id), toReleaseId: str(m?.toReleaseId ?? m?.to_release_id) }))
        : undefined;
    const res = scopeRelease(meshId, releaseId, {
        ...(Array.isArray(args.add) ? { add: args.add } : {}),
        ...(moves ? { move: moves } : {}),
        ...(Array.isArray(args.remove) ? { remove: args.remove } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
    }, caller.actor);
    if (!res.ok) return fail(res.code, res.error);
    return {
        success: true, meshId, release: releaseWire(res.release, new Set()),
        changes: res.changes, ...(res.warnings.length ? { warnings: res.warnings } : {}),
        suggestedMissions: res.suggestedMissions,
    };
};

const list: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    // Reads are allowed to every caller class except a revoked/unknown credential (workers hold none of these tools).
    const caller = classifyReleaseCaller(raw, RELEASE_LIST);
    if (!caller.ok) return fail(caller.code, caller.error);
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = readMeshId(raw);
    if (!meshId) return fail('invalid_args', 'meshId is required');
    const include = new Set(Array.isArray(args.include) ? args.include.filter((v): v is string => typeof v === 'string') : []);
    const store = meshReleases();
    const releaseId = str(args.releaseId);
    if (releaseId) {
        const release = store.get(meshId, releaseId);
        if (!release) return fail('release_not_found', `release '${releaseId}' does not exist on this mesh`);
        const missions = describeReleaseMissions(meshId, release, { git: include.has('git'), includeEnded: include.has('events') });
        return {
            success: true, meshId, release: releaseWire(release, include), missions,
            verified: verifiedSuggestion(release, missions),
            suggestedMissions: suggestMissionsForRelease(meshId),
            ...(include.has('events') ? { events: store.listEvents(release.id, { limit: 50 }) } : {}),
        };
    }
    const statuses = Array.isArray(args.statuses) ? args.statuses.filter(isReleaseStatus) : undefined;
    const releases = store.list(meshId, statuses?.length ? { statuses } : {});
    const membership = store.activeMembershipByMesh(meshId);
    const counts = new Map<string, number>();
    const names = new Map(releases.map(r => [r.id, r.name]));
    for (const row of membership.values()) counts.set(row.releaseId, (counts.get(row.releaseId) ?? 0) + 1);
    return {
        success: true, meshId,
        releases: releases.map(r => ({ ...releaseWire(r, include), missionCount: counts.get(r.id) ?? 0 })),
        // missionId → release, for badges on mission cards.
        membership: Object.fromEntries([...membership].map(([missionId, row]) => [missionId, { releaseId: row.releaseId, name: names.get(row.releaseId) ?? row.releaseId }])),
        ...(include.has('suggestions') ? { suggestedMissions: suggestMissionsForRelease(meshId) } : {}),
    };
};

const recordDeploy: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyReleaseCaller(raw, RELEASE_RECORD_DEPLOY);
    if (!caller.ok) return fail(caller.code, caller.error);
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = readMeshId(raw);
    if (!meshId) return fail('invalid_args', 'meshId is required');
    const res = recordReleaseDeploy(meshId, {
        ...(str(args.releaseId) ? { releaseId: str(args.releaseId) } : {}),
        channel: str(args.channel),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
        ...(typeof args.commit === 'string' ? { commit: args.commit } : {}),
        ...(typeof args.baseCommit === 'string' ? { baseCommit: args.baseCommit } : {}),
        ...(args.targets !== undefined ? { targets: args.targets } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
    }, caller.actor);
    if (!res.ok) return fail(res.code, res.error);
    return { success: true, meshId, created: res.created, release: releaseWire(res.release, new Set()), warnings: res.warnings, needsNote: res.needsNote };
};

const changelogDraft: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyReleaseCaller(raw, RELEASE_CHANGELOG_DRAFT);
    if (!caller.ok) return fail(caller.code, caller.error);
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = readMeshId(raw);
    const releaseId = str(args.releaseId);
    if (!meshId || !releaseId) return fail('invalid_args', 'meshId and releaseId are required');
    const res = draftReleaseChangelog(meshId, releaseId, caller.actor, { markApplied: args.markApplied === true });
    if ('error' in res) return fail(res.code, res.error);
    return { success: true, meshId, release: releaseWire(res.release, new Set()), draft: res.draft };
};

export const meshReleaseHandlers: Record<string, HighFamilyHandler> = {
    [RELEASE_UPSERT]: upsert,
    [RELEASE_SCOPE]: scope,
    [RELEASE_LIST]: list,
    [RELEASE_RECORD_DEPLOY]: recordDeploy,
    [RELEASE_CHANGELOG_DRAFT]: changelogDraft,
};

// No dashboard-topic invalidation: releases are not part of daemon.metadata; the panel refetches after its own writes.
export const meshReleaseSpecs = defineCommandSpecs('high', meshReleaseHandlers, {
    [RELEASE_UPSERT]: { sources: [...RELEASE_COMMAND_SOURCES] },
    [RELEASE_SCOPE]: { sources: [...RELEASE_COMMAND_SOURCES] },
    [RELEASE_LIST]: { sources: [...RELEASE_COMMAND_SOURCES] },
    [RELEASE_RECORD_DEPLOY]: { sources: [...RELEASE_COMMAND_SOURCES] },
    [RELEASE_CHANGELOG_DRAFT]: { sources: [...RELEASE_COMMAND_SOURCES] },
});
