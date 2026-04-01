import { randomUUID } from 'crypto';
import type { MuxAxis, MuxLayoutNode, MuxLayoutPreset, MuxWorkspaceState, RuntimePaneState } from './types.js';

type ResizeDirection = 'left' | 'right' | 'up' | 'down';

function cloneNode(node: MuxLayoutNode): MuxLayoutNode {
  if (node.type === 'pane') {
    return { ...node };
  }
  return {
    ...node,
    first: cloneNode(node.first),
    second: cloneNode(node.second),
  };
}

function replaceNode(node: MuxLayoutNode, paneId: string, next: MuxLayoutNode): MuxLayoutNode {
  if (node.type === 'pane') {
    return node.paneId === paneId ? next : node;
  }
  return {
    ...node,
    first: replaceNode(node.first, paneId, next),
    second: replaceNode(node.second, paneId, next),
  };
}

function removeNode(node: MuxLayoutNode, paneId: string): MuxLayoutNode | null {
  if (node.type === 'pane') {
    return node.paneId === paneId ? null : node;
  }

  const first = removeNode(node.first, paneId);
  const second = removeNode(node.second, paneId);

  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;

  return {
    ...node,
    first,
    second,
  };
}

function cloneWorkspace(workspace: MuxWorkspaceState): MuxWorkspaceState {
  return {
    ...workspace,
    root: cloneNode(workspace.root),
    panes: Object.fromEntries(
      Object.entries(workspace.panes).map(([paneId, pane]) => [paneId, { ...pane, viewport: { ...pane.viewport } }]),
    ),
  };
}

function nodeContainsPane(node: MuxLayoutNode, paneId: string): boolean {
  if (node.type === 'pane') {
    return node.paneId === paneId;
  }
  return nodeContainsPane(node.first, paneId) || nodeContainsPane(node.second, paneId);
}

function clampRatio(value: number): number {
  return Math.max(0.15, Math.min(0.85, value));
}

function adjustNodeForPane(
  node: MuxLayoutNode,
  paneId: string,
  axis: MuxAxis,
  delta: number,
): { node: MuxLayoutNode; changed: boolean } {
  if (node.type === 'pane') {
    return { node, changed: false };
  }

  const firstContains = nodeContainsPane(node.first, paneId);
  const secondContains = !firstContains && nodeContainsPane(node.second, paneId);
  let changed = false;
  let nextNode: MuxLayoutNode = node;

  if (node.axis === axis && (firstContains || secondContains)) {
    const directionDelta = firstContains ? delta : -delta;
    nextNode = {
      ...node,
      ratio: clampRatio(node.ratio + directionDelta),
    };
    changed = true;
  }

  if (firstContains) {
    const adjusted = adjustNodeForPane(nextNode.first, paneId, axis, delta);
    if (adjusted.changed) {
      nextNode = {
        ...nextNode,
        first: adjusted.node,
      };
      changed = true;
    }
  } else if (secondContains) {
    const adjusted = adjustNodeForPane(nextNode.second, paneId, axis, delta);
    if (adjusted.changed) {
      nextNode = {
        ...nextNode,
        second: adjusted.node,
      };
      changed = true;
    }
  }

  return { node: nextNode, changed };
}

function rebalanceNode(node: MuxLayoutNode): MuxLayoutNode {
  if (node.type === 'pane') return node;
  return {
    ...node,
    ratio: 0.5,
    first: rebalanceNode(node.first),
    second: rebalanceNode(node.second),
  };
}

function mapPaneIds(node: MuxLayoutNode, firstPaneId: string, secondPaneId: string): MuxLayoutNode {
  if (node.type === 'pane') {
    if (node.paneId === firstPaneId) return { ...node, paneId: secondPaneId };
    if (node.paneId === secondPaneId) return { ...node, paneId: firstPaneId };
    return node;
  }
  return {
    ...node,
    first: mapPaneIds(node.first, firstPaneId, secondPaneId),
    second: mapPaneIds(node.second, firstPaneId, secondPaneId),
  };
}

