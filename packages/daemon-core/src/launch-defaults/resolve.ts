import { isLaunchDefaultsDocument, type LaunchDefaultsRead } from './store.js';
import { hasOnlyKeys, isLaunchRole, isRecord, selectionSchemaIssue, validateLaunchDefault,
    type LaunchField, type LaunchRole, type LaunchSelection, type LaunchValidationPorts,
    type LaunchValidationReason, type LaunchValidationWarning, type ToolRestriction } from './validate.js';

export type LaunchValueSource = 'user' | 'project_default' | 'stored_default' | 'provider_default';
export interface LaunchDefaultRef {
    role: LaunchRole;
    scope: 'global' | 'project';
    revision: number;
    projectId?: string;
}
export interface ResolvedLaunchAxis {
    value: string | null;
    source: LaunchValueSource;
    defaultRef?: LaunchDefaultRef;
}
/** Construct only from the host's getMesh(meshId).coordinatorLaunch, never
 * inlineMesh or repository config. The integration owns that trust boundary. */
export interface HostCoordinatorLaunchOverride {
    projectId: string;
    revision: number;
    selection: LaunchSelection;
}
export interface ResolveLaunchInput {
    role: LaunchRole;
    stored: LaunchDefaultsRead;
    override?: Partial<LaunchSelection>;
    hostCoordinatorLaunch?: HostCoordinatorLaunchOverride;
    ignoreDefault?: true | LaunchField[];
}
export type ResolveLaunchResult =
    | { ok: true; selection: LaunchSelection;
        applied: Record<LaunchField, ResolvedLaunchAxis>; defaultRef?: LaunchDefaultRef;
        /** Revision of the disk snapshot even when every axis was explicit. */
        documentRevision: number; warnings: LaunchValidationWarning[]; toolRestriction: ToolRestriction }
    | { ok: false; code: 'launch_default_required' | 'launch_default_unavailable' | 'launch_selection_invalid';
        role: LaunchRole; field: LaunchField; reason: string; source?: LaunchValueSource;
        value?: string | null; defaultRef?: LaunchDefaultRef; candidates?: readonly string[]; hint: string };

/** Sole, read-only resolver. No worker slots, registry stickiness, CLI/browser
 * memory, implicit provider choice or persistence is accepted by this contract. */
export function resolveLaunchSelection(input: ResolveLaunchInput, ports: LaunchValidationPorts): ResolveLaunchResult {
    const failure = (code: Extract<ResolveLaunchResult, { ok: false }>['code'], field: LaunchField,
        reason: string, axis?: ResolvedLaunchAxis, candidates?: readonly string[]): ResolveLaunchResult =>
        ({ ok: false, code, role: input.role, field, reason, ...axis,
            ...(candidates ? { candidates } : {}),
            hint: code === 'launch_default_required' ? 'Explicitly save launch defaults on this daemon before launching.'
                : 'Correct the launch selection or explicitly update the default on the host daemon.' });
    if (!isLaunchRole(input.role)) return failure('launch_selection_invalid', 'provider', 'invalid_role');
    // Even a fully explicit launch cannot silently bootstrap or repair disk state.
    if (input.stored.status !== 'ok') return failure(input.stored.status === 'missing' ? 'launch_default_required' : 'launch_default_unavailable', 'provider', input.stored.reason);
    const document = input.stored.document;
    if (!isLaunchDefaultsDocument(document)) return failure('launch_default_unavailable', 'provider', 'launch_defaults_schema_invalid');
    const override: unknown = input.override === undefined ? {} : input.override;
    const schemaIssue = selectionSchemaIssue(override, true);
    if (schemaIssue) return failure('launch_selection_invalid', schemaIssue.field, schemaIssue.reason, { value: null, source: 'user' });
    const explicit = override as Partial<LaunchSelection>;
    const ignored = input.ignoreDefault === true ? ['provider', 'model', 'thinkingLevel'] : input.ignoreDefault ?? [];
    if (!Array.isArray(ignored) || ignored.some(field => !['provider', 'model', 'thinkingLevel'].includes(field))) {
        return failure('launch_selection_invalid', 'provider', 'invalid_ignore_default');
    }
    const project = input.hostCoordinatorLaunch;
    if (project !== undefined && (input.role !== 'coordinator' || !isRecord(project)
        || !hasOnlyKeys(project, ['projectId', 'revision', 'selection'])
        || typeof project.projectId !== 'string' || !project.projectId.trim()
        || !Number.isSafeInteger(project.revision) || project.revision < 1 || selectionSchemaIssue(project.selection))) {
        return failure('launch_default_unavailable', 'provider', 'invalid_host_project_override', { value: null, source: 'project_default' });
    }
    // A project entry replaces the global triple as a whole, including omissions.
    const base = project?.selection ?? document[input.role];
    const baseSource = project ? 'project_default' : 'stored_default';
    const ref: LaunchDefaultRef | undefined = project
        ? { role: input.role, scope: 'project', revision: project.revision, projectId: project.projectId }
        : base ? { role: input.role, scope: 'global', revision: document[input.role]!.revision } : undefined;
    const provider = explicit.provider ?? (ignored.includes('provider') ? undefined : base?.provider);
    if (!provider) return failure('launch_default_required', 'provider', 'role_default_unset');
    let sameProvider = false;
    try { sameProvider = !!base && ports.resolveAlias(provider) === ports.resolveAlias(base.provider); }
    catch { return failure('launch_default_unavailable', 'provider', 'catalog_unavailable'); }
    const axis = (field: LaunchField): ResolvedLaunchAxis => {
        if (explicit[field] !== undefined) return { value: explicit[field]!, source: 'user' };
        if (!ignored.includes(field) && (field === 'provider' || sameProvider) && base?.[field] !== undefined) {
            return { value: base[field]!, source: baseSource, defaultRef: ref };
        }
        return { value: null, source: 'provider_default' };
    };
    const applied = { provider: axis('provider'), model: axis('model'), thinkingLevel: axis('thinkingLevel') };
    const candidate: LaunchSelection = { provider,
        ...(applied.model.value !== null ? { model: applied.model.value } : {}),
        ...(applied.thinkingLevel.value !== null ? { thinkingLevel: applied.thinkingLevel.value } : {}) };
    const validated = validateLaunchDefault(input.role, candidate, ports);
    if (!validated.ok) {
        const issue: { field: LaunchField; reason: LaunchValidationReason; candidates?: readonly string[] } = validated.issue;
        return failure(applied[issue.field].source === 'user' ? 'launch_selection_invalid' : 'launch_default_unavailable',
            issue.field, issue.reason, applied[issue.field], issue.candidates);
    }
    applied.provider.value = validated.selection.provider;
    const usedDefault = Object.values(applied).some(value => value.defaultRef !== undefined);
    return { ok: true, selection: validated.selection, applied, ...(usedDefault ? { defaultRef: ref } : {}),
        documentRevision: document.revision, warnings: validated.warnings, toolRestriction: validated.toolRestriction };
}
