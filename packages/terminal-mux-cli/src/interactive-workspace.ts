import { type SessionHostRecord } from '@adhdev/session-host-core';
import { createAdhMuxControlServer } from '@adhdev/terminal-mux-control/control-socket';
import { TerminalMuxStorage } from '@adhdev/terminal-mux-control/storage';
import {
  SessionHostMuxClient,
  type MuxAxis,
  type MuxControllerEvent,
  type MuxWorkspaceState,
} from '@adhdev/terminal-mux-core';
import { copyTextToClipboard } from './clipboard.js';
import { computePaneRects, renderWorkspace } from './render.js';
import { searchPaneText, type PaneSearchMatch } from './search.js';
import { SESSION_HOST_APP_NAME } from './constants.js';
import { normalizeLayoutPreset } from './arg-parsing.js';
import { resolvePaneTarget } from './workspace-context.js';
import { usage } from './cli-usage.js';
import type {
  ChooserAction,
  OpenCommandOptions,
  PaneActivityState,
  PromptMode,
  UiMode,
} from './types.js';

function clearScreen(): void {
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
}

function restoreScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

function cycleFocus(workspace: MuxWorkspaceState): string {
  const paneIds = Object.keys(workspace.panes);
  if (paneIds.length <= 1) return workspace.focusedPaneId;
  const current = paneIds.indexOf(workspace.focusedPaneId);
  const next = current >= 0 ? (current + 1) % paneIds.length : 0;
  return paneIds[next] || workspace.focusedPaneId;
}

function buildChooserStatus(runtimes: SessionHostRecord[]): string {
  if (runtimes.length === 0) return '[adhmux] no running runtimes available';
  return runtimes
    .slice(0, 9)
    .map((runtime, index) => `${index + 1}:${runtime.runtimeKey}(${runtime.lifecycle})`)
    .join('  ');
}

function buildPaneIndicators(activityByPaneId: Map<string, PaneActivityState>): Record<string, string> {
  return Object.fromEntries(
    Array.from(activityByPaneId.entries()).map(([paneId, activity]) => {
      if (activity.kind === 'output') {
        return [paneId, `•${activity.count}`];
      }
      if (activity.kind === 'done') {
        return [paneId, '✓'];
      }
      return [paneId, '!'];
    }),
  );
}

