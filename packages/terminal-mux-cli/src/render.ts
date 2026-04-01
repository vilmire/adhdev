import type { MuxLayoutNode, MuxWorkspaceState, RuntimePaneState } from '@adhdev/terminal-mux-core';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderWorkspaceOptions {
  footerLine?: string;
  statusLine?: string;
  paneIndicators?: Record<string, string>;
  paneLineOffsets?: Record<string, number>;
}

function blankGrid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
}

function write(grid: string[][], x: number, y: number, text: string): void {
  const row = grid[y];
  if (!row) return;
  for (let i = 0; i < text.length; i += 1) {
    const cell = x + i;
    if (cell < 0 || cell >= row.length) break;
    row[cell] = text[i] || ' ';
  }
}

function renderBorder(grid: string[][], rect: Rect, title: string, focused: boolean): void {
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  if (rect.width < 4 || rect.height < 3) return;

  const h = focused ? '=' : '-';
  write(grid, rect.x, rect.y, `+${h.repeat(rect.width - 2)}+`);
  write(grid, rect.x, bottom, `+${h.repeat(rect.width - 2)}+`);
  for (let y = rect.y + 1; y < bottom; y += 1) {
    write(grid, rect.x, y, '|');
    write(grid, right, y, '|');
  }

  const safeTitle = ` ${title.slice(0, Math.max(0, rect.width - 4))} `;
  write(grid, rect.x + 2, rect.y, safeTitle);
}

function fitContent(text: string, width: number, height: number, lineOffset = 0): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const visibleLines = lineOffset > 0 ? lines.slice(lineOffset) : lines;
  for (const line of visibleLines) {
    if (out.length >= height) break;
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let start = 0;
    while (start < line.length && out.length < height) {
      out.push(line.slice(start, start + width));
      start += width;
    }
  }
  while (out.length < height) out.push('');
  return out;
}

function renderPane(
  grid: string[][],
  rect: Rect,
  pane: RuntimePaneState,
  focused: boolean,
  indicator?: string,
  lineOffset = 0,
): void {
  renderBorder(
    grid,
    rect,
    `${pane.runtimeKey}${pane.paneKind === 'mirror' ? ' [mirror]' : ''}${indicator ? ` ${indicator}` : ''} · ${pane.writeOwner ? `${pane.writeOwner.ownerType}` : pane.accessMode === 'interactive' ? 'interactive' : 'view'}`,
    focused,
  );

  const contentWidth = Math.max(0, rect.width - 2);
  const contentHeight = Math.max(0, rect.height - 2);
  const contentLines = fitContent(pane.viewport.text, contentWidth, contentHeight, lineOffset);
  for (let i = 0; i < contentLines.length && i < contentHeight; i += 1) {
    const line = contentLines[i] || '';
    const padded = line.padEnd(contentWidth, ' ');
    write(grid, rect.x + 1, rect.y + 1 + i, padded);
  }
}

function walkLayout(
  node: MuxLayoutNode,
  rect: Rect,
  workspace: MuxWorkspaceState,
  grid: string[][],
  indicators: Record<string, string> | undefined,
  lineOffsets: Record<string, number> | undefined,
): void {
  if (node.type === 'pane') {
    const pane = workspace.panes[node.paneId];
    if (!pane) return;
    renderPane(
      grid,
      rect,
      pane,
      workspace.focusedPaneId === node.paneId,
      indicators?.[node.paneId],
      lineOffsets?.[node.paneId] || 0,
    );
    return;
  }

  if (node.axis === 'vertical') {
    const firstWidth = Math.max(10, Math.floor(rect.width * node.ratio));
    const secondWidth = Math.max(10, rect.width - firstWidth);
    walkLayout(node.first, { ...rect, width: firstWidth }, workspace, grid, indicators, lineOffsets);
    walkLayout(node.second, { x: rect.x + firstWidth, y: rect.y, width: secondWidth, height: rect.height }, workspace, grid, indicators, lineOffsets);
    return;
  }

  const firstHeight = Math.max(4, Math.floor(rect.height * node.ratio));
  const secondHeight = Math.max(4, rect.height - firstHeight);
  walkLayout(node.first, { ...rect, height: firstHeight }, workspace, grid, indicators, lineOffsets);
  walkLayout(node.second, { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: secondHeight }, workspace, grid, indicators, lineOffsets);
}

function collectRects(
  node: MuxLayoutNode,
  rect: Rect,
  rects: Map<string, Rect>,
): void {
  if (node.type === 'pane') {
    rects.set(node.paneId, rect);
    return;
  }
  if (node.axis === 'vertical') {
    const firstWidth = Math.max(10, Math.floor(rect.width * node.ratio));
    const secondWidth = Math.max(10, rect.width - firstWidth);
    collectRects(node.first, { ...rect, width: firstWidth }, rects);
    collectRects(node.second, { x: rect.x + firstWidth, y: rect.y, width: secondWidth, height: rect.height }, rects);
    return;
  }
  const firstHeight = Math.max(4, Math.floor(rect.height * node.ratio));
  const secondHeight = Math.max(4, rect.height - firstHeight);
  collectRects(node.first, { ...rect, height: firstHeight }, rects);
  collectRects(node.second, { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: secondHeight }, rects);
}

export function computePaneRects(workspace: MuxWorkspaceState, cols: number, rows: number): Map<string, Rect> {
  const width = Math.max(40, cols);
  const height = Math.max(12, rows);
  const rects = new Map<string, Rect>();
  if (workspace.zoomedPaneId && workspace.panes[workspace.zoomedPaneId]) {
    rects.set(workspace.zoomedPaneId, { x: 0, y: 0, width, height: height - 2 });
    return rects;
  }
  collectRects(workspace.root, { x: 0, y: 0, width, height: height - 2 }, rects);
  return rects;
}

export function renderWorkspace(
  workspace: MuxWorkspaceState,
  cols: number,
  rows: number,
  options: RenderWorkspaceOptions = {},
): string {
  const width = Math.max(40, cols);
  const height = Math.max(12, rows);
  const grid = blankGrid(width, height);
  if (workspace.zoomedPaneId && workspace.panes[workspace.zoomedPaneId]) {
    renderPane(
      grid,
      { x: 0, y: 0, width, height: height - 2 },
      workspace.panes[workspace.zoomedPaneId]!,
      true,
      options.paneIndicators?.[workspace.zoomedPaneId],
      options.paneLineOffsets?.[workspace.zoomedPaneId] || 0,
    );
  } else {
    walkLayout(
      workspace.root,
      { x: 0, y: 0, width, height: height - 2 },
      workspace,
      grid,
      options.paneIndicators,
      options.paneLineOffsets,
    );
  }

  const status = options.statusLine || '';
  if (status) {
    write(grid, 0, height - 2, status.slice(0, width).padEnd(width, ' '));
  }
  const footer =
    options.footerLine ||
    `^B prefix  focus=${workspace.focusedPaneId.slice(0, 8)}  workspace=${workspace.title}${workspace.zoomedPaneId ? '  [zoom]' : ''}`;
  write(grid, 0, height - 1, footer.slice(0, width).padEnd(width, ' '));

  return grid.map((row) => row.join('')).join('\n');
}
