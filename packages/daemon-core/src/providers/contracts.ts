/**
 * Provider Output Contracts — Output contracts all providers must conform to
 * 
 * Design principles:
 * - Only output format is standardized; implementation is free
 * - Common across all categories (cli, ide, extension)
 * - User custom providers use the same contracts
 */

// ─── readChat() return value ───────────────────────────

export interface ReadChatResult {
  messages: ChatMessage[];
  status: AgentStatus;
  activeModal?: ModalInfo | null;
 /** IDE/Extension only: session info */
  id?: string;
  title?: string;
 /** Extension only: additional metadata */
  agentType?: string;
  agentName?: string;
  extensionId?: string;
 /** Status metadata */
  isVisible?: boolean;
  isWelcomeScreen?: boolean;
  inputContent?: string;
  model?: string;
  autoApprove?: string;
  /** Explicit dynamic control values returned by the provider */
  controlValues?: Record<string, string | number | boolean>;
  /** Provider-driven UI effects derived from chat state */
  effects?: ProviderEffect[];
}

import type { ChatMessage } from '../types.js';
import {
  flattenMessageParts,
  normalizeInputEnvelope,
  normalizeMessageParts,
} from './io-contracts.js';
export {
  flattenMessageParts,
  normalizeInputEnvelope,
  normalizeMessageParts,
} from './io-contracts.js';
import type {
  InputEnvelope,
  InputPart,
  MessagePart,
} from './io-contracts.js';
export type { ChatMessage, InputEnvelope, InputPart, MessagePart };

export type AgentStatus = 
  | 'idle' 
  | 'generating' 
  | 'waiting_approval' 
  | 'error' 
  | 'panel_hidden'
  | 'streaming';

export interface ModalInfo {
  message: string;
  buttons: string[];
  width?: number;
  height?: number;
}

export interface ProviderEffectMessage {
  role?: 'system' | 'assistant' | 'user';
  content: string | MessagePart[];
  kind?: string;
  senderName?: string;
}

export interface ProviderEffectToast {
  level?: 'info' | 'success' | 'warning';
  message: string;
}

export type ProviderNotificationPreferenceKey = 'disconnect' | 'completion' | 'approval' | 'browser';
export type ProviderNotificationChannel = 'bubble' | 'toast' | 'browser';

export interface ProviderEffectNotification {
  title?: string;
  body: string;
  level?: 'info' | 'success' | 'warning';
  channels?: ProviderNotificationChannel[];
  preferenceKey?: ProviderNotificationPreferenceKey;
  bubbleContent?: string | MessagePart[];
}

export interface ProviderEffect {
  type: 'message' | 'toast' | 'notification';
  /** Stable dedup key; falls back to a content hash when omitted */
  id?: string;
  /** Default immediate. turn_completed fires only on generating/waiting -> idle transitions. */
  when?: 'immediate' | 'turn_completed';
  /** Default true. False keeps the effect UI-only. */
  persist?: boolean;
  message?: ProviderEffectMessage;
  toast?: ProviderEffectToast;
  notification?: ProviderEffectNotification;
}

// ─── Legacy ACP ContentBlock Types (compatibility adapter) ─────────────────
// Based on ACP SDK v0.16.1 schema types.
// Internal runtime code should prefer MessagePart/InputEnvelope from io-contracts.ts.

/**
 * ContentBlock — ACP ContentBlock union type
 * Represents displayable content in messages, tool call results, etc.
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | ResourceLinkBlock
  | ResourceBlock;

/** Text content — ACP TextContent */
export interface TextBlock {
  type: 'text';
  text: string;
  annotations?: ContentAnnotations;
}

/** Image content — ACP ImageContent */
export interface ImageBlock {
  type: 'image';
  data: string;       // base64-encoded
  mimeType: string;   // 'image/png', 'image/jpeg', etc.
  uri?: string;       // optional URL reference
  annotations?: ContentAnnotations;
}

/** Audio content — ACP AudioContent */
export interface AudioBlock {
  type: 'audio';
  data: string;       // base64-encoded
  mimeType: string;
  annotations?: ContentAnnotations;
}

