/**
 * assistant-protocol — the assistant layer's tool and daemon-verb names
 * (docs/design/2026-10-07-assistant-layer.md §4.4).
 *
 * The single source for both halves of the assistant contract, like
 * `WORKER_TOOLS` is for workers:
 *   - `ASSISTANT_TOOLS` — exactly what `adhdev mcp --assistant` will advertise
 *     (an mcp-server parity test pins ListTools to this tuple once that mode
 *     lands);
 *   - `ASSISTANT_TOOL_VERBS` — the daemon command each tool calls;
 *   - the daemon-only verbs (launch / MCP-only pull / owner actions) that have
 *     no tool.
 *
 * Assistant tools are a separate set from the mesh tools: none of these names
 * belongs in `CANONICAL_MESH_TOOL_NAMES`, and the coordinator/worker MCP modes
 * never publish them.
 */

export const ASSISTANT_TOOLS = [
    'projects',
    'project_status',
    'project_send',
    'project_read',
    'project_add',
    'discover_repos',
    'memory',
    'skill_view',
    'skill_manage',
    'project_note',
] as const

export type AssistantTool = typeof ASSISTANT_TOOLS[number]

const ASSISTANT_TOOL_SET: ReadonlySet<string> = new Set(ASSISTANT_TOOLS)

export function isAssistantTool(value: unknown): value is AssistantTool {
    return typeof value === 'string' && ASSISTANT_TOOL_SET.has(value)
}

/** Daemon verb names (§4.4 table + the five verbs below it). */
export const ASSISTANT_VERB = {
    // tool verbs
    projects: 'assistant_projects',
    projectStatus: 'assistant_project_status',
    projectSend: 'assistant_project_send',
    projectRead: 'assistant_project_read',
    projectAdd: 'assistant_project_add',
    discoverRepos: 'assistant_discover_repos',
    memory: 'assistant_memory',
    skillView: 'assistant_skill_view',
    skillManage: 'assistant_skill_manage',
    projectNote: 'assistant_project_note',
    // assistant-side daemon verbs without a tool of the same name
    launch: 'launch_assistant',
    pendingRelays: 'assistant_pending_relays',
    // owner verbs (dashboard only)
    stagedResolve: 'assistant_staged_resolve',
    storeAdmin: 'assistant_store_admin',
    importSkills: 'assistant_import_skills',
} as const

export type AssistantVerb = typeof ASSISTANT_VERB[keyof typeof ASSISTANT_VERB]

/** The daemon verb each assistant tool calls. */
export const ASSISTANT_TOOL_VERBS: Readonly<Record<AssistantTool, AssistantVerb>> = {
    projects: ASSISTANT_VERB.projects,
    project_status: ASSISTANT_VERB.projectStatus,
    project_send: ASSISTANT_VERB.projectSend,
    project_read: ASSISTANT_VERB.projectRead,
    project_add: ASSISTANT_VERB.projectAdd,
    discover_repos: ASSISTANT_VERB.discoverRepos,
    memory: ASSISTANT_VERB.memory,
    skill_view: ASSISTANT_VERB.skillView,
    skill_manage: ASSISTANT_VERB.skillManage,
    project_note: ASSISTANT_VERB.projectNote,
}

/**
 * Tools annotated as writes; every other assistant tool is read-only. §4.4
 * lists the three store writes; project_send and project_add are here too
 * because they cause effects (a coordinator message or launch, a new
 * project), and MCP clients use readOnlyHint to skip confirmation.
 */
export const ASSISTANT_WRITE_TOOLS: readonly AssistantTool[] = ['memory', 'skill_manage', 'project_note', 'project_send', 'project_add']

/** Owner-only verbs: never reachable from the assistant's MCP server (no `ipc`). */
export const ASSISTANT_OWNER_VERBS: readonly AssistantVerb[] = [
    ASSISTANT_VERB.stagedResolve,
    ASSISTANT_VERB.storeAdmin,
    ASSISTANT_VERB.importSkills,
]

/** The only assistant verbs accepted while an idle review turn is open (§4.10.7). */
export const ASSISTANT_REVIEW_TURN_VERBS: readonly AssistantVerb[] = [
    ASSISTANT_VERB.memory,
    ASSISTANT_VERB.skillView,
    ASSISTANT_VERB.skillManage,
    ASSISTANT_VERB.projectNote,
]

/**
 * Env var the daemon sets on the assistant CLI's process (§4.5), read by the
 * assistant MCP server and forwarded on every verb as
 * `ASSISTANT_SESSION_ID_ARG`. Routing / ownership only — never an auth gate.
 */
export const ASSISTANT_SESSION_ID_ENV = 'ADHDEV_ASSISTANT_SESSION_ID'

/** Request arg carrying the calling assistant session id. */
export const ASSISTANT_SESSION_ID_ARG = 'assistantSessionId'
