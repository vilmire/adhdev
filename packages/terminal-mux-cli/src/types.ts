export interface OpenCommandOptions {
  runtimeTargets: string[];
  workspaceName?: string;
  readOnly: boolean;
  takeover: boolean;
}

export interface SessionCommandTarget {
  workspaceName: string;
  remainingArgs: string[];
}

export interface PaneCommandTarget extends SessionCommandTarget {
  paneTarget?: string;
}

export type UiMode = 'normal' | 'prefix' | 'prompt' | 'chooser' | 'copy';
export type ChooserAction = 'split' | 'replace';
export type PromptMode = 'runtime' | 'search';

export interface PaneActivityState {
  kind: 'output' | 'done' | 'owner';
  count: number;
}

export interface CommandFlags {
  json: boolean;
}

export interface CopyPaneOptions {
  json: boolean;
  clipboard: boolean;
  output?: string;
}

export type LayoutPreset = 'even' | 'main-vertical' | 'main-horizontal' | 'tiled';
