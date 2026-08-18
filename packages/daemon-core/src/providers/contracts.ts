/**
 * Provider Output Contracts — Output contracts all providers must conform to
 * 
 * Design principles:
 * - Only output format is standardized; implementation is free
 * - Common across all categories (cli, ide, extension)
 * - User custom providers use the same contracts
 */

// ─── readChat() return value ───────────────────────────

import type { ProviderSummaryMetadata } from '../shared-types.js';
import type { ChatMessageKind } from './chat-message-normalization.js';

export type ReadChatTurnStatus = 'open' | 'waiting_approval' | 'complete' | 'error';

export interface ReadChatResult {
  /**
   * Declared chat contract version. Absent or `'1.0'` → legacy v1 payload
   * (current shape). `'2.0'` → v2 payload conforming to transcript-v2.ts
   * (ReadChatResultV2). Validators in read-chat-contract.ts route on this
   * field. A1 only adds the field; A2 will make v2 the daemon-internal
   * canonical form and reject unrecognised versions at provider load time.
   */
  contractVersion?: import('./transcript-v2.js').ChatContractVersion;
  messages: ChatMessage[];
  status: AgentStatus;
  activeModal?: ModalInfo | null;
 /** IDE/Extension only: session info */
  id?: string;
  title?: string;
  /** Authoritative transcript turn identity when available. */
  currentTurnId?: string;
  turnStatus?: ReadChatTurnStatus;
 /** Extension only: additional metadata */
  agentType?: string;
  agentName?: string;
  extensionId?: string;
  /** Status metadata */
  isVisible?: boolean;
  isWelcomeScreen?: boolean;
  inputContent?: string;
  /** Explicit dynamic control values returned by the provider */
  controlValues?: Record<string, string | number | boolean>;
  /** Flexible always-visible metadata for compact/live surfaces. */
  summaryMetadata?: ProviderSummaryMetadata;
  /** Provider-owned transcript authority/coverage hints for daemon/dashboard sync. */
  transcriptAuthority?: 'provider' | 'daemon';
  coverage?: 'full' | 'tail' | 'current-turn';
  /**
   * Provider-native turn-terminal markers (kimi turn.ended, codex
   * task_complete/turn_aborted) surfaced by the daemon's native-history
   * readers. Present only when a native transcript was genuinely read on this
   * read path; absent on PTY/mirror fallbacks.
   */
  turnTerminalMarkers?: import('../chat/native-turn-signal.js').NativeTurnTerminalMarker[];
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
  kind?: ChatMessageKind;
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
  bubbleKind?: ChatMessageKind;
  bubbleRole?: 'system' | 'assistant' | 'user';
  bubbleSenderName?: string;
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
  | VideoBlock
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
  alt?: string;
  annotations?: ContentAnnotations;
}

/** Audio content — ACP AudioContent */
export interface AudioBlock {
  type: 'audio';
  data: string;       // base64-encoded
  mimeType: string;
  uri?: string;
  transcript?: string;
  annotations?: ContentAnnotations;
}

