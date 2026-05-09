import type { ProviderControlDef, ProviderControlType, ProviderModule } from './contracts.js'
import { providerHasOpenPanelSupport } from './open-panel-support.js'

const VALID_CAPABILITY_MEDIA_TYPES = new Set(['text', 'image', 'audio', 'video', 'resource'])
const VALID_INPUT_STRATEGIES = new Set(['native', 'native_acp', 'resource_link', 'text_fallback', 'paste', 'upload'])

const KNOWN_PROVIDER_FIELDS = new Set<string>([
  'type',
  'name',
  'category',
  'transcriptAuthority',
  'transcriptContext',
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
  'sessionIdPattern',
  'historyBehavior',
  'canonicalHistory',
  'autoFixProfile',
  'ideLevelScripts',
  'allowInputDuringGeneration',
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
  'meshCoordinator',
  'contractVersion',
  'capabilities',
  'providerVersion',
  'status',
  'details',
  'sendDelayMs',
  'sendKey',
  'submitStrategy',
  'requirePromptEchoBeforeSubmit',
  'timeouts',
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
  const typedProvider = provider as unknown as ProviderModule
  const controls = Array.isArray(provider.controls) ? provider.controls : []
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

  validateCapabilities(provider as unknown as ProviderModule, controls, errors)
  validateCanonicalHistory(provider.canonicalHistory, errors)
  validateMeshCoordinator(provider.meshCoordinator, errors)

  for (const control of controls) {
    validateControl(control as ProviderControlDef, errors)
  }

  if (
    (category === 'ide' || category === 'extension')
    && typeof typedProvider.scripts?.focusEditor === 'function'
    && !providerHasOpenPanelSupport(typedProvider)
  ) {
    warnings.push('scripts.focusEditor is present without scripts.openPanel/webviewOpenPanel; open_panel capability will remain disabled')
  }

  return { errors, warnings }
}

function validateCapabilities(provider: ProviderModule, controls: ProviderControlDef[], errors: string[]): void {
  const capabilities = provider.capabilities
  if (provider.contractVersion === 2) {
    if (!capabilities || typeof capabilities !== 'object') {
      errors.push('contractVersion 2 providers must declare capabilities')
      return
    }
  }
  if (!capabilities || typeof capabilities !== 'object') {
    return
  }

  const input = capabilities.input
  if (input !== undefined) {
    if (!input || typeof input !== 'object') {
      errors.push('capabilities.input must be an object when provided')
    } else if (typeof input.multipart !== 'boolean') {
      errors.push('capabilities.input.multipart must be boolean')
    }
    if (input && typeof input === 'object') {
      const mediaTypes = Array.isArray(input.mediaTypes) ? input.mediaTypes : undefined
      if (!mediaTypes || mediaTypes.length === 0) {
        errors.push('capabilities.input.mediaTypes must be a non-empty array')
      } else if (mediaTypes.some((type) => typeof type !== 'string' || !VALID_CAPABILITY_MEDIA_TYPES.has(type))) {
        errors.push(`capabilities.input.mediaTypes must only include: ${Array.from(VALID_CAPABILITY_MEDIA_TYPES).join(', ')}`)
      }
    }
    if (input && typeof input === 'object' && input.strategies !== undefined) {
      if (!Array.isArray(input.strategies)) {
        errors.push('capabilities.input.strategies must be an array when provided')
      } else {
        for (const strategy of input.strategies) {
          if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) {
            errors.push('capabilities.input.strategies entries must be objects')
            continue
          }
          const entry = strategy as Record<string, unknown>
          if (typeof entry.mediaType !== 'string' || !VALID_CAPABILITY_MEDIA_TYPES.has(entry.mediaType)) {
            errors.push(`capabilities.input.strategies.mediaType must only include: ${Array.from(VALID_CAPABILITY_MEDIA_TYPES).join(', ')}`)
          }
          for (const field of ['strategies', 'degradation'] as const) {
            const values = entry[field]
            if (values === undefined) continue
            if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !VALID_INPUT_STRATEGIES.has(value))) {
              errors.push(`capabilities.input.strategies.${field} must only include: ${Array.from(VALID_INPUT_STRATEGIES).join(', ')}`)
            }
          }
          if (entry.native !== undefined && typeof entry.native !== 'boolean') {
            errors.push('capabilities.input.strategies.native must be boolean when provided')
          }
        }
      }
    }
  }

  const output = capabilities.output
  if (!output || typeof output !== 'object') {
    errors.push('capabilities.output is required')
  } else {
    if (typeof output.richContent !== 'boolean') {
      errors.push('capabilities.output.richContent must be boolean')
    }
    if (!Array.isArray(output.mediaTypes) || output.mediaTypes.length === 0) {
      errors.push('capabilities.output.mediaTypes must be a non-empty array')
    } else if (output.mediaTypes.some((type) => typeof type !== 'string' || !VALID_CAPABILITY_MEDIA_TYPES.has(type))) {
      errors.push(`capabilities.output.mediaTypes must only include: ${Array.from(VALID_CAPABILITY_MEDIA_TYPES).join(', ')}`)
    }
  }

  const controlCapabilities = capabilities.controls
  if (!controlCapabilities || typeof controlCapabilities !== 'object') {
    errors.push('capabilities.controls is required')
    return
  }
  if (typeof controlCapabilities.typedResults !== 'boolean') {
    errors.push('capabilities.controls.typedResults must be boolean')
  }
  if (controls.length > 0 && controlCapabilities.typedResults !== true) {
    errors.push('providers declaring controls must set capabilities.controls.typedResults=true')
  }
}

