/** Persisted role-launch intent. Restart replays this selection rather than
 * consulting newer machine defaults; restore preserves its original provenance. */
import { isLaunchDefaultRole, isLaunchDefaultSource, type LaunchDefaultRole,
    type LaunchDefaultSelection, type LaunchDefaultAxis, type LaunchDefaultRef } from './launch-defaults';
export interface RoleLaunchSelection {
    role: LaunchDefaultRole;
    selection: LaunchDefaultSelection;
    applied: Record<keyof LaunchDefaultSelection, LaunchDefaultAxis>;
    defaultRef?: LaunchDefaultRef;
    documentRevision: number;
}
function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}
function ref(value: unknown): LaunchDefaultRef | undefined {
    const r = record(value);
    if (!r || !isLaunchDefaultRole(r.role) || (r.scope !== 'global' && r.scope !== 'project')
        || !Number.isSafeInteger(r.revision) || (r.revision as number) < 1
        || (r.scope === 'project' && (typeof r.projectId !== 'string' || !r.projectId))) return undefined;
    return { role: r.role, scope: r.scope, revision: r.revision as number,
        ...(r.scope === 'project' ? { projectId: r.projectId as string } : {}) };
}
function axis(value: unknown): LaunchDefaultAxis | undefined {
    const a = record(value);
    if (!a || !isLaunchDefaultSource(a.source) || (a.value !== null && typeof a.value !== 'string')) return undefined;
    const defaultRef = ref(a.defaultRef);
    if (a.source === 'stored_default' && defaultRef?.scope !== 'global'
        || a.source === 'project_default' && defaultRef?.scope !== 'project'
        || (a.source === 'user' || a.source === 'provider_default') && a.defaultRef !== undefined) return undefined;
    return { value: a.value as string | null, source: a.source, ...(defaultRef ? { defaultRef } : {}) };
}
export function parseRoleLaunchSelection(value: unknown): RoleLaunchSelection | undefined {
    const r = record(value), s = record(r?.selection), a = record(r?.applied);
    if (!r || !isLaunchDefaultRole(r.role) || !s || typeof s.provider !== 'string' || !s.provider
        || !Number.isSafeInteger(r.documentRevision) || (r.documentRevision as number) < 1
        || (s.model !== undefined && typeof s.model !== 'string')
        || (s.thinkingLevel !== undefined && typeof s.thinkingLevel !== 'string')) return undefined;
    const provider = axis(a?.provider), model = axis(a?.model), thinkingLevel = axis(a?.thinkingLevel);
    if (!provider || !model || !thinkingLevel
        || [provider, model, thinkingLevel].some(axis => axis.defaultRef && (axis.defaultRef.role !== r.role
            || axis.defaultRef.scope === 'global' && axis.defaultRef.revision > (r.documentRevision as number)))
        || provider.value !== s.provider
        || model.value !== (s.model ?? null) || thinkingLevel.value !== (s.thinkingLevel ?? null)) return undefined;
    const defaultRef = ref(r.defaultRef);
    return { role: r.role, selection: { provider: s.provider,
        ...(typeof s.model === 'string' ? { model: s.model } : {}),
        ...(typeof s.thinkingLevel === 'string' ? { thinkingLevel: s.thinkingLevel } : {}) },
        applied: { provider, model, thinkingLevel }, ...(defaultRef ? { defaultRef } : {}),
        documentRevision: r.documentRevision as number };
}
