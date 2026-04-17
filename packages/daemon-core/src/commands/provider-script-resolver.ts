export type LegacyStringScript = (params?: Record<string, unknown> | string) => string | null | undefined

export function resolveLegacyProviderScript(
  fn: LegacyStringScript | null | undefined,
  scriptName: string,
  params?: Record<string, unknown> | string,
): string | null {
  if (typeof fn !== 'function') return null

  if (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length > 0) {
    const firstVal = Object.values(params)[0]

    if (scriptName === 'sendMessage' && typeof firstVal === 'string') {
      const legacyScript = fn(firstVal)
      if (legacyScript) return legacyScript
    }

    const script = fn(params)
    const likelyLegacyObjectLeak =
      typeof script === 'string'
      && script.includes('[object Object]')
      && typeof firstVal === 'string'
    if (!likelyLegacyObjectLeak && script) return script

    if (firstVal !== undefined) {
      const legacyScript = fn(firstVal as string)
      if (legacyScript) return legacyScript
    }

    if (script) return script
    return null
  }

  if (params !== undefined) {
    const script = fn(params)
    if (script) return script
  }

  return fn() || null
}