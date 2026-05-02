import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const GIT_STATUS_TOOL = {
  name: 'git_status',
  description: 'Get git repository status for a workspace on the daemon machine.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace: {
        type: 'string',
        description: 'Absolute path to the workspace/repository directory.',
      },
      include_diff: {
        type: 'boolean',
        description: 'Include changed file list (default: true).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only).',
      },
    },
    required: ['workspace'],
  },
};

export async function gitStatus(
  transport: LocalTransport | CloudTransport,
  args: { workspace: string; include_diff?: boolean; daemon_id?: string },
): Promise<string> {
  let status: any;
  let diffSummary: any;

  if ('command' in transport) {
    // LocalTransport
    const statusResult = await (transport as LocalTransport).command('git_status', {
      workspace: args.workspace,
    });
    status = statusResult?.status ?? statusResult;

    if (args.include_diff !== false) {
      const diffResult = await (transport as LocalTransport).command('git_diff_summary', {
        workspace: args.workspace,
      });
      diffSummary = diffResult?.diffSummary ?? diffResult;
    }
  } else {
    // CloudTransport
    if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
    const result = await (transport as CloudTransport).gitStatus(
      args.daemon_id,
      args.workspace,
      args.include_diff !== false,
    );
    if (result?.error) return `Error: ${result.error}`;
    status = result?.status;
    diffSummary = result?.diff;
  }

  if (status?.success === false || status?.reason) {
    return `Git error: ${status?.error ?? status?.reason ?? 'unknown'}`;
  }
  if (!status?.isGitRepo) return `Not a git repository: ${args.workspace}`;

  const lines: string[] = [];
  if (status.branch) lines.push(`Branch: ${status.branch}`);
  if (status.headCommit) {
    lines.push(`HEAD: ${status.headCommit.slice(0, 7)}${status.headMessage ? ` — ${status.headMessage.slice(0, 80)}` : ''}`);
  }
  if (status.ahead > 0) lines.push(`Ahead: ${status.ahead}`);
  if (status.behind > 0) lines.push(`Behind: ${status.behind}`);
  if (status.staged > 0) lines.push(`Staged: ${status.staged}`);
  if (status.modified > 0) lines.push(`Modified: ${status.modified}`);
  if (status.untracked > 0) lines.push(`Untracked: ${status.untracked}`);
  if (status.deleted > 0) lines.push(`Deleted: ${status.deleted}`);
  if (status.stashCount > 0) lines.push(`Stashes: ${status.stashCount}`);
  if (status.hasConflicts) lines.push('Conflicts: YES');
  if (!status.dirty) lines.push('Working tree: clean');

  if (diffSummary?.files?.length > 0) {
    lines.push('');
    lines.push(`Changed files (${diffSummary.files.length}):`);
    for (const f of diffSummary.files.slice(0, 20)) {
      lines.push(`  ${f.status ?? 'M'} ${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ''}${f.insertions || f.deletions ? ` +${f.insertions ?? 0}/-${f.deletions ?? 0}` : ''}`);
    }
    if (diffSummary.files.length > 20) lines.push(`  … and ${diffSummary.files.length - 20} more`);
    if (diffSummary.totalInsertions || diffSummary.totalDeletions) {
      lines.push(`Total: +${diffSummary.totalInsertions ?? 0}/-${diffSummary.totalDeletions ?? 0}`);
    }
  }

  return lines.join('\n');
}
