/** Authenticated setup commands. These are never mesh-forwardable. */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getMesh } from '../../config/mesh-config.js';
import { setMeshHostPin } from '../../config/mesh-config-host-pairing.js';
import { readMeshHostRecord, writeMeshHostRecord } from '../../mesh/mesh-host-memory.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { githubRemote, git, checkoutRemote, managedCheckoutPath, verifyCheckout, pythonResourcePreflight, refusal, AttachFailure } from '../../assistant/remote-project-checkout.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
const str = (v: unknown) => typeof v === 'string' ? v : '';
const fail = (code: string, stage: string, action: string) => ({ success: false, code, stage, action, attached: false });
function selected(ctx: HighFamilyContext, args: any) {
    if (!/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args?.targetDaemonId)) || !daemonIdsEquivalent(args.targetDaemonId, ctx.deps.statusInstanceId)) throw new AttachFailure('WRONG_MACHINE', 'target_access', 'Address the exact owner-selected canonical daemon.');
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
    return ctx.deps.attachRemoteProject(args.meshId, args.targetDaemonId);
};
export const remoteProjectHandlers: Record<string, HighFamilyHandler> = {
    attach_remote_project: attachRemoteProject,
    remote_project_prepare: async (ctx, args) => {
        try { const { mesh, remote } = await prepare(ctx, args); return { success: true, meshId: mesh.id, ...remote, hostDaemonId: ctx.deps.statusInstanceId }; } catch (e) { return refusal(e); }
    },
    remote_project_checkout: async (ctx, args) => {
        try {
            selected(ctx, args);
            const remote = githubRemote(args?.url);
            if (!remote || remote.identity !== args?.identity || !/^mesh_[a-zA-Z0-9_-]+$/.test(str(args?.meshId))) throw new AttachFailure('REMOTE_IDENTITY_MISMATCH', 'repository_access', 'Only canonical verified GitHub projects are supported.');
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
                if (!pin || (!pin.applied && pin.reason !== 'already_pinned_same')) return fail('REGISTRATION_FAILED', 'registration', 'Checkout was preserved. Establish this project host before retrying.');
            }
            const result = await ctx.execute('add_mesh_node', { meshId: mesh.id, workspace: args.workspace, repoRoot: args.workspace, daemonId: args.targetDaemonId }, 'internal', { inProcess: true });
            return result.success ? { success: true, nodeId: (result.node as any)?.id, attached: true } : fail('REGISTRATION_FAILED', 'registration', 'Checkout was preserved. Retry after resolving host registration access.');
        } catch (e) { return refusal(e); }
    },
    remote_project_accept: async (ctx, args) => {
        try {
            selected(ctx, args);
            const remote = githubRemote(args.url);
            if (!remote || remote.identity !== args.identity || !/^mesh_[a-zA-Z0-9_-]+$/.test(str(args.meshId)) || !/^daemon_mach_[a-zA-Z0-9]+$/.test(str(args.hostDaemonId))) throw new AttachFailure('ATTACH_SCOPE_MISMATCH', 'registration', 'Use the authenticated project attachment flow.');
            const workspace = await managedCheckoutPath(args.meshId, remote.identity);
            if (workspace !== args.workspace) throw new AttachFailure('PATH_CONFLICT', 'registration', 'Attachment must use its verified managed checkout.');
            await verifyCheckout(workspace, remote.identity);
            const old = readMeshHostRecord(args.meshId);
            if (old && !daemonIdsEquivalent(old.hostDaemonId, args.hostDaemonId)) throw new AttachFailure('PROJECT_HOST_CONFLICT', 'registration', 'Preserve existing membership; resolve the project host conflict locally.');
            if (!old && !writeMeshHostRecord(args.meshId, args.hostDaemonId, 'pairing')) throw new AttachFailure('REGISTRATION_FAILED', 'registration', 'Checkout is preserved; restore writable daemon configuration before retrying.');
            const resources = await pythonResourcePreflight();
            return { success: true, attached: true, ready: resources.ready, resources, workspace, targetDaemonId: ctx.deps.statusInstanceId, stage: resources.ready ? 'ready' : 'resource_preflight' };
        } catch (e) { return refusal(e); }
    },
};
export const remoteProjectSpecs = {
    attach_remote_project: { sources: ['ipc', 'standalone'] as const },
    remote_project_prepare: { sources: ['api'] as const },
    remote_project_checkout: { sources: ['api'] as const },
    remote_project_register: { sources: ['api'] as const },
    remote_project_accept: { sources: ['api'] as const },
};
