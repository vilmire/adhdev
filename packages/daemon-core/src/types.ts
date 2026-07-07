/**
 * ADHDev Daemon Core — Shared Types
 *
 * Shared types referenced by daemon-core, daemon-standalone, and web-core.
 * When modifying this file, also update interface contracts in AGENT_PROTOCOL.md.
 */
import type { StatusReportPayload, AvailableProviderInfo } from './shared-types.js';
import type {
  ChatMessageKind,
  ChatMessageVisibility,
  ChatMessageTranscriptVisibility,
  ChatMessageAudience,
  ChatMessageSource,
} from './providers/chat-message-normalization.js';

// ── Daemon Status ──

/** Full status response from /api/v1/status and WS events */
export interface StatusResponse extends StatusReportPayload {
  /** For standalone API compat */
  id: string; // standalone specific
  type: string; // usually 'standalone'
  platform: string;
  hostname: string;
  /** User display name from config */
  userName?: string;
  /** Available providers */
  availableProviders?: AvailableProviderInfo[];
  /** System info (legacy compat) */
  system?: SystemInfo;
}

// ── Chat Message ──

export type ChatBubbleState = 'draft' | 'streaming' | 'final' | 'removed';

export interface ChatMessage {
  role: string;       // 'user' | 'assistant' | 'system' | 'human'
  /** Plain text (legacy) or canonical message parts */
  content: string | MessagePart[];
  kind?: ChatMessageKind;      // built-ins: standard | thought | tool | terminal | system; custom kinds allowed
  id?: string;
  /** Stable daemon-owned bubble identity when available. */
  bubbleId?: string;
  /** Stable provider-local unit identity used to reconcile legacy providers during migration. */
  providerUnitKey?: string;
  /** Bubble lifecycle state for transcript-authority migration. */
  bubbleState?: ChatBubbleState;
  index?: number;
  timestamp?: number;
  receivedAt?: number;
  /** (A2.3) Monotonic sequence number per (session, source). Producer-asserted
   *  when emitted by v2-aware providers (transcript v2 schema); otherwise
   *  derived by the daemon from receivedAt/timestamp/index. ChatSourceMachine
   *  uses this as the native peak watermark for regression detection. */
  sequence?: number;
  _turnKey?: string;
  /** Tool calls associated with this message */
  toolCalls?: ToolCallInfo[];
  /** Optional: fiber metadata */
  _type?: string;
  _sub?: string;
  /**
   * Transcript visibility/audience contract for separating chat-visible content
   * from internal/debug runtime rows. These reference the canonical named unions
   * declared alongside the classifier (chat-message-normalization.ts) so the known
   * values have one source of truth instead of a hand-inlined copy that drifts.
   * Each alias keeps the `| (string & {})` escape hatch: the read-chat contract
   * (read-chat-contract.ts) preserves ANY producer-supplied string verbatim, so
   * the type must stay open — it documents the known values without forbidding
   * provider-specific extensions.
   */
  visibility?: ChatMessageVisibility;
  transcriptVisibility?: ChatMessageTranscriptVisibility;
  audience?: ChatMessageAudience;
  source?: ChatMessageSource;
  userFacing?: boolean;
  internal?: boolean;
  isInternal?: boolean;
  debug?: boolean;
  /** Meta information for thought/terminal logs etc */
  meta?: { label?: string; isRunning?: boolean } | Record<string, any>;
  /** Sender name for shared sessions */
  senderName?: string;
}

// Re-export from contracts for convenience
import type { MessagePart, ToolCallInfo } from './providers/contracts.js';

// ── Extension Info ──

export interface ExtensionInfo {
  id: string;
  type: string;      // 'cline' | 'roo-code' | etc.
  name: string;
  isMonitored?: boolean;
  agentStatus?: string;
}

// ── Command Result ──

export interface CommandResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ── Provider Config ──

export interface ProviderConfig {
  id: string;
  type: 'ide' | 'extension' | 'cli' | 'acp';
  name: string;
 /** CDP port detection */
  cdpDetect?: {
    processName?: string;
    portFlag?: string;
  };
 /** Capabilities */
  capabilities?: string[];
}

// ── Event Types ──

export type DaemonEvent =
  | { type: 'status'; data: StatusResponse }
  | { type: 'chat_update'; data: { ideId: string; messages: ChatMessage[] } }
  | { type: 'screenshot'; data: { ideId: string; base64: string } }
  | { type: 'action_log'; data: { ideId: string; text: string; timestamp: number } }
  | { type: 'error'; data: { message: string } };

// ── API Response Types ──

export interface SystemInfo {
  cpus: number;
  totalMem: number;
  freeMem: number;
  /** macOS: reclaimable-inclusive; prefer for UI used% (see host-memory.ts) */
  availableMem?: number;
  loadavg: number[];
  uptime: number;
  arch: string;
}

export interface DetectedIde {
  id: string;
  type: string;
  name: string;
  installed: boolean;
  running: boolean;
}

export interface ProviderInfo extends AvailableProviderInfo {}


/** Flattened agent entry from /api/v1/agents */
export interface AgentEntry {
  ideId: string;
  type: string;
  name: string;
  status: string;
  source: 'native' | 'extension';
}
