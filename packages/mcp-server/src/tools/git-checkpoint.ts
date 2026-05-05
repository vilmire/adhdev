import type { McpTransport } from '../transports/mode.js';
import { isLocalTransport } from '../transports/mode.js';

export const GIT_CHECKPOINT_TOOL = {
  name: 'git_checkpoint',
  description:
    'Create a checkpoint commit in a workspace. ' +
    'Stages all tracked changes (or all files including untracked) and commits with a prefixed message. ' +
    'Use this to save progress before a risky operation, or to create a restore point the orchestrator can reference.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace: {
        type: 'string',
        description: 'Absolute path to the workspace/repository directory.',
      },
      message: {
        type: 'string',
        description: 'Checkpoint message (max 200 chars). Will be prefixed with "adhdev: checkpoint ".',
      },
      include_untracked: {
        type: 'boolean',
        description: 'Also stage and commit untracked files (default: false).',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only, required).',
      },
    },
    required: ['workspace', 'message'],
  },
};

export async function gitCheckpoint(
  transport: McpTransport,
  args: {
    workspace: string;
    message: string;
    include_untracked?: boolean;
    daemon_id?: string;
  },
): Promise<string> {
  const message = args.message?.trim();
  if (!message) return 'Error: message is required';
  if (message.length > 200) return 'Error: message must be 200 characters or fewer';

  let raw: any;
  if (isLocalTransport(transport)) {
    raw = await transport.command('git_checkpoint', {
      workspace: args.workspace,
      message,
      includeUntracked: args.include_untracked ?? false,
    });
    raw = raw?.checkpoint ?? raw;
  } else {
    if (!args.daemon_id) throw new Error('daemon_id is required in cloud mode');
    const result = await transport.gitCheckpoint(args.daemon_id, {
      workspace: args.workspace,
      message,
      includeUntracked: args.include_untracked ?? false,
    });
    raw = result?.checkpoint ?? result;
  }

  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? 'unknown';
    if (msg.includes('Nothing to commit') || msg.includes('nothing to commit')) {
      return 'Nothing to commit — working tree is clean.';
    }
    return `Git checkpoint error: ${msg}`;
  }

  const commit = raw?.commit?.slice(0, 7) ?? '???????';
  const fullMsg = raw?.message ?? `adhdev: checkpoint ${message}`;
  return `Checkpoint created: ${commit} — ${fullMsg}`;
}
