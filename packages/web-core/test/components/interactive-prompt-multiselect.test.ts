import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

const MODAL = 'components/interactive-prompt/InteractivePromptModal.tsx'

describe('InteractivePromptModal multi-select rendering', () => {
  it('OptionButton accepts a multiSelect prop', () => {
    const source = readSource(MODAL)
    // The prop must be part of the OptionButton signature so it can drive the indicator shape.
    expect(source).toMatch(/multiSelect\?\s*:\s*boolean/)
  })

  it('renders a square checkbox for multi-select and a round radio for single-select', () => {
    const source = readSource(MODAL)
    // The indicator shape must be conditional on multiSelect — square (rounded-sm) when multi,
    // round (rounded-full) when single. A hardcoded rounded-full would be the original bug.
    expect(source).toContain("multiSelect ? 'rounded-sm' : 'rounded-full'")
    // The indicator span must not unconditionally hardcode the radio shape any more.
    expect(source).not.toMatch(/rounded-full border\b/)
  })

  it('passes the question multiSelect flag down to OptionButton', () => {
    const source = readSource(MODAL)
    expect(source).toContain('multiSelect={currentQuestion.multiSelect}')
  })

  it('exposes accessible role/state for the choice group and options', () => {
    const source = readSource(MODAL)
    // Group semantics differ by selection mode.
    expect(source).toContain("currentQuestion.multiSelect ? 'group' : 'radiogroup'")
    // Each option exposes radio/checkbox semantics.
    expect(source).toContain("multiSelect ? 'checkbox' : 'radio'")
    expect(source).toContain('aria-checked={selected}')
  })

  it('shows a "Select all that apply" hint for multi-select questions', () => {
    const source = readSource(MODAL)
    expect(source).toContain('Select all that apply')
  })

  it('toggle logic still accumulates selections for multi-select (regression guard)', () => {
    const source = readSource(MODAL)
    // The existing toggleOption logic appends/removes for multiSelect and replaces otherwise.
    expect(source).toContain('question.multiSelect')
    expect(source).toMatch(/selectedLabels:\s*nextLabels/)
  })
})
