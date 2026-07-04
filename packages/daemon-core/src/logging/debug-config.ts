import type { LogLevel } from './logger.js'

export interface DebugRuntimeOptions {
  dev?: boolean
  logLevel?: LogLevel
  trace?: boolean
  traceContent?: boolean
  traceBufferSize?: number
  traceCategories?: string[]
}

export interface DebugRuntimeConfig {
  logLevel: LogLevel
  collectDebugTrace: boolean
  traceContent: boolean
  traceBufferSize: number
  traceCategories: string[]
}

const NORMAL_TRACE_BUFFER_SIZE = 200
const DEV_TRACE_BUFFER_SIZE = 1000

/**
 * ALWAYS-ON trace categories. These bypass the `collectDebugTrace` master switch
 * (and category selection) so they are collected in production daemons where
 * `--trace` is unset. They exist so mesh completion diagnostics — the FSM-transition
 * and completion-gate snapshots that explain an early / missing agent:generating_completed
 * notification — are retrievable via mesh_read_debug (chat_debug_bundle) without asking
 * an operator to relaunch the daemon with tracing on.
 *
 * SAFETY: only add a category here after confirming every record() call site for it
 * carries a content-free payload (statuses, epochs, timestamps, deltas, lengths, roles,
 * enum-like reasons — never transcript / prompt / bubble text). Always-on collection makes
 * such payloads unconditional, so a content-bearing field would leak into the ring buffer
 * in production.
 */
export const ALWAYS_ON_TRACE_CATEGORIES: readonly string[] = ['completion-gate', 'fsm-transition']

export function isAlwaysOnTraceCategory(category?: string | null): boolean {
  return !!category && ALWAYS_ON_TRACE_CATEGORIES.includes(category)
}

const DEFAULT_CONFIG: DebugRuntimeConfig = {
  logLevel: 'info',
  collectDebugTrace: false,
  traceContent: false,
  traceBufferSize: NORMAL_TRACE_BUFFER_SIZE,
  traceCategories: [],
}

let currentConfig: DebugRuntimeConfig = { ...DEFAULT_CONFIG }

function normalizeCategories(categories?: string[]): string[] {
  if (!Array.isArray(categories)) return []
  return categories
    .map((category) => String(category || '').trim())
    .filter(Boolean)
}

export function resolveDebugRuntimeConfig(options: DebugRuntimeOptions = {}): DebugRuntimeConfig {
  const dev = options.dev === true
  return {
    logLevel: options.logLevel || (dev ? 'debug' : DEFAULT_CONFIG.logLevel),
    collectDebugTrace: typeof options.trace === 'boolean' ? options.trace : dev,
    traceContent: options.traceContent === true,
    traceBufferSize: Number.isFinite(options.traceBufferSize)
      ? Math.max(10, Math.floor(options.traceBufferSize as number))
      : (dev ? DEV_TRACE_BUFFER_SIZE : DEFAULT_CONFIG.traceBufferSize),
    traceCategories: normalizeCategories(options.traceCategories),
  }
}

export function setDebugRuntimeConfig(config: DebugRuntimeConfig): void {
  currentConfig = {
    ...config,
    traceCategories: normalizeCategories(config.traceCategories),
    traceBufferSize: Math.max(10, Math.floor(config.traceBufferSize || DEFAULT_CONFIG.traceBufferSize)),
  }
}

export function getDebugRuntimeConfig(): DebugRuntimeConfig {
  return { ...currentConfig, traceCategories: [...currentConfig.traceCategories] }
}

export function resetDebugRuntimeConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG }
}

export function shouldCollectTraceCategory(category?: string | null): boolean {
  const config = currentConfig
  // Always-on categories are collected regardless of the collectDebugTrace master switch
  // and regardless of any explicit traceCategories selection (they form a superset on top of
  // whatever the operator requested), so an explicit --trace / --trace-categories run still
  // includes them with its existing behavior unchanged.
  if (isAlwaysOnTraceCategory(category)) return true
  if (!config.collectDebugTrace) return false
  if (!category) return true
  if (config.traceCategories.length === 0) return true
  return config.traceCategories.includes(category)
}