function collectPaneIds(node: MuxLayoutNode, acc: string[] = []): string[] {
  if (node.type === 'pane') {
    acc.push(node.paneId);
    return acc;
  }
  collectPaneIds(node.first, acc);
  collectPaneIds(node.second, acc);
  return acc;
}

function buildEvenLayout(paneIds: string[], axis: MuxAxis = 'vertical'): MuxLayoutNode {
  if (paneIds.length === 0) throw new Error('Cannot build layout without panes');
  if (paneIds.length === 1) return { type: 'pane', paneId: paneIds[0] };
  const midpoint = Math.ceil(paneIds.length / 2);
  const nextAxis: MuxAxis = axis === 'vertical' ? 'horizontal' : 'vertical';
  return {
    type: 'split',
    axis,
    ratio: 0.5,
    first: buildEvenLayout(paneIds.slice(0, midpoint), nextAxis),
    second: buildEvenLayout(paneIds.slice(midpoint), nextAxis),
  };
}

function buildStackLayout(paneIds: string[], axis: MuxAxis): MuxLayoutNode {
  if (paneIds.length === 0) throw new Error('Cannot build stack layout without panes');
  if (paneIds.length === 1) return { type: 'pane', paneId: paneIds[0] };
  const [first, ...rest] = paneIds;
  return {
    type: 'split',
    axis,
    ratio: 0.5,
    first: { type: 'pane', paneId: first },
    second: buildStackLayout(rest, axis),
  };
}

function buildMainLayout(paneIds: string[], rootAxis: MuxAxis): MuxLayoutNode {
  if (paneIds.length === 0) throw new Error('Cannot build layout without panes');
  if (paneIds.length === 1) return { type: 'pane', paneId: paneIds[0] };
  const [primary, ...rest] = paneIds;
  const stackAxis: MuxAxis = rootAxis === 'vertical' ? 'horizontal' : 'vertical';
  return {
    type: 'split',
    axis: rootAxis,
    ratio: rest.length === 1 ? 0.5 : 0.62,
    first: { type: 'pane', paneId: primary },
    second: buildStackLayout(rest, stackAxis),
  };
}

export function createMuxWorkspace(initialPane: RuntimePaneState, options: { workspaceId?: string; title?: string } = {}): MuxWorkspaceState {
  return {
    workspaceId: options.workspaceId || randomUUID(),
    title: options.title || initialPane.displayName,
    root: {
      type: 'pane',
      paneId: initialPane.paneId,
    },
    focusedPaneId: initialPane.paneId,
    zoomedPaneId: null,
    panes: {
      [initialPane.paneId]: initialPane,
    },
  };
}

export function splitMuxPane(
  workspace: MuxWorkspaceState,
  targetPaneId: string,
  axis: MuxAxis,
  nextPane: RuntimePaneState,
): MuxWorkspaceState {
  if (!workspace.panes[targetPaneId]) {
    throw new Error(`Unknown pane: ${targetPaneId}`);
  }

  const next = cloneWorkspace(workspace);
  next.root = replaceNode(next.root, targetPaneId, {
    type: 'split',
    axis,
    ratio: 0.5,
    first: { type: 'pane', paneId: targetPaneId },
    second: { type: 'pane', paneId: nextPane.paneId },
  });
  next.panes[nextPane.paneId] = nextPane;
  next.focusedPaneId = nextPane.paneId;
  return next;
}

export function removeMuxPane(workspace: MuxWorkspaceState, paneId: string): MuxWorkspaceState | null {
  if (!workspace.panes[paneId]) return workspace;

  const root = removeNode(workspace.root, paneId);
  if (!root) return null;

  const next = cloneWorkspace(workspace);
  delete next.panes[paneId];
  next.root = root;
  if (next.focusedPaneId === paneId) {
    next.focusedPaneId = Object.keys(next.panes)[0] || '';
  }
  if (next.zoomedPaneId === paneId) {
    next.zoomedPaneId = null;
  }
  return next;
}

