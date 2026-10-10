/**
 * Assistant-mode tools — what `adhdev mcp --assistant` publishes.
 *
 * Design SoT: docs/design/2026-10-07-assistant-layer.md §4.4 (tool table),
 * §4.5 (mcp-server, MCP-only assistant).
 *
 * The tool NAMES and the daemon verb each one calls come from
 * `ASSISTANT_TOOLS` / `ASSISTANT_TOOL_VERBS` (@adhdev/mesh-shared), the same
 * contract-tuple arrangement `WORKER_TOOLS` uses. This file owns only the input
 * schemas; `resolveAssistantModeTools()` refuses to start when the schemas and
 * the tuple disagree.
 *
 * Every tool is a thin pass-through: the daemon verb does the validation,
 * project resolution, staging and the `{project, meshId, result}` wrapping
 * (§4.4). This server only rejects unknown/mistyped arguments up front and
 * stamps the caller's `assistantSessionId` (from `ADHDEV_ASSISTANT_SESSION_ID`)
 * onto every call. That id is routing/ownership only, never an auth gate.
 *
 * Note there is deliberately no mesh tool, no approval tool (`project_resolve`
 * was rejected, §4.9) and no owner verb (staged resolve / store admin /
 * import) here — those are dashboard-only and the daemon refuses them over ipc.
 */

import {
  ASSISTANT_SESSION_ID_ARG,
  ASSISTANT_SESSION_ID_ENV,
  ASSISTANT_TOOLS,
  ASSISTANT_TOOL_VERBS,
  ASSISTANT_VERB,
  enumOf,
  isAssistantTool,
  type AssistantTool,
} from '@adhdev/mesh-shared';

import type { CommandTransport } from '../transports/mode.js';
import { annotateAll, type ToolBehaviorAnnotations } from './tool-annotations.js';

/** Read once at startup. Absent for an MCP-only assistant (e.g. Claude Desktop). */
export function readAssistantSessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ASSISTANT_SESSION_ID_ENV];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

const PROJECT_PROP = {
  project: {
    type: 'string',
    description: 'Project slug (or alias) as shown by `projects`.',
  },
} as const;

// Mirrors daemon-core assistant/note-staging.ts PROJECT_NOTE_CATEGORIES and the
// mesh_note schema — the operating-note categories are unchanged (§4.10.3).
const ASSISTANT_NOTE_CATEGORIES = ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'] as const;

interface AssistantToolSchema {
  name: AssistantTool | string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const PROJECTS_TOOL: AssistantToolSchema = {
  name: 'projects',
  description:
    'List every project, one line each: slug, repo, which machine hosts it (this machine, or another one — '
    + 'its requests and replies are relayed; `reachability: unreachable` with a reason when that machine cannot be reached now), '
    + 'whether a thread is open, and for projects this machine hosts the coordinator state (none / idle / working), queue counts, '
    + 'active missions and pending approvals (project_status asks the other machine for those) — plus a machines[] summary (label, OS, online, build).',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const PROJECT_STATUS_TOOL: AssistantToolSchema = {
  name: 'project_status',
  description:
    'Compact status of one project: machines online, queue counts, active mission titles, failed tasks, '
    + 'pending approvals, and when its coordinator last reported back. Also `routing`: which provider/model '
    + 'each machine would route a task to right now, which configured slots were excluded and why '
    + '(`slot_capacity_exhausted`, `difficulty_floor_unavailable`, …), and per-provider quota evidence '
    + '(`snapshotStatus`, `failureKind`, `zeroReason`, `gateOutcome`) — the answer to "why is this provider '
    + 'not being used". Read-only: no quota is fetched and nothing is changed.',
  inputSchema: { type: 'object', properties: { ...PROJECT_PROP }, required: ['project'] },
};

const PROJECT_SEND_TOOL: AssistantToolSchema = {
  name: 'project_send',
  description:
    'Send a request to a project\'s coordinator (launching one if none is running) and return immediately with '
    + '{status: accepted|queued|duplicate, launched}. `message` is the user\'s words exactly as written; your own '
    + 'additions go in `supplement`, which the project sees labelled as yours. `duplicate` means a send with the same '
    + '`messageId` already arrived — do not send it again. The coordinator\'s reply arrives later as a relay — do not '
    + 'wait or poll for it. `skills` attaches up to 2 of your skills\' bodies below the message.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PROJECT_PROP,
      message: { type: 'string', description: 'The user\'s request, verbatim (not translated or paraphrased). Required.' },
      supplement: {
        type: 'string',
        description: 'Optional: your own additions (context, clarifications), sent below the message and labelled as the assistant\'s.',
      },
      messageId: {
        type: 'string',
        description: 'Optional: a short unique id for this send. Resending with the same id is safe — it answers `duplicate` instead of sending twice.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 2,
        description: 'Optional: up to 2 skill names whose SKILL.md body is attached as a framed "## Attached procedure: <name>" reference block (12,000 chars total, refused rather than truncated).',
      },
    },
    required: ['project', 'message'],
  },
};

