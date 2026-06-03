/**
 * CLI provider types — v1.
 *
 * Mirrors the contract documented in
 * adhdev-providers/docs/provider-contract/cli/v1.md.
 *
 * Extracted at build time into the Apache 2.0 npm package
 * `@adhdev/provider-types`.
 */

import type {
  SettingsDef,
  CapabilitiesDef,
  SpawnDef,
  TimeoutsDef,
  ResumeDef,
  MeshCoordinatorDef,
  CompatibilityEntryDef,
  ControlDef,
  ProviderLifecycleStatus,
} from '../common/index.js';

// ─── Screen snapshot types — used by all handlers ───────────────────────

export interface CliScreenLine {
  text: string;
  /** Number of visible columns the line occupies. */
  width: number;
}

export interface CliScreenSnapshot {
  text: string;
  lineCount: number;
  lines: CliScreenLine[];
  nonEmptyLines: CliScreenLine[];
  firstNonEmptyLineIndex: number;
  lastNonEmptyLineIndex: number;
  firstNonEmptyLine: CliScreenLine | null;
  lastNonEmptyLine: CliScreenLine | null;
  promptLineIndex: number;
  promptLine: CliScreenLine | null;
  linesAbovePrompt: CliScreenLine[];
  linesBelowPrompt: CliScreenLine[];
}

// ─── Chat message — output shape from parseSession.messages ────────────

export type CliChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type CliChatKind = 'standard' | 'tool' | 'thinking' | 'system';
export type CliBubbleState = 'visible' | 'collapsed' | 'hidden';

export interface CliChatMessage {
  role: CliChatRole;
  /** Plain string is the common case; rich content (arrays / objects) is permitted but parsing differs by category. */
  content: string | unknown;
  timestamp?: number;
  receivedAt?: number;
  kind?: CliChatKind | string;
  /** Stable id from the agent's native history when available. */
  id?: string;
  /** Display index, can drift. Prefer `providerUnitKey` for stable identity. */
  index?: number;
  /**
   * Stable per-message identity used by ChatSourceMachine to compare native
   * vs PTY transcripts. When the provider supports native history, this
   * should be derivable from the on-disk session-id + turn-number.
   */
  providerUnitKey?: string;
  bubbleId?: string;
  bubbleState?: CliBubbleState;
  senderName?: string;
  meta?: Record<string, unknown>;
  /** Provider-specific extensions are permitted; daemon ignores unknown keys. */
  [extra: string]: unknown;
}

// ─── Approval modal ────────────────────────────────────────────────────

export interface CliApprovalModal {
  message: string;
  /** Raw button labels as the user sees them. Do not rewrite. */
  buttons: string[];
}

// ─── Inputs ────────────────────────────────────────────────────────────

/**
 * Provided to `parseSession` and `parseOutput`. The richest input shape.
 */
export interface CliScriptInput {
  /** Accumulated PTY output, ANSI cleaned. */
  buffer: string;
  /** Raw PTY bytes including ANSI sequences. */
  rawBuffer: string;
  /** Last ~1000 chars of buffer. */
  recentBuffer: string;
  /** The terminal screen as rendered by ghostty/xterm. */
  screenText: string;
  workspace?: string;
  /** Same as workspace; legacy alias. */
  workingDir?: string;
  /** Last known provider session id. May be empty. */
  providerSessionId?: string;
  /** Alias used for some native-history flows. */
  historySessionId?: string;
  screen: CliScreenSnapshot;
  bufferScreen: CliScreenSnapshot;
  recentScreen: CliScreenSnapshot;
  /** Accumulated from previous parse calls. */
  messages: CliChatMessage[];
  /** Current in-flight assistant text. */
  partialResponse: string;
  isWaitingForResponse?: boolean;
  /** The user's prompt for the active turn. */
  promptText?: string;
  /** Provider settings from ~/.adhdev/config.json. */
  settings?: Record<string, unknown>;
  /** Command-specific args (e.g. handler invocation parameters). */
  args?: Record<string, unknown>;
  /** ms timestamp of process spawn. Useful for native rollover guards. */
  spawnAt?: number;
}

/**
 * Provided to `detectStatus`. Trimmed for hot-path performance.
 */
export interface CliStatusInput {
  tail: string;
  screenText?: string;
  rawBuffer?: string;
  isWaitingForResponse?: boolean;
  screen: CliScreenSnapshot;
  tailScreen: CliScreenSnapshot;
}

/**
 * Provided to `parseApproval`.
 */
export interface CliApprovalInput {
  buffer: string;
  screenText?: string;
  rawBuffer?: string;
  tail: string;
  screen: CliScreenSnapshot;
  bufferScreen: CliScreenSnapshot;
  tailScreen: CliScreenSnapshot;
}

// ─── Outputs ───────────────────────────────────────────────────────────

export type CliStatus = 'idle' | 'generating' | 'waiting_approval' | 'starting' | 'error';
export type CliTranscriptAuthority = 'provider' | 'daemon';
export type CliTranscriptCoverage = 'full' | 'tail' | 'current-turn';

export interface CliParsedSession {
  status: CliStatus;
  messages: CliChatMessage[];
  modal: CliApprovalModal | null;
  parsedStatus?: string | null;
  errorMessage?: string;
  errorReason?: string;
  providerSessionId?: string;
  transcriptAuthority?: CliTranscriptAuthority;
  coverage?: CliTranscriptCoverage;
}

