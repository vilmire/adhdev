/**
 * Mesh RPC chunking — boundary behaviour.
 *
 * The DoD for the image-over-mesh work names three things this file pins down:
 * behaviour either side of the inline threshold, behaviour at the chunk boundary,
 * and an EXPLICIT refusal (never a silent truncation) past the cap. The failure
 * cases matter more than the happy path: a chunking bug that drops or reorders a
 * slice would otherwise surface as a corrupted prompt reaching a worker agent.
 */

import { describe, it, expect } from 'vitest'
import {
  splitMeshFrame,
  meshFrameNeedsChunking,
  meshUtf8ByteLength,
  MeshChunkAssembler,
  MESH_MAX_INLINE_FRAME_BYTES,
  MESH_MAX_CHUNKS,
  MESH_CHUNK_KIND,
  MESH_CHUNK_TTL_MS,
  measureWorstCaseChunkEnvelopeBytes,
  type MeshChunkEnvelope,
} from '../src/rpc-chunking'

const VERSION = 1

/** Round-trip helper: split a frame and feed every chunk through an assembler. */
function roundTrip(frame: unknown, chunkId = 'c1'): unknown {
  const json = JSON.stringify(frame)
  const split = splitMeshFrame(json, chunkId, VERSION)
  if (!split.ok) throw new Error(`split failed: ${split.reason}`)
  const assembler = new MeshChunkAssembler()
  let last: ReturnType<MeshChunkAssembler['accept']> | undefined
  for (const chunk of split.chunks) last = assembler.accept(chunk)
  if (last?.status !== 'complete') throw new Error(`expected complete, got ${last?.status}`)
  return last.frame
}

describe('inline threshold', () => {
  it('does not chunk a frame at or under the inline ceiling', () => {
    const json = JSON.stringify({ kind: 'rpc_req', pad: 'x'.repeat(1000) })
    expect(meshUtf8ByteLength(json)).toBeLessThan(MESH_MAX_INLINE_FRAME_BYTES)
    expect(meshFrameNeedsChunking(json)).toBe(false)
  })

  it('chunks a frame just over the inline ceiling', () => {
    const json = 'x'.repeat(MESH_MAX_INLINE_FRAME_BYTES + 1)
    expect(meshFrameNeedsChunking(json)).toBe(true)
  })

  it('treats the exact ceiling as inline (boundary is inclusive)', () => {
    const json = 'x'.repeat(MESH_MAX_INLINE_FRAME_BYTES)
    expect(meshUtf8ByteLength(json)).toBe(MESH_MAX_INLINE_FRAME_BYTES)
    expect(meshFrameNeedsChunking(json)).toBe(false)
  })

  it('counts BYTES not characters — multi-byte text crosses earlier', () => {
    // '한' is 3 bytes in UTF-8, so a string of well under the ceiling in characters
    // is over it in bytes. A char-based check would wrongly send this inline.
    const text = '한'.repeat(MESH_MAX_INLINE_FRAME_BYTES / 2)
    expect(text.length).toBeLessThan(MESH_MAX_INLINE_FRAME_BYTES)
    expect(meshFrameNeedsChunking(text)).toBe(true)
  })
})

