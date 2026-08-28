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

import type { CommandTransport } from '../transports/mode.js';

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

const BRANCH_STATES = [
  'merged_to_main',
  'pushed_feature_branch_needs_merge',
  'blocked_review',
  'cleanup_candidate',
  'not_mergeable',
];

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
      outcome: {
        type: 'string',
        enum: ['completed', 'blocked', 'failed'],
        description:
          "'completed' = the task is done. 'blocked' = you cannot proceed without something external "
          + "(list it in `blockers`). 'failed' = you tried and it did not work.",
      },
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
              'Files you changed. Required — this is how your note is matched to future work on the same code.',
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
      branch_state: {
        type: 'string',
        enum: BRANCH_STATES,
        description:
          'Where you left the branch. A task on a non-main branch is not fully complete unless this names '
          + 'the follow-up state.',
      },
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
    + 'can see movement without interrupting you.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      note: { type: 'string', description: 'What you are doing or what you just learned.' },
    },
    required: ['note'],
  },
};

export const ALL_WORKER_TOOLS = [REPORT_COMPLETION_TOOL, PROGRESS_UPDATE_TOOL];

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
    if (result.handoffNoteRecorded) {
      lines.push('Handoff note stored — it will be delivered to related future tasks automatically.');
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
    return { text: `Progress noted for task ${result.taskId ?? '(unknown)'}.` };
  }
  return {
    text: `progress_update refused (${result?.error || 'unknown_error'}).`,
    isError: true,
  };
}