export function focusMuxPane(workspace: MuxWorkspaceState, paneId: string): MuxWorkspaceState {
  if (!workspace.panes[paneId]) {
    throw new Error(`Unknown pane: ${paneId}`);
  }
  return {
    ...workspace,
    focusedPaneId: paneId,
  };
}

export function updateMuxPane(workspace: MuxWorkspaceState, pane: RuntimePaneState): MuxWorkspaceState {
  if (!workspace.panes[pane.paneId]) return workspace;
  return {
    ...workspace,
    panes: {
      ...workspace.panes,
      [pane.paneId]: pane,
    },
  };
}

export function toggleMuxPaneZoom(workspace: MuxWorkspaceState, paneId: string): MuxWorkspaceState {
  if (!workspace.panes[paneId]) {
    throw new Error(`Unknown pane: ${paneId}`);
  }
  return {
    ...workspace,
    focusedPaneId: paneId,
    zoomedPaneId: workspace.zoomedPaneId === paneId ? null : paneId,
  };
}

export function resizeMuxPane(
  workspace: MuxWorkspaceState,
  paneId: string,
  direction: ResizeDirection,
  amount = 0.05,
): MuxWorkspaceState {
  if (!workspace.panes[paneId]) {
    throw new Error(`Unknown pane: ${paneId}`);
  }
  const axis: MuxAxis = direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal';
  const delta =
    direction === 'left' || direction === 'up'
      ? -Math.abs(amount)
      : Math.abs(amount);
  const adjusted = adjustNodeForPane(workspace.root, paneId, axis, delta);
  if (!adjusted.changed) {
    return workspace;
  }
  return {
    ...workspace,
    root: adjusted.node,
  };
}

export function rebalanceMuxLayout(workspace: MuxWorkspaceState): MuxWorkspaceState {
  return {
    ...workspace,
    root: rebalanceNode(workspace.root),
  };
}

export function swapMuxPanePositions(
  workspace: MuxWorkspaceState,
  firstPaneId: string,
  secondPaneId: string,
): MuxWorkspaceState {
  if (firstPaneId === secondPaneId) return workspace;
  if (!workspace.panes[firstPaneId]) throw new Error(`Unknown pane: ${firstPaneId}`);
  if (!workspace.panes[secondPaneId]) throw new Error(`Unknown pane: ${secondPaneId}`);
  return {
    ...workspace,
    root: mapPaneIds(workspace.root, firstPaneId, secondPaneId),
    focusedPaneId: workspace.focusedPaneId === firstPaneId
      ? secondPaneId
      : workspace.focusedPaneId === secondPaneId
        ? firstPaneId
        : workspace.focusedPaneId,
    zoomedPaneId: workspace.zoomedPaneId === firstPaneId
      ? secondPaneId
      : workspace.zoomedPaneId === secondPaneId
        ? firstPaneId
        : workspace.zoomedPaneId,
  };
}

export function applyMuxLayoutPreset(
  workspace: MuxWorkspaceState,
  preset: MuxLayoutPreset,
): MuxWorkspaceState {
  const paneIds = collectPaneIds(workspace.root);
  const orderedPaneIds = [workspace.focusedPaneId, ...paneIds.filter((paneId) => paneId !== workspace.focusedPaneId)];
  let root: MuxLayoutNode;
  switch (preset) {
    case 'main-vertical':
      root = buildMainLayout(orderedPaneIds, 'vertical');
      break;
    case 'main-horizontal':
      root = buildMainLayout(orderedPaneIds, 'horizontal');
      break;
    case 'tiled':
    case 'even':
    default:
      root = buildEvenLayout(orderedPaneIds, 'vertical');
      break;
  }
  return { ...workspace, root };
}
