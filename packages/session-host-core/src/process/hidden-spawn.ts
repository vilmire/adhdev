import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';

/** Shared hidden-window primitive for daemon and session-host process helpers. */
export function hiddenSpawn(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args as string[], { windowsHide: true, ...options });
}
