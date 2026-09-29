/**
 * MCP tool schemas — Refinery, MAGI and mesh configuration (mesh-tools-refine.ts /
 * mesh-tools-magi.ts / mesh-tools-config handlers): refine node / batch / plan, the
 * review inbox, MAGI review / collect / kind panels, node slots, config / init, the
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
    description: 'Repo Mesh repo-config helper. Select the config family with `kind` (REQUIRED):\n'
        + '• kind="refine" — the Refinery config (read-only). Use when a refine run reports a config error or you need to know which validation commands will run. `mode` (REQUIRED): '
        + 'schema = the config JSON schema and supported repo-local locations (the validation authority; heuristic command detection is suggestions-only), no other args; validate = validate a node/workspace config without running validation or merging (optional node_id, optional inline `config`); suggest = scaffold a config from project context/package scripts (never executed until saved; optional node_id). '
        + 'Never runs validation or merges — that is mesh_refine_node / mesh_refine_plan.\n'
        + '• kind="change_impact" — the Change Impact config (read-only, declarative, never executed): which package/file changes between the live daemon build and workspace HEAD need a daemon rebuild/restart vs a web-only redeploy vs nothing. Use when deciding whether a landed change needs a daemon restart. '
        + 'Same `mode` values: schema; validate (loads .adhdev/change-impact.{json,yaml,yml} or repo-mesh-change-impact.* unless inline `config`); suggest (web-* → web-only, others → daemon-runtime, docs/license markers → non-runtime; review and save before it takes effect).\n'
        + '• kind="mesh_json" — gated WRITE of `.adhdev/mesh.json` (the repo-committed coordinator prompt override/append + declarative config) from the machine-local mesh entry. Use when the user wants the coordinator prompt/config committed to the repo. '
        + 'Dry-run by default (write=false), never clobbers an existing file unless overwrite=true, validates before writing. Overwrite silently replaces the file: present a current-vs-suggested diff and get explicit approval first. REPO-COMMITTED scope; takes no `mode`.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            kind: {
                type: 'string',
                enum: ['refine', 'change_impact', 'mesh_json'],
                description: 'Which config family (required). Each kind accepts only its own arguments — see the tool description.',
            },
            mode: {
                type: 'string',
                enum: ['schema', 'validate', 'suggest'],
                description: 'refine / change_impact only (required for them): schema (no other params), validate (optional node_id, optional inline config), suggest (optional node_id).',
            },
            node_id: { type: 'string', description: 'Optional node/workspace; defaults to the first mesh node. refine / change_impact: the config to load (validate) or context source (suggest), ignored by schema. mesh_json: whose workspace .adhdev/mesh.json is written (`workspace` wins when both are given).' },
            config: { type: 'object', description: 'refine / change_impact, mode=validate only: inline config object to validate instead of loading from the repo.' },
            write: { type: 'boolean', description: 'mesh_json: when true, persist .adhdev/mesh.json to the repo (commit target). Defaults false (dry-run preview).' },
            overwrite: { type: 'boolean', description: 'mesh_json: when true, replace an existing .adhdev/mesh.json. Defaults false (never clobber an existing repo mesh.json).' },
            workspace: { type: 'string', description: 'mesh_json: optional workspace path whose .adhdev/mesh.json is written. Defaults to the resolved node_id node\'s workspace.' },
        },
        required: ['kind'],
    },
};

export const MESH_INIT_TOOL = {
    name: 'mesh_init',
    description: 'Mesh onboarding for a git project: detects installed CLI providers, suggests all three repo `.adhdev/*` config families — Refinery (.adhdev/refine.json), worktree bootstrap (.adhdev/worktree_bootstrap.json) AND change-impact (.adhdev/change-impact.json) — optionally writes them, and recommends a node providerPriority. '
        + 'Also returns `currentConfig` (the saved config per domain: repo files + machine-local magiKindPanels) so you can present a current-vs-suggested diff. Suggestions never execute until saved; providerPriority is a recommendation, not auto-applied. Always dry-run unless write=true. Select with `mode`:\n'
        + '• mode="init" (default) — a fresh, never-onboarded repo. Never overwrites an existing config unless overwrite=true.\n'
        + '• mode="reinit" — re-onboard an ALREADY-initialized repo whose config needs refreshing: same suggest→validate→gated-write engine with overwrite defaulting to TRUE and a reinit contract in the response. '
        + 'Overwrite is a WHOLESALE replacement, so it must NOT silently drop operator hand-edits: the first call (write=false) is a DRY-RUN — present the per-section current-vs-suggested diff, get EXPLICIT per-section approval, then re-invoke with write=true.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['init', 'reinit'],
                description: 'init (default) = first-time onboarding, existing config wins; reinit = refresh an onboarded repo, overwrite defaults to true.',
            },
            node_id: { type: 'string', description: 'Optional node/workspace to onboard. Defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'When true, persist the suggested configs to disk. Defaults false (dry-run preview only — for reinit, the preview surfaces the current-vs-suggested diff; approve per-section first).' },
            overwrite: { type: 'boolean', description: 'Replace an existing config file. Defaults false for mode=init (never clobber) and true for mode=reinit; pass false with reinit to fall back to existing-wins.' },
        },
    },
};

export const MESH_REFINE_PLAN_TOOL = {
    name: 'mesh_refine_plan',
    description: 'Dry-run Refinery plan for a worktree node: reports config source, validation commands, suggestions/unavailable reason, and merge/cleanup intent without executing validation or git merge.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the worktree node to plan.' },
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

// ─── MAGI — Multi-Agent Ground-truth Insight ──

export const MESH_MAGI_REVIEW_TOOL = {
    name: 'mesh_magi_review',
    description: 'Cross-verify a read-only investigation across a standing panel of independent mesh agents (different machines/providers), instead of sending a SINGLE read-only worker. Drop-in for any read-only investigation — bug RCA, defect/regression measurement, "why does this code do X?", or doc/design/API review. Fans the SAME question out to N independent (node × provider) replicas, then synthesizes consensus/disagreement/unique evidence into a needs_verification list — NOT a majority vote (high agreement among coupled agents ≠ correct). Read-only is FORCED (no execute/write flag exists). COST: multiplies token spend by the total replica count (the call is the opt-in). PANEL RESOLUTION: the panel is resolved SOLELY from the USER-CONFIGURED kind-panel binding for the given `task_kind` (mesh settings → magiKindPanels: task_kind → (node × provider × model) slots). `task_kind` is REQUIRED — there is NO named-panel, inline-members, or automatic-preset path. A task_kind with no configured kind-panel errors `magi_kind_not_configured` (configure slots in mesh settings first). The binding must resolve to ≥2 (node, provider) targets; never silently degrades to N=1 (errors magi_insufficient_targets if the live mesh cannot supply the configured slots).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            question: { type: 'string', description: 'The single investigation question every agent answers — e.g. "What is the root cause of this defect?", "Refute this RCA.", "Why does this code do X?". Not only "review this".' },
            target: { type: 'string', description: 'What to investigate — file path(s), a bug symptom / error / stack trace, a code area / symbol, or omitted when the question is self-contained.' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Inline content when not file-backed: a doc/diff, a log/error dump, or a prior single-worker RCA to refute.' },
            n: { type: 'number', description: 'Global replica override per slot (clamped by the total-replica guard cap, default 12).' },
            task_kind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'REQUIRED. Selects (1) the SINGLE output schema injected into each replica prompt and the strict parser used at collection (no schema-on-schema conflict), AND (2) the user-configured kind-panel binding that supplies the fan-out slots (mesh settings → magiKindPanels; errors magi_kind_not_configured if that kind has no configured slots — no named-panel/inline/preset fallback). claim_audit: {claims[],top_findings[],open_questions[]}. rca: {rootCause,failsAt,mechanism,evidence[],fixDirection,confidence}. design: {recommendation,rationale,alternatives[],tradeoffs[],risks[],evidence[],confidence}. freeform: no schema — natural-language answer, parsing/evidence checks waived, cross-verification is weak. Every kind except freeform requires non-empty evidence[]; an empty-evidence or schema-invalid answer triggers ONE delta re-request before being dropped as unparseable. Do NOT also embed an output-format schema in the question — it collides with this contract (a warning is surfaced if detected).' },
            mode: { type: 'string', enum: ['rca', 'investigation', 'claim_audit', 'design_review', 'code_audit'], description: 'Synthesis emphasis hint — affects labels only, never the agent count or schema. Distinct from task_kind (which selects the output schema).' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            include_stale: { type: 'boolean', description: 'Default false. By default, panel slots whose node HEAD commit differs from the coordinator reference commit are EXCLUDED (they would investigate different code). Set true to fan out to them anyway — results will be git-skewed and a warning is surfaced. If exclusion drops the panel below 2 independent targets the call errors rather than degrading to N=1; include_stale=true is one way to recover.' },
            wait: { type: 'boolean', description: 'Default true — collect replica outputs and return the synthesis. Set false to dispatch async and return a consensusGroupId handle; collect later with mesh_magi_collect.' },
            wait_timeout_ms: { type: 'number', description: 'Max time to wait for replica completion before returning a partial "missing K of N" synthesis. Default 8 min, max 20 min.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete unless overridden). Once all replicas are terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified) so repeated reviews don\'t accumulate idle worker sessions. Reused/coordinator/other sessions are never touched. Set false to preserve auto-launched worker sessions for inspection. No effect on a partial (non-terminal) collection.' },
        },
        required: ['question', 'task_kind'],
    },
};

export const MESH_MAGI_COLLECT_TOOL = {
    name: 'mesh_magi_collect',
    description: 'Collect + synthesize a previously dispatched MAGI fan-out by its consensus group id — the async companion to mesh_magi_review({ wait:false }). Rediscovers the replica tasks from the queue and runs the SAME diversity-weighted synthesis (consensus/disagreement/unique-evidence → needs_verification list). Defaults to a SNAPSHOT (wait=false): returns whatever replicas are terminal right now, with a pending note if some are still generating; pass wait=true to block for the rest. Read-only. Drive off mission completion / pendingCoordinatorEvents rather than polling this in a tight loop.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            consensus_group_id: { type: 'string', description: 'The consensusGroupId returned by a wait=false mesh_magi_review.' },
            task_kind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'Optional override of the task_kind used to parse replica answers. Normally recovered automatically from the original dispatch — only set this if the dispatched ledger entry was pruned and auto-recovery falls back to claim_audit incorrectly.' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            wait: { type: 'boolean', description: 'Default false (snapshot). Set true to block for outstanding replicas up to wait_timeout_ms before synthesizing.' },
            wait_timeout_ms: { type: 'number', description: 'When wait=true, max time to wait for remaining replica completion. Default 8 min, max 20 min.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete). When the collection is terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified). Reused/coordinator/other sessions are never touched. Set false to preserve them. No effect on a partial (non-terminal) snapshot.' },
            verbose: { type: 'boolean', description: 'Default false. When true, each synthesis.replicas[] entry also carries rawAnswer — the replica\'s raw end-user answer text (capped). Omitted by default to keep the payload small; the structured clusters already carry the parsed claims.' },
        },
        required: ['consensus_group_id'],
    },
};

// 2026-09-26 tool consolidation: the MAGI kind-panel set/list pair as one tool.
export const MESH_MAGI_KIND_PANEL_TOOL = {
    name: 'mesh_magi_kind_panel',
    description: 'Read or bind the MAGI kind→panel slot lists for THIS mesh (machine-local ~/.adhdev/meshes.json → `meshes[].magiKindPanels`). The binding is what `mesh_magi_review({ task_kind })` resolves to — the SOLE panel-resolution path. '
        + 'Use it when mesh_magi_review fails with magi_kind_not_configured, or to confirm what a task_kind resolves to before a review. SCOPE: PER MESH, machine-local (NOT repo-committed); another mesh on this machine keeps its own bindings. Select with `action` (REQUIRED):\n'
        + '• list — read-only: every configured kind binding, or just `task_kind`\'s. The response `scope` names the mesh.\n'
        + '• set — bind `task_kind` to `slots`. WHOLESALE REPLACEMENT: the slots become the kind\'s COMPLETE set (prior slots dropped, not merged), so present the current-vs-new lists (the dry-run returns `currentSlots`) and get EXPLICIT user approval before write=true. Defaults to dry-run. '
        + 'A slot\'s `nodeId`, when given, MUST name a node of this mesh — a foreign/unknown id is rejected (invalid_magi_kind_panel).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'set'],
                description: 'Which panel operation to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            task_kind: { type: 'string', description: 'The task_kind key, e.g. claim_audit / rca / design / freeform. Required for set; list: optional filter (omit to list all).' },
            slots: {
                type: 'array',
                description: 'set: the COMPLETE desired slot list for this kind (wholesale replacement). Each slot: { provider (REQUIRED), nodeId?, model?, capabilityTags?, n? }. Required for set.',
                items: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string', description: 'REQUIRED — provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli.' },
                        nodeId: { type: 'string', description: 'Optional — pin to a specific node OF THIS MESH (validated against the mesh node list; a node id from another mesh is rejected). Omit to let the fan-out pick any node offering the provider.' },
                        model: { type: 'string', description: 'Optional — pin a specific model for this slot.' },
                        capabilityTags: { type: 'array', items: { type: 'string' }, description: 'Optional routing tags (ANDed with the provider tag) when nodeId is absent.' },
                        n: { type: 'number', description: 'Optional per-slot replica count (default 1).' },
                    },
                    required: ['provider'],
                },
            },
            write: { type: 'boolean', description: 'set: when true, persist the slot list (wholesale replacement) to meshes.json. Defaults false (dry-run preview of the normalized slots + currentSlots).' },
        },
        required: ['action'],
    },
};

// 2026-09-26 tool consolidation: set / list / propose on a node's capability
// slots are one tool, selected by `action` (per-action argument sets enforced in
// validate-tool-args.ts MESH_TOOL_ACTIONS).
export const MESH_NODE_SLOTS_TOOL = {
    name: 'mesh_node_slots',
    description: 'Read, draft, or change a mesh node\'s capability slots (policy.slots) — the provider/model/thinking + difficulty + capability-tag profile that task→node fitness routing and MAGI fan-out match against. '
        + 'Use it when routing keeps landing work on a poor-fit node, when a node has no slots, or after CLI agents were installed on a node. Select with `action` (REQUIRED):\n'
        + '• list — read-only: the node\'s current slots.\n'
        + '• propose — read-only AUTO-DETECT: reads the node\'s installed CLI agents from the coordinator (its own provider catalog, or the one the node pushed — category=cli + installed=true), maps each through a seeded provider→(model/thinkingLevel/difficulty/maxParallel) table, and returns `proposedSlots` with per-slot rationale plus `droppedSlots` / `droppedProviders` / `destructive` '
        + '(hand-tuned slots, tuned maxParallel, providers not on PATH are NOT preserved by the draft — present those before approving). Detects nothing → proposes nothing. Never writes.\n'
        + '• set — PROPOSE (dry-run, default) or APPLY (write=true) a slot list. WHOLESALE REPLACEMENT: the `slots` you pass become the COMPLETE new list; any prior slot not in it is dropped. The dry-run returns `currentSlots` vs `proposedSlots` — present the diff and get EXPLICIT user approval before write=true. Apply goes through update_mesh_node (machine-local node policy).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'propose', 'set'],
                description: 'Which slot operation to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            node_id: { type: 'string', description: 'REQUIRED — the mesh node id. All actions.' },
            slots: {
                type: 'array',
                description: 'set: the COMPLETE desired capability-slot list (wholesale replacement). Each slot: { provider (REQUIRED), model?, thinkingLevel?, difficulty?, capability?, maxParallel? }. Required for set.',
                items: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string', description: 'REQUIRED — provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli.' },
                        model: { type: 'string', description: 'Optional — model for this slot (best-effort at launch, e.g. opus / gpt-5-codex).' },
                        thinkingLevel: { type: 'string', description: 'Optional — provider-specific thinking level verbatim (e.g. low/medium/high/max, or codex minimal/xhigh).' },
                        difficulty: { type: 'array', items: { type: 'string' }, description: 'Optional — task difficulties this slot handles (easy/medium/difficult/freeform). Empty = all (general-purpose).' },
                        capability: { type: 'array', items: { type: 'string' }, description: 'Optional — capability tags this slot satisfies (matched against a task\'s requiredTags).' },
                        maxParallel: { type: 'number', description: 'Optional — per-node·per-slot max concurrent tasks. Omit = no per-slot cap.' },
                    },
                    required: ['provider'],
                },
            },
            reason: { type: 'string', description: 'set: optional short rationale, echoed in the dry-run so the user sees WHY the change is suggested.' },
            write: { type: 'boolean', description: 'set: when true, apply the slot list (wholesale replacement). Defaults false (dry-run preview of proposedSlots + currentSlots).' },
            include_magi: { type: 'boolean', description: 'propose: also draft a MAGI panel (one slot per detected provider, pinned to this node, models unpinned) for binding via mesh_magi_kind_panel action "set". Defaults false. Deliberately NOT a per-task_kind assignment — provider manifests carry no rca/design/claim_audit suitability data.' },
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