/** Resource link (file reference) — ACP ResourceLink */
export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: ContentAnnotations;
}

/** Embedded resource (inline file) — ACP EmbeddedResource */
export interface ResourceBlock {
  type: 'resource';
  resource: TextResourceContents | BlobResourceContents;
  annotations?: ContentAnnotations;
}

export interface TextResourceContents {
  uri: string;
  text: string;
  mimeType?: string | null;
}

export interface BlobResourceContents {
  uri: string;
  blob: string;      // base64-encoded
  mimeType?: string | null;
}

export interface ContentAnnotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;  // 0.0 ~ 1.0
}

// ─── Tool Call Types (ACP Standard) ─────────────────────

/** Tool call info — ACP ToolCall */
export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Content produced by a tool call — ACP ToolCallContent */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

// ─── Content Helpers ────────────────────────────────────

/** Normalize content into canonical message parts */
export function normalizeContent(content: string | MessagePart[] | ContentBlock[]): MessagePart[] {
  return normalizeMessageParts(content);
}

/** Flatten canonical/legacy content into a plain-text fallback string */
export function flattenContent(content: string | MessagePart[] | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return flattenMessageParts(normalizeMessageParts(content));
}

/** SendMessage params — canonical input envelope with legacy text/prompt compatibility */
export interface SendMessageParams {
  /** Shortcut: text-only message */
  text?: string;
  /** Rich content blocks (legacy ACP ContentBlock[]) */
  prompt?: ContentBlock[];
  /** Canonical multipart runtime input */
  input?: InputEnvelope;
}

// ─── sendMessage() return value ────────────────────────

export interface SendMessageResult {
  sent: boolean;
  error?: string;
 /** When CDP Input API is needed (Lexical editor etc) */
  needsTypeAndSend?: boolean;
  selector?: string;
}

// ─── listSessions() return value ───────────────────────

export interface ListSessionsResult {
  sessions: SessionInfo[];
}

export interface SessionInfo {
  id: string;
  title: string;
  time?: string;
}

// ─── switchSession() return value ──────────────────────

export interface SwitchSessionResult {
  switched: boolean;
 /** When CDP click coordinates are needed (Antigravity QuickInput etc) */
  action?: 'click';
  clickX?: number;
  clickY?: number;
  error?: string;
}

// ─── resolveAction() return value ──────────────────────
// Two methods supported:

/**
 * Method 1: Script-Click — script calls el.click() directly
 * Cursor Suitable for IDEs using div.cursor-pointer elements.
 */
export interface ResolveActionScriptClick {
  resolved: boolean;        // true = click succeeded
  clicked?: string;         // clicked button text
  available?: string[];     // available buttons when resolved=false
  error?: string;
}

/**
 * Method 2: Coordinate-Click — returns coordinates, daemon performs CDP mouse click
 * Antigravity Suitable for IDEs where el.click() does not work.
 */
export interface ResolveActionCoordinateClick {
  found: boolean;           // true = button found
  text?: string;            // button text
  x?: number;               // click X coordinate
  y?: number;               // click Y coordinate
  w?: number;               // button width
  h?: number;               // button height
}

export type ResolveActionResult = ResolveActionScriptClick | ResolveActionCoordinateClick;


// ─── Provider Module type ────────────────────────

export type ProviderCategory = 'cli' | 'ide' | 'extension' | 'acp';

/**
 * Type of object exported by module.exports in provider.js.
 * 
 * Each provider.js is fully independent and does not import other providers.
 * Helpers (_helpers/) can be optionally used.
 */
/**
 * Provider-configurable CDP target filter.
 * Used by DaemonCdpManager to select the correct page/tab to connect to.
 * Without this, the manager uses a hardcoded default filter.
 */
export interface CdpTargetFilter {
 /** URL must include this string (e.g. 'workbench.html') */
  urlIncludes?: string;
 /** URL must NOT include any of these strings */
  urlExcludes?: string[];
 /** Page title regex pattern for titles to EXCLUDE (e.g. 'Debug Console|Output') */
  titleExcludes?: string;
}

export type ProviderVersionCommand = string | Partial<Record<string, string>>;

