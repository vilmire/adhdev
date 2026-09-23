/**
 * Worker-mode tools — the minimal surface a delegated worker gets.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §3 (worker toolset), §4 (B).
 *
 * ─── What is NOT here, and why that is the feature ──────────────────────
 *
 * A coordinator's mesh mode publishes 60 tools (66 callable with aliases) and
 * exposes the coordinator system prompt as an MCP resource. Until Phase A a
 * worker inherited all of it — including `mesh_send_task`, `mesh_remove_node`
 * and `mesh_restart_daemon` — because isolation was provider-declared and only
 * 2 of 8 providers declared it.
 *
 * Worker mode publishes the list below and nothing else. In particular it has
 * NO `mesh_enqueue_*`: the "no nested coordinator" rule stops being a written
 * instruction a worker might not follow and becomes a tool that does not exist.
 * And no coordinator prompt resource — a worker has no business reading the
 * orchestration rulebook.
 *
 * ─── Identity ───────────────────────────────────────────────────────────
 *
 * The worker presents a bind (from its MCP config env) and the DAEMON resolves
 * which task that is. Note what is missing from every schema below: a `task_id`
 * parameter. That absence is deliberate (design §4) — a worker that supplies its
 * own task id can supply the wrong one, and the misattribution family this whole
 * feature exists to close is exactly "the wrong task got the completion".
 */

import {
  WORKER_BRANCH_STATES,
  WORKER_REPORT_OUTCOMES,
  WORKER_TOOLS,
  enumOf,
  type WorkerTool,
} from '@adhdev/mesh-shared';

import type { CommandTransport } from '../transports/mode.js';
import { annotateAll, type ToolBehaviorAnnotations } from './tool-annotations.js';
import { GIT_STATUS_TOOL } from './git-status.js';
import { GIT_LOG_TOOL } from './git-log.js';
import { GIT_DIFF_TOOL } from './git-diff.js';

/**
 * Credentials read once at startup from the environment the MCP config supplied.
 *
 * ★A worker CAN read and forge these values — it owns the process. That is
 * acknowledged and accepted (design §3 "남는 리스크"): the token authorizes
 * reporting on the worker's OWN task, which it can already do. What the design
 * rules out is the reverse — an identity a process ASSERTS about itself being
 * trusted. Here the value is meaningless unless the daemon minted it, so a
 * forged one resolves to nothing.
 */
export interface WorkerCredentials {
  bind?: string;
  token?: string;
}

export function readWorkerCredentials(env: NodeJS.ProcessEnv = process.env): WorkerCredentials {
  const bind = typeof env.ADHDEV_WORKER_SESSION_BIND === 'string' ? env.ADHDEV_WORKER_SESSION_BIND.trim() : '';
  const token = typeof env.ADHDEV_WORKER_TASK_TOKEN === 'string' ? env.ADHDEV_WORKER_TASK_TOKEN.trim() : '';
  return { ...(bind ? { bind } : {}), ...(token ? { token } : {}) };
}

export const REPORT_COMPLETION_TOOL = {
  name: 'report_completion',
  description:
    'Report the structured outcome of the task you were dispatched to do. Call this ONCE when your work is '
    + 'finished, blocked, or has failed. Your `summary` is recorded verbatim — it is not scraped from your '
    + 'terminal — so write what the coordinator actually needs to know. You do not pass a task id: the daemon '
    + 'knows which task you hold.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      outcome: enumOf(
        WORKER_REPORT_OUTCOMES,
        "'completed' = the task is done. 'blocked' = you cannot proceed without something external "
          + "(list it in `blockers`). 'failed' = you tried and it did not work.",
      ),
      summary: {
        type: 'string',
        description:
          'What you did and what the result was, in your own words. This is the authoritative record of '
          + 'this task — prefer specifics (files, commands, findings) over restating the assignment.',
      },
      handoff_notes: {
        type: 'object',
        description:
          'Durable notes for whoever touches this code next — including the agent that resolves a merge '
          + 'conflict against your change. These are delivered automatically into related future tasks, so '
          + 'write for a reader who cannot ask you questions.',
        properties: {
          intent: {
            type: 'string',
            description:
              'WHY you made this change — the part a diff cannot show. Required.',
          },
          conflict_guidance: {
            type: 'string',
            description:
              'If someone else changed the same code, how should the conflict be resolved? State which '
              + 'property of your change must survive.',
          },
          touched_files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Files you changed. Required — this is how your note is matched to future work on the same code. '
              + 'On a READ-ONLY task pass an empty array: it is the correct answer, and inventing a placeholder '
              + 'path to satisfy this field corrupts the matching key for everyone else.',
          },
          follow_ups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Work you deliberately did not do, that someone should pick up.',
          },
        },
        required: ['intent', 'touched_files'],
      },
      touched_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files this task changed.',
      },
      branch_state: enumOf(
        WORKER_BRANCH_STATES,
        'Where you left the branch. A task on a non-main branch is not fully complete unless this names '
          + 'the follow-up state.',
      ),
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: "What is blocking you. Expected when outcome is 'blocked'.",
      },
    },
    required: ['outcome', 'summary'],
  },
};

