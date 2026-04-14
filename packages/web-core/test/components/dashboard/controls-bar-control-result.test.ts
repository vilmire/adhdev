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

    expect(extractControlMutationResult({
      controlResult: typedSet,
      success: false,
      value: 'legacy-plan',
    })).toEqual(typedSet)

    expect(extractControlMutationResult({ controlResult: typedInvoke })).toEqual(typedInvoke)

    expect(extractControlMutationResult({
      success: true,
      value: 'legacy-plan',
    })).toBeNull()
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
