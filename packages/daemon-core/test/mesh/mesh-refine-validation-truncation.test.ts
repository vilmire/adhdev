import { describe, expect, it } from 'vitest'
import { truncateValidationOutput } from '../../src/mesh/mesh-refine-gates'

describe('truncateValidationOutput', () => {
  it('returns short input unchanged (no truncation marker)', () => {
    const text = 'ok\n'
    expect(truncateValidationOutput(text)).toBe(text)
  })

  it('returns input at exactly the budget unchanged', () => {
    const text = 'x'.repeat(8000)
    expect(truncateValidationOutput(text)).toBe(text)
  })

  it('keeps both head and tail, dropping only the middle, for oversized input', () => {
    const head = 'HEAD-MARKER-' + 'a'.repeat(5000)
    const tail = 'b'.repeat(5000) + '-TAIL-MARKER'
    const text = head + tail
    const result = truncateValidationOutput(text)
    expect(result).toContain('HEAD-MARKER-')
    expect(result).toContain('-TAIL-MARKER')
    expect(result).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/)
  })

  it('preserves the last line of oversized output (the verdict line)', () => {
    const noise = '[adhdev] Ignoring sibling daemon banner\n'.repeat(100)
    const verdict = '\nTest Files 1 failed | 42 passed (43)\nFAIL src/foo.test.ts\n'
    const text = noise + verdict
    const result = truncateValidationOutput(text)
    expect(result.endsWith(verdict.trimEnd()) || result.includes('Test Files 1 failed')).toBe(true)
    expect(result).toContain('FAIL src/foo.test.ts')
  })

  it('reproduces the real incident: FAIL line at char 4523 survives, and is lost under the old head-only 2000-char cut', () => {
    const bootstrapNoise = '[adhdev] Ignoring sibling daemon lockfile at /tmp/x\n'.repeat(50)
      + "warning: You appear to have cloned an empty repository.\n".repeat(30)
    const failLine = 'Test Files  1 failed | 12 passed (13)\n'
    const text = bootstrapNoise + failLine
    expect(text.length).toBeGreaterThan(2000)

    // Old behavior (head-only 2000 chars) would have dropped the FAIL line.
    const oldHeadOnly = text.slice(0, 2000)
    expect(oldHeadOnly).not.toContain('Test Files  1 failed')

    // New behavior preserves it.
    const result = truncateValidationOutput(text)
    expect(result).toContain('Test Files  1 failed')
  })

  it('handles non-string / nullish input like the old implementation', () => {
    expect(truncateValidationOutput(undefined)).toBe('')
    expect(truncateValidationOutput(null)).toBe('')
    expect(truncateValidationOutput(42)).toBe('42')
  })
})
