/**
 * launch-record — daemon-side construction of `SessionLaunchRecord`.
 *
 * Wiring-unification Phase E (docs/design/2026-09-23-wiring-unification.md §7
 * E1, RC5). The shape and the pure readers live in `@adhdev/mesh-shared`
 * (`session-launch.ts`) so web-core / server / mcp-server share one definition;
 * this file holds what only the daemon can do — resolve a provider default from
 * the model-discovery cache, attribute a mesh launch axis, and turn launch
 * arguments into a record. `SessionRegistry` owns the record once built.
 *
 * Every function here is pure (data in, data out).
 */

import {
    MODEL_SELECTION_HISTORY_LIMIT,
    isModelAxisSource,
    isSessionLaunchedBy,
    parseSessionLaunchRecord,
    type ModelAxisSource,
    type ModelSelection,
    type SessionLaunchRecord,
    type SessionLaunchedBy,
} from '@adhdev/mesh-shared';
import type { ModelDiscoverySnapshot } from '../models/types.js';

export type {
    ModelAxisSource,
    ModelSelection,
    ModelSelectionHistoryEntry,
    ModelSelectionVia,
    SessionLaunchRecord,
    SessionLaunchedBy,
} from '@adhdev/mesh-shared';

export type LaunchAxis = 'model' | 'thinkingLevel';

/**
 * The provider's default model when a launch requested none.
 *
 * The discovery registry has no "default" field: a default is encoded
 * positionally (a `defaultMarker` / priority sorts it first), and the read-time
 * overlay puts the discovered list in front of the picker only when discovery
 * SUCCEEDED. So: `snapshot.models[0]` for an ok snapshot, else the manifest's
 * first option — the same list the dashboard picker shows, so the daemon and
 * the dialog's "default resolves to X" hint agree. A label-valued picker
 * (antigravity) is translated to its slug through the manifest value map.
 */
export function resolveProviderDefaultModel(
    snapshot: ModelDiscoverySnapshot | undefined,
    manifestModelOptions: readonly string[] | undefined,
    manifestValueMap?: Record<string, string>,
): string | undefined {
    if (snapshot?.status === 'ok' && Array.isArray(snapshot.models)) {
        const slug = snapshot.models.find((model) => typeof model?.slug === 'string' && model.slug.trim())?.slug.trim();
        if (slug) return slug;
    }
    const first = Array.isArray(manifestModelOptions)
        ? manifestModelOptions.find((option) => typeof option === 'string' && option.trim())?.trim()
        : undefined;
    if (!first) return undefined;
    const mapped = manifestValueMap?.[first];
    return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : first;
}

/**
 * Attribute a mesh auto-launch axis value (see `resolveLaunchAxis` in
 * mesh-scheduling-fitness.ts, which picked it).
 *
 *  - no final value → undefined: the launch requests nothing and the daemon's own
 *    fallback (`provider_default` / `unspecified`) applies;
 *  - the final value IS the task's explicit value → `task_override`. A task row
 *    with no source marker predates the marker and is treated as explicit, the
 *    same backward-compat rule `resolveLaunchAxis` uses;
 *  - anything else (a slot filled the blank, a slot outranked a difficulty
 *    preset, a preset stood because no slot covered the difficulty, the slot
 *    guard / quota fallback re-picked it) → `mesh_slot`: mesh scheduling policy,
 *    not a person, chose it.
 */
export function classifyMeshLaunchAxisSource(input: {
    taskValue?: string;
    taskSource?: 'explicit' | 'preset' | string;
    effectiveValue?: string;
}): ModelAxisSource | undefined {
    const effective = typeof input.effectiveValue === 'string' ? input.effectiveValue.trim() : '';
    if (!effective) return undefined;
    const task = typeof input.taskValue === 'string' ? input.taskValue.trim() : '';
    if (task && task === effective && input.taskSource !== 'preset') return 'task_override';
    return 'mesh_slot';
}

/** Launch-provenance fields accepted on `launch_cli` args (all optional, all validated). */
export interface LaunchProvenanceArgs {
    launchedBy?: SessionLaunchedBy;
    modelSource?: ModelAxisSource;
    thinkingLevelSource?: ModelAxisSource;
}

/**
 * Read `launchedBy` / `modelSource` / `thinkingLevelSource` off `launch_cli`
 * args. Unknown values are dropped (the record then says `unspecified` /
 * falls back to the inferred launcher) — never trusted verbatim.
 */
export function readLaunchProvenanceArgs(args: unknown): LaunchProvenanceArgs {
    const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    return {
        ...(isSessionLaunchedBy(record.launchedBy) && record.launchedBy !== 'restore'
            ? { launchedBy: record.launchedBy }
            : {}),
        ...(isModelAxisSource(record.modelSource) ? { modelSource: record.modelSource } : {}),
        ...(isModelAxisSource(record.thinkingLevelSource) ? { thinkingLevelSource: record.thinkingLevelSource } : {}),
    };
}

/**
 * Who launched a `launch_cli` session when the caller did not say: a delegated
 * worker or a coordinator carries mesh settings; anything else is an API caller.
 */
