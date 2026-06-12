import type { CommandTransport } from '../transports/mode.js';

export const GIT_PUSH_TOOL = {
  name: 'git_push',
  description:
    'Push a branch to a remote repository on the daemon machine. ' +
    'If the branch has no upstream configured, sets it automatically. ' +
    'Key for parallel multi-machine workflows: after git_checkpoint, push each machine\'s ' +
    'branch to origin so changes are available for PR/review.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace: {
        type: 'string',
        description: 'Absolute path to the workspace/repository directory.',
      },
      remote: {
        type: 'string',
        description: 'Remote name (default: "origin").',
      },
      branch: {
        type: 'string',
        description: 'Branch to push (default: current branch).',
      },
    },
    required: ['workspace'],
  },
};

export async function gitPush(
  transport: CommandTransport,
  args: {
    workspace: string;
    remote?: string;
    branch?: string;
  },
): Promise<string> {
  let raw: any = await transport.command('git_push', {
    workspace: args.workspace,
    remote: args.remote ?? 'origin',
    ...(args.branch ? { branch: args.branch } : {}),
  });
  raw = raw?.push ?? raw;

  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? 'unknown';
    return `Git push error: ${msg}`;
  }

  const branch = raw?.branch ?? args.branch ?? '(current)';
  const remote = raw?.remote ?? args.remote ?? 'origin';
  const newBranch = raw?.newBranch ? ' [new branch]' : '';
  const output = raw?.output ? `\n${raw.output}` : '';

  return `Pushed ${branch} → ${remote}${newBranch}${output}`;
}
