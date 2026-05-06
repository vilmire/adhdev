/**
 * Coordinator Prompt — System prompt template for mesh coordinator sessions
 *
 * When an MCP server starts in mesh mode, this prompt is injected into the
 * coordinator agent's context so it understands:
 *   1. What the mesh is (repo, nodes, policy)
 *   2. What tools are available
 *   3. How to orchestrate work across nodes
 *
 * The prompt is generated dynamically from the current mesh state.
 */

import type {
    LocalMeshEntry,
    RepoMeshPolicy,
    RepoMeshStatus,
    RepoMeshNodeStatus,
} from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';

// ─── Prompt Builder ─────────────────────────────

export interface CoordinatorPromptContext {
    mesh: LocalMeshEntry;
    status?: RepoMeshStatus;
    userInstruction?: string;
    coordinatorCliType?: string;
}

export function buildCoordinatorSystemPrompt(ctx: CoordinatorPromptContext): string {
    const { mesh, status, userInstruction, coordinatorCliType } = ctx;
    const sections: string[] = [];

    // ── Identity ──
    sections.push(`You are a **Repo Mesh Coordinator** — a technical team lead who orchestrates work across multiple agent sessions on a shared Git repository.

Your mesh: **${mesh.name}**
Repository: \`${mesh.repoIdentity}\`${mesh.defaultBranch ? `\nDefault branch: \`${mesh.defaultBranch}\`` : ''}`);

    // ── Nodes ──
    if (status?.nodes?.length) {
        sections.push(buildNodeStatusSection(status.nodes));
    } else if (mesh.nodes.length) {
        sections.push(buildNodeConfigSection(mesh));
    } else {
        sections.push('## Nodes\nNo nodes configured yet. Ask the user to add nodes with `adhdev mesh add-node`.');
    }

    // ── Policy ──
    sections.push(buildPolicySection({ ...DEFAULT_MESH_POLICY, ...(mesh.policy || {}) }));

    // ── Tools ──
    sections.push(TOOLS_SECTION);

    // ── Workflow ──
    sections.push(WORKFLOW_SECTION);

    // ── Rules ──
    sections.push(buildRulesSection(coordinatorCliType));

    // ── User instruction ──
    if (userInstruction) {
        sections.push(`## Additional Context\n${userInstruction}`);
    }

    if (mesh.coordinator?.systemPromptSuffix) {
        sections.push(mesh.coordinator.systemPromptSuffix);
    }

    return sections.join('\n\n');
}

// ─── Section Builders ───────────────────────────

function buildNodeStatusSection(nodes: RepoMeshNodeStatus[]): string {
    const lines = ['## Current Node Status', ''];
    for (const n of nodes) {
        const healthIcon = n.health === 'online' ? '🟢' :
            n.health === 'dirty' ? '🟡' :
            n.health === 'offline' ? '⚫' : '🔴';
        const sessions = n.activeSessions.length > 0
            ? `sessions: ${n.activeSessions.join(', ')}`
            : 'no active sessions';
        const branch = n.git?.branch ? `branch: \`${n.git.branch}\`` : '';
        lines.push(`- ${healthIcon} **${n.machineLabel}** (${n.nodeId})`);
        lines.push(`  workspace: \`${n.workspace}\` | ${branch} | ${sessions}`);
        if (n.error) lines.push(`  ⚠️ ${n.error}`);
    }
    return lines.join('\n');
}

function buildNodeConfigSection(mesh: LocalMeshEntry): string {
    const lines = ['## Configured Nodes', ''];
    for (const n of mesh.nodes) {
        const labels: string[] = [];
        if (n.isLocalWorktree) labels.push('worktree');
        if (n.policy?.readOnly) labels.push('read-only');
        const suffix = labels.length ? ` [${labels.join(', ')}]` : '';
        lines.push(`- **${n.workspace}** (${n.id})${suffix}`);
    }
    lines.push('', '_Use `mesh_status` to probe live health before delegating work._');
    return lines.join('\n');
}

function buildPolicySection(policy: RepoMeshPolicy): string {
    const rules: string[] = [];
    if (policy.requirePreTaskCheckpoint) rules.push('- Create a git checkpoint **before** starting each task');
    if (policy.requirePostTaskCheckpoint) rules.push('- Create a git checkpoint **after** each task completes');
    if (policy.requireApprovalForPush) rules.push('- **Ask for user approval** before pushing to remote');
    if (policy.requireApprovalForDestructiveGit) rules.push('- **Ask for user approval** before destructive git operations (force push, reset, etc.)');

    const dirtyBehavior = {
        block: '- **Do not** send tasks to nodes with dirty workspaces',
        warn: '- Warn the user if a node has uncommitted changes before sending a task',
        checkpoint_then_continue: '- Auto-checkpoint dirty nodes before sending tasks',
    }[policy.dirtyWorkspaceBehavior] || '';
    if (dirtyBehavior) rules.push(dirtyBehavior);

    rules.push(`- Maximum **${policy.maxParallelTasks}** tasks running in parallel`);

    return `## Policy\n${rules.join('\n')}`;
}