export interface ProviderCompatibilityEntry {
  ideVersion: string;
  scriptDir: string;
}

export interface ProviderModule {
 /** Unique identifier (e.g. 'cline', 'cursor', 'gemini-cli') */
  type: string;
 /** Display name (e.g. 'Cline', 'Cursor') */
  name: string;
 /** Category: determines execution method */
  category: ProviderCategory;
 /** Alias list — allows users to invoke by alternate names (e.g. ['claude', 'claude-code']) */
  aliases?: string[];

 // ─── IDE infrastructure (used by launch/daemon) ───
 /** CDP ports [primary, secondary] (IDE category only) */
  cdpPorts?: [number, number];
 /** CDP target filter — controls which page/tab to connect to (IDE category only) */
  targetFilter?: CdpTargetFilter;
 /** CLI command (e.g. 'cursor', 'code') */
  cli?: string;
 /** Display icon */
  icon?: string;
 /** Display name (short name) */
  displayName?: string;
 /** Provider-definition version maintained in adhdev-providers */
  providerVersion?: string;
 /** Inventory/support status label maintained in adhdev-providers */
  status?: string;
 /** Inventory/support detail string maintained in adhdev-providers */
  details?: string;
 /** Install instructions (shown when command is missing) */
  install?: string;
 /** Custom version detection command (e.g. 'cursor --version', 'claude -v') */
  versionCommand?: ProviderVersionCommand;
 /** Versions tested by provider maintainer (informational) */
  testedVersions?: string[];
  /** Per-OS process names — used by launch.ts to detect/kill IDE processes */
  processNames?: {
    darwin?: string;
    win32?: string[];
    linux?: string[];
    [key: string]: string | string[] | undefined;
  };
  /**
   * IDE launch preferences.
   * Lets each provider choose how its GUI app should be started per platform.
   */
  launch?: {
    /**
     * Preferred launch method by platform.
     * - 'cli': use the IDE CLI wrapper/binary
     * - 'app': use platform app launcher (e.g. `open -a` on macOS)
     * - 'auto': let core choose a sensible default
     */
    prefer?: {
      darwin?: 'auto' | 'cli' | 'app';
      win32?: 'auto' | 'cli' | 'app';
      linux?: 'auto' | 'cli' | 'app';
      [key: string]: 'auto' | 'cli' | 'app' | undefined;
    };
    /**
     * Override how long core waits for CDP to come up after launch.
     */
    cdpStartupTimeoutMs?: number;
  };
 /** Per-OS install paths — used by detector.ts to detect IDE installation */
  paths?: {
    darwin?: string[];
    win32?: string[];
    linux?: string[];
    [key: string]: string[] | undefined;
  };

 // ─── Extension category only ───
  extensionId?: string;
  extensionIdPattern?: RegExp;
  extensionIdPattern_flags?: string;
  compatibility?: ProviderCompatibilityEntry[];
  defaultScriptDir?: string;

 // ─── CLI category only ───
  binary?: string;
  spawn?: {
    command: string;
    args?: string[];
    shell?: boolean;
    env?: Record<string, string>;
  };
  /** Delay before submitting typed CLI input (provider-specific TUI tuning) */
  sendDelayMs?: number;
  /** Submit key used after typing into CLI PTY (default: carriage return) */
  sendKey?: string;
  /** How the CLI adapter decides when to submit typed input */
  submitStrategy?: 'wait_for_echo' | 'immediate';
  /** Keep this provider out of the upstream auto-updated bundle */
  disableUpstream?: boolean;
  approvalKeys?: Record<number, string>;
  patterns?: {
    prompt?: RegExp[];
    generating?: RegExp[];
    approval?: RegExp[];
    ready?: RegExp[];
  };
  cleanOutput?: (raw: string, lastUserInput?: string) => string;
  resume?: ProviderResumeCapability;
 /** Session ID probe config — auto-discovers provider session ID from local SQLite DB */
  sessionProbe?: ProviderSessionProbe;
  /** Approval button priority hints used when auto-approve must pick a positive action */
  approvalPositiveHints?: string[];

 // ─── CDP scripts (ide/extension category) ───
  scripts?: ProviderScripts;