export const PROGRESS_UPDATE_TOOL = {
  name: 'progress_update',
  description:
    'Record a short progress note mid-task. Does not end the task. Use it on long work so the coordinator '
    + 'can see movement without interrupting you. Significant notes are forwarded to the coordinator; minor '
    + 'or closely-spaced ones are recorded but not forwarded, so report MILESTONES — a phase finishing, a '
    + 'blocker found, a long operation starting — rather than narrating each step. The response tells you '
    + 'which happened.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      note: {
        type: 'string',
        description:
          'What you are doing or what you just learned. Write it for a coordinator who cannot see your '
          + 'screen: state the milestone and what it means for the task.',
      },
    },
    required: ['note'],
  },
};

export const PEER_CONTEXT_PULL_TOOL = {
  name: 'peer_context_pull',
  description:
    'Read-only lookup of what sibling tasks in THIS mesh are doing or have left behind — their status and any '
    + 'handoff notes they recorded (design decision D). Does not include transcripts. This is a SUPPLEMENT: '
    + 'relevant handoff notes are already enclosed automatically in your task prompt when it was dispatched — '
    + 'call this when you want more than what was enclosed, e.g. before touching a file another agent might also '
    + 'be working on.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['mesh', 'same_mission'],
        description: "'mesh' (default) — every sibling task in this mesh. 'same_mission' — only tasks sharing your mission.",
      },
      topic: {
        type: 'string',
        description: 'Optional filter: only return peers whose handoff note mentions this substring (case-insensitive).',
      },
    },
  },
};

/**
 * The published worker toolset, each definition carrying its MCP behavior hints
 * (see tool-annotations.ts). `annotateAll` throws for an unclassified tool, so a
 * fourth worker tool cannot be added here without stating what it does.
 */
export const ALL_WORKER_TOOLS = annotateAll([REPORT_COMPLETION_TOOL, PROGRESS_UPDATE_TOOL, PEER_CONTEXT_PULL_TOOL]);

/** Shape of a tool definition as worker mode publishes it. */
export interface WorkerModeTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  annotations: ToolBehaviorAnnotations;
}

/**
 * The three read-only git tools a worker also holds. They are shared consts
 * published by more than one mode, so they are annotated here at the point of
 * publication rather than at their definition.
 */
export const WORKER_GIT_TOOLS: readonly WorkerModeTool[] = annotateAll([GIT_STATUS_TOOL, GIT_LOG_TOOL, GIT_DIFF_TOOL]);

/**
 * Everything worker mode publishes, in `WORKER_TOOLS` order (F1 — the tuple in
 * mesh-shared is the contract; the footer every dispatched task carries and the
 * coordinator prompt's Workers section are rendered from the same tuple).
 *
 * Asserts parity in BOTH directions and throws otherwise, so a schema added
 * here without a `WORKER_TOOLS` entry — or a `WORKER_TOOLS` entry with no
 * schema — is a startup failure rather than a silently under- or
 * over-advertised toolset. `candidates` exists so the parity check itself can
 * be tested with an injected drift.
 */
