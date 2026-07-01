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
 *
 * User customization:
 *   ~/.adhdev/coordinator-prompts/<cliType>.md         — full override
 *   ~/.adhdev/coordinator-prompts/<cliType>.append.md  — appended to default
 *   ~/.adhdev/coordinator-prompts/default.md           — full override (any CLI)
 *   ~/.adhdev/coordinator-prompts/default.append.md    — appended to default (any CLI)
 *
 * CLI-specific files take precedence over default.* files. The override file
 * still gets the node/policy facts substituted via the same {{placeholders}}
 * the daemon understands; an override that doesn't reference them just gets
 * a static prompt, which is also fine.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
    LocalMeshEntry,
    RepoMeshPolicy,
    RepoMeshStatus,
    RepoMeshNodeStatus,
} from '../repo-mesh-types.js';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';

/**
 * Cheap, locally-derived "what just happened" snapshot for the coordinator
 * prompt. Built at launch from the local ledger + work-queue stats — no remote
 * peer probe. Surfaces the gap a fresh coordinator otherwise misses: it can't
 * see recent failures / queue depth until it manually calls mesh_task_history.
 *
 * All fields are optional so callers that have nothing to report (or fail to
 * read the ledger) simply omit the section — the prompt output stays identical
 * to the pre-activity form in that case.
 */
export interface CoordinatorRecentActivity {
    /** task_failed entries from the recent window, newest last. */
    recentFailures?: Array<{
        timestamp?: string;
        nodeId?: string;
        /** Short task title/message, already truncated by the caller. */
        summary?: string;
    }>;
    /** Count of task_failed entries inside the recent (30-min) window. */
    recentFailureCount?: number;
    /** Pending (unclaimed) tasks in the work queue. */
    pendingTasks?: number;
    /** Assigned-but-not-yet-terminal tasks in the work queue. */
    assignedTasks?: number;
    /** Stalled tasks recorded in the ledger. */
    stalledTasks?: number;
    /** ISO timestamp of the most recent ledger activity, if any. */
    lastActivityAt?: string | null;
}

/**
 * One coordinator operating note — a runtime-accumulated lesson (provider
 * quirk, pattern to avoid, recovery lesson) persisted in the ledger so it
 * survives coordinator restarts and is provider-neutral (visible to codex /
 * hermes / antigravity coordinators, not just Claude's memory).
 */
export interface CoordinatorOperatingNote {
    text: string;
    category?: 'provider_quirk' | 'pattern_to_avoid' | 'recovery_lesson';
    createdAt?: string;
    sourceCoordinator?: string;
}

// ─── Prompt Builder ─────────────────────────────

export interface CoordinatorPromptContext {
    mesh: LocalMeshEntry;
    status?: RepoMeshStatus;
    userInstruction?: string;
    coordinatorCliType?: string;
    /**
     * M3: pre-rendered active mission section (from buildMissionPromptSection).
     * Empty/undefined when the mesh has no active mission — the prompt output
     * stays identical to the pre-M3 form in that case.
     */
    missionSection?: string;
    /**
     * Gap1: recent ledger/queue activity surfaced so a freshly-launched
     * coordinator sees recent failures + queue depth without first calling
     * mesh_task_history. Omitted → no "## Recent Activity" section.
     */
    recentActivity?: CoordinatorRecentActivity;
    /**
     * Gap2-A: runtime-accumulated operating notes (provider-neutral lessons)
     * read from the ledger at launch. Omitted/empty → no "## Operating Notes"
     * section.
     */
    operatingNotes?: CoordinatorOperatingNote[];
}

/**
 * Compose the final coordinator prompt from four layers, in this precedence:
 *
 *   1. Per-launch `extraSystemPrompt` (always appended, as "## Additional
 *      Context"). Never wins as a base — it's launch-scope context.
 *   2. Mesh-level append (`mesh.coordinator.systemPromptAppend` or the legacy
 *      `systemPromptSuffix`). Stacks after whichever base won.
 *   3. User-file append (`~/.adhdev/coordinator-prompts/<cli>.append.md` or
 *      `default.append.md`). Also stacks; same placeholder expansion as the
 *      override path.
 *   4. Base prompt, picked in this order:
 *      a. `mesh.coordinator.systemPromptOverride` (mesh-level override)
 *      b. user-file override (`~/.adhdev/coordinator-prompts/<cli>.md` or
 *         `default.md`)
 *      c. daemon default (assembled from identity/nodes/policy/tools/…)
 *
 * That layering lets a user customize prompts at three increasing scopes
 * (machine, mesh, single launch) without losing the daemon's stock rules.
 */
