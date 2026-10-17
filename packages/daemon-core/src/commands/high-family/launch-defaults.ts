import { mustStage, type StoreWriteOrigin } from '../../assistant/store-guards.js';
import type { LaunchDefaultsReadResponse, LaunchDefaultsSetResponse, LaunchDefaultsProposal } from '@adhdev/mesh-shared';
import { COMMAND_SOURCES, defineCommandSpecs } from '../command-registry.js';
import type { HighFamilyHandler } from './types.js';
import { MeshConfigStrictLockError } from '../../config/mesh-config-store.js';
import { getLaunchDefaultsCommandPorts, LaunchDefaultsCatalogError } from '../../launch-defaults/ports.js';
import { hasOnlyKeys, isLaunchDefaultsDocument, isLaunchRole, isRecord, resolveLaunchSelection,
    selectionSchemaIssue, validateLaunchDefault, type LaunchDefaultEntry, type LaunchDefaultsRead,
    type LaunchDefaultsStore, type LaunchDefaultsWriteResult, type LaunchRole, type LaunchSelection,
    type LaunchValidationPorts, type LaunchValidationWarning, type ResolveLaunchResult,
    type ToolRestriction } from '../../launch-defaults/index.js';

/** Source enforcement is performed by the existing command registry/router. */
export const launchDefaultsCommandSources = {
    launch_defaults_get: COMMAND_SOURCES,
    launch_defaults_set: ['p2p', 'ws', 'standalone'],
    assistant_launch_defaults: ['ipc', 'standalone'],
    assistant_launch_defaults_set: ['ipc', 'standalone'],
} as const;
const NEXT_LAUNCH = 'Applies to the next launch; running sessions are unchanged.';
type StoreFailure = Extract<LaunchDefaultsWriteResult, { ok: false }>;
type ResolutionFailure = Extract<ResolveLaunchResult, { ok: false }>;
type CommandErrorCode = StoreFailure['code'] | ResolutionFailure['code']
    | 'project_not_found' | 'project_ambiguous' | 'project_not_hosted' | 'project_storage_unavailable'
    | 'staging_unavailable' | 'staging_failed' | 'review_turn_tool_denied';
type ErrorDetail = Partial<Pick<ResolutionFailure, 'role' | 'field' | 'reason' | 'source' | 'value' | 'defaultRef' | 'candidates'>>
    & { committed?: boolean; actualRevision?: number; documentRevision?: number };
function fail(code: CommandErrorCode, error: string, detail: ErrorDetail = {}) {
    return { success: false as const, code, error, ...detail };
}
export interface HostProjectLaunchState {
    projectId: string;
    /** Host token survives a clear even though entry becomes null. */
    revision: number;
    entry: LaunchDefaultEntry | null;
}
type ProjectRead = { ok: true; state: HostProjectLaunchState }
    | { ok: false; code: 'project_not_found' | 'project_ambiguous' | 'project_not_hosted' | 'project_storage_unavailable' };