export function resolveWorkerModeTools(
  candidates: readonly WorkerModeTool[] = [...ALL_WORKER_TOOLS, ...WORKER_GIT_TOOLS],
): WorkerModeTool[] {
  const byName = new Map<string, WorkerModeTool>();
  for (const tool of candidates) {
    if (byName.has(tool.name)) {
      throw new Error(`worker mode: tool '${tool.name}' is defined twice`);
    }
    byName.set(tool.name, tool);
  }
  const contract = new Set<string>(WORKER_TOOLS);
  const missingSchema = WORKER_TOOLS.filter((name: WorkerTool) => !byName.has(name));
  const unlisted = [...byName.keys()].filter((name) => !contract.has(name));
  if (missingSchema.length || unlisted.length) {
    throw new Error(
      'worker mode: tool schemas and WORKER_TOOLS (@adhdev/mesh-shared) disagree — '
        + `missing schema for [${missingSchema.join(', ')}]; schema not in WORKER_TOOLS [${unlisted.join(', ')}]`,
    );
  }
  return WORKER_TOOLS.map((name: WorkerTool) => byName.get(name)!);
}

/**
 * Map the tool's snake_case wire shape onto the daemon's camelCase report.
 *
 * The two vocabularies are deliberate, not an oversight: MCP tool schemas in
 * this repo are snake_case (every existing tool is), while the daemon's internal
 * report type is camelCase like the rest of daemon-core. Translating here — at
 * the one boundary — keeps both conventions intact instead of leaking one into
 * the other.
 */
function toDaemonReport(a: Record<string, any>): Record<string, unknown> {
  const notes = a.handoff_notes;
  return {
    outcome: a.outcome,
    summary: a.summary,
    ...(a.touched_files !== undefined ? { touchedFiles: a.touched_files } : {}),
    ...(a.branch_state !== undefined ? { branchState: a.branch_state } : {}),
    ...(a.blockers !== undefined ? { blockers: a.blockers } : {}),
    ...(notes && typeof notes === 'object' && !Array.isArray(notes)
      ? {
        handoffNotes: {
          ...(notes.intent !== undefined ? { intent: notes.intent } : {}),
          ...(notes.conflict_guidance !== undefined ? { conflictGuidance: notes.conflict_guidance } : {}),
          ...(notes.touched_files !== undefined ? { touchedFiles: notes.touched_files } : {}),
          ...(notes.follow_ups !== undefined ? { followUps: notes.follow_ups } : {}),
        },
      }
      : {}),
  };
}

export interface WorkerToolResult {
  text: string;
  isError?: boolean;
}

export async function reportCompletion(
  transport: CommandTransport,
  credentials: WorkerCredentials,
  args: Record<string, any>,
): Promise<WorkerToolResult> {
  const result: any = await transport.command('worker_report_completion', {
    ...credentials,
    report: toDaemonReport(args),
  });

  if (result?.success === true) {
    const lines = [
      result.duplicate
        ? `Completion already recorded for task ${result.taskId} — this repeat was accepted as a duplicate.`
        : `Completion recorded for task ${result.taskId} (${result.outcome}).`,
    ];
    if (result.ownedPathsMismatch) {
      const { undeclaredTouched } = result.ownedPathsMismatch;
      lines.push(
        `Note: this task declared owned_paths, and touched_files included ${undeclaredTouched.length} `
        + `file(s) outside that declaration (${undeclaredTouched.slice(0, 5).join(', ')}${undeclaredTouched.length > 5 ? ', …' : ''}). `
        + 'This is informational — your completion was still recorded.',
      );
    }
    if (result.handoffNoteRecorded) {
      lines.push('Handoff note stored — it will be delivered to related future tasks automatically.');
    } else if (result.handoffNoteError) {
      // ★F5: never claim a note was stored when it was not. This line used to be
      // unreachable — the daemon returned handoffNoteRecorded:true even after
      // skipping the write entirely, so a worker was told its note was filed and
      // would be delivered when nothing had been persisted.
      lines.push(
        `WARNING: your handoff note was NOT stored (${result.handoffNoteError}). `
        + 'The completion itself was recorded. Put anything the next agent must know into your '
        + 'final message instead — it will not be delivered automatically.',
      );
    }
    return { text: lines.join('\n') };
  }

  // Field-level validation failures come back structured so the worker can fix
  // precisely what is wrong and re-call, rather than guessing from prose.
  if (result?.error === 'invalid_report' && Array.isArray(result.validationErrors)) {
    const details = result.validationErrors
      .map((e: any) => `  - ${e.field || '(root)'}: ${e.message}`)
      .join('\n');
    return {
      text: `report_completion rejected — fix these and call again:\n${details}`,
      isError: true,
    };
  }

  const reason = result?.error || 'unknown_error';
  const hint = result?.hint ? `\n${result.hint}` : '';
  const detail = result?.detail ? `\nDetail: ${result.detail}` : '';
  return { text: `report_completion refused (${reason}).${hint}${detail}`, isError: true };
}