export function buildCoordinatorSystemPrompt(ctx: CoordinatorPromptContext): string {
    const { mesh, userInstruction, coordinatorCliType } = ctx;

    // ── Pick the base prompt ──
    const meshOverride = mesh.coordinator?.systemPromptOverride?.trim();
    let base: string;
    if (meshOverride) {
        base = expandPromptPlaceholders(meshOverride, ctx);
    } else {
        const userOverride = readUserPromptFile(coordinatorCliType, 'md');
        if (userOverride !== null) {
            base = expandPromptPlaceholders(userOverride, ctx);
        } else {
            base = buildDefaultCoordinatorPrompt(ctx);
        }
    }

    const sections: string[] = [base];

    // ── User-level append runs after whichever base won ──
    const userAppend = readUserPromptFile(coordinatorCliType, 'append.md');
    if (userAppend !== null) {
        sections.push(expandPromptPlaceholders(userAppend, ctx));
    }

    // ── Mesh-level append (prefer the new field, fall back to the legacy alias) ──
    const meshAppend = (mesh.coordinator?.systemPromptAppend
        ?? mesh.coordinator?.systemPromptSuffix)?.trim();
    if (meshAppend) {
        sections.push(expandPromptPlaceholders(meshAppend, ctx));
    }

    // ── Per-launch context lands last so it's the most recent thing the
    //     agent reads. Marked as Additional Context, not a rule update. ──
    if (userInstruction) {
        sections.push(`## Additional Context\n${userInstruction}`);
    }

    return sections.join('\n\n');
}

function buildDefaultCoordinatorPrompt(ctx: CoordinatorPromptContext): string {
    const { mesh, status, coordinatorCliType } = ctx;
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

    // ── Active Mission (M3) — only present when one exists ──
    if (ctx.missionSection?.trim()) {
        sections.push(ctx.missionSection.trim());
    }

    // ── Recent Activity (Gap1) — only present when there's something to show ──
    const recentActivity = buildRecentActivitySection(ctx.recentActivity);
    if (recentActivity) sections.push(recentActivity);

    // ── Operating Notes (Gap2-A) — only present when notes exist ──
    const operatingNotes = buildOperatingNotesSection(ctx.operatingNotes);
    if (operatingNotes) sections.push(operatingNotes);

    // ── Policy ──
    sections.push(buildPolicySection(mergeAndNormalizePolicy(undefined, mesh.policy)));

    // ── Tools ──
    sections.push(TOOLS_SECTION);

    // ── Tool Exposure Preflight ──
    sections.push(TOOL_EXPOSURE_PREFLIGHT_SECTION);

    // ── Workflow ──
    sections.push(WORKFLOW_SECTION);

    // ── Onboarding / Reinit ──
    sections.push(ONBOARDING_SECTION);

    // ── Rules ──
    sections.push(buildRulesSection(coordinatorCliType));

    return sections.join('\n\n');
}

/**
 * Look up a user-customization file under ~/.adhdev/coordinator-prompts/.
 *
 * Lookup order:
 *   1. <cliType>.<suffix>   — provider-specific
 *   2. default.<suffix>     — shared across providers
 *
 * Returns null when neither exists; an empty/whitespace-only file is also
 * treated as "no override" so users can drop in a stub without affecting
 * behavior. Read errors (permission, IO) are swallowed and logged-as-null
 * intentionally: a broken override file should never block coordinator
 * launch, it should just behave as if the file weren't there.
 */
function readUserPromptFile(cliType: string | undefined, suffix: string): string | null {
    const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
    const candidates: string[] = [];
    if (cliType) candidates.push(path.join(dir, `${cliType}.${suffix}`));
    candidates.push(path.join(dir, `default.${suffix}`));
    for (const p of candidates) {
        try {
            const text = fs.readFileSync(p, 'utf8');
            if (text.trim()) return text;
        } catch { /* missing file is the common case — keep going */ }
    }
    return null;
}

/**
 * Expand `{{placeholder}}` tokens against current mesh state.
 *
 * Tokens we support today:
 *   {{meshName}}        — mesh.name
 *   {{repo}}            — mesh.repoIdentity
 *   {{defaultBranch}}   — mesh.defaultBranch or empty
 *   {{cliType}}         — coordinator CLI type or empty
 *   {{nodes}}           — full node section (status if known, otherwise config)
 *   {{mission}}         — active mission summary section (empty when none)
 *   {{recentActivity}}  — recent failures + queue depth section (empty when none)
 *   {{operatingNotes}}  — accumulated operating notes section (empty when none)
 *   {{policy}}          — full policy section
 *   {{tools}}           — the canonical tools table
 *   {{workflow}}        — the canonical orchestration workflow
 *   {{onboarding}}      — the guided init/reinit onboarding section
 *   {{rules}}           — the canonical rules section (with coordinatorNote)
 *   {{toolExposurePreflight}} — the MCP-missing preflight reminder
 *
 * Unknown tokens are left as-is — that way typos are obvious in the rendered
 * prompt instead of silently disappearing. Tokens are not recursive: an
 * expanded value's own {{...}} content stays literal.
 */
