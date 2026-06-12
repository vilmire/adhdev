import type { CommandTransport } from '../transports/mode.js';
import { FORMAT_PROP } from './list-sessions.js';

export const GIT_DIFF_TOOL = {
  name: 'git_diff',
  description:
    'Get the actual diff content for changed files in a workspace. ' +
    'Without a specific file, returns diffs for up to 5 changed files. ' +
    'Use this to review what an agent actually changed — file names alone (from git_status) are not enough for code review.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace: {
        type: 'string',
        description: 'Absolute path to the workspace/repository directory.',
      },
      file: {
        type: 'string',
        description: 'Specific repo-relative file path to diff (optional — if omitted, returns top 5 changed files).',
      },
      max_lines: {
        type: 'number',
        description: 'Max diff lines per file before truncating (default: 300).',
      },
      staged: {
        type: 'boolean',
        description: 'Show staged changes instead of unstaged (default: false).',
      },
      ...FORMAT_PROP,
    },
    required: ['workspace'],
  },
};

interface FileDiffResult {
  path: string;
  old_path?: string | null;
  status?: string;
  diff: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

export async function gitDiff(
  transport: CommandTransport,
  args: {
    workspace: string;
    file?: string;
    max_lines?: number;
    staged?: boolean;
    format?: 'text' | 'json';
  },
): Promise<string> {
  const maxLines = Math.max(10, Math.min(2000, args.max_lines ?? 300));
  const staged = args.staged ?? false;

  return localGitDiff(transport, args.workspace, args.file, maxLines, staged, args.format);
}

async function localGitDiff(
  transport: CommandTransport,
  workspace: string,
  file: string | undefined,
  maxLines: number,
  staged: boolean,
  format: 'text' | 'json' | undefined,
): Promise<string> {
  if (file) {
    const raw = await transport.command('git_diff_file', { workspace, path: file, staged });
    const d = raw?.diff ?? raw;

    if (d?.success === false || d?.reason) {
      const msg = d?.error ?? d?.reason ?? 'unknown';
      if (format === 'json') return JSON.stringify({ error: msg }, null, 2);
      return `Git diff error: ${msg}`;
    }

    const lines = (d?.diff ?? '').split('\n');
    const truncated = lines.length > maxLines;
    const result = {
      files: [{
        path: file,
        diff: truncated ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)' : (d?.diff ?? ''),
        truncated,
        binary: d?.binary ?? false,
      }],
      total_files: 1,
      shown_files: 1,
      truncated,
    };
    return formatDiffResult(result, format);
  }

  // No specific file: get summary then fetch top 5
  const summaryRaw = await transport.command('git_diff_summary', { workspace, staged });
  const summary = summaryRaw?.diffSummary ?? summaryRaw;

  if (summary?.success === false || summary?.reason) {
    const msg = summary?.error ?? summary?.reason ?? 'unknown';
    if (format === 'json') return JSON.stringify({ error: msg }, null, 2);
    return `Git diff error: ${msg}`;
  }

  if (!summary?.isGitRepo) {
    const msg = `Not a git repository: ${workspace}`;
    if (format === 'json') return JSON.stringify({ error: msg }, null, 2);
    return msg;
  }

  const files: any[] = summary?.files ?? [];
  if (files.length === 0) {
    if (format === 'json') return JSON.stringify({ files: [], total_files: 0, shown_files: 0, truncated: false }, null, 2);
    return 'No changed files.';
  }

  const topFiles = files.slice(0, 5);
  const fileDiffs: FileDiffResult[] = await Promise.all(
    topFiles.map(async (f: any): Promise<FileDiffResult> => {
      try {
        const raw = await transport.command('git_diff_file', { workspace, path: f.path, staged });
        const d = raw?.diff ?? raw;
        const lines = (d?.diff ?? '').split('\n');
        const trunc = lines.length > maxLines;
        return {
          path: f.path,
          old_path: f.oldPath ?? null,
          status: f.status ?? 'M',
          diff: trunc ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)' : (d?.diff ?? ''),
          truncated: trunc,
          binary: d?.binary ?? false,
        };
      } catch {
        return { path: f.path, diff: '', truncated: false, binary: false, error: 'fetch failed' };
      }
    }),
  );

  return formatDiffResult({
    files: fileDiffs,
    total_files: files.length,
    shown_files: topFiles.length,
    truncated: files.length > 5,
  }, format);
}

function formatDiffResult(result: any, format: 'text' | 'json' | undefined): string {
  if (format === 'json') return JSON.stringify(result, null, 2);

  const files: FileDiffResult[] = result?.files ?? [];
  if (files.length === 0) return 'No changed files.';

  const parts: string[] = [];
  const totalShown = result?.shown_files ?? files.length;
  const totalAll = result?.total_files ?? files.length;
  if (totalAll > totalShown) {
    parts.push(`Showing ${totalShown} of ${totalAll} changed files:\n`);
  }

  for (const f of files) {
    const header = `--- ${f.path}${f.old_path ? ` (was ${f.old_path})` : ''} ---`;
    if (f.error) {
      parts.push(`${header}\n(error: ${f.error})\n`);
    } else if (f.binary) {
      parts.push(`${header}\n(binary file)\n`);
    } else if (!f.diff) {
      parts.push(`${header}\n(no diff)\n`);
    } else {
      parts.push(`${header}\n${f.diff}${f.truncated ? '' : '\n'}`);
    }
  }

  return parts.join('\n');
}
