import type { ProviderControlDef, ProviderControlType, ProviderModule } from './contracts.js'

const KNOWN_PROVIDER_FIELDS = new Set<string>([
  'type',
  'name',
  'category',
  'aliases',
  'cdpPorts',
  'targetFilter',
  'cli',
  'icon',
  'displayName',
  'install',
  'versionCommand',
  'testedVersions',
  'processNames',
  'launch',
  'paths',
  'extensionId',
  'extensionIdPattern',
  'extensionIdPattern_flags',
  'compatibility',
  'defaultScriptDir',
  'binary',
  'spawn',
  'approvalKeys',
  'patterns',
  'cleanOutput',
  'resume',
  'sessionProbe',
  'approvalPositiveHints',
  'scripts',
  'vscodeCommands',
  'inputMethod',
  'inputSelector',
  'webviewMatchText',
  'os',
  'versions',
  'overrides',
  'settings',
  'controls',
  'staticConfigOptions',
  'spawnArgBuilder',
  'auth',
  'contractVersion',
  'capabilities',
  'providerVersion',
  'status',
  'details',
  'sendDelayMs',
  'sendKey',
  'submitStrategy',
  'disableUpstream',
])

const VALUE_CONTROL_TYPES = new Set<ProviderControlType>(['select', 'toggle', 'cycle', 'slider'])

export interface ProviderValidationResult {
  errors: string[]
  warnings: string[]
}

export function validateProviderDefinition(raw: unknown): ProviderValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!raw || typeof raw !== 'object') {
    return { errors: ['Provider definition must be an object'], warnings }
  }

  const provider = raw as Record<string, unknown>

  if (!provider.type) errors.push('Missing required field: type')
  if (!provider.name) errors.push('Missing required field: name')
  if (!provider.category) {
    errors.push('Missing required field: category')
  } else if (!['ide', 'extension', 'cli', 'acp'].includes(String(provider.category))) {
    errors.push(`Invalid category: ${String(provider.category)}`)
  }

  for (const key of Object.keys(provider)) {
    if (!KNOWN_PROVIDER_FIELDS.has(key)) {
      warnings.push(`Unknown provider field: ${key}`)
    }
  }
  if (provider.disableUpstream !== undefined) {
    warnings.push('disableUpstream is deprecated in provider definitions; use machine-level provider source policy instead')
  }

  const category = provider.category
  if ((category === 'cli' || category === 'acp')) {
    const spawn = provider.spawn
    const command = spawn && typeof spawn === 'object'
      ? (spawn as Record<string, unknown>).command
      : undefined
    if (!spawn || typeof spawn !== 'object') {
      errors.push(`${String(category).toUpperCase()}/CLI providers must have spawn config`)
    } else if (typeof command !== 'string' || !command.trim()) {
      errors.push('spawn.command is required')
    }
  }

  if ((category === 'ide' || category === 'extension') && provider.cdpPorts !== undefined) {
    if (!Array.isArray(provider.cdpPorts) || provider.cdpPorts.length === 0) {
      warnings.push('IDE/Extension providers should have cdpPorts')
    }
  }

  if (category === 'extension' && !provider.extensionId) {
    warnings.push('Extension providers should have extensionId')
  }

  for (const control of Array.isArray(provider.controls) ? provider.controls : []) {
    validateControl(control as ProviderControlDef, errors)
  }

  return { errors, warnings }
}

function validateControl(control: ProviderControlDef, errors: string[]): void {
  if (!control || typeof control !== 'object') {
    errors.push('controls: each control must be an object')
    return
  }

  const id = typeof control.id === 'string' && control.id.trim() ? control.id.trim() : 'unknown'
  const prefix = `controls.${id}`

  if (!control.id || !String(control.id).trim()) errors.push(`${prefix}: id is required`)
  if (!control.type) errors.push(`${prefix}: type is required`)
  if (!control.label || !String(control.label).trim()) errors.push(`${prefix}: label is required`)
  if (!control.placement) errors.push(`${prefix}: placement is required`)

  if (control.dynamic && !control.listScript) {
    errors.push(`${prefix}: dynamic controls require listScript`)
  }

  if (VALUE_CONTROL_TYPES.has(control.type) && !control.setScript) {
    errors.push(`${prefix}: ${control.type} controls require setScript`)
  }

  if (control.type === 'action' && !control.invokeScript) {
    errors.push(`${prefix}: action controls require invokeScript`)
  }

  if (control.type === 'slider') {
    if (typeof control.min !== 'number' || typeof control.max !== 'number') {
      errors.push(`${prefix}: slider controls require numeric min and max`)
    } else if (control.min > control.max) {
      errors.push(`${prefix}: slider min cannot exceed max`)
    }
  }

  if (control.readFrom !== undefined && (typeof control.readFrom !== 'string' || !control.readFrom.trim())) {
    errors.push(`${prefix}: readFrom must be a non-empty string when provided`)
  }
}
