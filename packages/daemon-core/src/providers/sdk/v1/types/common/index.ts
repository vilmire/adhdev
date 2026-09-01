/**
 * Shared types across provider categories.
 *
 * Extracted at build time into the Apache 2.0 npm package
 * `@adhdev/provider-types`. External provider authors import from there;
 * daemon-core imports from this file directly.
 */

// ─── Settings ───────────────────────────────────────────────────────────

export interface BooleanSettingDef {
  type: 'boolean';
  default: boolean;
  public?: boolean;
  label?: string;
  description?: string;
}

export interface NumberSettingDef {
  type: 'number';
  default: number;
  public?: boolean;
  label?: string;
  description?: string;
  min?: number;
  max?: number;
}

export interface StringSettingDef {
  type: 'string';
  default: string;
  public?: boolean;
  label?: string;
  description?: string;
}

export interface SelectSettingDef {
  type: 'select';
  default: string;
  options: ReadonlyArray<string | { value: string; label?: string }>;
  public?: boolean;
  label?: string;
  description?: string;
}

export type SettingDef =
  | BooleanSettingDef
  | NumberSettingDef
  | StringSettingDef
  | SelectSettingDef;

export type SettingsDef = Readonly<Record<string, SettingDef>>;

// ─── Capabilities ───────────────────────────────────────────────────────

export interface CapabilityInputDef {
  multipart?: boolean;
  mediaTypes?: ReadonlyArray<'text' | 'image' | 'audio' | string>;
  strategies?: ReadonlyArray<{
    mediaType: string;
    strategies: ReadonlyArray<string>;
    native?: boolean;
    degradation?: ReadonlyArray<string>;
  }>;
}

export interface CapabilityOutputDef {
  richContent?: boolean;
  mediaTypes?: ReadonlyArray<string>;
}

export interface CapabilityControlsDef {
  typedResults?: boolean;
}

export interface CapabilitiesDef {
  input?: CapabilityInputDef;
  output?: CapabilityOutputDef;
  controls?: CapabilityControlsDef;
}

// ─── Auth ───────────────────────────────────────────────────────────────

export interface EnvVarAuthDef {
  type: 'env_var';
  id: string;
  name: string;
  vars: ReadonlyArray<{ name: string; description?: string }>;
  link?: string;
}

export interface CliCommandAuthDef {
  type: 'cli_command';
  id: string;
  name: string;
  command: string;
  link?: string;
}

export type AuthDef = EnvVarAuthDef | CliCommandAuthDef;

// ─── Spawn ──────────────────────────────────────────────────────────────

export interface SpawnDef {
  command: string;
  args?: ReadonlyArray<string>;
  shell?: boolean;
  env?: Readonly<Record<string, string>>;
}

// ─── Timeouts ───────────────────────────────────────────────────────────

export interface TimeoutsDef {
  /** Gap between writes before considering a chunk settled (ms). */
  ptyFlush?: number;
  /** Delay before sending an approval key (ms). */
  dialogAccept?: number;
  /** Window during which a freshly resolved modal is suppressed (ms). */
  approvalCooldown?: number;
  /** Fallback "still generating" assumption window (ms). */
  generatingIdle?: number;
  /** Grace before declaring generating→idle final (ms). */
  idleFinish?: number;
  /** Second-pass confirmation window (ms). */
  idleFinishConfirm?: number;
  /** PTY-quiet threshold before marking activity ended (ms). */
  statusActivityHold?: number;
  /** Hard upper bound on a single generation (ms). */
  maxResponse?: number;
  /** SIGTERM→SIGKILL window (ms). */
  shutdownGrace?: number;
  /** Post-write debounce (ms). */
  outputSettle?: number;
}

// ─── Resume ─────────────────────────────────────────────────────────────

export type StopStrategy = 'command' | 'ctrl_c' | 'signal';
export type SessionIdFormat = 'uuid' | 'free' | 'string';