describe('split / reassemble round trip', () => {
  it('restores a large image-bearing envelope exactly', () => {
    const frame = {
      v: VERSION,
      kind: 'rpc_req',
      id: 'req-1',
      command: 'agent_command',
      args: {
        input: {
          parts: [
            { type: 'text', text: 'what is in this screenshot?' },
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(500_000) },
          ],
        },
      },
    }
    expect(roundTrip(frame)).toEqual(frame)
  })

  it('every emitted chunk fits the inline frame budget', () => {
    const json = JSON.stringify({ data: 'B'.repeat(400_000) })
    const split = splitMeshFrame(json, 'c1', VERSION)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    for (const chunk of split.chunks) {
      expect(meshUtf8ByteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(MESH_MAX_INLINE_FRAME_BYTES)
    }
  })

  it('stamps a consistent total and contiguous indices', () => {
    const split = splitMeshFrame(JSON.stringify({ d: 'C'.repeat(200_000) }), 'c1', VERSION)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const total = split.chunks.length
    expect(total).toBeGreaterThan(1)
    split.chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i)
      expect(chunk.total).toBe(total)
      expect(chunk.kind).toBe(MESH_CHUNK_KIND)
    })
  })

  it('keeps hostile JSON-escaping payloads within the frame budget', () => {
    // The inputs most likely to overflow: control chars, astral emoji and quote/
    // backslash runs all expand under JSON escaping. They stay in budget because
    // splitMeshFrame slices the ALREADY-serialized frame (so escaping happens before
    // the cut, not after) — this pins that property down end to end.
    const hostile = [
      String.fromCharCode(1).repeat(50_000), // control chars — 6 bytes each escaped
      '\u{1F31F}'.repeat(50_000),            // astral emoji — surrogate pairs
      '"'.repeat(50_000),                    // quotes — escaped to 2 bytes each
    ]
    for (const payload of hostile) {
      const split = splitMeshFrame(JSON.stringify({ d: payload }), 'c1', VERSION)
      expect(split.ok).toBe(true)
      if (!split.ok) continue
      for (const chunk of split.chunks) {
        expect(meshUtf8ByteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(MESH_MAX_INLINE_FRAME_BYTES)
      }
      // And it must still round-trip exactly after being shrunk.
      const assembler = new MeshChunkAssembler()
      let last: ReturnType<MeshChunkAssembler['accept']> | undefined
      for (const chunk of split.chunks) last = assembler.accept(chunk)
      expect(last?.status).toBe('complete')
      if (last?.status === 'complete') expect(last.frame).toEqual({ d: payload })
    }
  })

  it('survives multi-byte UTF-8 spanning a chunk boundary', () => {
    // The split must never cut a surrogate pair or produce a slice whose serialized
    // envelope exceeds the budget once the multi-byte chars are counted.
    const frame = { text: '한글🌟'.repeat(40_000) }
    expect(roundTrip(frame)).toEqual(frame)
  })

  it('reassembles correctly when chunks arrive out of order', () => {
    const frame = { d: 'D'.repeat(200_000) }
    const split = splitMeshFrame(JSON.stringify(frame), 'c1', VERSION)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const assembler = new MeshChunkAssembler()
    const shuffled = [...split.chunks].reverse()
    let last: ReturnType<MeshChunkAssembler['accept']> | undefined
    for (const chunk of shuffled) last = assembler.accept(chunk)
    expect(last?.status).toBe('complete')
    if (last?.status === 'complete') expect(last.frame).toEqual(frame)
  })

  it('reports partial progress until the final chunk lands', () => {
    const split = splitMeshFrame(JSON.stringify({ d: 'E'.repeat(200_000) }), 'c1', VERSION)
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const assembler = new MeshChunkAssembler()
    for (const chunk of split.chunks.slice(0, -1)) {
      expect(assembler.accept(chunk).status).toBe('partial')
    }
    expect(assembler.accept(split.chunks[split.chunks.length - 1]!).status).toBe('complete')
    // Completing a frame must release its buffer.
    expect(assembler.pendingCount).toBe(0)
  })

  it('keeps concurrent frames from different chunkIds separate', () => {
    const a = { tag: 'a', d: 'A'.repeat(120_000) }
    const b = { tag: 'b', d: 'B'.repeat(120_000) }
    const sa = splitMeshFrame(JSON.stringify(a), 'chunk-a', VERSION)
    const sb = splitMeshFrame(JSON.stringify(b), 'chunk-b', VERSION)
    expect(sa.ok && sb.ok).toBe(true)
    if (!sa.ok || !sb.ok) return
    const assembler = new MeshChunkAssembler()
    // Interleave the two streams.
    const max = Math.max(sa.chunks.length, sb.chunks.length)
    const results: unknown[] = []
    for (let i = 0; i < max; i += 1) {
      if (sa.chunks[i]) { const r = assembler.accept(sa.chunks[i]!); if (r.status === 'complete') results.push(r.frame) }
      if (sb.chunks[i]) { const r = assembler.accept(sb.chunks[i]!); if (r.status === 'complete') results.push(r.frame) }
    }
    expect(results).toHaveLength(2)
    expect(results).toContainEqual(a)
    expect(results).toContainEqual(b)
  })
})

