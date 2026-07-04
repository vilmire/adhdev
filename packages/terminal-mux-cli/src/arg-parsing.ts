import type {
  CommandFlags,
  LayoutPreset,
  OpenCommandOptions,
  PaneCommandTarget,
  SessionCommandTarget,
} from './types.js';

export function normalizeLayoutPreset(layoutName: string): LayoutPreset | 'balanced' {
  switch (layoutName) {
    case 'even':
    case 'even-horizontal':
    case 'even-vertical':
      return 'even';
    case 'balanced':
      return 'balanced';
    case 'tiled':
      return 'tiled';
    case 'main-vertical':
    case 'main-v':
      return 'main-vertical';
    case 'main-horizontal':
    case 'main-h':
      return 'main-horizontal';
    default:
      throw new Error(`Unsupported layout: ${layoutName}`);
  }
}

export function parseCommandFlags(args: string[]): { flags: CommandFlags; rest: string[] } {
  const rest: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    rest.push(arg);
  }
  return { flags: { json }, rest };
}

export function parseOpenArgs(args: string[]): OpenCommandOptions {
  const runtimeTargets: string[] = [];
  let workspaceName: string | undefined;
  let readOnly = false;
  let takeover = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--workspace' || arg === '-w') {
      workspaceName = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--read-only') {
      readOnly = true;
      continue;
    }
    if (arg === '--takeover') {
      takeover = true;
      continue;
    }
    runtimeTargets.push(arg);
  }

  return { runtimeTargets, workspaceName, readOnly, takeover };
}

export function parseSessionTargetArgs(args: string[]): SessionCommandTarget {
  let workspaceName = '';
  const remainingArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '-t' || arg === '-s') {
      workspaceName = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (!workspaceName) {
      workspaceName = arg;
      continue;
    }
    remainingArgs.push(arg);
  }
  if (!workspaceName) {
    throw new Error('Workspace name is required');
  }
  return { workspaceName, remainingArgs };
}

export function parsePaneTargetArgs(args: string[]): PaneCommandTarget {
  const session = parseSessionTargetArgs(args);
  let paneTarget: string | undefined;
  const remainingArgs: string[] = [];
  for (let i = 0; i < session.remainingArgs.length; i += 1) {
    const arg = session.remainingArgs[i];
    if (!arg) continue;
    if (arg === '-p') {
      paneTarget = session.remainingArgs[i + 1];
      i += 1;
      continue;
    }
    remainingArgs.push(arg);
  }
  return {
    workspaceName: session.workspaceName,
    paneTarget,
    remainingArgs,
  };
}