function expandPromptPlaceholders(template: string, ctx: CoordinatorPromptContext): string {
    const { mesh, status, coordinatorCliType } = ctx;
    const nodesSection = status?.nodes?.length
        ? buildNodeStatusSection(status.nodes)
        : mesh.nodes.length
            ? buildNodeConfigSection(mesh)
            : '## Nodes\nNo nodes configured yet. Ask the user to add nodes with `adhdev mesh add-node`.';
    const replacements: Record<string, string> = {
        meshName: mesh.name,
        repo: mesh.repoIdentity,
        defaultBranch: mesh.defaultBranch || '',
        cliType: coordinatorCliType || '',
        nodes: nodesSection,
        mission: ctx.missionSection?.trim() || '',
        recentActivity: buildRecentActivitySection(ctx.recentActivity) || '',
        operatingNotes: buildOperatingNotesSection(ctx.operatingNotes) || '',
        policy: buildPolicySection(mergeAndNormalizePolicy(undefined, mesh.policy)),
        tools: TOOLS_SECTION,
        workflow: WORKFLOW_SECTION,
        onboarding: ONBOARDING_SECTION,
        rules: buildRulesSection(coordinatorCliType),
        toolExposurePreflight: TOOL_EXPOSURE_PREFLIGHT_SECTION,
    };
    return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
        return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : m;
    });
}

// ─── Section Builders ───────────────────────────

function buildNodeStatusSection(nodes: RepoMeshNodeStatus[]): string {
    const lines = [
        '## Current Node Status',
        '',
        'Node labels are display context, not aliases. Use exact `nodeId` values in mesh tool calls; do not invent shorthand names such as M1/M2 unless they are explicitly configured labels.',
        '',
    ];
    for (const n of nodes) {
        const healthIcon = n.health === 'online' ? '🟢' :
            n.health === 'dirty' ? '🟡' :
            n.health === 'offline' ? '⚫' : '🔴';
        const sessions = n.activeSessions.length > 0
            ? `sessions: ${n.activeSessions.join(', ')}`
            : 'no active sessions';
        const branch = n.git?.branch ? `branch: \`${n.git.branch}\`` : '';
        const context = [
            n.daemonId ? `daemon: \`${n.daemonId}\`` : '',
            n.providers?.length ? `providers: ${n.providers.join(', ')}` : '',
        ].filter(Boolean).join(' | ');
        lines.push(`- ${healthIcon} **${n.machineLabel}** (nodeId: \`${n.nodeId}\`)`);
        lines.push(`  workspace: \`${n.workspace}\`${context ? ` | ${context}` : ''} | ${branch} | ${sessions}`);
        if (n.error) lines.push(`  ⚠️ ${n.error}`);
        const nodePrompt = typeof (n as any).systemPrompt === 'string' ? (n as any).systemPrompt.trim() : '';
        if (nodePrompt) {
            lines.push(`  📌 Node instruction: ${indentFollowing(nodePrompt, '     ')}`);
        }
    }
    return lines.join('\n');
}

