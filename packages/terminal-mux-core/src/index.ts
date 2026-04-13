export type {
  CreateWorkspaceOptions,
  MuxAxis,
  MuxControllerEvent,
  MuxLayoutPreset,
  MuxLayoutNode,
  MuxWorkspaceState,
  OpenRuntimeOptions,
  PaneAccessMode,
  PersistedMuxWorkspaceState,
  RuntimePaneState,
  SplitPaneOptions,
  TerminalViewportState,
} from './types.js';

export {
  applyMuxLayoutPreset,
  createMuxWorkspace,
  focusMuxPane,
  rebalanceMuxLayout,
  removeMuxPane,
  resizeMuxPane,
  splitMuxPane,
  swapMuxPanePositions,
  toggleMuxPaneZoom,
  updateMuxPane,
} from './layout.js';

export { GhosttyTerminalSurface } from './ghostty-terminal-surface.js';
export type { GhosttyTerminalSurfaceOptions } from './ghostty-terminal-surface.js';
export { resolveMuxOpenRuntimeRecord } from './runtime-targeting.js';
export { SessionHostMuxClient } from './session-host-mux-client.js';
export { serializeWorkspace } from './workspace-persistence.js';