const PROJECT_READ_TOOL: AssistantToolSchema = {
  name: 'project_read',
  description: 'Read the compact tail of a project coordinator\'s transcript.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PROJECT_PROP,
      tail: { type: 'integer', minimum: 1, description: 'Optional: how many recent messages to return.' },
    },
    required: ['project'],
  },
};

const PROJECT_ADD_TOOL: AssistantToolSchema = {
  name: 'project_add',
  description:
    'Make a local git checkout a project (this machine becomes its host). Checkouts on other machines are attached '
    + 'later by the project\'s coordinator once those machines are paired.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the repository checkout on this machine. Required.' },
      name: { type: 'string', description: 'Optional display name; defaults to the repository name.' },
    },
    required: ['path'],
  },
};

const DISCOVER_REPOS_TOOL: AssistantToolSchema = {
  name: 'discover_repos',
  description:
    'Bounded scan for git repositories (2 s, depth 3, at most 300 directories). Returns only '
    + '{path, repoIdentity, lastCommitAt, alreadyProject} — never file contents. Show the user which roots were scanned.',
  inputSchema: {
    type: 'object',
    properties: {
      roots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional directories to scan instead of the defaults (~/Work, ~/code, ~/src, ~/dev, ~/Projects, ~ at depth 1, managed workspaces).',
      },
    },
    required: [],
  },
};

const MEMORY_TOOL: AssistantToolSchema = {
  name: 'memory',
  description:
    'Change your persistent memory: target "memory" (environment & rules across projects) or "user" (the user\'s '
    + 'preferences). add needs text; replace needs match + text; remove needs match. `match` must hit exactly one '
    + 'entry. The result is applied, staged for the owner\'s review, or refused with a code, plus the new usage %. '
    + 'Your current prompt snapshot does not change; the write shows up next session.',
  inputSchema: {
    type: 'object',
    properties: {
      action: enumOf(['add', 'replace', 'remove'] as const, 'Required.'),
      target: enumOf(['memory', 'user'] as const, 'Which file. Required.'),
      text: { type: 'string', description: 'add / replace: the entry text.' },
      match: { type: 'string', description: 'replace / remove: a substring that occurs in exactly one existing entry.' },
    },
    required: ['action', 'target'],
  },
};

const SKILL_VIEW_TOOL: AssistantToolSchema = {
  name: 'skill_view',
  description:
    'Read a skill\'s SKILL.md body, or one of its references/ files via `file`. name "list" returns every skill '
    + '(name, description, state), including ones not in your index. Opening an archived skill makes it active again.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name, or "list". Required.' },
      file: { type: 'string', description: 'Optional: a file under the skill\'s references/ or templates/.' },
    },
    required: ['name'],
  },
};

const SKILL_MANAGE_TOOL: AssistantToolSchema = {
  name: 'skill_manage',
  description:
    'Create, patch or archive one of your skills. create: new skill (name, description, body). patch: replace one '
    + 'unique substring `old` with `new` in the body or in `file` (`file` without `old` adds a reference file; '
    + '`description` replaces the description). archive: mark it archived (files are kept). Patches are capped per '
    + 'session/turn; deleting, pinning and restoring are owner-only.',
  inputSchema: {
    type: 'object',
    properties: {
      action: enumOf(['create', 'patch', 'archive'] as const, 'Required.'),
      name: { type: 'string', description: 'Skill name: lowercase letters, digits and dashes. Required.' },
      description: { type: 'string', description: 'create: one-line description (1–300 chars). patch: replacement description.' },
      body: { type: 'string', description: 'create: the SKILL.md body (≤ 12,000 chars).' },
      old: { type: 'string', description: 'patch: the unique substring to replace.' },
      new: { type: 'string', description: 'patch: the replacement text.' },
      file: { type: 'string', description: 'patch: a references/ or templates/ file to patch or add (.md .txt .json .yaml .yml).' },
      project: { type: 'string', description: 'create: optional project slug this skill is for (an index hint only).' },
    },
    required: ['action', 'name'],
  },
};

const PROJECT_NOTE_TOOL: AssistantToolSchema = {
  name: 'project_note',
  description:
    'Record or forget an operating note for ONE project — the rule reaches every coordinator of that project. '
    + 'Use memory instead for rules that span projects, and for the user\'s preferences. Not available for projects '
    + 'hosted on another machine.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PROJECT_PROP,
      action: enumOf(['record', 'forget'] as const, 'Required.'),
      text: { type: 'string', description: 'record: the note (required). forget: retract notes with exactly this text.' },
      category: enumOf(ASSISTANT_NOTE_CATEGORIES, 'record: optional classification (governs prompt retention).'),
      note_id: { type: 'string', description: 'forget: the note id to retract.' },
    },
    required: ['project', 'action'],
  },
};