export interface ResumeDef {
  supported: boolean;
  stopStrategy?: StopStrategy;
  stopCommand?: string;
  shutdownGraceMs?: number;
  sessionIdFormat?: SessionIdFormat;
  /** Args appended to spawn.args when starting a session under a daemon-issued id. `{{id}}` is replaced at launch. */
  newSessionArgs?: ReadonlyArray<string>;
  /** Args appended when resuming a specific session id. */
  resumeSessionArgs?: ReadonlyArray<string>;
  /** Args appended when "continue most recent" semantics are wanted. */
  resumeArgs?: ReadonlyArray<string>;
}

// ─── Mesh coordinator ───────────────────────────────────────────────────

export interface McpConfigDef {
  mode: 'manual' | 'auto_import';
  format?: string;
  path?: string;
  configPathCommand?: string;
  serverName?: string;
  requiresRestart?: boolean;
  instructions?: string;
  /** Template string used by daemon to render the actual config snippet at install time. */
  template?: string;
}

export interface MeshCoordinatorDef {
  supported: boolean;
  mcpConfig?: McpConfigDef;
  systemPromptInjection?: MeshCoordinatorSystemPromptInjectionDef;
  /** Coordinator-only extra spawn args (e.g. cursor's --approve-mcps). */
  launchArgs?: string[];
  delegatedWorkerIsolation?: MeshCoordinatorDelegatedWorkerIsolationDef;
}

export type MeshCoordinatorSystemPromptInjectionDef =
  | { mode: 'cli_arg'; flag: string }
  | { mode: 'config_override'; flag: string; template: string }
  | { mode: 'context_file'; path: string; wrapper?: string; owned?: boolean }
  | { mode: 'env_var'; name: string }
  | { mode: 'agent_file'; flag: string; template?: string };

export interface MeshCoordinatorDelegatedWorkerIsolationDef {
  env?: {
    unset?: ReadonlyArray<string>;
    /**
     * Environment variables set to a concrete value for delegated workers.
     * Supports the `{{workerHome}}` placeholder (worker-private HOME).
     * `unset` wins on conflict.
     */
    set?: Readonly<Record<string, string>>;
  };
  args?: ReadonlyArray<MeshCoordinatorDelegatedWorkerArgRuleDef>;
  workerMcpDelivery?: MeshCoordinatorWorkerMcpDeliveryDef;
}

export interface MeshCoordinatorWorkerMcpDeliveryDef {
  mode: 'config_override';
  flag: string;
  serverName: string;
  commandTemplate: string;
  argsTemplate: string;
  envVarsTemplate: string;
  enabledTemplate: string;
  shellEnvExcludeTemplate?: string;
}

export type MeshCoordinatorDelegatedWorkerArgRuleDef =
  | { mode: 'empty_mcp_config'; flag: string; strictFlag?: string }
  | { mode: 'config_override'; flag: string; key: string; value: string; dedupeKey?: string };

// ─── Compatibility ──────────────────────────────────────────────────────

export interface CompatibilityEntryDef {
  /** SemVer range against the agent's own version. Optional. */
  ideVersion?: string;
  /** Script subdirectory to load when this entry matches. e.g. "scripts/1.0". */
  scriptDir: string;
}

// ─── Controls (dashboard chips/buttons) ─────────────────────────────────

export type ControlType = 'select' | 'action' | 'toggle';

export interface ControlDef {
  id: string;
  type: ControlType;
  label: string;
  icon?: string;
  placement?: string;
  order?: number;
  dynamic?: boolean;
  hidden?: boolean;
  options?: ReadonlyArray<unknown>;
  listScript?: string;
  setScript?: string;
  invokeScript?: string;
  readFrom?: string;
  resultDisplay?: string;
  defaultValue?: unknown;
  confirmTitle?: string;
  confirmMessage?: string;
  confirmLabel?: string;
}

// ─── Provider status flag ───────────────────────────────────────────────

export type ProviderLifecycleStatus = 'Stable' | 'Beta' | 'Experimental' | 'Deprecated';
