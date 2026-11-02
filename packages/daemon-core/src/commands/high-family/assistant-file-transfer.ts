/**
 * Assistant verb `assistant_file_transfer { project, action, ... }` (owner decision 2026-11-02 section 6).
 * Same rules as the coordinator command `project_transfer_agent`: request / status / cancel the assistant's
 * OWN transfer requests; never approve. The caller must be the bound assistant session (its own MCP session
 * credential), exactly like the owner-decision verbs. The owner decision lands in the hosted project's inbox.
 */
import { ASSISTANT_VERB, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { defineCommandSpecs } from '../command-registry.js';
import { runAgentTransfer } from '../../transfer/agent-transfer.js';
import { getProjectTransferEngine } from '../../transfer/runtime.js';
import { meshScopeFromEntry } from '../../transfer/workspace-scope.js';
import { ASSISTANT_TOOL_SOURCES, readAssistantSessionId } from './assistant-store.js';
import { assistantVerb, fail, resolveProject } from './assistant.js';
import { authorizeAssistantDecisionCaller } from './assistant-decisions.js';

const fileTransfer = assistantVerb(ASSISTANT_VERB.fileTransfer, async (ports, args) => {
    const denied = authorizeAssistantDecisionCaller(args, { requireOwnerUtterance: false });
    if (denied) return denied;
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    if (p.remote) return fail('remote_project_unsupported', 'file transfers can only be requested for a project hosted on this machine; ask on the host machine or have the owner use the dashboard');
    const sessionId = readAssistantSessionId(args);
    if (!sessionId) return fail('COMMAND_SOURCE_REJECTED', 'this verb requires the bound assistant session');
    const a = args as Record<string, unknown>;
    // The tool schema is snake_case; the transfer core is camelCase.
    const pick = (snake: string, camel: string): unknown => a[snake] ?? a[camel];
    const engine = getProjectTransferEngine();
    // The assistant may export only workspaces of the authorized project's nodes on this machine.
    const scope = engine ? meshScopeFromEntry(p.mesh, engine.selfId()) : null;
    // Another machine may be named as the source only when it is a node of this very project.
    const fromRaw = pick('from_daemon_id', 'fromDaemonId');
    const fromD = typeof fromRaw === 'string' ? fromRaw.trim() : '';
    if (fromD && engine && !daemonIdsEquivalent(fromD, engine.selfId())
        && !(p.mesh.nodes ?? []).some((n) => { const d = readMeshNodeDaemonId(n as never); return !!d && daemonIdsEquivalent(d, fromD); })) {
        return fail('machine_not_in_project', 'from_daemon_id must be a machine of this project');
    }
    return runAgentTransfer({ role: 'assistant', sessionId, meshId: p.mesh.id }, {
        action: a.action, fromWorkspace: pick('from_workspace', 'fromWorkspace'), selected: a.selected,
        toDaemonId: pick('to_daemon_id', 'toDaemonId'), toWorkspace: pick('to_workspace', 'toWorkspace'),
        targetMode: pick('target_mode', 'targetMode'), finalName: pick('final_name', 'finalName'),
        targetDir: pick('target_dir', 'targetDir'), transferId: pick('transfer_id', 'transferId'),
        fromDaemonId: pick('from_daemon_id', 'fromDaemonId'),
    }, { sourceWorkspaceIds: scope ? new Set(scope.workspaces.map((w) => w.id)) : null });
});

export const assistantFileTransferSpecs = defineCommandSpecs('high', { [ASSISTANT_VERB.fileTransfer]: fileTransfer }, {
    [ASSISTANT_VERB.fileTransfer]: { sources: [...ASSISTANT_TOOL_SOURCES] },
});