export async function openWorkspace(options: OpenCommandOptions): Promise<void> {
  const storage = new TerminalMuxStorage();
  const mux = new SessionHostMuxClient({ appName: SESSION_HOST_APP_NAME });
  await mux.connect();

  const savedWorkspace = options.workspaceName ? storage.loadWorkspace(options.workspaceName) : null;
  let workspace: MuxWorkspaceState;
  if (savedWorkspace && options.runtimeTargets.length === 0) {
    workspace = await mux.restoreWorkspace(savedWorkspace);
  } else {
    if (options.runtimeTargets.length === 0) usage();
    workspace = await mux.createWorkspace(options.runtimeTargets[0]!, {
      readOnly: options.readOnly,
      takeover: options.takeover,
      title: options.workspaceName || options.runtimeTargets.join(' + '),
    });
    for (let i = 1; i < options.runtimeTargets.length; i += 1) {
      workspace = await mux.splitWorkspacePane(
        workspace.workspaceId,
        workspace.focusedPaneId,
        options.runtimeTargets[i]!,
        {
          axis: i % 2 === 1 ? 'vertical' : 'horizontal',
          readOnly: options.readOnly,
          takeover: options.takeover,
        },
      );
    }
  }

  if (options.workspaceName) {
    storage.saveWorkspace(options.workspaceName, mux.serializeWorkspace(workspace.workspaceId));
    storage.setLastWorkspace(options.workspaceName);
  }

  let statusLine = options.workspaceName
    ? `workspace=${options.workspaceName}`
    : 'temporary workspace';
  let mode: UiMode = 'normal';
  let promptAxis: MuxAxis | null = null;
  let promptAction: ChooserAction = 'split';
  let promptMode: PromptMode = 'runtime';
  let promptBuffer = '';
  let chooserAxis: MuxAxis | null = null;
  let chooserAction: ChooserAction = 'split';
  let chooserRuntimes: SessionHostRecord[] = [];
  let shouldExit = false;
  let syncRunning = false;
  let syncQueued = false;
  let controlServer: ReturnType<typeof createAdhMuxControlServer> | null = null;
  const paneActivityById = new Map<string, PaneActivityState>();
  const paneSearchById = new Map<string, { query: string; matches: PaneSearchMatch[] }>();
  const paneScrollOffsetById = new Map<string, number>();
  const paneSearchIndexById = new Map<string, number>();

  const clearPaneActivity = (paneId: string) => {
    paneActivityById.delete(paneId);
  };

  const getSplitCandidates = async (): Promise<SessionHostRecord[]> => {
    const runtimes = (await mux.listRuntimes()).filter((runtime) => runtime.lifecycle === 'running');
    const openRuntimeKeys = new Set(Object.values(workspace.panes).map((pane) => pane.runtimeKey));
    const unseen = runtimes.filter((runtime) => !openRuntimeKeys.has(runtime.runtimeKey));
    return unseen.length > 0 ? unseen : runtimes;
  };

  const enterChooser = async (axis: MuxAxis, action: ChooserAction = 'split') => {
    chooserAxis = axis;
    chooserAction = action;
    chooserRuntimes = await getSplitCandidates();
    mode = 'chooser';
    statusLine = buildChooserStatus(chooserRuntimes);
    render();
  };

  const footerLine = () => {
    if (mode === 'prefix') {
      return '^B [% vertical] [" horizontal] [c replace] [[] copy-mode] [/ search] [y copy] [z zoom] [HJKL resize] [= rebalance] [n next] [t takeover] [r release] [x close] [s save] [d detach]';
    }
    if (mode === 'chooser') {
      return `${chooserAction} ${chooserAxis} choose [1-9]  [/] manual key  [esc] cancel`;
    }
    if (mode === 'prompt') {
      if (promptMode === 'search') {
        return `search query> ${promptBuffer}`;
      }
      return `${promptAction} ${promptAxis} runtime> ${promptBuffer}`;
    }
    if (mode === 'copy') {
      return 'copy-mode  [j/k down/up] [d/u page] [g/G top/bottom] [n/N next/prev match] [y copy pane] [enter/esc exit]';
    }
    const focused = workspace.panes[workspace.focusedPaneId];
    return `^B prefix  pane=${focused?.runtimeKey || 'n/a'}  mode=${focused?.accessMode || 'n/a'}  workspace=${workspace.title}`;
  };

  const persistWorkspace = () => {
    if (!options.workspaceName) return;
    storage.saveWorkspace(options.workspaceName, mux.serializeWorkspace(workspace.workspaceId));
    storage.setLastWorkspace(options.workspaceName);
  };

  const listWorkspacePanes = () =>
    Object.keys(workspace.panes).map((paneId, index) => {
      const pane = workspace.panes[paneId]!;
      return {
        index,
        paneId,
        paneKind: pane.paneKind,
        runtimeKey: pane.runtimeKey,
        accessMode: pane.accessMode,
        focused: workspace.focusedPaneId === paneId,
      };
    });

  const render = () => {
    clearScreen();
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    process.stdout.write(
      renderWorkspace(workspace, cols, rows, {
        footerLine: footerLine(),
        statusLine,
        paneIndicators: {
          ...buildPaneIndicators(paneActivityById),
          ...Object.fromEntries(
            Array.from(paneSearchById.entries()).map(([paneId, search]) => [paneId, `/${search.matches.length}`]),
          ),
        },
        paneLineOffsets: Object.fromEntries(paneScrollOffsetById.entries()),
      }),
    );
  };

  const scheduleSync = () => {
    if (shouldExit) return;
    if (syncRunning) {
      syncQueued = true;
      return;
    }
    syncRunning = true;
    void (async () => {
      do {
        syncQueued = false;
        const rects = computePaneRects(workspace, process.stdout.columns || 120, process.stdout.rows || 40);
        const seenRuntimeIds = new Set<string>();
        for (const [paneId, rect] of rects) {
          const pane = workspace.panes[paneId];
          if (pane?.paneKind === 'mirror') continue;
          if (!pane || seenRuntimeIds.has(pane.runtimeId)) continue;
          seenRuntimeIds.add(pane.runtimeId);
          const cols = Math.max(1, rect.width - 2);
          const rows = Math.max(1, rect.height - 2);
          if (pane.viewport.cols === cols && pane.viewport.rows === rows) continue;
          try {
            await mux.resizePane(paneId, cols, rows);
          } catch (error: any) {
            statusLine = `[adhmux] resize failed: ${error?.message || error}`;
          }
        }
      } while (syncQueued);
      syncRunning = false;
      if (!shouldExit) {
        render();
      }
    })();
  };

  const setStatus = (next: string) => {
    statusLine = next;
    render();
  };

  const updateSearchStatus = (paneId: string, query: string) => {
    const pane = workspace.panes[paneId];
    const matches = searchPaneText(pane?.viewport.text || '', query);
    if (matches.length === 0) {
      paneSearchById.delete(paneId);
      paneSearchIndexById.delete(paneId);
      setStatus(`[adhmux] no matches for "${query}"`);
      return;
    }
    paneSearchById.set(paneId, { query, matches });
    paneSearchIndexById.set(paneId, 0);
    paneScrollOffsetById.set(paneId, Math.max(0, matches[0]!.line - 1));
    const first = matches[0]!;
    setStatus(`[adhmux] ${matches.length} matches for "${query}" at ${first.line}:${first.column}`);
  };

  const setPaneScroll = (paneId: string, nextOffset: number) => {
    const maxOffset = Math.max(
      0,
      (workspace.panes[paneId]?.viewport.text.replace(/\r\n/g, '\n').split('\n').length || 1) - 1,
    );
    paneScrollOffsetById.set(paneId, Math.min(maxOffset, Math.max(0, nextOffset)));
    render();
  };

  const moveSearchMatch = (paneId: string, delta: 1 | -1) => {
    const search = paneSearchById.get(paneId);
    if (!search || search.matches.length === 0) {
      setStatus('[adhmux] no active search');
      return;
    }
    const currentIndex = paneSearchIndexById.get(paneId) || 0;
    const nextIndex = (currentIndex + delta + search.matches.length) % search.matches.length;
    paneSearchIndexById.set(paneId, nextIndex);
    const match = search.matches[nextIndex]!;
    paneScrollOffsetById.set(paneId, Math.max(0, match.line - 1));
    setStatus(`[adhmux] ${search.query} ${nextIndex + 1}/${search.matches.length} at ${match.line}:${match.column}`);
  };

  const onMuxEvent = (event: MuxControllerEvent) => {
    if (event.kind === 'runtime') {
      const paneId = event.pane.paneId;
      if (workspace.focusedPaneId !== paneId) {
        if (event.event?.type === 'session_output') {
          const previous = paneActivityById.get(paneId);
          paneActivityById.set(paneId, {
            kind: 'output',
            count: previous?.kind === 'output' ? previous.count + 1 : 1,
          });
          if (!previous) {
            process.stdout.write('0007');
          }
        } else if (event.event?.type === 'session_exit') {
          paneActivityById.set(paneId, { kind: 'done', count: 1 });
          process.stdout.write('0007');
        } else if (event.event?.type === 'write_owner_changed') {
          paneActivityById.set(paneId, { kind: 'owner', count: 1 });
        }
      }
      if (options.workspaceName) {
        controlServer?.broadcast({
          type: 'runtime_update',
          payload: {
            workspaceName: options.workspaceName,
            pane: event.pane,
            event: event.event || null,
          },
        });
      }
      render();
      return;
    }
    if (event.kind === 'workspace' && event.workspace?.workspaceId === workspace.workspaceId) {
      if (event.workspace.focusedPaneId !== workspace.focusedPaneId) {
        clearPaneActivity(event.workspace.focusedPaneId);
      }
      workspace = event.workspace;
      persistWorkspace();
      if (options.workspaceName) {
        controlServer?.broadcast({
          type: 'workspace_update',
          payload: {
            workspaceName: options.workspaceName,
            workspace,
            panes: listWorkspacePanes(),
          },
        });
      }
      if (!shouldExit) {
        render();
        scheduleSync();
      }
    }
  };

  const unsub = mux.onEvent(onMuxEvent);
  controlServer = options.workspaceName
    ? createAdhMuxControlServer(options.workspaceName, async (request) => {
        const payload = request.payload || {};
        if (request.type === 'list_panes') {
          return { success: true, result: listWorkspacePanes() };
        }
        if (request.type === 'workspace_state') {
          return {
            success: true,
            result: {
              workspaceName: options.workspaceName,
              workspace,
              panes: listWorkspacePanes(),
            },
          };
        }
        if (request.type === 'capture_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          return { success: true, result: { paneId, text: workspace.panes[paneId]!.viewport.text } };
        }
        if (request.type === 'copy_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          const text = workspace.panes[paneId]!.viewport.text;
          const clipboard = !!payload.clipboard;
          const output = typeof payload.output === 'string' ? payload.output : undefined;
          if (output) {
            const { writeFileSync } = await import('fs');
            writeFileSync(output, text, 'utf8');
          }
          if (clipboard) {
            copyTextToClipboard(text);
          }
          return {
            success: true,
            result: { paneId, copiedToClipboard: clipboard, output: output || null, text: !clipboard && !output ? text : undefined },
          };
        }
        if (request.type === 'search_pane') {
          const paneId = resolvePaneTarget(workspace, payload.paneTarget as string | undefined);
          const query = String(payload.query || '');
          const matches = searchPaneText(workspace.panes[paneId]!.viewport.text, query);
          return { success: true, result: { paneId, query, count: matches.length, matches } };
        }
        if (request.type === 'select_pane') {
          workspace = await mux.focusPane(workspace.workspaceId, resolvePaneTarget(workspace, payload.paneTarget as string | undefined));
          clearPaneActivity(workspace.focusedPaneId);
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'replace_pane') {
          workspace = await mux.replacePaneRuntime(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            String(payload.runtimeTarget || ''),
            { readOnly: false, takeover: false },
          );
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'split_window') {
          const axis = (payload.axis as MuxAxis) || 'vertical';
          workspace = payload.mirror
            ? await mux.splitWorkspaceMirror(workspace.workspaceId, workspace.focusedPaneId, workspace.focusedPaneId, axis)
            : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, String(payload.runtimeKey || ''), {
                axis,
                readOnly: false,
              });
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'resize_pane') {
          workspace = await mux.resizeLayoutPane(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            payload.direction as 'left' | 'right' | 'up' | 'down',
            Number(payload.amount || 0.05),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'select_layout') {
          const preset = normalizeLayoutPreset(String(payload.layoutName || 'balanced'));
          workspace = preset === 'balanced'
            ? await mux.rebalanceWorkspaceLayout(workspace.workspaceId)
            : await mux.applyLayoutPreset(workspace.workspaceId, preset);
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'swap_panes') {
          workspace = await mux.swapPanePositions(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.firstPaneTarget as string | undefined),
            resolvePaneTarget(workspace, payload.secondPaneTarget as string | undefined),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'zoom_pane') {
          workspace = await mux.togglePaneZoom(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
          );
          persistWorkspace();
          render();
          return { success: true };
        }
        if (request.type === 'kill_pane') {
          const next = await mux.closePane(
            workspace.workspaceId,
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
          );
          if (!next) {
            if (options.workspaceName) storage.deleteWorkspace(options.workspaceName);
            await finish();
            return { success: true, result: { workspaceDeleted: true } };
          }
          workspace = next;
          persistWorkspace();
          render();
          scheduleSync();
          return { success: true };
        }
        if (request.type === 'send_keys') {
          await mux.sendInput(
            resolvePaneTarget(workspace, payload.paneTarget as string | undefined),
            String(payload.text || ''),
          );
          return { success: true };
        }
        return { success: false, error: `Unsupported control request: ${request.type}` };
      })
    : null;
  const onResize = () => {
    render();
    scheduleSync();
  };
  process.stdout.on('resize', onResize);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  render();
  scheduleSync();

  const finish = async () => {
    if (shouldExit) return;
    shouldExit = true;
    persistWorkspace();
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    restoreScreen();
    unsub();
    controlServer?.close();
    await mux.close();
  };

  const handlePromptChar = async (char: string) => {
    if (char === '0007' || char === '001b') {
      mode = 'normal';
      promptAxis = null;
      promptAction = 'split';
      promptMode = 'runtime';
      promptBuffer = '';
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      render();
      return;
    }
    if (char === '\r' || char === '\n') {
      const value = promptBuffer.trim();
      mode = 'normal';
      const axis = promptAxis;
      const action = promptAction;
      const modeType = promptMode;
      promptAxis = null;
      promptAction = 'split';
      promptMode = 'runtime';
      promptBuffer = '';
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      if (modeType === 'search') {
        if (!value) {
          setStatus('[adhmux] search cancelled');
          return;
        }
        updateSearchStatus(workspace.focusedPaneId, value);
        return;
      }
      if (!value || !axis) {
        setStatus('[adhmux] split cancelled');
        return;
      }
      try {
        workspace = action === 'replace'
          ? await mux.replacePaneRuntime(workspace.workspaceId, workspace.focusedPaneId, value, {
              readOnly: false,
              takeover: false,
            })
          : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, value, {
              axis,
              readOnly: false,
            });
        persistWorkspace();
        render();
        scheduleSync();
      } catch (error: any) {
        setStatus(`[adhmux] split failed: ${error?.message || error}`);
      }
      return;
    }
    if (char === '007f') {
      promptBuffer = promptBuffer.slice(0, -1);
      render();
      return;
    }
    if (char >= ' ' && char <= '~') {
      promptBuffer += char;
      render();
    }
  };

  const handleChooserChar = async (char: string) => {
    if (char === '0007' || char === '001b') {
      mode = 'normal';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      render();
      return;
    }
    if (char === '/') {
      mode = 'prompt';
      promptAxis = chooserAxis;
      promptAction = chooserAction;
      promptMode = 'runtime';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      promptBuffer = '';
      render();
      return;
    }
    const digit = Number.parseInt(char, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
      const selected = chooserRuntimes[digit - 1];
      const axis = chooserAxis;
      const action = chooserAction;
      mode = 'normal';
      chooserAxis = null;
      chooserAction = 'split';
      chooserRuntimes = [];
      statusLine = options.workspaceName ? `workspace=${options.workspaceName}` : 'temporary workspace';
      if (!selected || !axis) {
        setStatus('[adhmux] invalid chooser selection');
        return;
      }
      try {
        workspace = action === 'replace'
          ? await mux.replacePaneRuntime(workspace.workspaceId, workspace.focusedPaneId, selected.runtimeKey, {
              readOnly: false,
              takeover: false,
            })
          : await mux.splitWorkspacePane(workspace.workspaceId, workspace.focusedPaneId, selected.runtimeKey, {
              axis,
              readOnly: false,
            });
        persistWorkspace();
        render();
        scheduleSync();
      } catch (error: any) {
        setStatus(`[adhmux] split failed: ${error?.message || error}`);
      }
    }
  };

  const handlePrefixChar = async (char: string) => {
    mode = 'normal';
    try {
      if (char === '0002') {
        await mux.sendInput(workspace.focusedPaneId, '0002');
        return;
      }
      if (char === '%') {
        await enterChooser('vertical', 'split');
        return;
      }
      if (char === '"') {
        await enterChooser('horizontal', 'split');
        return;
      }
      if (char === 'm') {
        workspace = await mux.splitWorkspaceMirror(
          workspace.workspaceId,
          workspace.focusedPaneId,
          workspace.focusedPaneId,
          'vertical',
        );
        persistWorkspace();
        render();
        return;
      }
      if (char === '[') {
        mode = 'copy';
        paneScrollOffsetById.set(workspace.focusedPaneId, paneScrollOffsetById.get(workspace.focusedPaneId) || 0);
        render();
        return;
      }
      if (char === 'c') {
        await enterChooser('vertical', 'replace');
        return;
      }
      if (char === '/') {
        mode = 'prompt';
        promptAxis = null;
        promptAction = 'split';
        promptMode = 'search';
        promptBuffer = '';
        render();
        return;
      }
      if (char === 'y') {
        copyTextToClipboard(workspace.panes[workspace.focusedPaneId]!.viewport.text);
        setStatus('[adhmux] copied focused pane to clipboard');
        return;
      }
      if (char === 'n' || char === '\t') {
        workspace = await mux.focusPane(workspace.workspaceId, cycleFocus(workspace));
        clearPaneActivity(workspace.focusedPaneId);
        render();
        return;
      }
      if (char === 'H') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'left');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'L') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'right');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'K') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'up');
        persistWorkspace();
        render();
        return;
      }
      if (char === 'J') {
        workspace = await mux.resizeLayoutPane(workspace.workspaceId, workspace.focusedPaneId, 'down');
        persistWorkspace();
        render();
        return;
      }
      if (char === '=') {
        workspace = await mux.rebalanceWorkspaceLayout(workspace.workspaceId);
        persistWorkspace();
        render();
        return;
      }
      if (char === 't') {
        await mux.takeoverPane(workspace.focusedPaneId);
        setStatus('[adhmux] write ownership acquired');
        return;
      }
      if (char === 'z') {
        workspace = await mux.togglePaneZoom(workspace.workspaceId, workspace.focusedPaneId);
        persistWorkspace();
        render();
        return;
      }
      if (char === 'r') {
        await mux.releasePane(workspace.focusedPaneId);
        setStatus('[adhmux] write ownership released');
        return;
      }
      if (char === 'x') {
        const next = await mux.closePane(workspace.workspaceId, workspace.focusedPaneId);
        if (!next) {
          await finish();
          return;
        }
        workspace = next;
        persistWorkspace();
        render();
        scheduleSync();
        return;
      }
      if (char === 's') {
        persistWorkspace();
        setStatus(options.workspaceName ? `[adhmux] saved workspace ${options.workspaceName}` : '[adhmux] temporary workspace');
        return;
      }
      if (char === 'd' || char === 'q') {
        await finish();
        return;
      }
      setStatus(`[adhmux] unknown prefix command: ${JSON.stringify(char)}`);
    } catch (error: any) {
      setStatus(`[adhmux] ${error?.message || error}`);
    } finally {
      if (!shouldExit) {
        render();
      }
    }
  };

  const handleNormalChunk = async (chunk: string) => {
    if (chunk === '0002') {
      mode = 'prefix';
      render();
      return;
    }
    try {
      await mux.sendInput(workspace.focusedPaneId, chunk);
    } catch (error: any) {
      setStatus(`[adhmux] ${error?.message || error}`);
    }
  };

  const onData = (chunk: string) => {
    void (async () => {
      for (const char of chunk) {
        if (shouldExit) break;
        if (mode === 'chooser') {
          await handleChooserChar(char);
          continue;
        }
        if (mode === 'prompt') {
          await handlePromptChar(char);
          continue;
        }
        if (mode === 'copy') {
          const paneId = workspace.focusedPaneId;
          const current = paneScrollOffsetById.get(paneId) || 0;
          if (char === '0007' || char === '001b' || char === '\r' || char === '\n') {
            mode = 'normal';
            render();
            continue;
          }
          if (char === 'j') {
            setPaneScroll(paneId, current + 1);
            continue;
          }
          if (char === 'k') {
            setPaneScroll(paneId, current - 1);
            continue;
          }
          if (char === 'd') {
            setPaneScroll(paneId, current + Math.max(5, Math.floor((process.stdout.rows || 40) / 2)));
            continue;
          }
          if (char === 'u') {
            setPaneScroll(paneId, current - Math.max(5, Math.floor((process.stdout.rows || 40) / 2)));
            continue;
          }
          if (char === 'g') {
            setPaneScroll(paneId, 0);
            continue;
          }
          if (char === 'G') {
            setPaneScroll(paneId, 1_000_000);
            continue;
          }
          if (char === 'n') {
            moveSearchMatch(paneId, 1);
            continue;
          }
          if (char === 'N') {
            moveSearchMatch(paneId, -1);
            continue;
          }
          if (char === 'y') {
            try {
              copyTextToClipboard(workspace.panes[paneId]!.viewport.text);
              setStatus('[adhmux] copied focused pane to clipboard');
            } catch (error: any) {
              setStatus(`[adhmux] ${error?.message || error}`);
            }
            continue;
          }
          continue;
        }
        if (mode === 'prefix') {
          await handlePrefixChar(char);
          continue;
        }
        await handleNormalChunk(char);
      }
    })();
  };

  process.stdin.on('data', onData);

  await new Promise<void>((resolve) => {
    const poll = () => {
      if (shouldExit) {
        resolve();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}