/** Video content — ADHDev canonical display block. ACP prompt input degrades video to resource_link/text. */
export interface VideoBlock {
  type: 'video';
  data?: string;      // base64-encoded
  mimeType: string;
  uri?: string;
  transcript?: string;
  posterUri?: string;
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

// ─── focusEditor() / openPanel() return values ─────────

export interface FocusEditorResult {
  focused: boolean;
  error?: string;
}

export interface OpenPanelResult {
  opened: boolean;
  visible: boolean;
  focused?: boolean;
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

export type MeshCoordinatorMcpConfigMode = 'auto_import' | 'manual' | 'none';
export type MeshCoordinatorMcpConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml';

export interface ProviderMeshCoordinatorConfig {
  /** Whether ADHDev may select this provider for Repo Mesh coordinator sessions. */
  supported: boolean;
  /** Human-readable reason shown when unsupported or blocked. */
  reason?: string;
  /** How ADHDev mesh MCP tools become visible to the launched CLI. */
  mcpConfig?: {
    mode: MeshCoordinatorMcpConfigMode;
    format?: MeshCoordinatorMcpConfigFormat;
    /** Provider-relative/project-relative config path for auto-import modes, e.g. '.mcp.json'. */
    path?: string;
    /** MCP server name to materialize or display. Defaults to 'adhdev-mesh'. */
    serverName?: string;
    /** Manual setup target path/help command, e.g. 'hermes config path'. */
    configPathCommand?: string;
    /** Whether users need a fresh CLI session after config changes. */
    requiresRestart?: boolean;
    /** User-facing setup explanation for manual modes. */
    instructions?: string;
    /** Copyable setup template. Supports {{meshId}}, {{adhdevMcpCommand}}, {{adhdevMcpArgs}}, {{workspace}}, {{serverName}}. */
    template?: string;
  };
  /**
   * How the coordinator system prompt reaches the launched CLI. Replaces the
   * old hard-coded `if (cliType === 'claude-cli') push --append-system-prompt`
   * branches in router.ts: a new CLI now ships its injection rule in its
   * provider.v1.json, no daemon code change needed. Users can override the
   * rendered prompt or the injection mechanism per-provider; if omitted, no
   * system prompt is injected (safe default — won't crash spawn with a flag
   * the CLI doesn't recognize).
   */
  systemPromptInjection?: MeshCoordinatorSystemPromptInjection;
  /**
   * Extra spawn args appended ONLY for coordinator launches (never worker or
   * interactive sessions). Use for CLI flags that pre-answer daemon-written
   * setup prompts — e.g. cursor-agent's `--approve-mcps`, which accepts the
   * daemon-written .cursor/mcp.json without parking the session on the
   * "MCP servers need to be approved" modal at coordinator startup.
   */
  launchArgs?: string[];
  /**
   * How coordinator-launched worker sessions are isolated from coordinator-only
   * MCP/tools/config. Provider-specific CLI quirks belong here, not in daemon
   * launch code.
   */
  delegatedWorkerIsolation?: MeshCoordinatorDelegatedWorkerIsolation;
}

export interface MeshCoordinatorDelegatedWorkerIsolation {
  /** Environment variables to unset for delegated worker sessions. */
  env?: {
    unset?: string[];
  };
  /** Spawn-argument rules applied before launching a delegated worker. */
  args?: MeshCoordinatorDelegatedWorkerArgRule[];
}

export type MeshCoordinatorDelegatedWorkerArgRule =
  | {
      mode: 'empty_mcp_config';
      /** CLI flag that points at an MCP config file, e.g. '--mcp-config'. */
      flag: string;
      /** Optional CLI flag that forces only the provided MCP config to be used. */
      strictFlag?: string;
    }
  | {
      mode: 'config_override';
      /** CLI config flag, e.g. '-c' or '--config'. */
      flag: string;
      /** Config key to set for worker isolation. */
      key: string;
      /** Config value to set. */
      value: string;
      /** Optional broader key prefix used for duplicate detection. */
      dedupeKey?: string;
    };

/**
 * Declarative description of how a CLI accepts a session-scoped system prompt.
 *
 * Modes:
 *   - cli_arg          → push `flag` + prompt onto spawn args                (Claude)
 *   - config_override  → push `flag` + a templated key=value config override (Codex)
 *   - context_file     → write prompt into a workspace markdown the CLI
 *                        auto-loads as project context                       (Gemini, Antigravity)
 *   - env_var          → expose prompt to the spawned process as $name       (Hermes)
 *   - agent_file       → write prompt to a daemon-owned temp agent file and
 *                        pass its path via `flag`                            (Kimi --agent-file)
 *
 * The prompt text is templated with `{prompt}` (raw) or `{prompt_json}`
 * (JSON-encoded for embedding inside config-override strings).
 */
export type MeshCoordinatorSystemPromptInjection =
  | {
      mode: 'cli_arg';
      /** Spawn-args flag, e.g. '--append-system-prompt'. The prompt becomes the next argv. */
      flag: string;
    }
  | {
      mode: 'config_override';
      /** Spawn-args flag, e.g. '-c'. Followed by `template` with placeholders rendered. */
      flag: string;
      /** Template using {prompt} or {prompt_json}, e.g. 'developer_instructions={prompt_json}'. */
      template: string;
    }
  | {
      mode: 'context_file';
      /** Workspace-relative file path the CLI auto-loads, e.g. 'AGENTS.md' or 'GEMINI.md'. */
      path: string;
      /**
       * Optional wrapper around the prompt. Use `{prompt}` placeholder. Existing
       * wrapper-delimited blocks are replaced rather than duplicated, so re-launching
       * a coordinator doesn't pile up copies. If omitted, the prompt is appended raw.
       */
      wrapper?: string;
      /**
       * When true the daemon owns the whole file (a dedicated, daemon-named
       * file such as `.cursor/rules/adhdev-mesh-coordinator.mdc`), so cleanup
       * DELETES the file outright instead of stripping the wrapper block out
       * of user-authored content. Default false (shared user file — strip).
       */
      owned?: boolean;
    }
  | {
      mode: 'env_var';
      /** Env-var name, e.g. 'HERMES_EPHEMERAL_SYSTEM_PROMPT'. */
      name: string;
    }
  | {
      mode: 'agent_file';
      /** Spawn-args flag that accepts an agent-file path, e.g. '--agent-file' (kimi). */
      flag: string;
      /**
       * Agent-file body template using the {prompt} placeholder; defaults to
       * '{prompt}'. CLI-native template variables (e.g. kimi's ${base_prompt})
       * pass through verbatim — only {prompt} is substituted by the daemon.
       * The file is written under a daemon-owned temp dir, never the workspace.
       */
      template?: string;
    };

export interface ProviderCompatibilityEntry {
  ideVersion: string;
  scriptDir: string;
}

export type AutoApproveModeStrategy =
  | 'pty-parse-default'
  | 'launch-args'
  | 'post-boot-command';

export type AutoApproveModeRisk = 'safe' | 'caution' | 'dangerous';

export interface AutoApproveMode {
  id: string;
  label: string;
  strategy: AutoApproveModeStrategy;
  risk: AutoApproveModeRisk;
  warning?: string;
  launchArgs?: string[];
  removeArgs?: string[];
}

export interface AutoApproveModesConfig {
  default: string;
  modes: AutoApproveMode[];
}

export interface ProviderModule {
 /** Unique identifier (e.g. 'cline', 'cursor', 'gemini-cli') */
  type: string;
 /** Display name (e.g. 'Cline', 'Cursor') */
  name: string;
 /** Category: determines execution method */
  category: ProviderCategory;
 /** When provider-owned, daemon treats provider parser output as canonical transcript authority. */
  transcriptAuthority?: 'provider' | 'daemon';
 /** Full context lets provider-owned parsers canonicalize retained history instead of daemon prefix stitching. */
  transcriptContext?: 'full' | 'tail';
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
  /** Provider-specific auto-approve choices and their launch/runtime strategy. */
  autoApproveModes?: AutoApproveModesConfig;
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
  /**
   * v1 declarative tui block (spinner/settledPrompt/modal/dispatchOrder/etc).
   * When present, the daemon's CliScriptRunner builds canonical
   * (input → verdict) functions from this and injects them into provider
   * scripts as `sdk.declarativeDetectStatus` and `sdk.declarativeParseApproval`.
   * v0 / verified-tier providers can omit this entirely.
   */
  tui?: Record<string, unknown>;
  /**
   * Scripts that can run at the IDE main-page level (not just inside the extension webview session frame).
   * Default: ['listModes', 'setMode', 'listModels', 'setModel'].
   * Add extra scripts here if the provider supports them at the IDE level (e.g. 'setModelGui').
   * Replaces hardcoded claude-code-vscode special-case in stream-commands.ts.
   */
  ideLevelScripts?: string[];