export interface CliReadChatPayload {
  id: 'cli_session' | string;
  status: CliStatus;
  title: string;
  messages: CliChatMessage[];
  activeModal: CliApprovalModal | null;
  providerSessionId?: string;
  transcriptAuthority?: CliTranscriptAuthority;
  coverage?: CliTranscriptCoverage;
  controlValues?: Record<string, unknown>;
}

// ─── Handler function signatures ───────────────────────────────────────

export type CliCreateStateFn<S = Record<string, unknown>> = () => S;

export type CliParseSessionFn<S = unknown> = (
  state: S | undefined,
  input: CliScriptInput,
) => CliParsedSession;

export type CliDetectStatusFn = (
  input: CliStatusInput,
) => CliStatus | null;

export type CliParseApprovalFn = (
  input: CliApprovalInput,
) => CliApprovalModal | null;

export type CliParseOutputFn<S = unknown> = (
  state: S | undefined,
  input: CliScriptInput,
) => CliReadChatPayload;

// ─── Capability handlers ───────────────────────────────────────────────

export interface CliCapabilityHandlerResult {
  ok?: boolean;
  writeRaw?: string;
  sendMessage?: string;
  result?: unknown;
}

export type CliCapabilityHandlerFn<S = unknown> = (
  state: S | undefined,
  input: CliScriptInput,
) => CliCapabilityHandlerResult;

// ─── Native history ────────────────────────────────────────────────────

export interface CliNativeHistoryReadInput {
  historySessionId?: string;
  workspace?: string;
  /** ms timestamp of provider spawn. Use to reject pre-spawn rollovers. */
  spawnAt?: number;
}

export interface CliNativeHistoryMessage {
  role: CliChatRole;
  content: unknown;
  kind?: CliChatKind | string;
  providerUnitKey?: string;
  receivedAt?: number;
  workspace?: string;
  historySessionId?: string;
}

export interface CliNativeHistoryReadResult {
  source: 'provider-native';
  providerSessionId: string;
  messages: CliNativeHistoryMessage[];
  sourcePath: string;
  sourceMtimeMs: number;
  nativeHistoryCoverage: CliTranscriptCoverage;
  workspace?: string;
  unavailableReason?: string;
}

export type CliReadNativeHistoryFn = (
  input: CliNativeHistoryReadInput,
) => CliNativeHistoryReadResult | null;

export interface CliListNativeHistoryEntry {
  providerSessionId: string;
  title?: string;
  workspace?: string;
  receivedAt?: number;
  messageCount?: number;
}

export type CliListNativeHistoryFn = () => {
  sessions: CliListNativeHistoryEntry[];
};

// ─── Canonical history config ──────────────────────────────────────────

export interface CliCanonicalHistoryDef {
  format: string;
  watchPath: string;
  mode: 'native-source' | 'daemon-mirror';
  contractVersion?: string;
  scripts?: {
    readSession?: string;
    listSessions?: string;
  };
}

// ─── Patterns (legacy fallback detector hints) ─────────────────────────

export interface CliPatternEntry {
  source: string;
  flags?: string;
}

export interface CliPatternsDef {
  prompt?: CliPatternEntry[];
  generating?: CliPatternEntry[];
  approval?: CliPatternEntry[];
  ready?: CliPatternEntry[];
  dialog?: CliPatternEntry[];
}

// ─── Manifest ──────────────────────────────────────────────────────────

export interface CliProviderManifest {
  /** Identity */
  type: string;
  name: string;
  displayName?: string;
  category: 'cli';
  icon?: string;
  aliases?: ReadonlyArray<string>;

  /** Versioning */
  engines?: { adhdev?: string };
  providerVersion?: string;
  contractVersion?: number | string;
  status?: ProviderLifecycleStatus;
  details?: string;
  disableUpstream?: boolean;

  /** Process spawn */
  binary: string;
  versionCommand?: string;
  spawn: SpawnDef;

  /** Input/output behavior */
  sendDelayMs?: number;
  sendKey?: string;
  submitStrategy?: 'wait_for_echo' | 'immediate';
  requirePromptEchoBeforeSubmit?: boolean;
  allowInputDuringGeneration?: boolean;
  requiresFinalAssistantBeforeIdle?: boolean;
  augmentStaleSnapshot?: boolean;
  transcriptAuthority?: CliTranscriptAuthority;
  transcriptContext?: 'full' | 'tail';

  /** Patterns (legacy fallback) */
  patterns?: CliPatternsDef;

  /** Approval */
  approvalKeys?: Readonly<Record<string, string>>;
  approvalPositiveHints?: ReadonlyArray<string>;

  /** Timeouts */
  timeouts?: TimeoutsDef;

  /** Resume */
  resume?: ResumeDef;

  /** Compatibility */
  compatibility: ReadonlyArray<CompatibilityEntryDef>;
  defaultScriptDir?: string;

  /** Capabilities advertised to the dashboard */
  capabilities?: CapabilitiesDef;

  /** Mesh coordinator setup */
  meshCoordinator?: MeshCoordinatorDef;

  /** Native history */
  canonicalHistory?: CliCanonicalHistoryDef;

  /** Settings (UI toggles persisted to ~/.adhdev/config.json) */
  settings?: SettingsDef;

  /** Controls (dashboard chips/buttons) */
  controls?: ReadonlyArray<ControlDef>;
}
