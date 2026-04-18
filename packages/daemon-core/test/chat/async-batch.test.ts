import { describe, expect, it } from 'vitest'
import { runAsyncBatch } from '../../src/chat/async-batch.js'

describe('runAsyncBatch', () => {
  it('processes every item', async () => {
    const seen: number[] = []
    await runAsyncBatch([1, 2, 3], async (item) => {
      seen.push(item)
    }, { concurrency: 2 })

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('respects concurrency greater than one', async () => {
    let active = 0
    let maxActive = 0

    await runAsyncBatch([1, 2, 3, 4], async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
    }, { concurrency: 3 })

    expect(maxActive >= 2).toBe(true)
  })
})
