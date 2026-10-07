/**
 * MCP tool schemas — Refinery and mesh configuration (mesh-tools-refine.ts /
 * mesh-tools-config handlers): refine node / batch / plan, the
 * review inbox, node slots, config / init, the
 * coordinator prompt append and worker notification. Pure data; ALL_MESH_TOOLS in
 * mesh-tool-schemas.ts is the registry.
 */

export const MESH_REFINE_NODE_TOOL = {
    name: 'mesh_refine_node',
    description: 'The Refinery: validate → merge → push → clean up a completed worktree node onto the base branch. '
        + 'Defaults to dry-run (plan only): returns the validation plan with mergeWillRun:false/cleanupWillRun:false and performs NO merge/push/cleanup. '
        + 'Pass execute=true to actually converge the node. execute=true is async: the immediate response includes async:true, status:\'accepted\', jobId, interactionId, target node, and startedAt; completion/failure evidence is delivered through pending mesh events and the mesh task ledger. '
        + 'dry_run=true overrides execute. Matches the mesh_refine_batch / mesh_fast_forward_node dry_run/execute contract. '
        + 'Converges ONE node: to land two or more sibling worktrees that share a base branch, use mesh_refine_batch instead of calling this repeatedly — it orders the nodes conflict-aware and auto-rebases each one onto the base its predecessors advanced, which repeated single-node calls leave to you (and which can contend on the base lease as base_locked).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the completed worktree node to refine and merge.' },
            execute: { type: 'boolean', description: 'When true, run validation/merge/push/cleanup for this node. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the validation plan without merging. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REFINE_BATCH_TOOL = {
    name: 'mesh_refine_batch',
    description: 'Batch Refinery: converge multiple sibling worktree nodes onto the base branch in one conflict-aware sequential pipeline. '
        + 'Orders nodes by change-area (non-submodule nodes first, submodule-touching nodes serialized last) so each merged sibling advances the base and the next node auto-rebases + re-checks patch-equivalence before its own merge. '
        + 'Each node runs the same validation/patch-equivalence/submodule-reachability/merge/cleanup gates as mesh_refine_node. '
        + 'Conflicting or blocked nodes are isolated as blocked_review while the rest of the batch proceeds. Defaults to dry-run (plan only); set execute=true to converge. Never force-pushes or resets. '
        + 'execute=true is async: the immediate response is async:true / status:\'accepted\' with the batch jobId and ordered target node list; per-node convergence runs in the background and the aggregate completion/failure (with per-node merged / blocked_review / not_mergeable results) is delivered as a terminal refine event via pending mesh events and the ledger — do not re-invoke while a batch is in flight. dry_run returns the plan synchronously.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit node IDs to converge, in any order (the tool computes the safe merge order). When omitted, all local worktree nodes that need convergence are auto-collected.',
            },
            execute: { type: 'boolean', description: 'When true, run validation/rebase/merge for each node in order. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the ordering + per-node validation plan without executing. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: [],
    },
};

// 2026-09-26 tool consolidation: the Refinery config helper, the Change Impact
// config helper and the `.adhdev/mesh.json` gated write are one tool, selected
// by `kind`. refine / change_impact keep their read-only `mode`
// (schema/validate/suggest); mesh_json keeps its write/overwrite dry-run contract.
// The pre-2026-09 per-mode names (mesh_refine_config_schema & co.) stay
// dispatchable as hidden aliases with kind + mode injected (mesh-tool-dispatch.ts).
export const MESH_CONFIG_TOOL = {
    name: 'mesh_config',
    description: 'Repo-config helper; `kind` (REQUIRED) picks the family, each taking only its own arguments:\n'
        + '• kind="refine" — Refinery config, read-only (use on a refine config error, or to see which validation commands run). `mode` (REQUIRED): schema = JSON schema + supported repo-local locations (the validation authority; heuristic detection only suggests); validate = check a config without running validation or merging; suggest = scaffold from project scripts (never executed until saved). Validation+merge itself is mesh_refine_node.\n'
        + '• kind="change_impact" — read-only, declarative, never executed: which changes between the live daemon build and workspace HEAD need a daemon restart vs a web-only redeploy vs nothing (use when deciding whether a landed change needs a restart). Same modes; validate loads .adhdev/change-impact.{json,yaml,yml} or repo-mesh-change-impact.*; suggest maps web-* → web-only, others → daemon-runtime, docs/license → non-runtime, effective once saved.\n'
        + '• kind="mesh_json" — gated WRITE of `.adhdev/mesh.json` (repo-committed coordinator prompt override/append + config) from the machine-local mesh entry. REPO-COMMITTED scope, no `mode`; dry-run by default, validated, never clobbers without overwrite=true — show a current-vs-suggested diff and get explicit approval first.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            kind: {
                type: 'string',
                enum: ['refine', 'change_impact', 'mesh_json'],
                description: 'Config family (required).',
            },
            mode: {
                type: 'string',
                enum: ['schema', 'validate', 'suggest'],
                description: 'refine / change_impact (required): schema (no other args) | validate | suggest.',
            },
            node_id: { type: 'string', description: 'Default: first mesh node. Config/context source (refine, change_impact) or target workspace (mesh_json; `workspace` wins).' },
            config: { type: 'object', description: 'mode=validate: inline config to validate instead of the repo file.' },
            write: { type: 'boolean', description: 'mesh_json: persist .adhdev/mesh.json (commit target). Default false (dry-run).' },
            overwrite: { type: 'boolean', description: 'mesh_json: replace an existing .adhdev/mesh.json. Default false.' },
            workspace: { type: 'string', description: 'mesh_json: workspace path to write into; defaults to node_id\'s workspace.' },
        },
        required: ['kind'],
    },
};

