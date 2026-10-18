/** Fresh role launches resolve here before any config or process effects.
 * Restarts replay the recorded selection; they never consume newer defaults. */
import { statSync } from 'node:fs';
import { getMeshConfigPath } from '../config/mesh-config-store.js';
import type { HighFamilyContext } from '../commands/high-family/types.js';
import { getLaunchDefaultsCommandPorts } from './ports.js';
import { resolveLaunchSelection, type ResolveLaunchResult } from './resolve.js';
import type { LaunchRole, LaunchSelection } from './validate.js';

export function resolveRoleLaunch(ctx: Pick<HighFamilyContext, 'deps'>, role: LaunchRole,
    override: Partial<LaunchSelection>, projectId?: string): ResolveLaunchResult {
    const ports = getLaunchDefaultsCommandPorts(ctx);
    const unavailable = (reason: string): ResolveLaunchResult => ({ ok: false,
        code: 'launch_default_unavailable', role, field: 'provider', reason,
        hint: 'Correct the launch defaults on the host daemon before launching.' });
    if (!ports.store.withSnapshot) return unavailable('snapshot_lock_unavailable');
    try {
        return ports.store.withSnapshot(stored => {
            if (stored.status !== 'ok') return resolveLaunchSelection({ role, stored, override }, ports.validation);
            if (projectId && !ports.projects) return unavailable('project_storage_unavailable');
            const resolve = () => {
                // Only this daemon's persisted host inventory may supply a project
                // override. A cloud inline mesh is never a defaults authority.
                let hasHostInventory = false;
                if (projectId) {
                    try { statSync(getMeshConfigPath()); hasHostInventory = true; }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                }
                const project = hasHostInventory ? ports.projects?.read(projectId!) : undefined;
                if (project && !project.ok && project.code !== 'project_not_found') return unavailable(project.code);
                const state = project?.ok ? project.state : undefined;
                return resolveLaunchSelection({ role, stored, override,
                    ...(state?.entry ? { hostCoordinatorLaunch: { projectId: state.projectId,
                        revision: state.revision, selection: { provider: state.entry.provider,
                            ...(state.entry.model !== undefined ? { model: state.entry.model } : {}),
                            ...(state.entry.thinkingLevel !== undefined ? { thinkingLevel: state.entry.thinkingLevel } : {}) } } } : {}),
                }, ports.validation);
            };
            return projectId && ports.projects ? ports.projects.withWriteLock(resolve) : resolve();
        });
    } catch { return unavailable('launch_snapshot_unavailable'); }
}

export function roleLaunchFailure(result: Extract<ResolveLaunchResult, { ok: false }>) {
    return { ...result, success: false as const,
        error: `${result.role} launch ${result.field} '${result.value ?? ''}' unavailable: ${result.reason}. ${result.hint}` };
}
export function roleLaunchProvenance(role: LaunchRole, result: Extract<ResolveLaunchResult, { ok: true }>) {
    return { providerSource: result.applied.provider.source, modelSource: result.applied.model.source,
        thinkingLevelSource: result.applied.thinkingLevel.source,
        roleLaunch: { role, selection: result.selection, applied: result.applied,
            ...(result.defaultRef ? { defaultRef: result.defaultRef } : {}), documentRevision: result.documentRevision } };
}