function buildNodeConfigSection(mesh: LocalMeshEntry): string {
    const lines = [
        '## Configured Nodes',
        '',
        'Node labels are display context, not aliases. Use exact `nodeId` values in mesh tool calls; do not invent shorthand names such as M1/M2 unless they are explicitly configured labels.',
        '',
    ];
    for (const n of mesh.nodes) {
        const labels: string[] = [];
        if (n.isLocalWorktree) labels.push('worktree');
        if (n.policy?.readOnly) labels.push('read-only');
        const suffix = labels.length ? ` [${labels.join(', ')}]` : '';
        const explicitMachineLabel = typeof (n as any).machineLabel === 'string' ? (n as any).machineLabel : '';
        const explicitLabel = explicitMachineLabel ? ` label: **${explicitMachineLabel}** |` : '';
        const providerPriority = n.policy?.providerPriority?.length ? ` | providers: ${n.policy.providerPriority.join(', ')}` : '';
        // Per-(node, provider) maxParallel cap. Only maxParallel is enforced by the
        // queue; routing is governed by required_tags, not provider roles.
        const providerRoles = Array.isArray(n.policy?.providerRoles)
            ? (n.policy!.providerRoles as Array<{ providerType?: unknown; maxParallel?: unknown }>)
                .map(r => {
                    const type = typeof r?.providerType === 'string' ? r.providerType.trim() : '';
                    if (!type) return '';
                    const cap = Number.isFinite(Number(r?.maxParallel)) ? ` (max ${Math.floor(Number(r.maxParallel))})` : '';
                    return `${type}${cap}`;
                })
                .filter(Boolean)
            : [];
        const providerRolesSuffix = providerRoles.length ? ` | caps: ${providerRoles.join(', ')}` : '';
        lines.push(`- ${explicitLabel} nodeId: \`${n.id}\` | workspace: \`${n.workspace}\`${n.daemonId ? ` | daemon: \`${n.daemonId}\`` : ''}${providerPriority}${providerRolesSuffix}${suffix}`);
        const nodePrompt = typeof (n as any).systemPrompt === 'string' ? (n as any).systemPrompt.trim() : '';
        if (nodePrompt) {
            lines.push(`  📌 Node instruction: ${indentFollowing(nodePrompt, '     ')}`);
        }
    }
    lines.push('', '_Use `mesh_status` to probe live health before delegating work._');
    return lines.join('\n');
}

/**
 * Indent every line after the first by `pad`. Used so multi-line node
 * instructions still visually nest under the node bullet without the
 * second line dangling at column zero.
 */
function indentFollowing(text: string, pad: string): string {
    const lines = text.split('\n');
    if (lines.length === 1) return lines[0];
    return [lines[0], ...lines.slice(1).map(l => pad + l)].join('\n');
}

/**
 * Gap1 — render the "## Recent Activity" section from the locally-derived
 * activity snapshot. Returns '' (no section) when there's nothing worth
 * surfacing: no recent failures, no queued work, no stalls. This keeps a quiet
 * mesh's prompt identical to the pre-activity form.
 */
function buildRecentActivitySection(activity?: CoordinatorRecentActivity): string {
    if (!activity) return '';
    const failures = Array.isArray(activity.recentFailures) ? activity.recentFailures : [];
    const pending = Number.isFinite(activity.pendingTasks) ? Number(activity.pendingTasks) : 0;
    const assigned = Number.isFinite(activity.assignedTasks) ? Number(activity.assignedTasks) : 0;
    const stalled = Number.isFinite(activity.stalledTasks) ? Number(activity.stalledTasks) : 0;
    const recentFailureCount = Number.isFinite(activity.recentFailureCount)
        ? Number(activity.recentFailureCount)
        : failures.length;

    // Nothing actionable to show → omit the section entirely.
    if (failures.length === 0 && pending === 0 && assigned === 0 && stalled === 0 && recentFailureCount === 0) {
        return '';
    }

    const lines: string[] = ['## Recent Activity', ''];
    lines.push('A snapshot of this mesh\'s recent ledger/queue state at launch. Use it to decide what needs attention first; call `mesh_task_history` / `mesh_view_queue` for full detail.');
    lines.push('');

    const counts: string[] = [];
    if (pending > 0) counts.push(`**${pending}** pending`);
    if (assigned > 0) counts.push(`**${assigned}** assigned`);
    if (stalled > 0) counts.push(`**${stalled}** stalled`);
    if (recentFailureCount > 0) counts.push(`**${recentFailureCount}** failed in the last 30 min`);
    if (counts.length) lines.push(`- Queue/ledger: ${counts.join(', ')}.`);
    if (activity.lastActivityAt) lines.push(`- Last ledger activity: ${activity.lastActivityAt}.`);

    if (failures.length > 0) {
        // Newest first, capped to the 5 most recent so the prompt stays lean.
        const recent = failures.slice(-5).reverse();
        lines.push('', 'Recent failures (newest first):');
        for (const f of recent) {
            const when = f.timestamp ? `${f.timestamp} ` : '';
            const node = f.nodeId ? `node \`${f.nodeId}\`` : 'unknown node';
            const summary = (f.summary || '').trim();
            lines.push(`- ${when}${node}${summary ? ` — ${summary}` : ''}`);
        }
        lines.push('', '_Check `mesh_task_history` before retrying; repeated failures on the same node mean reassign or escalate, not retry._');
    }

    return lines.join('\n');
}