export const MESH_INIT_TOOL = {
    name: 'mesh_init',
    description: 'Mesh onboarding for a git repo: detects installed CLI providers, suggests the three repo `.adhdev/*` config families — Refinery (refine.json), worktree bootstrap (worktree_bootstrap.json) and change-impact (change-impact.json) — optionally writes them, and recommends a node providerPriority (never auto-applied). Returns `currentConfig` (the saved config per domain). Suggestions never execute until saved; always dry-run unless write=true.\n'
        + '• mode="init" (default) — a fresh repo; never overwrites an existing config unless overwrite=true.\n'
        + '• mode="reinit" — refresh an already-onboarded repo: same engine, overwrite defaults to TRUE. Overwrite is a WHOLESALE replacement that would silently drop operator hand-edits, so the first call (write=false) is a DRY-RUN: present the per-section current-vs-suggested diff and get EXPLICIT per-section approval before write=true.\n'
        + 'GUIDED FLOW (one approval-gated conversation — you draft, the user approves, the daemon writes; never write a heuristic suggestion without an explicit approval turn): (1) call with write=false; (2) present each domain\'s draft labelled with its save scope — repo-file (commit target: .adhdev/refine.json, worktree_bootstrap.json, change-impact.json, mesh.json; shared with every machine) or machine-local (node providerPriority in ~/.adhdev/meshes.json, not committed) — as a current-vs-suggested diff whenever currentConfig already holds a value; (3) after approval write: repo .adhdev/* files → mesh_init write=true (overwrite=true only for approved domains); .adhdev/mesh.json → mesh_config kind="mesh_json" write=true; providerPriority → the node policy update.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['init', 'reinit'],
                description: 'init (default) = first-time onboarding, existing config wins; reinit = refresh, overwrite defaults to true.',
            },
            node_id: { type: 'string', description: 'Optional node/workspace to onboard; defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'Persist the suggested configs. Default false (dry-run; for reinit it surfaces the diff to approve per section).' },
            overwrite: { type: 'boolean', description: 'Replace existing config files. Default false for init, true for reinit (pass false to keep existing-wins).' },
        },
    },
};

export const MESH_REFINE_PLAN_TOOL = {
    name: 'mesh_refine_plan',
    description: 'Alias of mesh_refine_node\'s default dry-run: the Refinery plan for a worktree node (config source, validation commands, merge/cleanup intent); executes nothing.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Worktree node to plan.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REVIEW_INBOX_TOOL = {
    name: 'mesh_review_inbox',
    description: 'List local worktree nodes that need human review: merge candidates (pushed feature branches ready to merge) and Refinery-blocked review results. Returns evidence summaries, diff stats vs. the default branch, and suggested actions (Refine / Requeue / Dismiss). Remote nodes are excluded in M4.0.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mesh_id: { type: 'string', description: 'Mesh ID (optional — inferred from active mesh if omitted).' },
        },
        required: [],
    },
};

