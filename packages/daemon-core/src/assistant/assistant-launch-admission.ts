import { getConfigDir } from '../config/config.js';
import type { HighFamilyContext } from '../commands/high-family/types.js';
import type { CommandRouterResult } from '../commands/router.js';
import { shouldRestoreHostedRuntime } from '../commands/hosted-runtime-restore.js';
import { sameHostedBindingOwner } from '../session-host/binding-owner.js';
import { assistantRestoreCandidate, persistedAssistantRuntimeIds } from './assistant-identity.js';
import { getAssistantRegistry } from './assistant-registry.js';

const refused = (code: string, error = code): CommandRouterResult => ({ success: false, code, error });

/** Called under the shared account-slot launch lock, before planning or writing MCP config. */
export async function admitAssistantLaunch(ctx: HighFamilyContext): Promise<CommandRouterResult | undefined> {
    const manager = ctx.deps.cliManager;
    if (!manager || manager.hostedRestoreState !== 'ready') return refused('assistant_restore_pending');
    const owner = manager.deps.getHostedBindingOwner?.();
    if (!owner || !manager.deps.listHostedCliRuntimes) return refused('assistant_inventory_unavailable');
    const registry = getAssistantRegistry();
    const entry = registry.reload();
    if (entry?.hostOwner && !sameHostedBindingOwner(entry.hostOwner, owner)) return refused('assistant_owned_by_other_host');
    try {
        const records = await manager.deps.listHostedCliRuntimes();
        if (manager.hostedRestoreState !== 'ready') return refused('assistant_restore_pending');
        for (const id of ctx.deps.instanceManager.listInstanceIds?.() ?? []) {
            const instance = ctx.deps.instanceManager.getInstance(id);
            if (instance?.getState().settings.assistant === true && !records.some(r => r.runtimeId === id)) {
                return refused('assistant_restore_pending', `Attached assistant ${id} is not yet in the hosted inventory`);
            }
        }
        const candidate = assistantRestoreCandidate(entry, records);
        const persisted = persistedAssistantRuntimeIds(getConfigDir());
        if ([...persisted].some(id => id !== candidate?.runtimeId)) return refused('assistant_identity_conflict');
        if (candidate) {
            if (candidate.lifecycle === 'starting' || candidate.lifecycle === 'stopping') return refused('assistant_restore_pending');
            if (!shouldRestoreHostedRuntime(candidate, owner.managedBy)) return refused('assistant_owned_by_other_host');
            if (!ctx.deps.instanceManager.getInstance(candidate.runtimeId)) {
                await manager.restoreHostedSessions(records);
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
                || (latest?.hostOwner && !sameHostedBindingOwner(latest.hostOwner, owner))) return refused('assistant_identity_conflict');
            // An already-attached runtime also needs the durable binding healed.
            registry.bindSession({ sessionId: candidate.runtimeId, cliType: candidate.cliType,
                workspace: candidate.workspace, hostOwner: owner, mcpConfigPath: entry?.mcpConfigPath, at: Date.now() });
            return { success: true, launched: false, sessionId: candidate.runtimeId, cliType: candidate.cliType, workspace: candidate.workspace };
        }
        if (entry?.sessionId && ctx.deps.instanceManager.getInstance(entry.sessionId)) {
            return { success: true, launched: false, sessionId: entry.sessionId, cliType: entry.cliType, workspace: entry.workspace };
        }
        // An unscoped legacy binding is not proven dead by this endpoint's empty list.
        if (entry?.sessionId && !sameHostedBindingOwner(entry.hostOwner, owner)) return refused('assistant_binding_owner_unknown');
        registry.pruneAfterRestore(new Set(records.map(r => r.runtimeId)), owner);
        return undefined;
    } catch (error) {
        const message = (error as Error).message;
        return refused(message.startsWith('assistant_identity_conflict') ? 'assistant_identity_conflict' : 'assistant_inventory_unavailable', message);
    }
}