/**
 * Gap2-A — render the "## Operating Notes" section from accumulated coordinator
 * notes. Returns '' when there are none, so a mesh that has never recorded a
 * note gets the unchanged prompt. Notes are runtime-accumulated lessons that
 * persist across coordinator restarts and are provider-neutral.
 */
function buildOperatingNotesSection(notes?: CoordinatorOperatingNote[]): string {
    const valid = Array.isArray(notes)
        ? notes.filter(n => n && typeof n.text === 'string' && n.text.trim())
        : [];
    if (valid.length === 0) return '';

    const categoryLabel: Record<string, string> = {
        provider_quirk: 'provider quirk',
        pattern_to_avoid: 'pattern to avoid',
        recovery_lesson: 'recovery lesson',
    };

    const lines: string[] = ['## Operating Notes', ''];
    lines.push('Lessons earlier coordinators on this mesh recorded via `mesh_record_note`. Treat them as accumulated operating knowledge — apply them. When you learn a durable lesson (a provider quirk, a pattern to avoid, a recovery lesson), record it with `mesh_record_note` so future coordinators inherit it.');
    lines.push('');
    for (const n of valid) {
        const cat = n.category && categoryLabel[n.category] ? `[${categoryLabel[n.category]}] ` : '';
        lines.push(`- ${cat}${n.text.trim()}`);
    }
    return lines.join('\n');
}