/** Every assistant schema, in no particular order — the tuple decides the order. */
export const ALL_ASSISTANT_TOOL_SCHEMAS: readonly AssistantToolSchema[] = [
  PROJECTS_TOOL,
  PROJECT_STATUS_TOOL,
  PROJECT_SEND_TOOL,
  PROJECT_READ_TOOL,
  PROJECT_ADD_TOOL,
  DISCOVER_REPOS_TOOL,
  MEMORY_TOOL,
  SKILL_VIEW_TOOL,
  SKILL_MANAGE_TOOL,
  PROJECT_NOTE_TOOL,
];

export type AssistantModeTool = AssistantToolSchema & { annotations: ToolBehaviorAnnotations };

/** Annotated assistant tools (for registry-wide annotation coverage tests). */
export const ALL_ASSISTANT_TOOLS: readonly AssistantModeTool[] = annotateAll(ALL_ASSISTANT_TOOL_SCHEMAS);

/**
 * The published assistant-mode list: `ASSISTANT_TOOLS` order, every entry
 * annotated. Throws at startup when a tuple entry has no schema, a schema is
 * not in the tuple, or a schema is defined twice.
 */
export function resolveAssistantModeTools(
  candidates: readonly AssistantToolSchema[] = ALL_ASSISTANT_TOOL_SCHEMAS,
): AssistantModeTool[] {
  const byName = new Map<string, AssistantToolSchema>();
  for (const tool of candidates) {
    if (byName.has(tool.name)) throw new Error(`assistant mode: tool '${tool.name}' is defined twice`);
    byName.set(tool.name, tool);
  }
  const missingSchema = ASSISTANT_TOOLS.filter(name => !byName.has(name));
  const unlisted = [...byName.keys()].filter(name => !isAssistantTool(name));
  if (missingSchema.length || unlisted.length) {
    throw new Error(
      'assistant mode: tool schemas and ASSISTANT_TOOLS (@adhdev/mesh-shared) disagree — '
        + `missing schema for [${missingSchema.join(', ')}]; schema not in ASSISTANT_TOOLS [${unlisted.join(', ')}]`,
    );
  }
  return annotateAll(ASSISTANT_TOOLS.map(name => byName.get(name)!));
}

/**
 * Call the daemon verb behind one assistant tool. Arguments pass through
 * unchanged (the schemas already use the daemon's key names); the caller's
 * session id is stamped last so a tool argument can never override it.
 */
export async function callAssistantTool(
  transport: Pick<CommandTransport, 'command'>,
  tool: AssistantTool,
  args: Record<string, unknown>,
  assistantSessionId: string | undefined,
): Promise<{ text: string; isError?: boolean }> {
  const verb = ASSISTANT_TOOL_VERBS[tool];
  const result: any = await transport.command(verb, {
    ...args,
    ...(assistantSessionId ? { [ASSISTANT_SESSION_ID_ARG]: assistantSessionId } : {}),
  });
  const text = result && typeof result === 'object' ? JSON.stringify(result) : String(result);
  return result?.success === true ? { text } : { text, isError: true };
}

/**
 * MCP-only assistant relays (§4.5): pull undelivered relay rows and return them
 * as `assistantEvents` to attach to the response. Never throws — a failed pull
 * (including an older daemon that does not know the verb) attaches nothing.
 */
export async function pullAssistantEvents(
  transport: Pick<CommandTransport, 'command'>,
  assistantSessionId: string | undefined,
): Promise<unknown[]> {
  try {
    const result: any = await transport.command(ASSISTANT_VERB.pendingRelays, {
      ...(assistantSessionId ? { [ASSISTANT_SESSION_ID_ARG]: assistantSessionId } : {}),
    });
    return result?.success === true && Array.isArray(result.assistantEvents) ? result.assistantEvents : [];
  } catch {
    return [];
  }
}

/**
 * Attach pending relays to a tool response. Only a JSON-object response gets
 * them, and the pull happens only then: the daemon claims rows on pull, so a
 * claimed relay with nowhere to go would be consumed unseen (the same rule as
 * mesh-pending-events-attach.ts).
 */
export async function attachAssistantEvents(
  transport: Pick<CommandTransport, 'command'>,
  assistantSessionId: string | undefined,
  text: string,
): Promise<string> {
  if (!text.trimStart().startsWith('{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  if (Object.prototype.hasOwnProperty.call(parsed, 'assistantEvents')) return text;
  const events = await pullAssistantEvents(transport, assistantSessionId);
  if (events.length === 0) return text;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), assistantEvents: events });
}