export interface LaunchDefaultsProjectPort {
    /** Read HOST getMesh data only. Refuse remote hosts; never use inline/repo data. */
    read(project: string): ProjectRead;
    /** Serialize read/CAS/revalidation/replace with meshes.json writers and
     * refuse acquisition failure. Production uses the dedicated strict helper. */
    withWriteLock<T>(operation: () => T): T;
    /** Persist sibling coordinatorLaunch (including clear token) in host meshes.json.
     * Preserve all coordinator/worker policy fields. No separate project store. */
    replace(state: HostProjectLaunchState): { ok: true; durable: true }
        | { ok: false; reason: string; committed: boolean };
}
export type LaunchDefaultsStagingProposal = LaunchDefaultsProposal;
export interface LaunchDefaultsCommandPorts {
    /** Same store and facts as launch resolution, never a second authority. */
    store: Pick<LaunchDefaultsStore, 'read' | 'write'>;
    validation: LaunchValidationPorts;
    projects?: LaunchDefaultsProjectPort;
    /** Adapter to existing AssistantInputLog, never origin data from request args. */
    assistantContext?(sessionId: string | undefined): { origin: StoreWriteOrigin; reviewTurnOpen: boolean };
    currentAssistantToolRestriction?(): ToolRestriction | undefined;
    /** Adapter to existing owner Inbox. No staging persistence is invented here. */
    stage?(proposal: LaunchDefaultsStagingProposal): string;
}
interface Parsed {
    action: 'get' | 'check' | 'set' | 'clear';
    role?: LaunchRole;
    project?: string;
    selection?: LaunchSelection;
    expectedRevision?: number;
    sessionId?: string;
}
function parse(args: unknown, write: boolean, assistant: boolean): Parsed | null {
    const raw = args === undefined ? {} : args;
    if (!isRecord(raw) || !hasOnlyKeys(raw, [
        'action', 'role', 'project', 'provider', 'model', 'thinkingLevel',
        ...(write ? ['expectedRevision'] : []), ...(assistant ? ['assistantSessionId'] : []),
    ])) return null;
    const action = raw.action === undefined && !write ? 'get' : raw.action;
    if (write ? action !== 'set' && action !== 'clear' : action !== 'get' && action !== 'check') return null;
    if (action !== 'get' && !isLaunchRole(raw.role) || Object.hasOwn(raw, 'role') && !isLaunchRole(raw.role)) return null;
    if (Object.hasOwn(raw, 'project') && (raw.role !== 'coordinator' || typeof raw.project !== 'string'
        || !raw.project.trim() || raw.project !== raw.project.trim())) return null;
    if (Object.hasOwn(raw, 'assistantSessionId') && (typeof raw.assistantSessionId !== 'string' || !raw.assistantSessionId.trim())) return null;
    const selection = Object.fromEntries(['provider', 'model', 'thinkingLevel']
        .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
    if (action === 'set' || action === 'check') {
        if (selectionSchemaIssue(selection)) return null;
    } else if (Object.keys(selection).length) return null;
    if (write && (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0)) return null;
    return { action: action as Parsed['action'], ...(isLaunchRole(raw.role) ? { role: raw.role } : {}),
        ...(typeof raw.project === 'string' ? { project: raw.project } : {}),
        ...(action === 'set' || action === 'check' ? { selection: selection as unknown as LaunchSelection } : {}),
        ...(write ? { expectedRevision: raw.expectedRevision as number } : {}),
        ...(typeof raw.assistantSessionId === 'string' ? { sessionId: raw.assistantSessionId } : {}) };
}
function diskError(stored: LaunchDefaultsRead) {
    if (stored.status === 'ok' && isLaunchDefaultsDocument(stored.document)) return null;
    return stored.status === 'missing'
        ? fail('launch_default_required', 'Explicitly save launch defaults on this daemon.', { documentRevision: 0 })
        : fail('launch_default_unavailable', 'Launch defaults cannot be read.',
            { reason: stored.status === 'ok' ? 'launch_defaults_schema_invalid' : stored.reason });
}
function projectState(ports: LaunchDefaultsCommandPorts, ref: string) {
    if (!ports.projects) return { ok: false as const, code: 'project_storage_unavailable' as const };
    const read = ports.projects.read(ref);
    if (!read.ok) return read;
    const state = read.state;
    if (!isRecord(state) || typeof state.projectId !== 'string' || !state.projectId.trim()
        || !Number.isSafeInteger(state.revision) || state.revision < 0
        || state.entry !== null && (!isRecord(state.entry) || state.entry.revision !== state.revision
            || !isLaunchDefaultsDocument({ version: 1, revision: state.revision, coordinator: state.entry, history: [] }))) {
        return { ok: false as const, code: 'project_storage_unavailable' as const };
    }
    return read;
}
function previousRestriction(ports: LaunchDefaultsCommandPorts, previous: LaunchDefaultEntry | null): ToolRestriction | undefined {
    // The active assistant can still have an enforced lock after a default edit.
    const live = ports.currentAssistantToolRestriction?.();
    const prior = previous ? ports.validation.getProvider(ports.validation.resolveAlias(previous.provider))?.assistant.toolRestriction : undefined;
    return live === 'enforced' || prior === 'enforced' ? 'enforced' : live ?? prior;
}
function persistenceFailure(result: StoreFailure) {
    return fail(result.code, result.reason, { reason: result.reason, committed: result.committed,
        ...(result.actualRevision !== undefined ? { actualRevision: result.actualRevision } : {}),
        ...(result.document ? { documentRevision: result.document.revision } : {}),
        ...(result.validation ? result.validation.issue : {}) });
}

/** Shared public wire responses, existing core authority and injectable ports.
 * The production high-family specs below bind this factory to daemon services. */
export function createLaunchDefaultsHandlers(ports: LaunchDefaultsCommandPorts) {
    const run = async (args: unknown, write: boolean, assistant: boolean) => {
        const input = parse(args, write, assistant);
        if (!input) return fail('invalid_args', 'Invalid launch defaults request.');
        let origin: StoreWriteOrigin = 'owner';
        if (assistant) {
            const authority = ports.assistantContext?.(input.sessionId);
            if (authority?.reviewTurnOpen || authority?.origin === 'review') {
                return fail('review_turn_tool_denied', 'Launch defaults tools are unavailable during review turns.');
            }
            origin = authority?.origin === 'human' || authority?.origin === 'review_tainted' ? authority.origin : 'relay';
        }
        const stored = ports.store.read();
        const unavailable = diskError(stored);
        // Explicit global set/clear is the only absent-document bootstrap path.
        // A get on an absent document still answers per role (stored: null with a
        // loud launch_default_required in `effective`), so a UI can offer first setup.
        if (unavailable && !(stored.status === 'missing'
            && (input.action === 'get' || !input.project && (write || input.action === 'check')))) return unavailable;
        let project: HostProjectLaunchState | undefined;
        if (input.project) {
            const read = projectState(ports, input.project);
            if (!read.ok) return fail(read.code, read.code);
            project = read.state;
        }
        if (input.action === 'get') {
            // Every requested role answers on its own: an unset or no-longer-valid
            // default is a loud failure inside that role's `effective` (shared
            // LaunchDefaultsRoleView contract), never a failure of the whole read,
            // and the stored entry is returned as-is so the owner can see and fix it.
            const roles: Partial<Record<LaunchRole, { stored: LaunchDefaultEntry | null; effective: ResolveLaunchResult }>> = {};
            for (const role of input.role ? [input.role] : ['assistant', 'coordinator'] as const) {
                const effective = resolveLaunchSelection({ role, stored,
                    ...(project?.entry ? { hostCoordinatorLaunch: { projectId: project.projectId, revision: project.revision,
                        selection: pickSelection(project.entry) } } : {}) }, ports.validation);
                roles[role] = { stored: stored.status === 'ok' ? stored.document[role] ?? null : null, effective };
            }
            return { success: true as const, result: 'get' as const,
                documentRevision: stored.status === 'ok' ? stored.document.revision : 0, roles,
                ...(project ? { project } : {}) };
        }
        const role = input.role!;
        const previous = project ? project.entry : stored.status === 'ok' ? stored.document[role] ?? null : null;
        const restriction = role === 'assistant' && input.selection && (assistant || input.action === 'check')
            ? previousRestriction(ports, previous) : undefined;
        let selection: LaunchSelection | null = null;
        let warnings: LaunchValidationWarning[] = [];
        let lowersToolLock = false;
        if (input.selection) {
            const validated = validateLaunchDefault(role, input.selection, ports.validation, restriction);
            if (!validated.ok) return fail('launch_default_invalid', validated.issue.reason, { role, ...validated.issue });
            selection = validated.selection;
            warnings = validated.warnings;
            lowersToolLock = validated.lowersToolLock;
            if (input.action === 'check') return { success: true as const, result: 'check' as const, role,
                selection, warnings, toolRestriction: validated.toolRestriction, lowersToolLock };
        }
        const revision = project?.revision ?? (stored.status === 'ok' ? stored.document.revision : 0);
        if (input.expectedRevision !== revision) return fail('revision_conflict', 'Default revision changed.', { actualRevision: revision, committed: false });
        const providerChange = assistant && role === 'assistant' && selection !== null && (!previous
            || ports.validation.resolveAlias(previous.provider) !== selection.provider);
        if (assistant && (mustStage(origin) || providerChange && lowersToolLock)) {
            if (!ports.stage) return fail('staging_unavailable', 'Owner Inbox staging is unavailable.');
            let stagedId: string;
            try {
                stagedId = ports.stage({ kind: 'launch_defaults', role, selection, previous,
                    expectedRevision: revision, origin, ...(project ? { project: project.projectId } : {}),
                    ...(input.sessionId ? { callerSessionId: input.sessionId } : {}) });
            } catch { return fail('staging_failed', 'Could not stage launch defaults.'); }
            if (!/^ldf-[A-Za-z0-9-]+$/.test(stagedId)) return fail('staging_failed', 'Invalid owner Inbox proposal identifier.');
            return { success: true as const, result: 'staged' as const, role, stagedId, previous, selection,
                expectedRevision: revision, warnings, note: NEXT_LAUNCH };
        }
        if (project) {
            const projectId = project.projectId;
            return ports.projects!.withWriteLock(() => {
                const fresh = projectState(ports, projectId);
                if (!fresh.ok) return fail(fresh.code, fresh.code);
                if (fresh.state.projectId !== projectId) return fail('project_storage_unavailable', 'Host project identity changed.');
                if (fresh.state.revision !== input.expectedRevision) return fail('revision_conflict', 'Project default revision changed.', { actualRevision: fresh.state.revision, committed: false });
                if (fresh.state.revision >= Number.MAX_SAFE_INTEGER) return fail('store_unavailable', 'Project revision exhausted.');
                if (selection) {
                    const checked = validateLaunchDefault(role, selection, ports.validation);
                    if (!checked.ok) return fail('launch_default_invalid', checked.issue.reason, { role, ...checked.issue });
                    warnings = checked.warnings;
                }
                const nextRevision = fresh.state.revision + 1;
                const entry: LaunchDefaultEntry | null = selection ? { ...selection, revision: nextRevision,
                    setBy: assistant ? 'assistant' : 'owner', setAt: Date.now() } : null;
                const outcome = ports.projects!.replace({ projectId, revision: nextRevision, entry });
                if (!outcome.ok) return fail('persistence_failed', outcome.reason, { committed: outcome.committed, reason: outcome.reason });
                return { success: true as const, result: 'applied' as const, role, scope: 'project' as const,
                    projectId, entry, previous: fresh.state.entry, revision: nextRevision, warnings,
                    durable: true as const, note: NEXT_LAUNCH };
            });
        }
        const result = ports.store.write({ role, selection, expectedRevision: input.expectedRevision!,
            by: assistant ? 'assistant' : 'owner', origin, previousToolRestriction: restriction });
        if (!result.ok) return persistenceFailure(result);
        return { success: true as const, result: 'applied' as const, role, scope: 'global' as const,
            entry: result.document[role] ?? null, previous: result.previous, revision: result.document.revision,
            warnings: result.warnings, durable: result.durable, note: NEXT_LAUNCH };
    };
    const guarded = async (args: unknown, write: boolean, assistant: boolean) => {
        try { return await run(args, write, assistant); }
        catch (error) {
            if (error instanceof MeshConfigStrictLockError) return fail(error.code, error.message, { committed: false,
                ...(error.lockPath ? { reason: `${error.code === 'store_busy' ? 'write_lock_held' : 'write_lock_unavailable'}: ${error.lockPath}` } : {}) });
            if (error instanceof LaunchDefaultsCatalogError) return fail('launch_default_unavailable', error.message, { reason: 'catalog_unavailable' });
            return fail('persistence_failed', 'Launch defaults operation outcome is unconfirmed.', { reason: 'operation_outcome_unconfirmed' });
        }
    };
    type Result = Awaited<ReturnType<typeof guarded>>;
    type ReadResult = Exclude<Result, { result: 'applied' | 'staged' }>;
    type WriteResult = Exclude<Result, { result: 'get' | 'check' }>;
    // parse() enforces the disjoint read/write action sets at runtime.
    const read = (args: unknown, assistant: boolean): Promise<LaunchDefaultsReadResponse> => guarded(args, false, assistant) as Promise<ReadResult>;
    const write = (args: unknown, assistant: boolean): Promise<LaunchDefaultsSetResponse> => guarded(args, true, assistant) as Promise<WriteResult>;
    return {
        launch_defaults_get: (_context: unknown, args: unknown) => read(args, false),
        launch_defaults_set: (_context: unknown, args: unknown) => write(args, false),
        assistant_launch_defaults: (_context: unknown, args: unknown) => read(args, true),
        assistant_launch_defaults_set: (_context: unknown, args: unknown) => write(args, true),
    };
}
function pickSelection(entry: LaunchDefaultEntry): LaunchSelection {
    return { provider: entry.provider, ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}) };
}

function productionHandler(name: keyof ReturnType<typeof createLaunchDefaultsHandlers>): HighFamilyHandler {
    return async (ctx, args) => ({ ...await createLaunchDefaultsHandlers(getLaunchDefaultsCommandPorts(ctx))[name](ctx, args) });
}
export const launchDefaultsSpecs = defineCommandSpecs('high', {
    launch_defaults_get: productionHandler('launch_defaults_get'),
    launch_defaults_set: productionHandler('launch_defaults_set'),
    assistant_launch_defaults: productionHandler('assistant_launch_defaults'),
    assistant_launch_defaults_set: productionHandler('assistant_launch_defaults_set'),
}, {
    launch_defaults_get: { sources: launchDefaultsCommandSources.launch_defaults_get, meshSender: 'authenticated_peer' },
    launch_defaults_set: { sources: launchDefaultsCommandSources.launch_defaults_set, invalidates: ['daemon.metadata'] },
    assistant_launch_defaults: { sources: launchDefaultsCommandSources.assistant_launch_defaults },
    assistant_launch_defaults_set: { sources: launchDefaultsCommandSources.assistant_launch_defaults_set, invalidates: ['daemon.metadata'] },
}, { stripTransportMetadata: true });