export function inferLaunchedBy(settings: Record<string, unknown> | undefined): SessionLaunchedBy {
    if (!settings) return 'api';
    const meshSetting = (key: string) => typeof settings[key] === 'string' && (settings[key] as string).trim().length > 0;
    if (settings.launchedByCoordinator === true || meshSetting('meshNodeFor') || meshSetting('meshCoordinatorFor')) return 'mesh';
    return 'api';
}

export interface LaunchAxisInput {
    /** What the caller asked for (raw; trimmed here). */
    requested?: string;
    /** Where the caller says the value came from. Ignored when nothing was requested. */
    declaredSource?: ModelAxisSource;
    /** What was actually handed to the provider; absent when the request was not applied. */
    launchValue?: string;
    /** The provider default, used only when nothing was requested. */
    providerDefault?: string;
}

function trimmed(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Build one axis.
 *
 * A requested value keeps the caller's declared source; with no declaration it
 * is `unspecified` (the field's absence is itself the fact — e.g. an old
 * dashboard). `provider_default` / `unspecified` cannot be claimed for a value
 * that WAS requested. With nothing requested the source is `provider_default`
 * when the default is known, else `unspecified`.
 */
export function buildModelSelection(input: LaunchAxisInput, at: number): ModelSelection {
    const requested = trimmed(input.requested);
    const launchValue = requested ? trimmed(input.launchValue) : undefined;
    if (requested) {
        const declared = input.declaredSource;
        const source: ModelAxisSource = declared && declared !== 'provider_default' ? declared : 'unspecified';
        const inForce = launchValue ?? requested;
        return {
            requested,
            source,
            ...(launchValue ? { launchValue } : {}),
            history: [{ at, value: inForce, via: 'launch' }],
        };
    }
    const resolvedDefault = trimmed(input.providerDefault);
    if (resolvedDefault) {
        return {
            source: 'provider_default',
            resolvedDefault,
            history: [{ at, value: resolvedDefault, via: 'launch' }],
        };
    }
    return { source: 'unspecified', history: [] };
}

export interface SessionLaunchRecordInput {
    sessionId: string;
    providerType: string;
    providerVersion?: string;
    providerChannel?: string;
    launchedBy: SessionLaunchedBy;
    launchedAt: number;
    workspace?: string;
    model: LaunchAxisInput;
    thinkingLevel: LaunchAxisInput;
    autoApproveModeId?: string;
}

export function buildSessionLaunchRecord(input: SessionLaunchRecordInput): SessionLaunchRecord {
    const providerVersion = trimmed(input.providerVersion);
    const workspace = trimmed(input.workspace);
    const autoApproveModeId = trimmed(input.autoApproveModeId);
    return {
        sessionId: input.sessionId,
        providerType: input.providerType,
        ...(providerVersion ? { providerVersion } : {}),
        ...(input.providerChannel === 'stable' || input.providerChannel === 'preview'
            ? { providerChannel: input.providerChannel }
            : {}),
        launchedBy: input.launchedBy,
        launchedAt: input.launchedAt,
        ...(workspace ? { workspace } : {}),
        model: buildModelSelection(input.model, input.launchedAt),
        thinkingLevel: buildModelSelection(input.thinkingLevel, input.launchedAt),
        ...(autoApproveModeId ? { autoApproveModeId } : {}),
    };
}

/**
 * The record for a hosted session re-attached after a daemon restart.
 *
 * The stored record (session-host `meta.launchRecord`, written at spawn) keeps
 * its axis sources — the user still picked that model — and only `launchedBy`
 * becomes `restore`. A runtime spawned before Phase E has no stored record:
 * the restored session then gets an honest `unspecified` record rather than
 * none, so readers never have to special-case "restored, provenance unknown".
 */
export function buildRestoredLaunchRecord(
    stored: unknown,
    fallback: { sessionId: string; providerType: string; workspace?: string; launchedAt: number },
): SessionLaunchRecord {
    const parsed = parseSessionLaunchRecord(stored);
    if (parsed) return { ...parsed, sessionId: fallback.sessionId, launchedBy: 'restore' };
    return buildSessionLaunchRecord({
        sessionId: fallback.sessionId,
        providerType: fallback.providerType,
        launchedBy: 'restore',
        launchedAt: fallback.launchedAt,
        workspace: fallback.workspace,
        model: {},
        thinkingLevel: {},
    });
}

/** Deep-enough copy for handing a record to a bus subscriber (axes + history arrays). */
export function cloneLaunchRecord(record: SessionLaunchRecord): SessionLaunchRecord {
    const cloneAxis = (axis: ModelSelection): ModelSelection => ({ ...axis, history: axis.history.map((entry) => ({ ...entry })) });
    return { ...record, model: cloneAxis(record.model), thinkingLevel: cloneAxis(record.thinkingLevel) };
}

/** Append to an axis history, keeping the first `launch` entry and the newest rest. */
export function appendAxisHistory(axis: ModelSelection, entry: ModelSelection['history'][number]): void {
    axis.history.push(entry);
    if (axis.history.length <= MODEL_SELECTION_HISTORY_LIMIT) return;
    const first = axis.history[0];
    const keepFirst = first?.via === 'launch';
    const tail = axis.history.slice(-(MODEL_SELECTION_HISTORY_LIMIT - (keepFirst ? 1 : 0)));
    axis.history = keepFirst ? [first, ...tail] : tail;
}
