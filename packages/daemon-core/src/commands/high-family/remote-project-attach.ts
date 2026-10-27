/** Authenticated setup commands. These are never mesh-forwardable. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { loadConfig, updateConfig } from '../../config/config.js';
import { getMesh } from '../../config/mesh-config.js';
import { setMeshHostPin } from '../../config/mesh-config-host-pairing.js';
import { readMeshHostRecord, writeMeshHostRecord } from '../../mesh/mesh-host-memory.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { githubRemote, git, checkoutRemote, managedCheckoutPath, verifyCheckout, pythonResourcePreflight, refusal, AttachFailure } from '../../assistant/remote-project-checkout.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
const str = (v: unknown) => typeof v === 'string' ? v : '';
const fail = (code: string, stage: string, action: string, subcode?: string) => ({ success: false, code, ...(subcode ? { subcode } : {}), stage, action, attached: false });
export type ProjectAttachStepStage = 'prepare' | 'checkout' | 'register' | 'accept';
export type ProjectAttachRole = 'source' | 'target';
export function projectAttachStepAttribution(command: string): { stage: ProjectAttachStepStage; role: ProjectAttachRole } {
    switch (command) {
        case 'remote_project_prepare': return { stage: 'prepare', role: 'source' };
        case 'remote_project_register': return { stage: 'register', role: 'source' };
        case 'remote_project_accept': return { stage: 'accept', role: 'target' };
        case 'remote_project_checkout':
        default: return { stage: 'checkout', role: 'target' };
    }
}
export function formatProjectAttachDisabledHint(info: { stage?: string; role?: string; daemonId?: string; machineName?: string }): string {
    const roleLabel = info.role === 'source' ? 'source' : info.role === 'target' ? 'target' : 'selected';
    const name = str(info.machineName).trim();
    const id = str(info.daemonId).trim();
    const machineDesc = name && id && name !== id ? `${name} (${id})` : name || id || 'this machine';
    const stagePart = str(info.stage).trim() ? ` at stage "${str(info.stage).trim()}"` : '';
    return `Remote project attachment is disabled on the ${roleLabel} machine ${machineDesc}${stagePart} (\`allowRemoteProjectAttach\` is off). Turn on "Remote project attach" for ${machineDesc} in Dashboard → Settings, or set \`"allowRemoteProjectAttach": true\` in its daemon \`config.json\` (no restart required). Both source and target machines must have \`allowRemoteProjectAttach\`` + ' enabled.';
}
function selected(ctx: HighFamilyContext, args: any) {
    if (!/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args?.targetDaemonId)) || !daemonIdsEquivalent(args.targetDaemonId, ctx.deps.statusInstanceId)) throw new AttachFailure('WRONG_MACHINE', 'target_access', 'Address the exact owner-selected canonical daemon.');
}
function validGrant(grant: any, selfId: string, hostId: string, meshId: string, identity: string, secret: string | null | undefined): boolean {
    if (!grant || typeof grant !== 'object' || typeof secret !== 'string' || !secret.trim()) return false;
    if (!daemonIdsEquivalent(str(grant.target), selfId) || !daemonIdsEquivalent(str(grant.host), hostId) || grant.meshId !== meshId || grant.identity !== identity) return false;
    const now = Date.now();
    if (typeof grant.exp !== 'number' || !Number.isFinite(grant.exp) || grant.exp <= now || grant.exp > now + 600_000 || !/^[0-9a-f]{64}$/.test(str(grant.sig))) return false;
    const key = createHash('sha256').update(secret).digest('hex');
    const expected = createHmac('sha256', key).update(`${grant.target}\n${grant.host}\n${grant.meshId}\n${grant.identity}\n${grant.exp}`).digest('hex');
    return timingSafeEqual(Buffer.from(grant.sig, 'hex'), Buffer.from(expected, 'hex'));
}
function authorizeHost(ctx: HighFamilyContext, args: any, identity: string) {
    const hostId = str(args?.hostDaemonId);
    if (!/^daemon_mach_[a-zA-Z0-9]+$/.test(hostId) || daemonIdsEquivalent(hostId, ctx.deps.statusInstanceId)) throw new AttachFailure('HOST_NOT_AUTHORIZED', 'target_access', 'Authorize the project host on the selected daemon before attaching.');
    const old = readMeshHostRecord(args.meshId);
    if (old && !daemonIdsEquivalent(old.hostDaemonId, hostId)) throw new AttachFailure('PROJECT_HOST_CONFLICT', 'registration', 'Preserve existing membership; resolve the project host conflict locally.');
    const cfg = loadConfig();
    if (args?.grant !== undefined) {
        if (!validGrant(args.grant, str(ctx.deps.statusInstanceId), hostId, args.meshId, identity, cfg.machineSecret)) throw new AttachFailure('HOST_NOT_AUTHORIZED', 'target_access', 'Authorize the project host on the selected daemon before attaching.');
        return old;
    }
    const allowed = (cfg.allowedRemoteProjectHosts ?? []).some(h => daemonIdsEquivalent(h, hostId)) || Boolean(old && daemonIdsEquivalent(old.hostDaemonId, hostId));
    if (!allowed) throw new AttachFailure('HOST_NOT_AUTHORIZED', 'target_access', 'Authorize the project host on the selected daemon before attaching.');
    return old;
}
async function prepare(ctx: HighFamilyContext, args: any) {
    const mesh = getMesh(str(args?.meshId));
    if (!mesh) throw new AttachFailure('PROJECT_NOT_FOUND', 'registration', 'Use a project registered on the authenticated source daemon.');
    const host = resolveMeshHostStatus(mesh, { localDaemonId: ctx.deps.statusInstanceId });
    if (!host.canOwnCoordinator || !daemonIdsEquivalent(host.hostDaemonId, ctx.deps.statusInstanceId)) throw new AttachFailure('PROJECT_HOST_REQUIRED', 'registration', 'Request attachment through the registered project host.');
    const remote = githubRemote(mesh.repoRemoteUrl);
    if (!remote || remote.identity !== str(mesh.repoIdentity).toLowerCase()) throw new AttachFailure('LOCAL_ONLY_PROJECT', 'registration', 'Register a verified GitHub-backed project first; local-only projects cannot attach across machines.');
    const self = mesh.nodes.find(n => daemonIdsEquivalent(n.daemonId, ctx.deps.statusInstanceId));
    if (!self) throw new AttachFailure('SOURCE_CHECKOUT_REQUIRED', 'registration', 'The project host needs its registered source checkout for remote identity verification.');
    const origin = githubRemote(await git(self.workspace, ['remote', 'get-url', 'origin']));
    if (origin?.identity !== remote.identity) throw new AttachFailure('REMOTE_IDENTITY_MISMATCH', 'registration', 'Registered project identity must match the source checkout origin.');
    return { mesh, remote, self, hostSynthesized: host.hostSynthesized === true };
}
export const attachRemoteProject: HighFamilyHandler = async (ctx, args) => {
    if (!/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args?.targetDaemonId))) return fail('INVALID_TARGET', 'target_access', 'Pass the exact owner-selected canonical daemon_mach_* identity.');
    try { await prepare(ctx, args); } catch (e) { return refusal(e); }
    if (!ctx.deps.attachRemoteProject) return fail('CAPABILITY_NOT_AVAILABLE', 'authentication', 'This runtime has no authenticated remote attachment bridge. Activate the reviewed cloud preview capability.');
    const res: any = await ctx.deps.attachRemoteProject(args.meshId, args.targetDaemonId);
    if (res && res.code === 'PROJECT_ATTACH_DISABLED') {
        const role: ProjectAttachRole = res.role === 'source' || res.role === 'target'
            ? res.role
            : (res.stage === 'prepare' || res.stage === 'register' ? 'source' : 'target');
        const stage = str(res.stage).trim() || (role === 'source' ? 'prepare' : 'checkout');
        const daemonId = str(res.daemonId).trim() || (role === 'source' ? str(ctx.deps.statusInstanceId) : str(args.targetDaemonId));
        const machineName = str(res.machineName).trim() || (role === 'source' ? (loadConfig().machineNickname?.trim() || daemonId) : daemonId);
        const hint = formatProjectAttachDisabledHint({ stage, role, daemonId, machineName });
        return {
            ...res,
            success: false,
            attached: false,
            code: 'PROJECT_ATTACH_DISABLED',
            stage,
            role,
            daemonId,
            machineName,
            setting: 'allowRemoteProjectAttach',
            error: str(res.error).includes('allowRemoteProjectAttach') ? res.error : hint,
            action: str(res.action).includes('allowRemoteProjectAttach') ? res.action : hint,
            hint: str(res.hint).includes('allowRemoteProjectAttach') ? res.hint : hint,
        };
    }
    return res;
};
export const remoteProjectHandlers: Record<string, HighFamilyHandler> = {
    attach_remote_project: attachRemoteProject,
    remote_project_attach_settings: async (ctx, args) => {
        const hasToggleArg = args?.enabled !== undefined || args?.allowRemoteProjectAttach !== undefined;
        const action = args?.action === undefined ? (hasToggleArg ? 'set' : 'get') : str(args.action);
        if (action === 'get') {
            const cfg = loadConfig();
            const enabled = cfg.allowRemoteProjectAttach === true;
            return { success: true, enabled, allowRemoteProjectAttach: enabled, daemonId: str(ctx.deps.statusInstanceId) };
        }
        if (action !== 'set') return { success: false, code: 'INVALID_ARGUMENTS', error: 'Expected action get or set.' };
        const rawEnabled = args?.enabled !== undefined ? args.enabled : args?.allowRemoteProjectAttach;
        if (typeof rawEnabled !== 'boolean') return { success: false, code: 'INVALID_ARGUMENTS', error: 'Expected boolean enabled.' };
        const updated = updateConfig({ allowRemoteProjectAttach: rawEnabled });
        const enabled = updated.allowRemoteProjectAttach === true;
        return { success: true, enabled, allowRemoteProjectAttach: enabled, daemonId: str(ctx.deps.statusInstanceId) };
    },
    remote_project_prepare: async (ctx, args) => {
        try { const { mesh, remote } = await prepare(ctx, args); return { success: true, meshId: mesh.id, ...remote, hostDaemonId: ctx.deps.statusInstanceId }; } catch (e) { return refusal(e); }
    },
    remote_project_checkout: async (ctx, args) => {
        try {
            selected(ctx, args);
            const remote = githubRemote(args?.url);
            if (!remote || remote.identity !== args?.identity || !/^mesh_[a-zA-Z0-9_-]+$/.test(str(args?.meshId))) throw new AttachFailure('REMOTE_IDENTITY_MISMATCH', 'repository_access', 'Only canonical verified GitHub projects are supported.');
            authorizeHost(ctx, args, remote.identity);
            const checkout = await checkoutRemote(args.meshId, remote);
            return { success: true, ...checkout, meshId: args.meshId, identity: remote.identity, targetDaemonId: ctx.deps.statusInstanceId, stage: 'checkout', attached: false };
        } catch (e) { return refusal(e); }
    },
    remote_project_register: async (ctx, args) => {
        try {
            const { mesh, remote, self, hostSynthesized } = await prepare(ctx, args);
            if (args.identity !== remote.identity || !/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args.targetDaemonId)) || !str(args.workspace)) return fail('ATTACH_SCOPE_MISMATCH', 'registration', 'Repeat the authenticated attachment flow with the exact project and target.');
            const existing = mesh.nodes.find(n => daemonIdsEquivalent(n.daemonId, args.targetDaemonId) && n.workspace === args.workspace);
            if (existing) return { success: true, nodeId: existing.id, attached: true };
            // A foreign node on an unpinned mesh makes its host unknown to every reader
            // (HOST-SELF-SYNTHESIS-GUARD), which would also refuse this flow's own retry.
            // Pin this verified host first with the same conservative writer the
            // coordinator launch uses; it never re-homes an existing pin.
            if (hostSynthesized) {
                const pin = setMeshHostPin(mesh.id, { hostDaemonId: ctx.deps.statusInstanceId, hostNodeId: self.id });
                if (!pin || (!pin.applied && pin.reason !== 'already_pinned_same')) return fail('REGISTRATION_FAILED', 'registration', 'Checkout was preserved. Establish this project host before retrying.', 'HOST_PIN_FAILED');
            }
            const result = await ctx.execute('add_mesh_node', { meshId: mesh.id, workspace: args.workspace, repoRoot: args.workspace, daemonId: args.targetDaemonId }, 'internal', { inProcess: true });
            return result.success ? { success: true, nodeId: (result.node as any)?.id, attached: true } : fail('REGISTRATION_FAILED', 'registration', 'Checkout was preserved. Retry after resolving host registration access.', 'NODE_ADD_FAILED');
        } catch (e) { return refusal(e); }
    },
    remote_project_accept: async (ctx, args) => {
        try {
            selected(ctx, args);
            const remote = githubRemote(args.url);
            if (!remote || remote.identity !== args.identity || !/^mesh_[a-zA-Z0-9_-]+$/.test(str(args.meshId)) || !/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args.hostDaemonId))) throw new AttachFailure('ATTACH_SCOPE_MISMATCH', 'registration', 'Use the authenticated project attachment flow.');
            const workspace = await managedCheckoutPath(args.meshId, remote.identity);
            if (workspace !== args.workspace) throw new AttachFailure('PATH_CONFLICT', 'registration', 'Attachment must use its verified managed checkout.');
            const old = authorizeHost(ctx, args, remote.identity);
            await verifyCheckout(workspace, remote.identity);
            if (!old && !writeMeshHostRecord(args.meshId, args.hostDaemonId, 'pairing', undefined, { pairingVerified: true })) return fail('REGISTRATION_FAILED', 'registration', 'Checkout is preserved; restore writable daemon configuration before retrying.', 'HOST_RECORD_WRITE_FAILED');
            const resources = await pythonResourcePreflight();
            return { success: true, attached: true, ready: resources.ready, resources, workspace, targetDaemonId: ctx.deps.statusInstanceId, stage: resources.ready ? 'ready' : 'resource_preflight' };
        } catch (e) { return refusal(e); }
    },
};
export const remoteProjectSpecs = {
    attach_remote_project: { sources: ['ipc', 'standalone'] as const },
    remote_project_attach_settings: { sources: ['p2p', 'ws', 'standalone'] as const },
    remote_project_prepare: { sources: ['project_attach'] as const },
    remote_project_checkout: { sources: ['project_attach'] as const },
    remote_project_register: { sources: ['project_attach'] as const },
    remote_project_accept: { sources: ['project_attach'] as const },
};