 // ─── VS Code Commands (Extension IPC via) ───
  vscodeCommands?: {
    focusPanel?: string;
    openPanel?: string;
    [key: string]: string | undefined;
  };

 // ─── Input method (IDE category — Lexical editor etc) ───
  inputMethod?: 'cdp-type-and-send' | 'script';
  inputSelector?: string;

 // ─── Webview chat (IDE category — chat UI is in webview iframe) ───
 /** webview iframe match text (must be contained in body) */
  webviewMatchText?: string;

 // ─── Per-OS overrides ───
  os?: {
    [platform: string]: Partial<Pick<ProviderModule, 'scripts' | 'inputMethod' | 'inputSelector'>>;
  };

 // ─── Per-version overrides ───
  /** Key: semver range string (e.g. '< 1.107.0', '>= 2.0.0') */
  versions?: {
    [versionRange: string]: Partial<Pick<ProviderModule, 'scripts'>> & {
      /**
       * Load scripts from a subdirectory instead of scripts.js root.
       * Path is relative to the provider directory (e.g. 'scripts/legacy').
       * The subdirectory should contain its own scripts.js or individual .js files.
       */
      __dir?: string;
    };
  };

 // ─── Composite override (OS + version) ───
  overrides?: Array<{
    when: { os?: string; version?: string };
    scripts?: Partial<ProviderScripts>;
    /** Load scripts from a subdirectory for this OS+version combination */
    __dir?: string;
  }>;

 // ─── Provider Settings (variables controllable from dashboard) ───
  settings?: Record<string, ProviderSettingDef>;

 // ─── Provider Controls (interactive controls exposed in chat UI) ───
 /** Dynamic controls declared by provider — rendered in chat panel bar/header */
  controls?: ProviderControlDef[];

 // ─── ACP Static Config (for agents without config/* support) ───
 /** Static options used when agent does not provide configOptions */
  staticConfigOptions?: Array<{
    category: 'model' | 'mode' | 'thought_level' | 'other';
    configId: string;
    defaultValue?: string;
    options: Array<{ value: string; name: string; description?: string; group?: string }>;
  }>;
 /** Function to convert selected config values to spawn args (applied via process restart when config/* not supported) */
  spawnArgBuilder?: (config: Record<string, string>) => string[];

 // ─── ACP Authentication (auth method definitions) ───
 /** ACP agent auth methods (multiple supported — in priority order) */
  auth?: AcpAuthMethod[];

 // ─── Contract version / capability declaration ───
  contractVersion?: number;
  capabilities?: {
    input?: { multipart?: boolean; mediaTypes?: Array<'text' | 'image' | 'audio' | 'video' | 'resource'> };
    output?: { richContent?: boolean; mediaTypes?: Array<'text' | 'image' | 'audio' | 'video' | 'resource'> };
    controls?: { typedResults?: boolean };
  };
}

export interface ProviderResumeCapability {
  supported: boolean;
  stopStrategy?: 'command' | 'ctrl_c';
  stopCommand?: string;
  shutdownGraceMs?: number;
  /** Delay (ms) between Ctrl+C interrupt and stop command (default 500ms) */
  interruptGraceMs?: number;
  resumeArgs?: string[];
  resumeSessionArgs?: string[];
  newSessionArgs?: string[];
  sessionIdFormat?: 'uuid' | 'string';
}

/**
 * Declarative session ID probe config for CLI providers.
 * Instead of hardcoded probe functions, providers declare their SQLite schema.
 *
 * Example (OpenCode):
 * ```
 * sessionProbe: {
 *   dbPath: '~/.local/share/opencode/opencode.db',
 *   query: 'SELECT id FROM session WHERE directory IN ({dirs}) AND time_created >= ? AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1',
 *   timestampFormat: 'unix_ms',
 * }
 * ```
 */