describe('explicit refusal — never silent corruption', () => {
  it('refuses a frame needing more than the chunk cap', () => {
    // Just past MAX_CHUNKS worth of payload at the per-chunk slice size.
    const oversized = 'F'.repeat((MESH_MAX_CHUNKS + 2) * 16_000)
    const split = splitMeshFrame(oversized, 'c1', VERSION)
    expect(split.ok).toBe(false)
    if (split.ok) return
    expect(split.reason).toBe('too_many_chunks')
    expect(split.detail).toContain('chunks')
  })

  it('rejects a malformed chunk envelope', () => {
    const assembler = new MeshChunkAssembler()
    const bad = assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: '', index: 0, total: 2, data: 'x' })
    expect(bad.status).toBe('failed')
    if (bad.status === 'failed') expect(bad.reason).toBe('malformed_chunk')
  })

  it('rejects an out-of-range index', () => {
    const assembler = new MeshChunkAssembler()
    const bad = assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 5, total: 2, data: 'x' })
    expect(bad.status).toBe('failed')
    if (bad.status === 'failed') expect(bad.reason).toBe('malformed_chunk')
  })

  it('rejects a declared total above the cap', () => {
    const assembler = new MeshChunkAssembler()
    const bad = assembler.accept({
      v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: MESH_MAX_CHUNKS + 1, data: 'x',
    })
    expect(bad.status).toBe('failed')
    if (bad.status === 'failed') expect(bad.reason).toBe('too_many_chunks')
  })

  it('rejects a group whose total changes mid-stream', () => {
    const assembler = new MeshChunkAssembler()
    expect(assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: 3, data: 'a' }).status).toBe('partial')
    const bad = assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 1, total: 4, data: 'b' })
    expect(bad.status).toBe('failed')
    if (bad.status === 'failed') expect(bad.reason).toBe('inconsistent_total')
  })

  it('accepts an identical retransmit but refuses a conflicting one', () => {
    const assembler = new MeshChunkAssembler()
    const chunk: MeshChunkEnvelope = { v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: 2, data: 'a' }
    expect(assembler.accept(chunk).status).toBe('partial')
    // Benign duplicate — same bytes, still partial, not an error.
    expect(assembler.accept({ ...chunk }).status).toBe('partial')
    const conflicting = assembler.accept({ ...chunk, data: 'DIFFERENT' })
    expect(conflicting.status).toBe('failed')
    if (conflicting.status === 'failed') expect(conflicting.reason).toBe('duplicate_chunk_mismatch')
  })

  it('reports an unparseable reassembly rather than returning junk', () => {
    const assembler = new MeshChunkAssembler()
    // Two chunks that individually look fine but do not join into valid JSON.
    assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: 2, data: '{"a":' })
    const result = assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 1, total: 2, data: 'NOT_JSON' })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('reassembled_parse_failed')
  })

  it('sweeps partial frames past the TTL instead of pinning memory', () => {
    let now = 1_000
    const assembler = new MeshChunkAssembler(() => now)
    assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: 2, data: 'a' })
    expect(assembler.pendingCount).toBe(1)
    now += MESH_CHUNK_TTL_MS + 1
    // Any subsequent activity sweeps the expired partial.
    assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'other', index: 0, total: 2, data: 'z' })
    expect(assembler.pendingCount).toBe(1)
  })

  it('reset() clears partial state on disconnect', () => {
    const assembler = new MeshChunkAssembler()
    assembler.accept({ v: VERSION, kind: MESH_CHUNK_KIND, chunkId: 'c', index: 0, total: 2, data: 'a' })
    expect(assembler.pendingCount).toBe(1)
    assembler.reset()
    expect(assembler.pendingCount).toBe(0)
  })
})

describe('constant safety margin', () => {
  it('worst-case chunk envelope stays within the inline frame ceiling', () => {
    // THIS is the test that goes red if the constants are retuned unsafely — e.g.
    // raising MESH_CHUNK_PAYLOAD_CHARS to 24_000 (worst case ~72KB) or dropping the
    // frame ceiling. The splitter's measure-and-shrink loop is the runtime backstop,
    // but at the shipped constants it is unreachable, so it cannot be covered by a
    // behavioural fixture; this invariant is what actually guards the boundary.
    const worst = measureWorstCaseChunkEnvelopeBytes()
    expect(worst).toBeLessThanOrEqual(MESH_MAX_INLINE_FRAME_BYTES)
  })

  it('documents the measured margin so a retune is a conscious decision', () => {
    // Measured at 48,073 bytes for a 16,000-char 3-byte-per-char slice. Pinned as a
    // range, not an exact value, so incidental envelope-field changes do not churn.
    const worst = measureWorstCaseChunkEnvelopeBytes()
    expect(worst).toBeGreaterThan(40_000)
    expect(worst).toBeLessThan(50_000)
  })
})

describe('frame identification', () => {
  it('identifies chunk frames and passes ordinary frames through', () => {
    expect(MeshChunkAssembler.isChunkFrame({ kind: MESH_CHUNK_KIND })).toBe(true)
    expect(MeshChunkAssembler.isChunkFrame({ kind: 'rpc_req' })).toBe(false)
    expect(MeshChunkAssembler.isChunkFrame(null)).toBe(false)
    expect(MeshChunkAssembler.isChunkFrame('string')).toBe(false)
  })
})
