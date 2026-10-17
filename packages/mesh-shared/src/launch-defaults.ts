/** Daemon-local launch intent and command wire contract. P2P/local only;
 * never include this document or its history in cloud status_report.
 * Publication through mesh-shared's barrel is a later integration step. */
export const LAUNCH_DEFAULT_ROLES = ['assistant', 'coordinator'] as const;
export type LaunchDefaultRole = typeof LAUNCH_DEFAULT_ROLES[number];
export const LAUNCH_DEFAULT_SOURCES = ['user', 'stored_default', 'project_default', 'provider_default'] as const;
export type LaunchDefaultSource = typeof LAUNCH_DEFAULT_SOURCES[number];
export const LAUNCH_DEFAULTS_NEXT_LAUNCH_NOTE = 'Applies to the next launch; running sessions are unchanged.';
export function isLaunchDefaultRole(value: unknown): value is LaunchDefaultRole {
    return typeof value === 'string' && (LAUNCH_DEFAULT_ROLES as readonly string[]).includes(value);
}
export function isLaunchDefaultSource(value: unknown): value is LaunchDefaultSource {
    return typeof value === 'string' && (LAUNCH_DEFAULT_SOURCES as readonly string[]).includes(value);
}
export interface LaunchDefaultSelection {
    provider: string;
    /** Omission means pass no model/thinking argument, not inherit another provider. */
    model?: string;
    thinkingLevel?: string;
}
export type LaunchDefaultToolRestriction = 'enforced' | 'prompt_only';
export type LaunchDefaultOrigin = 'owner' | 'human' | 'relay' | 'review' | 'review_tainted';
export interface LaunchDefaultEntry extends LaunchDefaultSelection {
    revision: number;
    setBy: 'owner' | 'assistant';
    setAt: number;
}
export interface LaunchDefaultChange {
    at: number;
    role: LaunchDefaultRole;
    by: 'owner' | 'assistant';
    origin: LaunchDefaultOrigin;
    from: LaunchDefaultEntry | null;
    to: LaunchDefaultEntry | null;
}
export interface LaunchDefaultsDocument {
    version: 1;
    /** Global document token, including clears; distinct from entry revisions. */
    revision: number;
    assistant?: LaunchDefaultEntry;
    coordinator?: LaunchDefaultEntry;
    history: LaunchDefaultChange[];
}
export interface LaunchDefaultRef {
    role: LaunchDefaultRole;
    scope: 'global' | 'project';
    /** Entry revision for global defaults; host project token for project defaults. */
    revision: number;
    projectId?: string;
}
export type LaunchDefaultField = keyof LaunchDefaultSelection;
export interface LaunchDefaultAxis {
    value: string | null;
    source: LaunchDefaultSource;
    defaultRef?: LaunchDefaultRef;
}
export type LaunchDefaultWarning = 'catalog_unverified' | 'manual_mcp_setup_required';
export type LaunchDefaultValidationReason =
    | 'invalid_schema' | 'provider_unknown' | 'provider_not_cli' | 'provider_disabled'
    | 'provider_not_detected' | 'provider_not_eligible' | 'model_unsupported'
    | 'model_provider_mismatch' | 'model_not_offered' | 'thinking_unsupported'
    | 'thinking_not_offered' | 'catalog_unavailable';
export type LaunchDefaultResolution =
    | { ok: true; selection: LaunchDefaultSelection; applied: Record<LaunchDefaultField, LaunchDefaultAxis>;
        defaultRef?: LaunchDefaultRef; documentRevision: number; warnings: LaunchDefaultWarning[];
        toolRestriction: LaunchDefaultToolRestriction }
    | { ok: false; code: 'launch_default_required' | 'launch_default_unavailable' | 'launch_selection_invalid';
        role: LaunchDefaultRole; field: LaunchDefaultField; reason: string; source?: LaunchDefaultSource;
        value?: string | null; defaultRef?: LaunchDefaultRef; candidates?: readonly string[]; hint: string };
export interface LaunchDefaultsRoleView {
    stored: LaunchDefaultEntry | null;
    /** The existing daemon resolver's result, including loud failures. */
    effective: LaunchDefaultResolution;
}
type Target = { role: 'assistant'; project?: never } | { role: 'coordinator'; project?: string };
export type LaunchDefaultsReadRequest =
    | ({ action?: 'get' } & (Target | { role?: never; project?: never }))
    | ({ action: 'check' } & Target & LaunchDefaultSelection);