export interface ProviderSessionProbe {
  /**
   * Path to SQLite database. Supports ~ for home directory.
   * Supports platform-specific paths via {platform} placeholder.
   */
  dbPath: string;
  /**
   * SQL query to find the session ID.
   * Use {dirs} placeholder for the directory IN-clause parameters.
   * The query must SELECT a column named 'id'.
   * A '?' placeholder after {dirs} receives the min-created-at timestamp.
   */
  query: string;
  /**
   * How the provider stores timestamps.
   * - 'unix_ms': milliseconds since epoch (default)
   * - 'unix_s': seconds since epoch
   * - 'iso': ISO 8601 string (YYYY-MM-DD HH:MM:SS)
   */
  timestampFormat?: 'unix_ms' | 'unix_s' | 'iso';
}

// ─── ACP Auth Types ─────────────────────────────────

/** ACP auth method — based on ACP official spec */
export type AcpAuthMethod = AcpAuthEnvVar | AcpAuthAgent | AcpAuthTerminal;

/** Environment variable-based auth (API keys etc) */
export interface AcpAuthEnvVar {
  type: 'env_var';
  id: string;
  name: string;
  vars: Array<{
    name: string;
    label?: string;
    secret?: boolean;    // default true
    optional?: boolean;  // default false
  }>;
  link?: string;  // Key issuance URL
}

/** Agent self-auth (OAuth, browser-based etc) */
export interface AcpAuthAgent {
  type: 'agent';
  id: string;
  name: string;
  description?: string;
}

/** Terminal command-based auth (runs setup command) */
export interface AcpAuthTerminal {
  type: 'terminal';
  id: string;
  name: string;
  description?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * CDP script functions.
 * Each function takes a params object and returns a JS code string for CDP evaluate.
 * The JS execution result must conform to the Output Contract.
 * 
 * Custom scripts can be added via index signature in addition to built-in scripts.
 * All scripts can receive params: Record<string, any>,
 * backward compatible with legacy single-argument style (e.g. sendMessage(text)).
 */
export interface ProviderScripts {
 // ─── Core ───
  readChat?: (params?: Record<string, any>) => string;
  sendMessage?: (params?: Record<string, any>) => string;
  listSessions?: (params?: Record<string, any>) => string;
  switchSession?: (params?: Record<string, any>) => string;
  newSession?: (params?: Record<string, any>) => string;

 // ─── UI Control ───
  focusEditor?: (params?: Record<string, any>) => string;
  openPanel?: (params?: Record<string, any>) => string;

 // ─── Model / Mode Control ───
 /** List available models → { models: string[], current: string } */
  listModels?: (params?: Record<string, any>) => string;
 /** Change model → { success: boolean } */
  setModel?: (params?: Record<string, any>) => string;
 /** List available modes → { modes: string[], current: string } */
  listModes?: (params?: Record<string, any>) => string;
 /** Change mode → { success: boolean } */
  setMode?: (params?: Record<string, any>) => string;

 // ─── Modal/Approval ───
 /** params: { action: 'approve'|'reject'|'custom', button?: string } */
  resolveAction?: (params?: Record<string, any>) => string;
  webviewResolveAction?: (params?: Record<string, any>) => string;

 // ─── Notifications ───
  listNotifications?: (params?: Record<string, any>) => string;
  dismissNotification?: (params?: Record<string, any>) => string;

