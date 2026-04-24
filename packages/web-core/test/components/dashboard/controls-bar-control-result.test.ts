import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ControlInvokeResult,
  ControlListResult,
  ControlSetResult,
  ProviderControlSchema,
} from '@adhdev/daemon-core'
import ControlsBar, {
  buildControlValueScriptArgs,
  extractControlListResult,
  extractControlMutationResult,
  getAuthoritativeControlValue,
  shouldAdoptListedCurrentValue,
  shouldHideBarControl,
} from '../../../src/components/dashboard/ControlsBar'

describe('ControlsBar typed controlResult consumption', () => {
  it('renders nothing when a provider has not declared typed controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
      }),
    )

    expect(html).toBe('')
  })

  it('renders nothing when controls exist but none belong in the bar', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        controls: [
          {
            id: 'model',
            type: 'select',
            label: 'Model',
            placement: 'menu',
          } satisfies ProviderControlSchema,
        ],
        controlValues: { model: 'gpt-5' },
      }),
    )

    expect(html).toBe('')
  })

  it('does not render controls marked hidden in the provider schema', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        controls: [
          {
            id: 'mode',
            type: 'select',
            label: 'Mode',
            placement: 'bar',
            hidden: true,
          } satisfies ProviderControlSchema,
        ],
        controlValues: { mode: 'plan' },
      }),
    )

    expect(html).toBe('')
  })

  it('keeps the Usage action visible for Antigravity-hosted Claude Code sessions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        hostIdeType: 'antigravity',
        providerType: 'claude-code-vscode',
        displayLabel: 'Claude Code',
        controls: [
          {
            id: 'usage',
            type: 'action',
            label: 'Usage',
            placement: 'bar',
            invokeScript: 'requestUsage',
          } satisfies ProviderControlSchema,
        ],
        controlValues: {},
      }),
    )

    expect(html).toContain('Usage')
  })

  it('keeps model and mode controls visible for Antigravity-hosted Codex sessions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        hostIdeType: 'antigravity',
        providerType: 'codex',
        displayLabel: 'Codex',
        controls: [
          {
            id: 'model',
            type: 'select',
            label: 'Model',
            placement: 'bar',
          } satisfies ProviderControlSchema,
          {
            id: 'mode',
            type: 'select',
            label: 'Mode',
            placement: 'bar',
          } satisfies ProviderControlSchema,
        ],
        controlValues: { model: 'GPT-5.4', mode: 'High' },
      }),
    )

    expect(html).toContain('GPT-5.4')
    expect(html).toContain('High')
  })

  it('hides low-value Claude CLI bar controls plus New for Antigravity, Claude Code (VS Code), and Codex providers', () => {
    const newControl = {
      id: 'new_session',
      type: 'action',
      label: 'New',
      placement: 'bar',
      invokeScript: 'newSession',
    } satisfies ProviderControlSchema
    const compactControl = {
      id: 'compact',
      type: 'toggle',
      label: 'Compact',
      placement: 'bar',
      setScript: 'setCompact',
    } satisfies ProviderControlSchema

    expect(shouldHideBarControl(undefined, 'antigravity', newControl)).toBe(true)
    expect(shouldHideBarControl(undefined, 'claude-code-vscode', newControl)).toBe(true)
    expect(shouldHideBarControl(undefined, 'codex', newControl)).toBe(true)
    expect(shouldHideBarControl(undefined, 'roo-code', newControl)).toBe(false)
    expect(shouldHideBarControl(undefined, 'claude-cli', newControl)).toBe(true)
    expect(shouldHideBarControl(undefined, 'claude-cli', compactControl)).toBe(true)
  })

  it('treats shouldHideBarControl as host-agnostic so provider rules apply regardless of hostIdeType', () => {
    const newControl = {
      id: 'new_session',
      type: 'action',
      label: 'New',
      placement: 'bar',
      invokeScript: 'newSession',
    } satisfies ProviderControlSchema
    const compactControl = {
      id: 'compact',
      type: 'toggle',
      label: 'Compact',
      placement: 'bar',
      setScript: 'setCompact',
    } satisfies ProviderControlSchema
    const modelControl = {
      id: 'model',
      type: 'select',
      label: 'Model',
      placement: 'bar',
    } satisfies ProviderControlSchema

    for (const host of [undefined, 'antigravity', 'claude-code-vscode', 'cursor', 'vscode'] as const) {
      expect(shouldHideBarControl(host, 'claude-cli', newControl)).toBe(true)
      expect(shouldHideBarControl(host, 'claude-cli', compactControl)).toBe(true)
      expect(shouldHideBarControl(host, 'claude-cli', modelControl)).toBe(false)
      expect(shouldHideBarControl(host, 'roo-code', newControl)).toBe(false)
    }
  })

  it('does not render the New action for Antigravity sessions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'antigravity',
        displayLabel: 'Antigravity',
        controls: [
          {
            id: 'model',
            type: 'select',
            label: 'Model',
            placement: 'bar',
          } satisfies ProviderControlSchema,
          {
            id: 'new_session',
            type: 'action',
            label: 'New',
            placement: 'bar',
            invokeScript: 'newSession',
          } satisfies ProviderControlSchema,
        ],
        controlValues: { model: 'Claude Opus 4.6 (Thinking)' },
      }),
    )

    expect(html).toContain('Claude Opus 4.6 (Thinking)')
    expect(html).not.toContain('>New<')
  })

  it('does not synthesize model values from legacy serverModel props when schema controls are present', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        controls: [
          {
            id: 'model',
            type: 'select',
            label: 'Model',
            placement: 'bar',
          } satisfies ProviderControlSchema,
        ],
        controlValues: {},
        serverModel: 'legacy-model',
      }),
    )

    expect(html).toContain('Model')
    expect(html).not.toContain('legacy-model')
  })

  it('renders the typed option label for the current select value', () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlsBar, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        controls: [
          {
            id: 'model',
            type: 'select',
            label: 'Model',
            placement: 'bar',
            options: [
              { value: 'gpt-5', label: 'GPT-5 (Default)' },
              { value: 'gpt-4.1', label: 'GPT-4.1 Fast' },
            ],
          } satisfies ProviderControlSchema,
        ],
        controlValues: { model: 'gpt-5' },
      }),
    )

    expect(html).toContain('GPT-5 (Default)')
    expect(html).not.toContain('>gpt-5<')
  })

  it('extracts dynamic select options only from typed controlResult payloads', () => {
    const typedResult: ControlListResult = {
      options: [
        { value: 'gpt-5', label: 'GPT-5' },
        { value: 'gpt-4.1', label: 'GPT-4.1' },
      ],
      currentValue: 'gpt-5',
    }

    expect(extractControlListResult({
      controlResult: typedResult,
      models: ['legacy-model'],
    })).toEqual(typedResult)

    expect(extractControlListResult({
      models: ['legacy-model'],
      current: 'legacy-model',
    })).toBeNull()
  })

  it('preserves typed option labels instead of collapsing dynamic options to raw values', () => {
    const typedResult: ControlListResult = {
      options: [
        { value: 'gpt-5', label: 'GPT-5 (Default)' },
        { value: 'gpt-4.1', label: 'GPT-4.1 Fast' },
      ],
      currentValue: 'gpt-5',
    }

    expect(extractControlListResult({ controlResult: typedResult })?.options).toEqual([
      { value: 'gpt-5', label: 'GPT-5 (Default)' },
      { value: 'gpt-4.1', label: 'GPT-4.1 Fast' },
    ])
  })

  it('extracts set/invoke outcomes only from typed controlResult payloads', () => {
    const typedSet: ControlSetResult = {
      ok: true,
      currentValue: 'plan',
    }
    const typedInvoke: ControlInvokeResult = {
      ok: false,
      error: 'bad request',
    }

    expect(extractControlMutationResult({ controlResult: typedSet, success: false })).toEqual(typedSet)
    expect(extractControlMutationResult({ controlResult: typedInvoke })).toEqual(typedInvoke)
    expect(extractControlMutationResult({
      success: true,
      value: 'legacy-plan',
    })).toBeNull()
  })

  // Cloud's sendDaemonCommand wraps the daemon response in `{ success, result }`.
  // Standalone passes the raw daemon response. Both shapes must resolve identically
  // — otherwise the control bar silently renders an empty dropdown on Cloud.
  it('extracts typed list results wrapped in a Cloud-style { result } envelope', () => {
    const typedResult: ControlListResult = {
      options: [{ value: 'sonnet', label: 'sonnet' }],
      currentValue: 'sonnet',
    }

    expect(extractControlListResult({
      success: true,
      result: { success: true, controlResult: typedResult },
    })).toEqual(typedResult)
  })

  it('extracts typed mutation results wrapped in a Cloud-style { result } envelope', () => {
    const typedSet: ControlSetResult = { ok: true, currentValue: 'plan' }

    expect(extractControlMutationResult({
      success: true,
      result: { success: true, controlResult: typedSet },
    })).toEqual(typedSet)
  })

  it('does not let stale list-script currentValue override an existing control value', () => {
    expect(shouldAdoptListedCurrentValue('default', 'sonnet')).toBe(false)
    expect(shouldAdoptListedCurrentValue('opus', 'sonnet')).toBe(false)
  })

  it('adopts list-script currentValue when no authoritative control value is known yet', () => {
    expect(shouldAdoptListedCurrentValue(undefined, 'sonnet')).toBe(true)
    expect(shouldAdoptListedCurrentValue('', 'sonnet')).toBe(true)
  })

  it('prefers the freshest local override before falling back to server control values', () => {
    expect(getAuthoritativeControlValue('model', {
      now: 100,
      localOverrideUntil: 200,
      localValues: { model: 'default' },
      controlValues: { model: 'sonnet' },
    })).toBe('default')

    expect(getAuthoritativeControlValue('model', {
      now: 300,
      localOverrideUntil: 200,
      localValues: { model: 'default' },
      controlValues: { model: 'sonnet' },
    })).toBe('sonnet')

    expect(getAuthoritativeControlValue('model', {
      now: 300,
      localOverrideUntil: 200,
      localValues: {},
      controlValues: undefined,
      defaultValues: { model: 'haiku' },
    })).toBe('haiku')
  })

  it('builds generic value-only script args for schema controls, including model and mode', () => {
    const modelControl = {
      id: 'model',
      type: 'select',
      label: 'Model',
      placement: 'bar',
    } satisfies ProviderControlSchema
    const modeControl = {
      id: 'mode',
      type: 'select',
      label: 'Mode',
      placement: 'bar',
    } satisfies ProviderControlSchema
    const effortControl = {
      id: 'effort',
      type: 'select',
      label: 'Effort',
      placement: 'bar',
    } satisfies ProviderControlSchema

    expect(buildControlValueScriptArgs(modelControl, 'gpt-5')).toEqual({ value: 'gpt-5' })
    expect(buildControlValueScriptArgs(modeControl, 'plan')).toEqual({ value: 'plan' })
    expect(buildControlValueScriptArgs(effortControl, 'high')).toEqual({ value: 'high' })
  })
})
