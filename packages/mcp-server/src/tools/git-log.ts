import type { CommandTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const GIT_LOG_TOOL = {
  name: 'git_log',
  description:
    'Get commit history for a workspace. Shows hash, message, author, and date for recent commits. ' +
    'Use this to track what changes an agent has made, verify checkpoint commits, or understand project history.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace: {
        type: 'string',
        description: 'Absolute path to the workspace/repository directory.',
      },
      limit: {
        type: 'number',
        description: 'Max commits to return (default: 20, max: 100).',
      },
      file: {
        type: 'string',
        description: 'Filter history to commits that touched this repo-relative file path (optional).',
      },
      since: {
        type: 'string',
        description: 'Only commits after this date (ISO 8601 or git date string, optional).',
      },
      until: {
        type: 'string',
        description: 'Only commits before this date (ISO 8601 or git date string, optional).',
      },
      ...FORMAT_PROP,
    },
    required: ['workspace'],
  },
};

export async function gitLog(
  transport: CommandTransport,
  args: {
    workspace: string;
    limit?: number;
    file?: string;
    since?: string;
    until?: string;
    format?: 'text' | 'json';
  },
): Promise<string> {
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));

  let raw: any = await transport.command('git_log', {
    workspace: args.workspace,
    limit,
    ...(args.file ? { path: args.file } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.until ? { until: args.until } : {}),
  });
  raw = raw?.log ?? raw;

  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? 'unknown';
    if (args.format === 'json') return JSON.stringify({ error: msg }, null, 2);
    return `Git log error: ${msg}`;
  }

  if (!raw?.isGitRepo) {
    const msg = `Not a git repository: ${args.workspace}`;
    if (args.format === 'json') return JSON.stringify({ error: msg }, null, 2);
    return msg;
  }

  const entries: any[] = raw?.entries ?? [];

  if (args.format === 'json') {
    return JSON.stringify({
      workspace: raw.workspace,
      branch: raw.branch ?? null,
      entries: entries.map((e) => ({
        commit: e.commit,
        short: e.commit?.slice(0, 7),
        message: e.message,
        author: e.authorName ?? null,
        author_email: e.authorEmail ?? null,
        authored_at: e.authoredAt ? new Date(e.authoredAt).toISOString() : null,
      })),
      total: entries.length,
      truncated: raw.truncated ?? false,
    }, null, 2);
  }

  if (entries.length === 0) return 'No commits found.';

  const lines = entries.map((e) => {
    const hash = e.commit?.slice(0, 7) ?? '???????';
    const date = e.authoredAt ? new Date(e.authoredAt).toISOString().slice(0, 10) : '';
    const author = e.authorName ? ` (${e.authorName})` : '';
    return `${hash} ${date}${author} ${e.message}`;
  });

  const header = `Commits (${entries.length}${raw.truncated ? ', truncated' : ''}):`;
  return `${header}\n${lines.join('\n')}`;
}
