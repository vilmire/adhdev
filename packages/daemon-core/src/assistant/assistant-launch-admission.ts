import { dirname } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { getProcessInstanceContext } from '../config/instance-context.js';
import { isTrustedOwnerIngress } from '../commands/command-args.js';
import type { HighFamilyContext } from '../commands/high-family/types.js';
import type { CommandRouterResult } from '../commands/router.js';
import { shouldRestoreHostedRuntime } from '../commands/hosted-runtime-restore.js';
import { LOG } from '../logging/logger.js';
import { resolveHostedBindingOwner, sameHostedBindingOwner } from '../session-host/binding-owner.js';
import { assistantRestoreCandidate, persistedAssistantRuntimeIds } from './assistant-identity.js';
import { getAssistantRegistry } from './assistant-registry.js';

const refused = (code: string, error = code): CommandRouterResult => ({ success: false, code, error });

/** Called under the shared account-slot launch lock, before planning or writing MCP config. */
export async function admitAssistantLaunch(
    ctx: HighFamilyContext,
    args?: Record<string, unknown>,
    isAborted?: () => boolean,
): Promise<CommandRouterResult | undefined> {
    const forceRequested = args?.force === true || args?.replace === true;
    if (forceRequested && !isTrustedOwnerIngress(args)) return refused('assistant_owner_required');
    const manager = ctx.deps.cliManager;
    if (!manager) return refused('assistant_restore_pending');
    if (manager.hostedRestoreState === 'failed' && typeof manager.restoreHostedSessions === 'function') {
        try { await manager.restoreHostedSessions(); }
        catch { return refused('assistant_restore_pending'); }
        if (isAborted?.()) return refused('assistant_launch_timeout');
    }
    if (manager.hostedRestoreState !== 'ready') return refused('assistant_restore_pending');
    const owner = manager.deps.getHostedBindingOwner?.();
    if (!owner || !manager.deps.listHostedCliRuntimes) return refused('assistant_inventory_unavailable');
    const registry = getAssistantRegistry();
    const initial = registry.reload();
    if (initial?.sessionId && initial.hostOwner && !sameHostedBindingOwner(initial.hostOwner, owner) && !forceRequested) {
        return refused('assistant_owned_by_other_host');
    }
    try {
        const records = await manager.deps.listHostedCliRuntimes();
        if (isAborted?.()) return refused('assistant_launch_timeout');
        if (manager.hostedRestoreState !== 'ready') return refused('assistant_restore_pending');
        for (const id of ctx.deps.instanceManager.listInstanceIds?.() ?? []) {
            const instance = ctx.deps.instanceManager.getInstance(id);
            if (instance?.getState().settings.assistant === true && !records.some(r => r.runtimeId === id)) {
                return refused('assistant_restore_pending', `Attached assistant ${id} is not yet in the hosted inventory`);
            }
        }
        const liveIds = new Set(records.map(r => r.runtimeId));
        if (!initial?.sessionId || !ctx.deps.instanceManager.getInstance(initial.sessionId)) {
            registry.pruneAfterRestore(liveIds, owner);
        }
        let entry = registry.reload();
        const candidate = entry?.sessionId && entry.hostOwner && !sameHostedBindingOwner(entry.hostOwner, owner)
            ? undefined : assistantRestoreCandidate(entry, records);
        const attached = candidate ? ctx.deps.instanceManager.getInstance(candidate.runtimeId)
            : entry?.sessionId ? ctx.deps.instanceManager.getInstance(entry.sessionId) : undefined;
        const persisted = attached ? new Set<string>() : await persistedAssistantRuntimeIds(getConfigDir(), {
            ipcKey: getProcessInstanceContext({ standalone: owner.managedBy === 'adhdev-standalone' }).ipcKey,
            allowUnverified: forceRequested,
            boundSessionId: entry?.sessionId ?? undefined,
            boundNamespace: entry?.hostOwner?.namespace,
            onUnverified: namespace => LOG.warn('Assistant', `owner_force bypassed unverified assistant evidence in ${namespace}`),
        });
        if (isAborted?.()) return refused('assistant_launch_timeout');
        if (forceRequested && !isTrustedOwnerIngress(args)) return refused('assistant_owner_required');
        if ([...persisted].some(id => id !== candidate?.runtimeId)) return refused('assistant_identity_conflict');
        if (candidate) {
            if (candidate.lifecycle === 'starting' || candidate.lifecycle === 'stopping') return refused('assistant_restore_pending');
            if (!shouldRestoreHostedRuntime(candidate, owner.managedBy)) return refused('assistant_owned_by_other_host');
            if (!ctx.deps.instanceManager.getInstance(candidate.runtimeId)) {
                await manager.restoreHostedSessions(records);
                if (isAborted?.()) return refused('assistant_launch_timeout');
            }
            const instance = ctx.deps.instanceManager.getInstance(candidate.runtimeId);
            if (!instance) return refused('assistant_restore_pending');
            if (instance.getState().settings.assistant !== true) {
                if (!instance.updateSettings) return refused('assistant_restore_pending');
                instance.updateSettings({ assistant: true, ...(candidate.autoApproveMode
                    ? { autoApproveMode: candidate.autoApproveMode } : { autoApprove: false, autoApproveMode: undefined }) });
            }
            const latest = registry.reload();
            if ((latest?.sessionId && latest.sessionId !== candidate.runtimeId)
                || (latest?.sessionId && latest.hostOwner && !sameHostedBindingOwner(latest.hostOwner, owner))) return refused('assistant_identity_conflict');
            // An already-attached runtime also needs the durable binding healed.
            registry.bindSession({ sessionId: candidate.runtimeId, cliType: candidate.cliType,
                workspace: candidate.workspace, hostOwner: owner, mcpConfigPath: entry?.mcpConfigPath, at: Date.now() });
            return { success: true, launched: false, sessionId: candidate.runtimeId, cliType: candidate.cliType, workspace: candidate.workspace };
        }
        if (entry?.sessionId && ctx.deps.instanceManager.getInstance(entry.sessionId)) {
            return { success: true, launched: false, sessionId: entry.sessionId, cliType: entry.cliType, workspace: entry.workspace };
        }
        if (entry?.sessionId && forceRequested) {
            LOG.warn('Assistant', `owner_force cleared stale assistant binding ${entry.sessionId}`);
            registry.releaseSession(entry.sessionId, 'owner_force');
            entry = registry.reload();
        }
        // An unscoped legacy binding is not proven dead by this endpoint's empty list.
        if (entry?.sessionId && !sameHostedBindingOwner(
            resolveHostedBindingOwner(entry.sessionId, entry.hostOwner, owner, liveIds, dirname(registry.path)), owner)) {
            return refused(entry.hostOwner ? 'assistant_owned_by_other_host' : 'assistant_binding_owner_unknown');
        }
        registry.pruneAfterRestore(liveIds, owner);
        return undefined;
    } catch (error) {
        const message = (error as Error).message;
        return refused(message.startsWith('assistant_identity_conflict') ? 'assistant_identity_conflict' : 'assistant_inventory_unavailable', message);
    }
}