export async function progressUpdate(
  transport: CommandTransport,
  credentials: WorkerCredentials,
  args: Record<string, any>,
): Promise<WorkerToolResult> {
  const note = typeof args?.note === 'string' ? args.note.trim() : '';
  if (!note) return { text: 'progress_update requires a non-empty `note`.', isError: true };

  const result: any = await transport.command('worker_progress_update', { ...credentials, note });
  if (result?.success === true) {
    // ★F3: say whether this note actually reached the coordinator. The channel
    // is deliberately filtered (milestones, not a log tail), so "recorded but
    // not surfaced" is the ordinary outcome for a small or closely-spaced note
    // — and a worker that is told plainly will not repeat it hoping for a reply.
    return {
      text: result.surfacedToCoordinator
        ? `Progress noted for task ${result.taskId ?? '(unknown)'} and surfaced to the coordinator.`
        : `Progress noted for task ${result.taskId ?? '(unknown)'} (recorded; not surfaced to the coordinator — `
          + 'it was too close to your previous update or too brief to be a milestone).',
    };
  }
  const detail = result?.detail ? `\nDetail: ${result.detail}` : '';
  return {
    text: `progress_update refused (${result?.error || 'unknown_error'}).${detail}`,
    isError: true,
  };
}

export async function peerContextPull(
  transport: CommandTransport,
  credentials: WorkerCredentials,
  args: Record<string, any>,
): Promise<WorkerToolResult> {
  const scope = args?.scope === 'same_mission' ? 'same_mission' : undefined;
  const topic = typeof args?.topic === 'string' && args.topic.trim() ? args.topic.trim() : undefined;
  const result: any = await transport.command('worker_peer_context_pull', {
    ...credentials,
    ...(scope ? { scope } : {}),
    ...(topic ? { topic } : {}),
  });

  if (result?.success !== true) {
    const reason = result?.error || 'unknown_error';
    const hint = result?.hint ? `\n${result.hint}` : '';
    return { text: `peer_context_pull refused (${reason}).${hint}`, isError: true };
  }

  const peers = Array.isArray(result.peers) ? result.peers : [];
  if (!peers.length) {
    return { text: 'No sibling task context found for this mesh (in this scope).' };
  }
  const lines = peers.map((p: any) => JSON.stringify(p));
  const omitted = typeof result.omitted === 'number' && result.omitted > 0
    ? `\n(${result.omitted} further peer(s) omitted to fit the response — the most recently updated are shown.)`
    : '';
  return { text: `${peers.length} sibling task(s) in scope '${result.scope}':\n${lines.join('\n')}${omitted}` };
}

/**
 * E-T0 (mailbox piggyback): drain any pending urgent memo for the caller's
 * current task and render it as the block a worker tool response appends.
 * Never throws — a mailbox check must not be the reason an otherwise-successful
 * tool call fails to return.
 */
export async function drainMailbox(
  transport: CommandTransport,
  credentials: WorkerCredentials,
): Promise<string | null> {
  try {
    const result: any = await transport.command('worker_drain_mailbox', { ...credentials });
    if (result?.success !== true) return null;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    if (!messages.length) return null;
    const heading = messages.length > 1 ? 'Urgent messages from the coordinator' : 'Urgent message from the coordinator';
    const lines = messages.map((m: any, i: number) => `${i + 1}. ${typeof m?.text === 'string' ? m.text : ''}`);
    return `\n\n---\n\n## ${heading}\n\n${lines.join('\n')}\n`;
  } catch {
    return null;
  }
}
