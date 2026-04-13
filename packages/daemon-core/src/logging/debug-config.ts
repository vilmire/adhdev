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
  if (!config.collectDebugTrace) return false
  if (!category) return true
  if (config.traceCategories.length === 0) return true
  return config.traceCategories.includes(category)
}