 // ─── CLI category only ───
  binary?: string;
  spawn?: {
    command: string;
    args?: string[];
    shell?: boolean;
    env?: Record<string, string>;
    /** Auto-implement spawn config — controls how this provider is invoked for autonomous script generation */
    autoImpl?: ProviderAutoImplSpawnConfig;
  };
  /**
   * MAGI-KIND-PANEL (model axis): template for expanding an `initialModel` selection
   * into launch args for a CLI provider. `{{model}}` is substituted with the model
   * string; e.g. `['--model', '{{model}}']` for claude-cli → `--model opus`. Applied
   * at session launch when `initialModel` is passed AND this provider is a plain CLI
   * (ACP providers instead route the model through setConfigOption). A CLI provider
   * with no template silently ignores `initialModel` at launch (best-effort; a model
   * request never fails a launch). Absent → no launch-time model selection for CLI.
   */
  modelLaunchArgs?: string[];
  /**
   * BRAIN-ROUTING (model axis): suggested model values for this provider, surfaced
   * as dropdown options in the new-session dialog (e.g. claude ['opus','sonnet',
   * 'haiku']; codex ['gpt-5.5','gpt-5-codex']). Advisory only — the UI allows free
   * text too, so the list going stale never blocks a model the provider accepts.
   */
  modelOptions?: string[];
  /**
   * BRAIN-ROUTING (thinking axis): template for expanding an `initialThinkingLevel`
   * selection into launch args for a CLI provider, parallel to modelLaunchArgs.
   * `{{level}}` is substituted with the provider-appropriate reasoning-effort value
   * (already mapped from the standard low|medium|high level, see thinkingLevelMap).
   * Examples: claude-cli `['--effort', '{{level}}']` → `--effort high`; codex-cli
   * `['-c', 'model_reasoning_effort={{level}}']`. Applied at session launch when
   * `initialThinkingLevel` is passed AND this provider is a plain CLI. A CLI provider
   * with no template silently ignores the thinking level (best-effort; never fails a
   * launch). ACP providers instead route thinking through setConfigOption('thought_level').
   */
  thinkingLaunchArgs?: string[];
  /**
   * BRAIN-ROUTING (thinking axis): optional per-provider mapping from the standard
   * thinking levels (`low`|`medium`|`high`) to this provider's own reasoning-effort
   * vocabulary, used to fill `{{level}}` in thinkingLaunchArgs. e.g. claude-cli might
   * map `{ high: 'max' }`; codex-cli `{ high: 'xhigh' }`. A level absent from the map
   * passes through unchanged (so `medium` → `medium` by default).
   */
  thinkingLevelMap?: Partial<Record<'low' | 'medium' | 'high', string>>;
  /**
   * BRAIN-ROUTING (thinking axis): the reasoning-effort values this provider actually
   * accepts, surfaced as the thinking-level dropdown options in the new-session
   * dialog (e.g. claude ['low','medium','high','max']; codex ['minimal','low',
   * 'medium','high','xhigh']). Absent → the UI falls back to the standard
   * low/medium/high. These are the provider's OWN vocabulary and are passed through
   * verbatim as initialThinkingLevel (not remapped by thinkingLevelMap, which only
   * translates the mesh's standard low/medium/high presets).
   */
  thinkingLevelOptions?: string[];
  /**
   * BRAIN-ROUTING (thinking axis, runtime-control providers): the `controls[].id`
   * of a runtime reasoning-effort control to drive for the thinking level when the
   * provider has no `thinkingLaunchArgs` (e.g. hermes-cli's `reasoning` select,
   * which types `/reasoning <level>` into the PTY via its setScript). At launch,
   * initialThinkingLevel (after thinkingLevelMap) is applied by invoking that
   * control's setScript with `{ value: <level> }`. Ignored if the id doesn't match a
   * control. Providers that use thinkingLaunchArgs don't need this.
   */
  thinkingControlId?: string;
  /** Delay before submitting typed CLI input (provider-specific TUI tuning) */
  sendDelayMs?: number;
  /** Submit key used after typing into CLI PTY (default: carriage return) */
  sendKey?: string;
  /** How the CLI adapter decides when to submit typed input */
  submitStrategy?: 'wait_for_echo' | 'immediate';
  /** If true, typed input must echo on the PTY screen before the adapter sends Enter. */
  requirePromptEchoBeforeSubmit?: boolean;
  /** Keep this provider out of the upstream auto-updated bundle */
  /** @deprecated Machine-level provider source policy now lives in config.providerSourceMode. Local overrides shadow upstream by root precedence and should not rely on provider-level disableUpstream. */
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
  /** Allow sending another prompt while the CLI is still generating so users can intervene mid-turn. */
  allowInputDuringGeneration?: boolean;
  /** Approval button priority hints used when auto-approve must pick a positive action */
  approvalPositiveHints?: string[];
  /**
   * Regex pattern (as string) that a valid provider session ID must match.
   * If set and the ID doesn't match, it is rejected (treated as invalid).
   * Replaces hardcoded HERMES_SESSION_ID_RE / CLAUDE_SESSION_ID_RE checks.
   */
  sessionIdPattern?: string;
  /** History behavior config — controls message filtering and collapse during replay */
  historyBehavior?: ProviderHistoryBehavior;
  /**
   * Native history config — for providers that maintain native history files.
   * When set, daemon reads/lists provider-native transcripts directly. This is
   * the canonical v1 field name; the legacy `canonicalHistory` field name is
   * still accepted by the loader and aliased onto this field at load time.
   */
  nativeHistory?: NativeHistoryConfig;
  /**
   * @deprecated Legacy v0 alias for {@link ProviderModule.nativeHistory}.
   * Loader populates this from `nativeHistory` so existing internal readers
   * keep working during the transition. Remove after one release.
   */
  canonicalHistory?: ProviderCanonicalHistoryConfig;
  /**
   * Auto-fix verification profile — provider-specific test expectations for `provider fix`.
   * If not set, provider fix runs without pre/post verification.
   */
  autoFixProfile?: ProviderAutoFixProfile;

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