function buildPolicySection(policy: RepoMeshPolicy): string {
    const rules: string[] = [];
    if (policy.requirePreTaskCheckpoint) rules.push('- Create a git checkpoint **before** starting each task');
    if (policy.requirePostTaskCheckpoint) rules.push('- Create a git checkpoint **after** each task completes');
    if (policy.requireApprovalForPush) rules.push('- **Ask for user approval** before pushing to remote');
    if (policy.allowAutoPublishSubmoduleMainCommits) {
        rules.push('- Refinery may auto-publish unreachable submodule gitlink commits to submodule origin/main with non-force pushes after validation and patch-equivalence pass');
    }
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
| \`mesh_status\` | Check all nodes' health, git state, active sessions, and branch convergence |
| \`mesh_list_nodes\` | List nodes with workspace paths |
| \`mesh_enqueue_task\` | Add a task to the pull-based work queue; idle nodes auto-claim |
| \`mesh_view_queue\` | View queue status — pending, assigned, completed, failed, cancelled tasks |
| \`mesh_queue_cancel\` | Cancel a queue task without deleting audit history |
| \`mesh_queue_requeue\` | Return a task to pending for retry; clears stale session targets |
| \`mesh_send_task\` | Legacy push: enqueue a task targeted at a specific node |
| \`mesh_launch_session\` | Start a new agent session on a node |
| \`mesh_read_chat\` | Read recent chat messages from a delegated agent session |
| \`mesh_read_debug\` | Collect a daemon-side chat/parser debug bundle for a session |
| \`mesh_task_history\` | Read the task ledger — dispatches, completions, failures. Use to understand what has been done before deciding next steps |
| \`mesh_record_note\` | Record a durable, provider-neutral operating note (provider quirk / pattern to avoid / recovery lesson). Future coordinators see it under "## Operating Notes" at launch |
| \`mesh_forget_note\` | Retract a stale/wrong operating note by note_id or exact text so it stops riding into future coordinators' prompts (append-only tombstone; history preserved) |
| \`mesh_git_status\` | Check git status on a specific node |
| \`mesh_read_node_logs\` | Fetch a remote node's daemon log tail directly over P2P (grep/since/byte-bounded, secrets redacted) — no session/PowerShell needed to debug a node's daemon |
| \`mesh_fast_forward_node\` | Safely dry-run or explicitly execute an obvious clean fast-forward without launching an agent session |
| \`mesh_checkpoint\` | Create a git checkpoint on a node |
| \`mesh_approve\` | Approve/reject a pending agent action |
| \`mesh_clone_node\` | Create a worktree node for isolated parallel branch work |
| \`mesh_refine_node\` | Validate and merge a completed worktree node back into its base branch |
| \`mesh_remove_node\` | Remove a node (cleans up worktree if applicable) |
| \`mesh_cleanup_sessions\` | Manually clean up delegated session records for a node |
| \`mesh_init\` | Guided onboarding for a fresh repo: dry-run scan → suggest \`.adhdev/*\` configs (refine/bootstrap/change-impact) + providerPriority + current-config echo; gated write on approval |
| \`mesh_reinit\` | Re-onboard an already-configured repo: re-suggest with overwrite semantics + current-vs-suggested diff; dry-run preview first, per-section approval before write |
| \`mesh_write_mesh_json_config\` | Gated write of \`.adhdev/mesh.json\` (repo coordinator-prompt config) from the mesh entry — dry-run/overwrite like mesh_init |
| \`mesh_magi_kind_panel_set\` | Bind a task_kind → MAGI kind-panel slots (machine-local, wholesale replacement — approve current-vs-new first) |
| \`mesh_magi_kind_panel_list\` | List configured task_kind → MAGI kind-panel slot bindings (machine-local, read-only) |`;

const TOOL_EXPOSURE_PREFLIGHT_SECTION = `## Tool Exposure Preflight

Before doing any coordinator work, confirm that the actual callable tool list includes \`mesh_status\` and the other \`mesh_*\` tools from the table above. If this Repo Mesh coordinator prompt is present but the callable \`mesh_*\` tools are missing, the MCP server/tool manifest is stale or not injected yet. Do not substitute terminal/file/git tools, do not inspect or edit the repository directly, and do not continue as a non-mesh local coding agent. Stop immediately and tell the user to run \`/reload-mcp\` or start a fresh coordinator session so ADHDev can reconnect \`adhdev-mesh\`.`;

const WORKFLOW_SECTION = `## Orchestration Workflow

1. **Assess** — Call \`mesh_status\` to see which nodes are healthy and available. Check \`mesh_task_history\` to understand what has already been done in this mesh — previous delegations, completions, and failures.
2. **Plan** — Decompose the user's request into independent tasks for parallel execution, or sequential tasks when dependencies exist. If \`mesh_task_history\` shows a recent failure for a task, decide whether to retry or reassign. **For multi-task work, create a mission first**: call \`mesh_mission_upsert\` with a title and goal, then attach every enqueued task with \`mission_id\`. Express "B after A" ordering with \`depends_on\` on the queue task instead of waiting and polling — the system claims dependents automatically when their dependencies complete. When the mission's outcome is decided, update its status (\`completed\`/\`abandoned\`) via \`mesh_mission_upsert\`. If the prompt already shows an **Active Mission**, continue it from its current task state — do not re-enqueue tasks that already exist.
3. **Queue / Delegate** — The Mesh uses an autonomous pull-based Work Queue:
   a. **General Tasks**: Enqueue tasks using \`mesh_enqueue_task\`. Idle node agents will automatically pull tasks from the queue and begin working.
   b. **Node Preparation**: Reuse an existing idle session on the correct node/provider before launching a new chat/session. Call \`mesh_launch_session\` only when no suitable session exists, when the user explicitly asks for a fresh provider/session, or when branch/worktree isolation requires it. If you need branch isolation for parallel work, call \`mesh_clone_node\` to create a worktree node first.
   c. **Targeted Tasks**: Use \`mesh_send_task\` only when you need to bypass the queue and force a specific node to execute a task immediately.
   d. For the first dispatch of a new task, provide a **complete, self-contained** instruction that includes all context the agent needs (file paths, line numbers, what to change, why). Do not send partial instructions expecting future follow-up.
   e. For a continuation of the same issue in an existing session, send a concise **delta instruction**: current verified state, the exact failed/blocked step, the newly approved action, and final reporting requirements. Do not resend the full original task or open a new chat solely to continue the same work; that wastes coordinator and worker context.
4. **Monitor** — Prefer event-driven completion/status notifications. Do **not** poll \`mesh_read_chat\` repeatedly. Do **not** repeatedly call \`mesh_status\` or \`mesh_view_queue\` just to wait for assigned/generating work. After dispatching a direct or queued task, send one progress update with the task/session handle, then stop. Wait for \`pendingCoordinatorEvents\` or another completion/approval/status signal, an explicit user status request, or a real timeout/stall signal before reading status/chat/queue again. Use at most one compact \`mesh_read_chat\` check after a terminal signal. Handle approvals via \`mesh_approve\`. **Proactively parallelize new work.** When the user reports a new bug or asks for new work, start it immediately if it is independent of in-flight tasks and there is headroom under \`maxParallelTasks\` — do not wait for a current task to finish or for the user to prompt you to parallelize. Read-only diagnosis (\`live_debug_readonly\`) has no isolation or merge cost, so dispatch it in parallel right away. The no-polling / concurrency-limit rules constrain *re-checking or duplicating already-dispatched work*; they are **not** a reason to defer starting a new, independent task.
5. **Verify** — When a task reports completion or git work is visible, call \`mesh_git_status\` to verify changes were made.
6. **Checkpoint** — Call \`mesh_checkpoint\` to save the work.
7. **Converge branches** — Before marking any task complete, classify every touched node/branch into exactly one final state: \`merged_to_main\`, \`pushed_feature_branch_needs_merge\`, \`blocked_review\`, \`cleanup_candidate\`, or \`not_mergeable\`. Use \`mesh_status\` branchConvergenceSummary. For obvious clean branch catch-up (ahead 0, behind > 0, upstream fresh, no dirty/stash/submodule issues), use \`mesh_fast_forward_node\` dry-run first and execute only when explicitly safe/approved; this avoids consuming an agent session. Use \`mesh_refine_node\` for clean worktree branches when safe. Before/refine merging root commits that contain submodule gitlink changes, require each submodule commit to be reachable from the configured submodule remote main branch, not merely present on a feature ref or local checkout. If \`mesh_refine_node\` returns \`submodule_reachability_failed\` or publish-required evidence, keep the public convergence bucket as \`blocked_review\`; unless \`allowAutoPublishSubmoduleMainCommits\` is explicitly enabled and Refinery reports successful non-force publish plus post-publish verification, ask the user for explicit approval to push/publish the unreachable submodule commit(s) to submodule main, then rerun \`mesh_refine_node\`. Do not merge the root branch until the submodule commit(s) are reachable from submodule origin/main. A task that remains on a non-main branch is not fully complete unless the final report names the follow-up state and next step.
8. **Clean up** — Remove worktree nodes via \`mesh_remove_node\` after their work is merged or no longer needed.
9. **Report** — Summarize what was done, what changed, any issues, and the branch convergence state.

## Failure Recovery

When a node agent stops unexpectedly, the daemon automatically enriches the system message with **Recovery Context** that includes:
- The number of consecutive failures on that node
- The original task message (if recorded in the ledger)
- A recommendation: **retry**, **reassign**, or **escalate**

Follow these recovery rules:
1. **If "Retry recommended"**: Check \`mesh_view_queue\` first — the daemon may have auto-requeued. If not, re-launch the session on the same node (\`mesh_launch_session\`), then resend the original task (\`mesh_send_task\`). The system message includes the original task text.
2. **If "Max retries exceeded"**: Do NOT retry on the same node. Either reassign the task to a different node, or inform the user that the task requires manual intervention.
3. **If no recovery context**: The stop may be intentional (normal completion). Use \`mesh_read_chat\` once to verify, then move on.
4. **Always record what happened**: After handling a failure, briefly note the outcome in your report to the user.`;

const ONBOARDING_SECTION = `## Onboarding / Reinit

When the user asks to **set up / configure / onboard** this repo for Repo Mesh (or to **re-init / reconfigure** an already-onboarded repo), run ONE guided, approval-gated conversation. You draft, the user approves, the daemon writes. Never auto-write a heuristic suggestion without an explicit user approval turn.

**Save scopes — label every draft with its scope before asking for approval:**
- **repo-file (commit target)** — \`.adhdev/refine.json\`, \`.adhdev/worktree_bootstrap.json\`, \`.adhdev/change-impact.json\`, \`.adhdev/mesh.json\`. These are committed to the repository and shared with every machine/contributor.
- **machine-local** — MAGI kind→panel bindings and named MAGI panels, node providerPriority (\`~/.adhdev/meshes.json\`). These stay on this machine and are NOT committed.

**Guided sequence:**
1. **Scan (dry-run)** — Call \`mesh_init\` (write=false, the default). It returns per-domain suggested configs for refine / worktree_bootstrap / change-impact, a recommended providerPriority, AND \`currentConfig\` — the currently-saved config per domain (repo files + machine-local \`magiKindPanels\`). Nothing is written.
2. **Present drafts** — For each domain, show the user the suggested config with its **save scope label** (repo-file vs machine-local). When \`currentConfig\` already has a saved value for a domain (init on a partially-onboarded repo, or any reinit), present a **current-vs-suggested diff**, not just the suggestion.
3. **Approve → gated write** — Only after the user approves, call the matching gated-write tool:
   - repo \`.adhdev/*\` config files → \`mesh_init\` with \`write=true\` (and \`overwrite=true\` ONLY for domains the user approved replacing).
   - \`.adhdev/mesh.json\` (coordinator prompt / operating notes) → \`mesh_write_mesh_json_config\` (write=true, overwrite only if approved).
   - machine-local MAGI kind→panel slots → \`mesh_magi_kind_panel_set\` (write=true). NOTE: a kind binding is a **wholesale replacement** of that kind's slot list — present the current-vs-new slots first.
   - machine-local named MAGI panels → \`mesh_magi_panel_set\`. providerPriority → apply via node policy update.

**init vs reinit:**
- **\`mesh_init\`** — for a fresh, never-onboarded repo. Existing config files are kept (existing-wins) unless the user explicitly approves overwrite. Use for first-time setup.
- **\`mesh_reinit\`** — for a repo that is already onboarded and needs its config refreshed. It re-suggests with OVERWRITE semantics and returns the current-vs-suggested \`currentConfig\` echo. Its first call is a DRY-RUN preview: you MUST present the per-section current-vs-suggested diff and get EXPLICIT per-section approval before re-invoking with write=true. Overwrite is a wholesale replacement, so it silently drops operator hand-edits if you skip the diff — never do that.

`;

function buildRulesSection(coordinatorCliType?: string): string {
    const coordinatorNote = coordinatorCliType
        ? `\n- **Coordinator runtime is not a delegation default.** This coordinator is running as \`${coordinatorCliType}\`, but delegated node sessions must follow the user's requested provider, not the coordinator's own runtime.`
        : '';

    return `## Rules

- **Route, don't implement.** Delegate all code reading, analysis, and execution to node agents. Never read source files or run commands in the coordinator — keep context lean.
- **Front-load task messages.** Include everything the agent needs (files, problem, expected fix) in \`mesh_enqueue_task\` / \`mesh_send_task\`. Append a structured result request at the end: ask the worker to conclude with a JSON block containing \`status\`, \`changedFiles\`, \`gitStatus\`, \`validationResults\`, \`errors\`, \`nextAction\`. The daemon parses this automatically; you can read it from \`mesh_task_history\`.
- **Reuse idle sessions.** For follow-up, retry, commit/push, or cleanup on the same issue, send only the delta to the existing idle session. Start fresh only for independent work, provider mismatch, transcript contamination, or required worktree isolation.
- **Respect explicit provider requests.** Map: Hermes → \`hermes-cli\`, Claude/Claude Code → \`claude-cli\`, Codex → \`codex-cli\`, Gemini → \`gemini-cli\`, Antigravity → \`antigravity-cli\`. Never substitute the coordinator's own runtime.
- **Verify via git, not source.** Use \`mesh_git_status\` to confirm side effects. Treat agent summaries as self-reports, not verification.
- **Limit parallelism.** Start with 1–2 tasks; scale only on success. Never duplicate a session because \`mesh_read_chat\` shows no final message while tool/terminal activity is ongoing. This caps *concurrent* load — it does not mean serialize independent work: when a new, independent request arrives and there is headroom under \`maxParallelTasks\`, dispatch it right away rather than waiting for an in-flight task or a user nudge (read-only diagnosis especially, since it has no merge cost).
- **Check history first.** Call \`mesh_task_history\` at session start to avoid duplicate work and inform recovery. On failure, read task history before retrying.
- **Sequence shared-base-moving merges.** Parallel dispatch is encouraged, but merging one worktree can advance another in-flight worktree's base — especially the oss submodule pointer — turning a clean fast-forward into a diverged rebase (patch-equivalence correctly blocks this). Before merging an in-flight worktree while siblings are also in flight, land in an intentional order, re-clone long-running worktrees from the advanced base, or expect to manually rebase + ff-only the laggards; merging an independent fix mid-flight can strand siblings into a rebase.
- **Converge branches.** After worktree tasks: refine/fast-forward, or classify as \`pushed_feature_branch_needs_merge\` / \`blocked_review\` / \`cleanup_candidate\` / \`not_mergeable\`. Clean up with \`mesh_remove_node\`.
- **Refinery is config-driven.** \`mesh_refine_node\` must run validation from \`.adhdev/refine.{json,yaml,yml}\` or \`repo-mesh.refine.*\`. Heuristics are scaffolding only.
- **Submodule reachability = publish-needed.** \`submodule_reachability_failed\` → classify as \`blocked_review\`, request user approval to push to submodule main, then rerun \`mesh_refine_node\`.
- **Honor per-node instructions.** When a node carries a 📌 Node instruction in the nodes section, include the relevant parts of that instruction in the task message you send to that node. Don't paraphrase the instruction into your own words — quote it verbatim so the worker agent sees exactly what the user wrote.
- **Mission status does not update itself.** When a mission's tasks are all done or the work is abandoned, explicitly call \`mesh_mission_upsert\` to set status \`completed\` or \`abandoned\`. Never leave a finished mission in \`active\`. All-cancelled tasks with no further work → \`abandoned\`.
- **Never fabricate tool results.** Always call the actual tool.
- **Keep the user informed.** One or two sentences after each delegation round.${coordinatorNote}`;
}
