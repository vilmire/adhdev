/**
 * Provider Output Contracts — Output contracts all providers must conform to
 * 
 * Design principles:
 * - Only output format is standardized; implementation is free
 * - Common across all categories (cli, ide, extension)
 * - User custom providers use the same contracts
 */

// ─── readChat() return value ───────────────────────────

import type { SessionStatus } from '@adhdev/mesh-shared';
import type { ProviderSummaryMetadata } from '../shared-types.js';
import type { ModelDiscoverySpec } from '../models/types.js';
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
  /**
   * The one session status vocabulary (mesh-shared `session-status.ts`).
   * Provider scripts may still emit raw spellings such as `streaming`; those
   * are folded by `normalizeSessionStatus` at the consumer, never widened here.
   */
  status: SessionStatus;
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
import type { ProviderSettingDef, ProviderControlDef } from './provider-control-contracts.js';
import type { ProviderMeshCoordinatorConfig } from './mesh-coordinator-contracts.js';
export type { ChatMessage, InputEnvelope, InputPart, MessagePart };

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

export type ProviderCategory = 'cli' | 'ide' | 'extension';

/** Categories a user can launch a session for — webview extensions are attached, never launched. */
export type LaunchableProviderCategory = Exclude<ProviderCategory, 'extension'>;

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
   * Model axis: template for expanding an `initialModel` selection
   * into launch args for a CLI provider. `{{model}}` is substituted with the model
   * string; e.g. `['--model', '{{model}}']` for claude-cli → `--model opus`. Applied
   * at session launch when `initialModel` is passed AND this provider is a plain CLI
   * A CLI provider
   * with no template silently ignores `initialModel` at launch (best-effort; a model
   * request never fails a launch). Absent → no launch-time model selection for CLI.
   */
  modelLaunchArgs?: string[];
  /**
   * Optional mapping from user-facing model labels to the provider's launch-time
   * CLI values. This keeps modelOptions readable when a CLI accepts stable slugs
   * rather than its displayed labels. Unmapped values pass through unchanged so
   * free-form models remain supported.
   */
  modelLaunchValueMap?: Record<string, string>;
  /**
   * BRAIN-ROUTING (model axis): suggested model values for this provider, surfaced
   * as dropdown options in the new-session dialog (e.g. claude ['opus','sonnet',
   * 'haiku']; codex ['gpt-5.5','gpt-5-codex']). Advisory only — the UI allows free
   * text too, so the list going stale never blocks a model the provider accepts.
   */
  modelOptions?: string[];
  /**
   * MODEL DISCOVERY: how to ask the INSTALLED binary what models it actually
   * offers, so `modelOptions` above stops being a hand-written list that drifts.
   *
   * Drift is two-directional and both directions are user-visible: measured
   * 2026-09-23, codex's manifest lacked `gpt-6-astra` AND still listed four
   * models the binary no longer offers. So a successful discovery REPLACES
   * `modelOptions` at read time rather than merging into it.
   *
   * ★The result is a RUNTIME OVERLAY (daemon-core `models/`), never a write back
   * to this manifest: manifests are digest-verified channel objects, and the
   * answer is per-machine and per-account anyway (`grok models` → "You are
   * logged in with grok.com"). Any discovery failure falls back to the list
   * above, so a signed-out CLI can never empty a picker.
   *
   * `kind: 'none'` is an explicit declaration that a provider cannot be
   * discovered (claude-cli ships no listing subcommand; hermes-cli is
   * interactive only) — stated rather than omitted so the UI can render
   * "cannot verify" instead of implying the list was checked.
   */
  modelDiscovery?: ModelDiscoverySpec;
  /**
   * BRAIN-ROUTING (thinking axis): template for expanding an `initialThinkingLevel`
   * selection into launch args for a CLI provider, parallel to modelLaunchArgs.
   * `{{level}}` is substituted with the provider-appropriate reasoning-effort value
   * (already mapped from the standard low|medium|high level, see thinkingLevelMap).
   * Examples: claude-cli `['--effort', '{{level}}']` → `--effort high`; codex-cli
   * `['-c', 'model_reasoning_effort={{level}}']`. Applied at session launch when
   * `initialThinkingLevel` is passed AND this provider is a plain CLI. A CLI provider
   * with no template silently ignores the thinking level (best-effort; never fails a
   * launch).
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
        strategies?: Array<'native' | 'resource_link' | 'text_fallback' | 'paste' | 'upload'>;
        native?: boolean;
        degradation?: Array<'native' | 'resource_link' | 'text_fallback' | 'paste' | 'upload'>;
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
