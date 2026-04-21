import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

function buildAdapter() {
  const adapter = new ProviderCliAdapter({
    type: 'hermes-cli',
    name: 'Hermes Agent',
    category: 'cli',
    binary: 'hermes',
    spawn: { command: 'hermes', args: [], shell: true, env: {} },
    allowInputDuringGeneration: true,
    scripts: {
      detectStatus: () => 'generating',
      parseOutput: () => ({ status: 'generating', messages: [] }),
      parseApproval: () => null,
    },
  } as any, '/tmp/project') as any

  adapter.terminalScreen = { write: vi.fn(), getText: () => '' }
  adapter.scheduleSettle = vi.fn()
  adapter.resolveStartupState = vi.fn()
  return adapter
}

describe('ProviderCliAdapter turn scope offset drift', () => {
  it('shifts currentTurnScope offsets when the rolling accumulated buffer truncates', () => {
    const adapter = buildAdapter()
    const MAX = (ProviderCliAdapter as any).MAX_ACCUMULATED_BUFFER as number

    // Pre-fill the accumulated buffer close to the cap.
    const preFill = 'x'.repeat(MAX - 1000)
    adapter.handleOutput(preFill)
    expect(adapter.accumulatedBuffer.length).toBe(MAX - 1000)

    // Simulate a turn starting at the current absolute offset.
    const turnStart = adapter.accumulatedBuffer.length
    adapter.currentTurnScope = {
      prompt: 'hello',
      startedAt: Date.now(),
      bufferStart: turnStart,
      rawBufferStart: adapter.accumulatedRawBuffer.length,
    }
    adapter.isWaitingForResponse = true

    // Pour in 3000 bytes of turn output → buffer overflows by 2000 and
    // sheds the oldest bytes. The turn-scope offsets must move in lockstep
    // so sliceFromOffset still returns the full turn tail.
    const turnOutput = 'y'.repeat(3000)
    adapter.handleOutput(turnOutput)

    expect(adapter.accumulatedBuffer.length).toBe(MAX)
    expect(adapter.currentTurnScope.bufferStart).toBe(turnStart - 2000)
    expect(adapter.currentTurnScope.rawBufferStart).toBeLessThanOrEqual(turnStart - 2000 + 1)

    const sliced = adapter.accumulatedBuffer.slice(adapter.currentTurnScope.bufferStart)
    expect(sliced.length).toBe(turnOutput.length)
    expect(sliced).toBe(turnOutput)
  })

  it('clamps scope offsets to zero when the entire turn prefix is shed', () => {
    const adapter = buildAdapter()
    const MAX = (ProviderCliAdapter as any).MAX_ACCUMULATED_BUFFER as number

    adapter.handleOutput('x'.repeat(100))
    adapter.currentTurnScope = {
      prompt: 'hi',
      startedAt: Date.now(),
      bufferStart: 50,
      rawBufferStart: 50,
    }
    adapter.isWaitingForResponse = true

    // Far larger than MAX → every byte of the original prefix is shed.
    adapter.handleOutput('y'.repeat(MAX + 5000))

    expect(adapter.accumulatedBuffer.length).toBe(MAX)
    expect(adapter.currentTurnScope.bufferStart).toBe(0)
    expect(adapter.currentTurnScope.rawBufferStart).toBe(0)
  })

  it('leaves scope offsets unchanged when the buffer stays below the cap', () => {
    const adapter = buildAdapter()

    adapter.handleOutput('hello ')
    adapter.currentTurnScope = {
      prompt: 'x',
      startedAt: Date.now(),
      bufferStart: adapter.accumulatedBuffer.length,
      rawBufferStart: adapter.accumulatedRawBuffer.length,
    }
    adapter.isWaitingForResponse = true

    const before = {
      bufferStart: adapter.currentTurnScope.bufferStart,
      rawBufferStart: adapter.currentTurnScope.rawBufferStart,
    }

    adapter.handleOutput('world')

    expect(adapter.currentTurnScope.bufferStart).toBe(before.bufferStart)
    expect(adapter.currentTurnScope.rawBufferStart).toBe(before.rawBufferStart)
  })
})
