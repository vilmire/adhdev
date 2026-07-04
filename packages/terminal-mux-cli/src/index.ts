#!/usr/bin/env node
import { buildWorkspaceName, TerminalMuxStorage } from '@adhdev/terminal-mux-control/storage';
import {
  parseCommandFlags,
  parseOpenArgs,
  parsePaneTargetArgs,
  parseSessionTargetArgs,
} from './arg-parsing.js';
import { usage } from './cli-usage.js';
import {
  capturePane,
  controlWorkspace,
  copyPane,
  listPanes,
  listRuntimes,
  listSessions,
  listWindows,
  listWorkspaces,
  printLastWorkspace,
  printSocketInfo,
  printWorkspaceState,
  printWorkspaceTree,
  searchPane,
  snapshotRuntime,
  streamWorkspaceEvents,
} from './commands-read.js';
import {
  deleteWorkspace,
  hasSession,
  killSession,
  killWindow,
  newWindow,
  renameSession,
  renameWindow,
  renameWorkspace,
  selectWindow,
} from './commands-session.js';
import {
  killPane,
  replacePane,
  resizePane,
  selectLayout,
  selectPane,
  sendKeys,
  splitWindow,
  swapPane,
  zoomPane,
} from './commands-pane.js';
import { openWorkspace } from './interactive-workspace.js';

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') usage(0);
  const { flags, rest } = parseCommandFlags(args);

  if (command === 'list' || command === 'list-runtimes') {
    await listRuntimes(flags);
    return;
  }
  if (command === 'sessions' || command === 'list-sessions') {
    await listSessions(flags);
    return;
  }
  if (command === 'workspaces' || command === 'ls' || command === 'list-workspaces') {
    await listWorkspaces(flags);
    return;
  }
  if (command === 'windows' || command === 'list-windows') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await listWindows(workspaceName, flags);
    return;
  }
  if (command === 'tree') {
    await printWorkspaceTree(flags);
    return;
  }
  if (command === 'state') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await printWorkspaceState(workspaceName, flags);
    return;
  }
  if (command === 'socket-info') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await printSocketInfo(workspaceName, flags);
    return;
  }
  if (command === 'events') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await streamWorkspaceEvents(workspaceName, flags);
    return;
  }
  if (command === 'control') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await controlWorkspace(workspaceName, remainingArgs[0], remainingArgs[1], flags);
    return;
  }
  if (command === 'last-session') {
    await printLastWorkspace(flags);
    return;
  }
  if (command === 'rename-workspace') {
    if (!rest[0] || !rest[1]) usage();
    await renameWorkspace(rest[0], rest[1]);
    return;
  }
  if (command === 'delete-workspace') {
    if (!rest[0]) usage();
    await deleteWorkspace(rest[0]);
    return;
  }
  if (command === 'new-session') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    await openWorkspace({
      workspaceName: buildWorkspaceName(workspaceName, workspaceName),
      runtimeTargets: remainingArgs,
      readOnly: false,
      takeover: false,
    });
    return;
  }
  if (command === 'attach-session') {
    const storage = new TerminalMuxStorage();
    const sessionTarget = rest.length > 0 ? parseSessionTargetArgs(rest).workspaceName : storage.getLastWorkspace();
    if (!sessionTarget) {
      throw new Error('No workspace specified and no last session recorded');
    }
    const workspaceTarget = storage.resolveSessionWindowWorkspace(sessionTarget) || sessionTarget;
    await openWorkspace({
      workspaceName: workspaceTarget,
      runtimeTargets: [],
      readOnly: false,
      takeover: false,
    });
    return;
  }
  if (command === 'kill-session') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await killSession(workspaceName);
    return;
  }
  if (command === 'rename-session') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await renameSession(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'has-session') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    process.exit((await hasSession(workspaceName)) ? 0 : 1);
  }
  if (command === 'new-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    let windowName;
    const runtimeTargets = [];
    for (let i = 0; i < remainingArgs.length; i += 1) {
      const arg = remainingArgs[i];
      if (arg === '-n' && remainingArgs[i + 1]) {
        windowName = remainingArgs[i + 1];
        i += 1;
        continue;
      }
      runtimeTargets.push(arg);
    }
    await newWindow(workspaceName, windowName, runtimeTargets);
    return;
  }
  if (command === 'select-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await selectWindow(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'rename-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0] || !remainingArgs[1]) usage();
    await renameWindow(workspaceName, remainingArgs[0], remainingArgs[1]);
    return;
  }
  if (command === 'kill-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await killWindow(workspaceName, remainingArgs[0]);
    return;
  }
  if (command === 'list-panes') {
    const { workspaceName } = parseSessionTargetArgs(rest);
    await listPanes(workspaceName, flags);
    return;
  }
  if (command === 'capture-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    await capturePane(workspaceName, paneTarget, flags);
    return;
  }
  if (command === 'copy-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    let clipboard = false;
    let output: string | undefined;
    for (let i = 0; i < remainingArgs.length; i += 1) {
      const arg = remainingArgs[i];
      if (arg === '--clipboard') {
        clipboard = true;
        continue;
      }
      if (arg === '--output' && remainingArgs[i + 1]) {
        output = remainingArgs[i + 1];
        i += 1;
      }
    }
    await copyPane(workspaceName, paneTarget, { json: flags.json, clipboard, output });
    return;
  }
  if (command === 'search-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await searchPane(workspaceName, paneTarget, remainingArgs.join(' '), flags);
    return;
  }
  if (command === 'select-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    if (!paneTarget) usage();
    await selectPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'replace-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await replacePane(workspaceName, paneTarget, remainingArgs[0]);
    return;
  }
  if (command === 'kill-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    if (!paneTarget) usage();
    await killPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'split-window') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    await splitWindow(workspaceName, remainingArgs);
    return;
  }
  if (command === 'resize-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    await resizePane(workspaceName, paneTarget, remainingArgs);
    return;
  }
  if (command === 'select-layout') {
    const { workspaceName, remainingArgs } = parseSessionTargetArgs(rest);
    if (!remainingArgs[0]) usage();
    await selectLayout(workspaceName, remainingArgs[0]!);
    return;
  }
  if (command === 'swap-pane') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (!paneTarget || !remainingArgs[0]) usage();
    await swapPane(workspaceName, paneTarget, remainingArgs[0]!);
    return;
  }
  if (command === 'zoom-pane') {
    const { workspaceName, paneTarget } = parsePaneTargetArgs(rest);
    await zoomPane(workspaceName, paneTarget);
    return;
  }
  if (command === 'send-keys') {
    const { workspaceName, paneTarget, remainingArgs } = parsePaneTargetArgs(rest);
    if (remainingArgs.length === 0) usage();
    await sendKeys(workspaceName, paneTarget, remainingArgs);
    return;
  }
  if (command === 'snapshot') {
    if (!rest[0]) usage();
    await snapshotRuntime(rest[0]);
    return;
  }
  if (command === 'open') {
    await openWorkspace(parseOpenArgs(rest));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error('[adhmux]', error?.message || error);
  process.exit(1);
});