function validateCanonicalHistory(raw: unknown, errors: string[]): void {
  if (raw === undefined) return
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('canonicalHistory must be an object')
    return
  }

  const canonicalHistory = raw as Record<string, unknown>
  const format = canonicalHistory.format
  if (format !== undefined && (typeof format !== 'string' || !format.trim())) {
    errors.push('canonicalHistory.format must be a non-empty string when provided')
  }

  const watchPath = canonicalHistory.watchPath
  if (watchPath !== undefined && (typeof watchPath !== 'string' || !watchPath.trim())) {
    errors.push('canonicalHistory.watchPath must be a non-empty string when provided')
  }

  const mode = canonicalHistory.mode
  if (mode !== undefined && !['native-source', 'materialized-mirror', 'disabled'].includes(String(mode))) {
    errors.push('canonicalHistory.mode must be one of: native-source, materialized-mirror, disabled')
  }

  const scripts = canonicalHistory.scripts
  if (scripts === undefined) return
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    errors.push('canonicalHistory.scripts must be an object')
    return
  }

  const scriptConfig = scripts as Record<string, unknown>
  for (const key of ['readSession', 'listSessions']) {
    const value = scriptConfig[key]
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`canonicalHistory.scripts.${key} must be a non-empty string`)
    }
  }
}

function validateMeshCoordinator(raw: unknown, errors: string[]): void {
  if (raw === undefined) return
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('meshCoordinator must be an object')
    return
  }

  const meshCoordinator = raw as Record<string, unknown>
  if (typeof meshCoordinator.supported !== 'boolean') {
    errors.push('meshCoordinator.supported must be boolean')
  }
  if (meshCoordinator.reason !== undefined && (typeof meshCoordinator.reason !== 'string' || !meshCoordinator.reason.trim())) {
    errors.push('meshCoordinator.reason must be a non-empty string when provided')
  }

  const mcpConfig = meshCoordinator.mcpConfig
  if (mcpConfig === undefined) return
  if (!mcpConfig || typeof mcpConfig !== 'object' || Array.isArray(mcpConfig)) {
    errors.push('meshCoordinator.mcpConfig must be an object')
    return
  }

  const config = mcpConfig as Record<string, unknown>
  const mode = config.mode
  if (!['auto_import', 'manual', 'none'].includes(String(mode))) {
    errors.push('meshCoordinator.mcpConfig.mode must be one of: auto_import, manual, none')
  }

  const format = config.format
  if (format !== undefined && !['claude_mcp_json', 'hermes_config_yaml'].includes(String(format))) {
    errors.push('meshCoordinator.mcpConfig.format must be one of: claude_mcp_json, hermes_config_yaml')
  }

  for (const key of ['path', 'serverName', 'configPathCommand', 'instructions', 'template']) {
    const value = config[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      errors.push(`meshCoordinator.mcpConfig.${key} must be a non-empty string when provided`)
    }
  }

  if (config.requiresRestart !== undefined && typeof config.requiresRestart !== 'boolean') {
    errors.push('meshCoordinator.mcpConfig.requiresRestart must be boolean when provided')
  }

  if (mode === 'auto_import') {
    if (format === undefined) {
      errors.push('meshCoordinator.mcpConfig.format is required for auto_import MCP setup')
    }
    if (typeof config.path !== 'string' || !config.path.trim()) {
      errors.push('meshCoordinator.mcpConfig.path is required for auto_import MCP setup')
    }
  }

  if (mode === 'manual') {
    if (typeof config.instructions !== 'string' || !config.instructions.trim()) {
      errors.push('meshCoordinator.mcpConfig.instructions is required for manual MCP setup')
    }
    if (typeof config.template !== 'string' || !config.template.trim()) {
      errors.push('meshCoordinator.mcpConfig.template is required for manual MCP setup')
    }
  }
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