 // ─── Custom Scripts (user-defined) ───
  [scriptName: string]: ((params?: Record<string, any>) => string) | undefined;
}


/**
 * ProviderLoader.resolve() result: Final provider with OS/version overrides applied
 */
export interface ResolvedProvider extends ProviderModule {
 /** OS applied during resolve */
  _resolvedOs?: string;
 /** Version applied during resolve */
  _resolvedVersion?: string;
 /** Warning when detected version is not in compatibility matrix */
  _versionWarning?: string;
 /** On-disk provider directory selected by ProviderLoader */
  _resolvedProviderDir?: string;
 /** Script directory selected by compatibility/default resolution */
  _resolvedScriptDir?: string;
 /** scripts.js path or fallback script directory used to build runtime scripts */
  _resolvedScriptsPath?: string;
 /** Why this script selection was chosen */
  _resolvedScriptsSource?: string;
}

// ─── Provider Settings ─────────────────────────────────

/** Setting variable definition declared by provider */
export interface ProviderSettingDef {
  type: 'boolean' | 'number' | 'string' | 'select';
  default: any;
 /** true = controllable from dashboard UI */
  public: boolean;
 /** UI label */
  label?: string;
 /** UI description */
  description?: string;
 /** Minimum value for number type */
  min?: number;
 /** Maximum value for number type */
  max?: number;
 /** Options for select type */
  options?: string[];
}

/** Public settings schema (for dashboard transmission) */
export interface ProviderSettingSchema extends ProviderSettingDef {
  key: string;
}

// ─── Provider Controls (interactive chat-level controls) ────────

/**
 * Control types:
 * - 'select'  — dropdown list (model picker, mode picker)
 * - 'toggle'  — on/off switch (compact mode, auto-approve)
 * - 'cycle'   — click-to-cycle through options (thinking level: low→med→high)
 * - 'slider'  — numeric range (temperature: 0–2)
 * - 'action'  — one-shot button (show usage, restart, clear context)
 */
export type ProviderControlType = 'select' | 'toggle' | 'cycle' | 'slider' | 'action' | 'display';

/**
 * Where the control appears in the chat UI:
 * - 'bar'    — thin strip below/above the chat input (always visible)
 * - 'header' — in the agent header area
 * - 'menu'   — inside a ⋯ overflow menu
 */
export type ProviderControlPlacement = 'bar' | 'header' | 'menu';

/** Static option for select/cycle controls */
export interface ProviderControlOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

export interface ControlListResult {
  options: ProviderControlOption[];
  currentValue?: string | number | boolean;
  error?: string;
}

export interface ControlSetResult {
  ok: boolean;
  currentValue?: string | number | boolean;
  effects?: ProviderEffect[];
  error?: string;
}

export interface ControlInvokeResult {
  ok: boolean;
  currentValue?: string | number | boolean;
  effects?: ProviderEffect[];
  error?: string;
}

/**
 * ProviderControlDef — A single interactive control declared by a provider.
 *
 * Controls are different from Settings:
 * - Settings: background config, infrequently changed, managed in settings page
 * - Controls: interactive, changed during chat, rendered inside chat panel
 *
 * Each control maps to provider scripts for get/set operations.
 * The frontend renders controls automatically based on this schema —
 * no hardcoded model/mode assumptions needed.
 *
 * For 'action' type:
 * - Renders as a button. On click → calls invokeScript.
 * - No value state. Optionally shows result via toast/inline.
 */
export interface ProviderControlDef {
 /** Unique identifier (e.g. 'model', 'mode', 'thinking', 'usage') */
  id: string;
 /** Control type */
  type: ProviderControlType;
 /** Display label */
  label: string;
 /** Icon (emoji or icon name) */
  icon?: string;
 /** Where to show this control in the UI */
  placement: ProviderControlPlacement;

 // ─── Options (for select/cycle) ───
 /** Static options — used when the list is known at definition time */
  options?: ProviderControlOption[];
 /** Dynamic options — load via script at runtime */
  dynamic?: boolean;
 /** Script name to list options (e.g. 'listModels') — required when dynamic=true */
  listScript?: string;

 // ─── Value (for select/toggle/cycle/slider) ───
 /** Script name to change value (e.g. 'setModel') — required for value-based controls */
  setScript?: string;
 /** Field name in readChat() result to read current value (e.g. 'model', 'mode') */
  readFrom?: string;
 /** Default value */
  defaultValue?: string | number | boolean;

 // ─── Action (for 'action' type) ───
 /** Script name to invoke (one-shot call, no value) */
  invokeScript?: string;
 /** How to display action result: 'toast' = notification, 'inline' = show in bar, 'none' = silent */
  resultDisplay?: 'toast' | 'inline' | 'none';
 /** Optional confirmation title shown before invoking a destructive or disruptive action */
  confirmTitle?: string;
 /** Optional confirmation message shown before invoking a destructive or disruptive action */
  confirmMessage?: string;
 /** Optional confirmation button label */
  confirmLabel?: string;

 // ─── Slider-specific ───
  min?: number;
  max?: number;
  step?: number;

 // ─── Display ───
 /** Sort order within placement group (lower = first) */
  order?: number;
 /** Hide this control when condition not met */
  hidden?: boolean;
}
