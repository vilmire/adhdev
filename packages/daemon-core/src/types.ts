/**
 * ADHDev Daemon Core — Shared Types
 *
 * Shared types referenced by daemon-core, daemon-standalone, and web-core.
 * When modifying this file, also update interface contracts in AGENT_PROTOCOL.md.
 */
import type { StatusReportPayload, AvailableProviderInfo } from './shared-types.js';

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

export interface ChatMessage {
  role: string;       // 'user' | 'assistant' | 'system' | 'human'
  /** Plain text (legacy) or canonical message parts */
  content: string | MessagePart[];
  kind?: string;      // 'standard' | 'thought' | 'tool' | 'terminal' | 'system'
  id?: string;
  index?: number;
  timestamp?: number;
  receivedAt?: number;
  /** Tool calls associated with this message */
  toolCalls?: ToolCallInfo[];
  /** Optional: fiber metadata */
  _type?: string;
  _sub?: string;
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
