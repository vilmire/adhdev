import { describe, expect, it } from 'vitest'
import { validateProviderDefinition } from '../../src/providers/provider-schema.js'

describe('validateProviderDefinition', () => {
  const baseCapabilities = {
    input: { multipart: false, mediaTypes: ['text'] },
    output: { richContent: false, mediaTypes: ['text'] },
    controls: { typedResults: true },
  }

  const providerWithModes = (autoApproveModes: unknown) => ({
    type: 'mock-modes-cli',
    name: 'Mock Modes CLI',
    category: 'cli',
    spawn: { command: 'mock-modes' },
    autoApproveModes,
  })

  it('accepts valid auto-approve modes', () => {
    const result = validateProviderDefinition(providerWithModes({
      default: 'parsed',
      modes: [
        { id: 'parsed', label: 'Parsed approvals', strategy: 'pty-parse-default', risk: 'safe' },
        {
          id: 'yolo',
          label: 'Skip permissions',
          strategy: 'launch-args',
          risk: 'dangerous',
          warning: 'All permission checks are disabled.',
          launchArgs: ['--dangerously-skip-permissions'],
          removeArgs: ['--permission-mode'],
        },
      ],
    }))

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('rejects invalid auto-approve mode defaults, enums, and required security fields', () => {
    const missingDefault = validateProviderDefinition(providerWithModes({
      default: 'missing',
      modes: [{ id: 'parsed', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' }],
    }))
    expect(missingDefault.errors).toContain('autoApproveModes.default must reference an existing mode id: missing')

    const duplicateId = validateProviderDefinition(providerWithModes({
      default: 'same',
      modes: [
        { id: 'same', label: 'First', strategy: 'pty-parse-default', risk: 'safe' },
        { id: 'same', label: 'Second', strategy: 'pty-parse-default', risk: 'safe' },
      ],
    }))
    expect(duplicateId.errors).toContain('autoApproveModes.modes[1].id must be unique (duplicate: same)')

    const invalidEnums = validateProviderDefinition(providerWithModes({
      default: 'invalid',
      modes: [{ id: 'invalid', label: 'Invalid', strategy: 'telepathy', risk: 'extreme' }],
    }))
    expect(invalidEnums.errors).toContain('autoApproveModes.modes[0].strategy must be one of: pty-parse-default, launch-args, post-boot-command')
    expect(invalidEnums.errors).toContain('autoApproveModes.modes[0].risk must be one of: safe, caution, dangerous')

    const missingLaunchArgs = validateProviderDefinition(providerWithModes({
      default: 'launch',
      modes: [{ id: 'launch', label: 'Launch', strategy: 'launch-args', risk: 'safe' }],
    }))
    expect(missingLaunchArgs.errors).toContain('autoApproveModes.modes[0].launchArgs must be a non-empty array for launch-args strategy')

    const missingWarning = validateProviderDefinition(providerWithModes({
      default: 'danger',
      modes: [{ id: 'danger', label: 'Danger', strategy: 'launch-args', risk: 'dangerous', launchArgs: ['--unsafe'] }],
    }))
    expect(missingWarning.errors).toContain('autoApproveModes.modes[0].warning is required for dangerous modes')
  })

  it('derives dangerous risk from known launch flags so a provider cannot disguise it as safe', () => {
    const definition = providerWithModes({
      default: 'disguised',
      modes: [{
        id: 'disguised',
        label: 'Disguised',
        strategy: 'launch-args',
        risk: 'safe',
        warning: 'This bypasses the approval sandbox.',
        launchArgs: ['-c', 'approval_policy=never'],
      }],
    })
    const result = validateProviderDefinition(definition)

    expect(result.errors).toEqual([])
    expect((definition.autoApproveModes as any).modes[0].risk).toBe('dangerous')

    const missingDerivedWarning = validateProviderDefinition(providerWithModes({
      default: 'disguised',
      modes: [{
        id: 'disguised',
        label: 'Disguised',
        strategy: 'launch-args',
        risk: 'safe',
        launchArgs: ['sandbox_mode=danger-full-access'],
      }],
    }))
    expect(missingDerivedWarning.errors).toContain('autoApproveModes.modes[0].warning is required for dangerous modes')

    const claudeBypass = providerWithModes({
      default: 'yolo',
      modes: [{
        id: 'yolo',
        label: 'Bypass permissions',
        strategy: 'launch-args',
        risk: 'caution',
        warning: 'All permission checks are bypassed.',
        launchArgs: ['--permission-mode', 'bypassPermissions'],
      }],
    })
    expect(validateProviderDefinition(claudeBypass).errors).toEqual([])
    expect((claudeBypass.autoApproveModes as any).modes[0].risk).toBe('dangerous')
  })

  it('rejects the reserved post-boot-command strategy in v1', () => {
    const result = validateProviderDefinition(providerWithModes({
      default: 'future',
      modes: [{ id: 'future', label: 'Future', strategy: 'post-boot-command', risk: 'safe' }],
    }))
    expect(result.errors).toContain('autoApproveModes.modes[0].strategy post-boot-command is reserved and unsupported in v1')
  })

  it('accepts a valid CLI provider with typed controls and explicit capabilities', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      controls: [
        {
          id: 'model',
          type: 'select',
          label: 'Model',
          placement: 'bar',
          dynamic: true,
          listScript: 'listModels',
          setScript: 'setModel',
          readFrom: 'model',
        },
        {
          id: 'new_session',
          type: 'action',
          label: 'New Session',
          placement: 'menu',
          invokeScript: 'newSession',
        },
      ],
      contractVersion: 2,
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('accepts omitted input capabilities as text-only default and validates input strategy descriptors', () => {
    const result = validateProviderDefinition({
      type: 'future-acp',
      name: 'Future ACP',
      category: 'acp',
      spawn: { command: 'future-acp' },
      capabilities: {
        output: { richContent: false, mediaTypes: ['text'] },
        controls: { typedResults: true },
      },
      contractVersion: 2,
    })
    expect(result.errors).not.toContain('capabilities.input is required')

    const strategyResult = validateProviderDefinition({
      type: 'future-acp',
      name: 'Future ACP',
      category: 'acp',
      spawn: { command: 'future-acp' },
      capabilities: {
        input: {
          multipart: true,
          mediaTypes: ['text', 'image'],
          strategies: [
            { mediaType: 'image', strategies: ['native_acp'], native: true, degradation: ['resource_link', 'text_fallback'] },
          ],
        },
        output: { richContent: false, mediaTypes: ['text'] },
        controls: { typedResults: true },
      },
      contractVersion: 2,
    })
    expect(strategyResult.errors).toEqual([])
  })

  it('rejects contractVersion 2 providers that omit capabilities', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      contractVersion: 2,
    })

    expect(result.errors).toContain('contractVersion 2 providers must declare capabilities')
  })

  it('rejects providers with malformed capabilities metadata', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      contractVersion: 2,
      capabilities: {
        input: { multipart: 'yes', mediaTypes: ['text', 'bogus'] },
        output: { richContent: 'no', mediaTypes: [] },
        controls: { typedResults: 'sometimes' },
      },
    })

    expect(result.errors).toContain('capabilities.input.multipart must be boolean')
    expect(result.errors).toContain('capabilities.input.mediaTypes must only include: text, image, audio, video, resource')
    expect(result.errors).toContain('capabilities.output.richContent must be boolean')
    expect(result.errors).toContain('capabilities.output.mediaTypes must be a non-empty array')
    expect(result.errors).toContain('capabilities.controls.typedResults must be boolean')
  })

  it('rejects providers with controls that do not declare typed control results', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      contractVersion: 2,
      capabilities: {
        input: { multipart: false, mediaTypes: ['text'] },
        output: { richContent: false, mediaTypes: ['text'] },
        controls: { typedResults: false },
      },
      controls: [
        {
          id: 'model',
          type: 'select',
          label: 'Model',
          placement: 'bar',
          dynamic: true,
          listScript: 'listModels',
          setScript: 'setModel',
        },
      ],
    })

    expect(result.errors).toContain('providers declaring controls must set capabilities.controls.typedResults=true')
  })

  it('rejects dynamic controls without a list script', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      controls: [
        {
          id: 'model',
          type: 'select',
          label: 'Model',
          placement: 'bar',
          dynamic: true,
          setScript: 'setModel',
        },
      ],
    })

    expect(result.errors).toContain('controls.model: dynamic controls require listScript')
  })

  it('rejects action controls without invokeScript', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      controls: [
        {
          id: 'clear_context',
          type: 'action',
          label: 'Clear Context',
          placement: 'menu',
        },
      ],
    })

    expect(result.errors).toContain('controls.clear_context: action controls require invokeScript')
  })

  it('rejects value controls without setScript', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      controls: [
        {
          id: 'auto_approve',
          type: 'toggle',
          label: 'Auto Approve',
          placement: 'bar',
        },
      ],
    })

    expect(result.errors).toContain('controls.auto_approve: toggle controls require setScript')
  })

  it('accepts provider-owned native history script entrypoints in canonicalHistory', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      nativeHistory: {
        format: 'foo-native-jsonl',
        watchPath: '~/.foo/sessions/**/*.jsonl',
        mode: 'native-source',
        scripts: {
          readSession: 'readNativeHistory',
          listSessions: 'listNativeHistory',
        },
      },
    })

    expect(result.errors).toEqual([])
  })

  it('rejects malformed provider-owned native history script entrypoints', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      nativeHistory: {
        format: '',
        watchPath: '',
        mode: 'unknown-mode',
        scripts: {
          readSession: '',
        },
      },
    })

    expect(result.errors).toContain('nativeHistory.format must be a non-empty string when provided')
    expect(result.errors).toContain('nativeHistory.watchPath must be a non-empty string when provided')
    expect(result.errors).toContain('nativeHistory.mode must be one of: native-source, materialized-mirror, disabled')
    expect(result.errors).toContain('nativeHistory.scripts.readSession must be a non-empty string')
    expect(result.errors).toContain('nativeHistory.scripts.listSessions must be a non-empty string')
  })

  it('accepts provider-owned transcript manifest fields without unknown field warnings', () => {
    const result = validateProviderDefinition({
      type: 'hermes-cli',
      name: 'Hermes CLI',
      category: 'cli',
      spawn: { command: 'hermes' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      transcriptAuthority: 'provider',
      transcriptContext: 'tail',
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).not.toContain('Unknown provider field: transcriptAuthority')
    expect(result.warnings).not.toContain('Unknown provider field: transcriptContext')
  })

  it('accepts mesh coordinator auto-import MCP metadata without unknown field warnings', () => {
    const result = validateProviderDefinition({
      type: 'claude-cli',
      name: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'auto_import',
          format: 'claude_mcp_json',
          path: '.mcp.json',
          serverName: 'adhdev-mesh',
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).not.toContain('Unknown provider field: meshCoordinator')
  })

  it('accepts provider-declared delegated worker isolation rules', () => {
    const result = validateProviderDefinition({
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          instructions: 'Register adhdev-mesh with Codex.',
          template: 'codex mcp add {{serverName}} -- {{adhdevMcpCommand}} {{adhdevMcpArgs}}',
        },
        delegatedWorkerIsolation: {
          env: { unset: ['ADHDEV_INLINE_MESH'] },
          args: [
            {
              mode: 'config_override',
              flag: '-c',
              key: 'mcp_servers.adhdev-mesh.enabled',
              value: 'false',
              dedupeKey: 'mcp_servers.adhdev-mesh',
            },
            {
              mode: 'empty_mcp_config',
              flag: '--mcp-config',
              strictFlag: '--strict-mcp-config',
            },
          ],
        },
      },
    })

    expect(result.errors).toEqual([])
  })

  it('accepts mesh coordinator manual MCP metadata with actionable instructions', () => {
    const result = validateProviderDefinition({
      type: 'hermes-cli',
      name: 'Hermes CLI',
      category: 'cli',
      spawn: { command: 'hermes' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
          instructions: 'Add this server to Hermes config under mcp_servers.',
          template: 'mcp_servers:\n  adhdev-mesh:\n    command: {{adhdevMcpCommand}}\n',
          requiresRestart: true,
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).not.toContain('Unknown provider field: meshCoordinator')
  })

  it('rejects malformed mesh coordinator metadata that could create false-success launches', () => {
    const result = validateProviderDefinition({
      type: 'broken-cli',
      name: 'Broken CLI',
      category: 'cli',
      spawn: { command: 'broken' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      meshCoordinator: {
        supported: true,
        mcpConfig: {
          mode: 'manual',
          format: 'hermes_config_yaml',
        },
      },
    })

    expect(result.errors).toContain('meshCoordinator.mcpConfig.instructions is required for manual MCP setup')
  })

  it('warns when focusEditor is declared without any openPanel script, because open_panel capability will stay disabled', () => {
    const result = validateProviderDefinition({
      type: 'foo-ide',
      name: 'Foo IDE',
      category: 'ide',
      cli: 'foo',
      contractVersion: 2,
      capabilities: {
        input: { multipart: false, mediaTypes: ['text'] },
        output: { richContent: false, mediaTypes: ['text'] },
        controls: { typedResults: false },
      },
      scripts: {
        readChat: () => '(() => JSON.stringify({ status: "idle", messages: [] }))()',
        focusEditor: () => '(() => JSON.stringify({ focused: true }))()',
      },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('scripts.focusEditor is present without scripts.openPanel/webviewOpenPanel; open_panel capability will remain disabled')
  })

  it('warns that provider-level disableUpstream is deprecated while still accepting runtime metadata', () => {
    const result = validateProviderDefinition({
      type: 'foo-cli',
      name: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      providerVersion: '1.0.0',
      sendDelayMs: 500,
      sendKey: '\\r',
      submitStrategy: 'immediate',
      disableUpstream: true,
      status: 'Stable',
      details: 'Inventory metadata',
      contractVersion: 2,
      capabilities: {
        input: { multipart: false, mediaTypes: ['text'] },
        output: { richContent: false, mediaTypes: ['text'] },
        controls: { typedResults: false },
      },
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('disableUpstream is deprecated in provider definitions; use machine-level provider source policy instead')
  })

  it('passes schema validation without allowInputDuringGeneration', () => {
    const result = validateProviderDefinition({
      type: 'future-cli',
      name: 'Future CLI',
      category: 'cli',
      spawn: { command: 'future' },
      capabilities: baseCapabilities,
      contractVersion: 2,
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('warns when a manifest still declares the deprecated allowInputDuringGeneration field', () => {
    const result = validateProviderDefinition({
      type: 'legacy-cli',
      name: 'Legacy CLI',
      category: 'cli',
      spawn: { command: 'legacy' },
      capabilities: baseCapabilities,
      contractVersion: 2,
      allowInputDuringGeneration: true,
    })

    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('Unknown provider field: allowInputDuringGeneration')
  })
})