  /**
   * Repo Mesh coordinator capability and MCP ingestion behavior.
   * Providers must declare this rather than relying on daemon hardcoded CLI quirks.
   */
  meshCoordinator?: ProviderMeshCoordinatorConfig;

 // ─── Contract version / capability declaration ───
  contractVersion?: number;
  capabilities?: {
    input?: {
      multipart?: boolean;
      mediaTypes?: Array<'text' | 'image' | 'audio' | 'video' | 'resource'>;
      strategies?: Array<{
        mediaType: 'text' | 'image' | 'audio' | 'video' | 'resource';
        strategies?: Array<'native' | 'native_acp' | 'resource_link' | 'text_fallback' | 'paste' | 'upload'>;
        native?: boolean;
        degradation?: Array<'native' | 'native_acp' | 'resource_link' | 'text_fallback' | 'paste' | 'upload'>;
      }>;
    };
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
  /** Skip session ID probing when launchMode is 'new' — for providers that manage their own session IDs on new sessions */
  skipProbeOnNewSession?: boolean;
  /**
   * Subcommands that carry a session ID as their next positional argument.
   * e.g. ['resume', 'fork'] for codex-cli (codex resume <id> / codex fork <id>).
   * Replaces the hardcoded readCodexResumeSessionId check in cli-manager.ts.
   */
  sessionIdFromSubcommand?: string[];
  /**
   * When --session-id is present without an explicit resume flag, treat as 'new' rather than 'resume'.
   * e.g. goose-cli passes --session-id on new sessions but requires --resume/-r to actually resume.
   * Replaces the hardcoded goose-cli check in cli-manager.ts.
   */
  sessionIdIsNewByDefault?: boolean;
}

/**
 * History behavior config — controls how history messages are processed for this provider.
 * Replaces hardcoded agentType checks in chat-history.ts.
 */
export interface ProviderHistoryBehavior {
  /** Collapse consecutive assistant turns during history replay (e.g. codex-cli shows replayed intermediate turns) */
  collapseConsecutiveAssistantTurns?: boolean;
  /** Regex patterns (as strings) to filter out from assistant messages — e.g. CLI starter prompt suggestions */
  filterAssistantPatterns?: string[];
  /** If true, session ID must match sessionIdPattern exactly — reject and return '' if it doesn't match */
  requireStrictSessionIdFormat?: boolean;
}

/**
 * Provider-owned native history script names.
 *
 * These functions live in the provider's versioned CLI script bundle, not in
 * daemon-core. They let each provider own native transcript file discovery and
 * parsing while daemon-core only validates/pages the normalized result.
 */
export interface NativeHistoryScriptsConfig {
  /** Reads one native session. Default: 'readNativeHistory'. */
  readSession?: string;
  /** Lists native sessions with summary metadata. Default: 'listNativeHistory'. */
  listSessions?: string;
}

/**
 * @deprecated Use {@link NativeHistoryScriptsConfig}. Retained as an alias for
 * one release so external consumers that referenced the old name keep compiling.
 */
export type ProviderCanonicalHistoryScriptsConfig = NativeHistoryScriptsConfig;

/**
 * Native history config — for providers that maintain their own native history files.
 *
 * Preferred mode is provider-owned scripts via `scripts`. `format` is now an
 * opaque provider label retained for diagnostics/backward compatibility; daemon
 * live paths must not branch on provider-specific format values.
 */
export interface NativeHistoryConfig {
  /** Opaque provider-owned history format label. */
  format?: string;
  /** Optional native history glob/template for diagnostics only. */
  watchPath?: string;
  /** Provider-owned script entry points for native transcript list/read. */
  scripts?: ProviderCanonicalHistoryScriptsConfig;
  /**
   * How ADHDev should use native history.
   * - 'native-source': provider-native files are canonical; ADHDev reads them directly and keeps only in-memory/thin projections.
   * - 'materialized-mirror': transitional compatibility mode; native files are rewritten into ~/.adhdev/history before read/list.
   * - 'disabled': ignore native history and use ADHDev mirror only.
   *
   * Omitted mode defaults to 'native-source'.
   */
  mode?: 'native-source' | 'materialized-mirror' | 'disabled';
  /**
   * Chat transcript contract version this provider's read_chat output
   * conforms to. See transcript-v2.ts for the v2 invariants. Absent or `'1.0'`
   * → legacy v1 payload (current behaviour). `'2.0'` → strict v2 payload
   * (stable providerUnitKey/bubbleId/sequence, strict enums, honest coverage).
   *
   * A1 only surfaces this field; validators in read-chat-contract.ts route
   * on it. A2 makes v2 the daemon-internal canonical form and rejects
   * unrecognised values at provider load time.
   */
  contractVersion?: import('./transcript-v2.js').ChatContractVersion;
}

/**
 * @deprecated Use {@link NativeHistoryConfig}. Retained as an alias for one
 * release so external consumers that referenced the old name keep compiling.
 */
export type ProviderCanonicalHistoryConfig = NativeHistoryConfig;

/**
 * Auto-implement spawn config — controls how the provider is spawned for autonomous AI-driven
 * provider script implementation (dev-auto-implement.ts).
 * Replaces hardcoded per-command branching.
 */
export interface ProviderAutoImplSpawnConfig {
  /**
   * How the meta-prompt is passed to the agent.
   * - 'flag': passed via a CLI flag (e.g. `claude -p "..."`)
   * - 'stdin': piped via stdin (generic fallback)
   * - 'subcommand': prepended as a subcommand (e.g. `codex exec "..."`)
   */
  promptMode: 'flag' | 'stdin' | 'subcommand';
  /** CLI flag used to pass the prompt (promptMode: 'flag') — e.g. '-p' */
  promptFlag?: string;
  /** Subcommand prepended before the prompt (promptMode: 'subcommand') — e.g. 'exec' */
  subcommand?: string;
  /** Extra args appended in auto-impl mode — e.g. ['--dangerously-skip-permissions'] */
  extraArgs?: string[];
  /** Custom meta-prompt template; use {{promptFile}} placeholder. If omitted, generic prompt is used. */
  metaPrompt?: string;
  /**
   * If true, schedule an auto-stop timer when the agent output goes quiet during verification.
   * Replaces the hardcoded `command !== 'codex'` check in dev-auto-implement.ts.
   */
  autoStopOnQuiet?: boolean;
}

/**
 * Auto-fix verification profile — provider-specific test expectations for `provider fix`.
 * Replaces the hardcoded CLI_AUTO_FIX_VERIFICATION_PROFILES record in provider-commands.ts.
 */
export interface ProviderAutoFixProfile {
  fixtureName: string;
  description: string;
  inspectFields?: string[];
  focusAreas?: string[];
  lastAssistantMustContainAny?: string[];
  lastAssistantMustNotContainAny?: string[];
  timeoutMs?: number;
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
 /**
  * FSM state ids in which this control should be visible (mirrors the spec's
  * `control_bar[].visible_when_state`). When omitted the control is always
  * visible. The daemon enforces this on click (FsmDriver.handleClickControl),
  * so the web bar must mirror the same gating to avoid showing a button that
  * the daemon would silently drop. Uses raw FSM state ids (e.g. 'idle',
  * 'busy'), not the derived dashboard status.
  */
  visibleWhenState?: string[];
}
