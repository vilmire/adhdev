import { describe, expect, it } from 'vitest'
import { validateProviderDefinition } from '../../src/providers/provider-schema.js'

describe('validateProviderDefinition', () => {
  const baseCapabilities = {
    input: { multipart: false, mediaTypes: ['text'] },
    output: { richContent: false, mediaTypes: ['text'] },
    controls: { typedResults: true },
  }

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
      canonicalHistory: {
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
      canonicalHistory: {
        format: '',
        watchPath: '',
        mode: 'unknown-mode',
        scripts: {
          readSession: '',
        },
      },
    })

    expect(result.errors).toContain('canonicalHistory.format must be a non-empty string when provided')
    expect(result.errors).toContain('canonicalHistory.watchPath must be a non-empty string when provided')
    expect(result.errors).toContain('canonicalHistory.mode must be one of: native-source, materialized-mirror, disabled')
    expect(result.errors).toContain('canonicalHistory.scripts.readSession must be a non-empty string')
    expect(result.errors).toContain('canonicalHistory.scripts.listSessions must be a non-empty string')
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
})