// 2026-09-26 tool consolidation: set / list / propose on a node's capability
// slots are one tool, selected by `action` (per-action argument sets enforced in
// validate-tool-args.ts MESH_TOOL_ACTIONS).
export const MESH_NODE_SLOTS_TOOL = {
    name: 'mesh_node_slots',
    description: 'Read, draft or change a node\'s capability slots (policy.slots): the provider/model/thinking + difficulty + capability tags routing matches. Use when routing keeps landing on a poor-fit node, a node has no slots, or CLIs were installed. `action` (REQUIRED, own arguments only):\n'
        + '• list — read-only current slots.\n'
        + '• propose — read-only AUTO-DETECT from the node\'s installed CLIs (category=cli, installed=true) via a seeded provider→(model/thinkingLevel/difficulty/maxParallel) table: `proposedSlots` with rationale plus `droppedSlots` / `droppedProviders` / `destructive` (hand-tuned slots, tuned maxParallel and providers not on PATH are NOT kept — present them before approving). Nothing detected → nothing proposed.\n'
        + '• set — dry-run (default) or write=true. WHOLESALE REPLACEMENT: `slots` becomes the complete list. Present the dry-run\'s `currentSlots` vs `proposedSlots` and get EXPLICIT user approval before writing (machine-local node policy, via update_mesh_node).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'propose', 'set'],
                description: 'Slot operation (required).',
            },
            node_id: { type: 'string', description: 'REQUIRED for every action — the mesh node id.' },
            slots: {
                type: 'array',
                description: 'set (required): the COMPLETE desired slot list.',
                items: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string', description: 'REQUIRED provider type, e.g. claude-cli / codex-cli / antigravity-cli.' },
                        model: { type: 'string', description: 'Best-effort at launch, e.g. opus / gpt-5-codex.' },
                        thinkingLevel: { type: 'string', description: 'Provider-specific level verbatim (low/medium/high/max; codex minimal/xhigh).' },
                        difficulty: { type: 'array', items: { type: 'string' }, description: 'Difficulties handled (easy/medium/difficult/freeform); empty = all.' },
                        capability: { type: 'array', items: { type: 'string' }, description: 'Capability tags satisfied (matched against a task\'s requiredTags).' },
                        maxParallel: { type: 'number', description: 'Per-node·per-slot concurrency cap; omit = none.' },
                    },
                    required: ['provider'],
                },
            },
            reason: { type: 'string', description: 'set: optional rationale echoed in the dry-run.' },
            write: { type: 'boolean', description: 'set: apply (wholesale replacement). Default false (dry-run).' },
        },
        required: ['action', 'node_id'],
    },
};

// 2026-09-26 tool consolidation: the coordinator prompt APPEND get/set pair as one tool.
export const MESH_COORDINATOR_PROMPT_APPEND_TOOL = {
    name: 'mesh_coordinator_prompt_append',
    description: 'Read or write the user-level coordinator prompt APPEND text for a CLI type — the per-machine file ~/.adhdev/coordinator-prompts/<cli>.append.md on this MCP server\'s daemon, applied to every mesh this daemon coordinates. '
        + 'Use it only when the user asks to add a standing instruction to every coordinator on this machine. Select with `action` (REQUIRED):\n'
        + '• get — read the current append text. Read it before `set` so you know what you would replace.\n'
        + '• set — write (or, with empty/omitted content, clear) the append file. WHOLESALE REPLACE of the whole file, not an incremental add.\n'
        + 'APPEND ONLY (a safety boundary, not a missing feature): this always stacks AFTER whichever base prompt wins; it can NEVER replace the daemon\'s base coordinator prompt (the OVERRIDE file) — that stays a dashboard-only, human-gated action, so a coordinator cannot erase its own core operating rules.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'set'],
                description: 'get = read the append text; set = replace (or clear) it. Required.',
            },
            cli_type: { type: 'string', description: 'CLI type key, e.g. "claude-cli", "codex-cli". Defaults to "default" (applies to every CLI type without its own file).' },
            content: { type: 'string', description: 'set: the full append text to write. Omit or pass an empty string to clear (delete the file, falling back to no append at this layer).' },
        },
        required: ['action'],
    },
};

/**
 * E-T0 (design §7.1) — deposit an urgent memo into a delegated worker's
 * mailbox. Delivered on the worker's NEXT MCP tool response (report_completion,
 * progress_update, peer_context_pull, even git_status — whichever it calls
 * first), never mid-turn: this repo has no hook infrastructure to interrupt a
 * generating turn (§7.3), and T3's destructive interrupt is a different,
 * much costlier tool for a different situation (aborts the turn outright).
 *
 * ★NOT in `ALL_MESH_TOOLS` — this tool is published only when the worker-MCP
 * flag is on (server.ts gates it explicitly), so a flag-off coordinator's
 * ListTools response stays byte-identical to before E-T0 existed. See
 * `mesh-tools-session.ts`'s `meshNotifyWorker` for the implementation and
 * `commands/low-family/worker-mailbox.ts` for the daemon-side gate that backs
 * this up even if a caller invokes the tool name without it being listed.
 */
export const MESH_NOTIFY_WORKER_TOOL = {
    name: 'mesh_notify_worker',
    description: 'Send an urgent memo to a delegated worker\'s task. Delivered on the worker\'s NEXT MCP tool call '
        + '(report_completion / progress_update / peer_context_pull / git_status — whichever it calls first), '
        + 'NOT instantly — this does not interrupt a running generation turn. Use for something the worker needs '
        + 'to know before it finishes (a changed requirement, a reason to stop) that does not justify aborting its '
        + "turn outright (mesh_send_task's delivery_mode: 'interrupt' does that, destructively). Requires ADHDEV_WORKER_MCP "
        + 'to be enabled on the target daemon; refused otherwise.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes) — the node the worker is running on.' },
            task_id: { type: 'string', description: 'The worker\'s task ID (from mesh_view_queue / mesh_task_history).' },
            message: { type: 'string', description: 'The urgent memo text, in your own words. Kept short — this rides inside a tool response, not a full document.' },
        },
        required: ['node_id', 'task_id', 'message'],
    },
};