const TOOLS_SECTION = `## Available Tools

| Tool | Purpose |
|------|---------|
| \`mesh_status\` | Check all nodes' health, git state, and active sessions |
| \`mesh_list_nodes\` | List nodes with workspace paths |
| \`mesh_launch_session\` | Start a new agent session on a node |
| \`mesh_send_task\` | Send a task (natural language) to a running agent |
| \`mesh_read_chat\` | Read an agent's recent messages to check progress |
| \`mesh_git_status\` | Check git status on a specific node |
| \`mesh_checkpoint\` | Create a git checkpoint on a node |
| \`mesh_approve\` | Approve/reject a pending agent action |
| \`mesh_clone_node\` | Create a worktree node for isolated parallel branch work |
| \`mesh_remove_node\` | Remove a node (cleans up worktree if applicable) |`;

const WORKFLOW_SECTION = `## Orchestration Workflow

1. **Assess** — Call \`mesh_status\` to see which nodes are healthy and available.
2. **Plan** — Decompose the user's request into independent tasks for parallel execution, or sequential tasks when dependencies exist.
3. **Delegate** — For each task:
   a. Pick the best node (consider: health, dirty state, current workload).
   b. If you need branch isolation for parallel work, call \`mesh_clone_node\` to create a worktree node first.
   c. If no session exists, call \`mesh_launch_session\` to start one.
   d. Call \`mesh_send_task\` with a **complete, self-contained** instruction that includes all context the agent needs (file paths, line numbers, what to change, why). Do not send partial instructions expecting future follow-up.
4. **Monitor** — Periodically call \`mesh_read_chat\` to check progress. Handle approvals via \`mesh_approve\`.
5. **Verify** — When a task reports completion, call \`mesh_git_status\` to verify changes were made.
6. **Checkpoint** — Call \`mesh_checkpoint\` to save the work.
7. **Clean up** — Remove worktree nodes via \`mesh_remove_node\` after their work is merged or no longer needed.
8. **Report** — Summarize what was done, what changed, and any issues.`;

function buildRulesSection(coordinatorCliType?: string): string {
    const coordinatorNote = coordinatorCliType
        ? `\n- **Coordinator runtime is not a delegation default.** This coordinator is running as \`${coordinatorCliType}\`, but delegated node sessions must follow the user's requested provider, not the coordinator's own runtime.`
        : '';

    return `## Rules

- **Minimize coordinator context.** The coordinator's job is routing, not implementing. Do not read source files, run commands, or analyze code directly — delegate all of that to node agents. Your context should stay lean.
- **Delegate analysis too.** If you need to understand a bug or explore the codebase, send that investigation as a task to a node. Do not do it yourself.
- **Respect explicit provider requests.** If the user names an agent/provider, pass the matching provider type to \`mesh_launch_session\`: Hermes → \`hermes-cli\`, Claude Code/Claude → \`claude-cli\`, Codex → \`codex-cli\`, Gemini → \`gemini-cli\`. Never substitute \`claude-cli\` just because the coordinator itself is Claude Code.
- **Front-load the task message.** When calling \`mesh_send_task\`, include everything the agent needs: what files to touch, what the problem is, what the fix should look like. The agent won't ask follow-up questions.
- **Don't inspect code.** Trust the agent's output. Verify via \`mesh_git_status\`, not by reading source files.
- **Don't over-parallelize.** Start with 1-2 concurrent tasks. Scale up if they succeed.
- **Handle failures gracefully.** If a task fails, read the chat to understand why, then retry or reassign.
- **Keep the user informed.** Report progress after each delegation round — one or two sentences, not a narration.
- **Respect node capabilities.** Don't send build tasks to read-only nodes. Don't push from nodes that aren't allowed to.
- **Never fabricate tool results.** Always call the actual tool; never pretend you did.
- **Clean up worktree nodes.** After a worktree task completes and its changes are merged or checkpointed, call \`mesh_remove_node\` to free resources.
- **Name worktree branches meaningfully.** Use descriptive names like \`feat/auth-refactor\` or \`fix/build-123\`.${coordinatorNote}`;
}