/** Mandatory CAS: global document token, or host project token for project writes.
 * 0 is explicit first setup; clears advance the token and never restore fallback. */
export type LaunchDefaultsSetRequest = Target & { expectedRevision: number } & (
    | ({ action: 'set' } & LaunchDefaultSelection)
    | { action: 'clear'; provider?: never; model?: never; thinkingLevel?: never }
);
/** Existing assistant routing envelope; session identity never supplies origin. */
export type AssistantLaunchDefaultsReadRequest = LaunchDefaultsReadRequest & { assistantSessionId?: string };
export type AssistantLaunchDefaultsSetRequest = LaunchDefaultsSetRequest & { assistantSessionId?: string };
export const LAUNCH_DEFAULT_ERROR_CODES = [
    'invalid_args', 'launch_default_required', 'launch_default_unavailable', 'launch_selection_invalid',
    'launch_default_invalid', 'revision_conflict', 'store_unavailable', 'store_busy', 'persistence_failed',
    'project_not_found', 'project_ambiguous', 'project_not_hosted', 'project_storage_unavailable',
    'staging_unavailable', 'staging_failed', 'review_turn_tool_denied',
] as const;
export type LaunchDefaultsErrorCode = typeof LAUNCH_DEFAULT_ERROR_CODES[number];
export interface LaunchDefaultsError {
    success: false;
    code: LaunchDefaultsErrorCode;
    error: string;
    reason?: string;
    role?: LaunchDefaultRole;
    field?: LaunchDefaultField;
    source?: LaunchDefaultSource;
    value?: string | null;
    defaultRef?: LaunchDefaultRef;
    candidates?: readonly string[];
    actualRevision?: number;
    /** 0 for an absent global document; absent when it cannot be read. */
    documentRevision?: number;
    /** A persistence failure can replace intent without confirming durability.
     * Re-read before retrying; never report applied on committed:true alone. */
    committed?: boolean;
}
export interface LaunchDefaultsReadSuccess {
    success: true;
    result: 'get';
    documentRevision: number;
    roles: Partial<Record<LaunchDefaultRole, LaunchDefaultsRoleView>>;
    project?: { projectId: string; revision: number; entry: LaunchDefaultEntry | null };
}
export interface LaunchDefaultsCheckSuccess {
    success: true;
    result: 'check';
    role: LaunchDefaultRole;
    selection: LaunchDefaultSelection;
    warnings: LaunchDefaultWarning[];
    toolRestriction: LaunchDefaultToolRestriction;
    lowersToolLock: boolean;
}
export interface LaunchDefaultsApplied {
    success: true;
    result: 'applied';
    role: LaunchDefaultRole;
    scope: 'global' | 'project';
    projectId?: string;
    entry: LaunchDefaultEntry | null;
    previous: LaunchDefaultEntry | null;
    /** CAS token returned by the authority that performed the write. */
    revision: number;
    warnings: LaunchDefaultWarning[];
    durable: true;
    note: string;
}
export interface LaunchDefaultsStaged {
    success: true;
    result: 'staged';
    role: LaunchDefaultRole;
    stagedId: string;
    previous: LaunchDefaultEntry | null;
    selection: LaunchDefaultSelection | null;
    expectedRevision: number;
    warnings: LaunchDefaultWarning[];
    note: string;
}
/** Existing owner Inbox adapter stores this proposal; it is not another default.
 * Applying it must revalidate on the host and CAS via the same set handler. */
export interface LaunchDefaultsProposal {
    kind: 'launch_defaults';
    role: LaunchDefaultRole;
    project?: string;
    selection: LaunchDefaultSelection | null;
    previous: LaunchDefaultEntry | null;
    expectedRevision: number;
    origin: LaunchDefaultOrigin;
    callerSessionId?: string;
}
export type LaunchDefaultsReadResponse = LaunchDefaultsReadSuccess | LaunchDefaultsCheckSuccess | LaunchDefaultsError;
export type LaunchDefaultsSetResponse = LaunchDefaultsApplied | LaunchDefaultsStaged | LaunchDefaultsError;
export type LaunchDefaultsResponse = LaunchDefaultsReadResponse | LaunchDefaultsSetResponse;
