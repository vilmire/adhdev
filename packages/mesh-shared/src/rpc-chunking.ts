/**
 * Mesh RPC frame chunking — split/reassemble oversized mesh envelopes.
 *
 * WHY THIS EXISTS
 * The mesh DataChannel path (`daemon-mesh-manager`) writes every RPC envelope as a
 * SINGLE `dc.sendMessage(JSON.stringify(envelope))` frame. That was fine while every
 * mesh arg was small text, but a coordinator dispatching an IMAGE to a worker puts a
 * multi-MB base64 part inside `args` — far past what one DataChannel frame carries, so
 * the send throws or the frame is dropped and the dispatch silently dies.
 *
 * The dashboard P2P path already solved exactly this problem and has been running in
 * production: `packages/daemon-cloud/src/daemon-p2p/data-channel-router.ts` (send +
 * reassemble) and `packages/web-cloud/src/p2p.ts` (browser side). This module is a PORT
 * of that proven scheme onto the mesh envelope shape — deliberately NOT a new protocol.
 * The boundary values are carried over unchanged (see the constants below for why each
 * one is what it is).
 *
 * It lives in mesh-shared because it is pure string/JSON work with no transport, no
 * Node API and no DOM API — the same reason the normalizers live here. `daemon-cloud`
 * (sender/receiver) is the only current consumer, but keeping it in the pure leaf means
 * the standalone side can reassemble with the identical code rather than a hand-synced
 * copy, which is the drift bug class this package was created to kill.
 *
 * FAILURE POLICY (DoD): reassembly never degrades silently. A malformed, out-of-range,
 * over-budget or unparseable chunk stream yields an explicit typed failure that the
 * caller turns into an RPC error — never a partially-applied or truncated envelope.
 */

/**
 * Inline ceiling: an envelope whose JSON is at or below this goes out as one frame,
 * exactly as before this module existed. 60_000 (not 65_536) matches the dashboard
 * path and leaves headroom under the common 64KiB SCTP message limit so the frame is
 * never the thing that trips a transport-level cap.
 */
export const MESH_MAX_INLINE_FRAME_BYTES = 60_000

/**
 * Per-chunk payload slice, in CHARACTERS. Ported unchanged from the dashboard path.
 *
 * Why 16_000 chars is safe under a 60_000-BYTE ceiling, with ~3.75x of headroom:
 * `splitMeshFrame` slices the ALREADY-SERIALIZED outer frame, so the text being cut
 * is JSON output — control characters are pre-expanded to `\u00XX` ASCII before they
 * ever reach the slicer. Re-escaping that slice inside the chunk envelope can at worst
 * double the backslashes. Measured worst cases for a 16_000-char slice:
 *   backslashes / astral emoji  → 32,073 bytes
 *   Korean (3-byte, unescaped)  → 48,073 bytes   ← densest observed
 *   plain ASCII                 → 16,073 bytes
 * All are under MESH_MAX_INLINE_FRAME_BYTES. `splitMeshFrame` still MEASURES each
 * envelope and shrinks on overflow, so the guarantee is enforced rather than assumed
 * if either constant is ever retuned — but at these values that path is unreachable,
 * which is exactly what `assertMeshChunkConstantsAreSafe` pins down.
 */
export const MESH_CHUNK_PAYLOAD_CHARS = 16_000

/**
 * Hard cap on chunk count for one frame. 1024 × ~16KB ≈ 16MB of transferable payload,
 * which comfortably covers a screenshot while bounding what a single peer can make the
 * receiver buffer. Exceeding it is an explicit refusal, never a truncated send.
 */
export const MESH_MAX_CHUNKS = 1024

/**
 * Reassembly budget for one frame, in bytes. Bounds receiver memory independently of
 * chunk count so a peer cannot send 1024 maximally-large chunks to force an oversized
 * allocation. Mirrors the dashboard receiver's MAX_REASSEMBLED_JSON_BYTES.
 */
export const MESH_MAX_REASSEMBLED_BYTES = 16_000_000

/**
 * How long a partially-received frame is retained. A sender that dies mid-stream must
 * not pin receiver memory forever; the partial is swept and the frame simply never
 * completes (the RPC's own deadline then reports it).
 */
export const MESH_CHUNK_TTL_MS = 60_000

/** Envelope `kind` for a chunk of a larger mesh frame. */
export const MESH_CHUNK_KIND = 'rpc_chunk'

export interface MeshChunkEnvelope {
  v: number
  kind: typeof MESH_CHUNK_KIND
  /** Groups the chunks of one logical frame. */
  chunkId: string
  /** 0-based position of this chunk. */
  index: number
  /** Total chunk count for this frame; constant across the group. */
  total: number
  /** The slice of the original envelope JSON. */
  data: string
}

export type MeshChunkSplitResult =
  | { ok: true; chunks: MeshChunkEnvelope[] }
  | { ok: false; reason: 'too_many_chunks' | 'chunk_too_large'; detail: string }

export type MeshChunkAcceptResult =
  /** Chunk stored; the frame is not complete yet. */
  | { status: 'partial'; received: number; total: number }
  /** Final chunk landed and the frame parsed cleanly. */
  | { status: 'complete'; frame: unknown }
  /** Explicitly rejected — the caller must surface this, never ignore it. */
  | { status: 'failed'; reason: MeshChunkFailureReason; detail: string; chunkId: string }

export type MeshChunkFailureReason =
  | 'malformed_chunk'
  | 'too_many_chunks'
  | 'inconsistent_total'
  | 'duplicate_chunk_mismatch'
  | 'budget_exceeded'
  | 'reassembled_parse_failed'

/** UTF-8 byte length without assuming Buffer or TextEncoder is present. */
export function meshUtf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1 }
    else bytes += 3
  }
  return bytes
}

/**
 * Worst-case size of one chunk envelope at the current constants.
 *
 * Exported so the safety margin documented on MESH_CHUNK_PAYLOAD_CHARS is a CHECKED
 * invariant rather than a comment that rots. The densest slice the splitter can produce
 * is 3-byte unescaped text (JSON.stringify leaves non-ASCII as-is), so that is what this
 * measures. If someone raises MESH_CHUNK_PAYLOAD_CHARS or lowers the frame ceiling past
 * the safe point, the accompanying test fails loudly instead of the overflow only
 * showing up as dropped frames on a live mesh.
 */
export function measureWorstCaseChunkEnvelopeBytes(): number {
  const densest = '한'.repeat(MESH_CHUNK_PAYLOAD_CHARS)
  return meshUtf8ByteLength(JSON.stringify(
    buildChunkEnvelope(Number.MAX_SAFE_INTEGER, 'x'.repeat(64), MESH_MAX_CHUNKS, MESH_MAX_CHUNKS, densest),
  ))
}

/** True when the serialized frame must be chunked rather than sent inline. */
export function meshFrameNeedsChunking(json: string): boolean {
  return meshUtf8ByteLength(json) > MESH_MAX_INLINE_FRAME_BYTES
}

function buildChunkEnvelope(
  version: number, chunkId: string, index: number, total: number, data: string,
): MeshChunkEnvelope {
  return { v: version, kind: MESH_CHUNK_KIND, chunkId, index, total, data }
}

/**
 * Split a serialized mesh envelope into chunk envelopes.
 *
 * Each slice is measured AS ITS FINAL SERIALIZED ENVELOPE and shrunk (×0.8, as in the
 * dashboard implementation) until it fits the inline ceiling — so multi-byte UTF-8 and
 * the envelope overhead are both accounted for rather than assumed away. `total` is
 * stamped only after the full split is known, so every chunk in a group agrees.
 */
export function splitMeshFrame(json: string, chunkId: string, version: number): MeshChunkSplitResult {
  const slices: string[] = []
  let offset = 0
  while (offset < json.length) {
    let end = Math.min(json.length, offset + MESH_CHUNK_PAYLOAD_CHARS)
    // Measure against MESH_MAX_CHUNKS as the `total` placeholder: it is the widest the
    // field can serialize to, so a slice that fits here still fits once the real (never
    // larger) total is stamped in below.
    while (end > offset) {
      const candidate = json.slice(offset, end)
      const probe = JSON.stringify(buildChunkEnvelope(version, chunkId, slices.length, MESH_MAX_CHUNKS, candidate))
      if (meshUtf8ByteLength(probe) <= MESH_MAX_INLINE_FRAME_BYTES) break
      const shrunk = Math.max(1, Math.floor((end - offset) * 0.8))
      if (offset + shrunk >= end) { end -= 1; continue }
      end = offset + shrunk
    }
    if (end <= offset) {
      return { ok: false, reason: 'chunk_too_large', detail: 'a single character did not fit the chunk envelope budget' }
    }
    slices.push(json.slice(offset, end))
    if (slices.length > MESH_MAX_CHUNKS) {
      return {
        ok: false,
        reason: 'too_many_chunks',
        detail: `frame needs more than ${MESH_MAX_CHUNKS} chunks (${meshUtf8ByteLength(json)} bytes)`,
      }
    }
    offset = end
  }
  if (slices.length === 0) {
    return { ok: false, reason: 'chunk_too_large', detail: 'refusing to chunk an empty frame' }
  }
  const total = slices.length
  return { ok: true, chunks: slices.map((data, index) => buildChunkEnvelope(version, chunkId, index, total, data)) }
}

interface MeshChunkBuffer {
  total: number
  chunks: string[]
  received: number
  bytesReceived: number
  createdAt: number
}

/**
 * Receiver-side reassembly buffer, one per peer connection.
 *
 * Keyed by chunkId only — callers construct one assembler per peer, so chunk groups
 * from different peers can never collide in the same map.
 */
export class MeshChunkAssembler {
  private readonly buffers = new Map<string, MeshChunkBuffer>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** True when the frame is a chunk envelope this assembler should handle. */
  static isChunkFrame(frame: unknown): boolean {
    return !!frame && typeof frame === 'object' && (frame as { kind?: unknown }).kind === MESH_CHUNK_KIND
  }

  /** Drop partials older than the TTL so a dead sender cannot pin memory. */
  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of Array.from(this.buffers.entries())) {
      if (now - entry.createdAt > MESH_CHUNK_TTL_MS) this.buffers.delete(key)
    }
  }

  /** Discard any partial state for a peer (call on disconnect). */
  reset(): void {
    this.buffers.clear()
  }

  /** Number of frames currently mid-reassembly — for tests and diagnostics. */
  get pendingCount(): number {
    return this.buffers.size
  }

  /**
   * Accept one chunk envelope.
   *
   * Never throws and never returns a partially-applied frame: the result is exactly one
   * of partial / complete / failed, and `failed` carries a typed reason the transport
   * turns into an explicit RPC error.
   */
  accept(frame: unknown): MeshChunkAcceptResult {
    this.sweep()
    const raw = frame as Partial<MeshChunkEnvelope> | null
    const chunkId = typeof raw?.chunkId === 'string' ? raw.chunkId : ''
    const index = Number(raw?.index)
    const total = Number(raw?.total)
    const data = typeof raw?.data === 'string' ? raw.data : ''

    if (!chunkId || !Number.isInteger(index) || !Number.isInteger(total)
      || index < 0 || total <= 0 || index >= total || !data) {
      return {
        status: 'failed',
        reason: 'malformed_chunk',
        detail: `malformed chunk envelope (chunkId=${chunkId || '-'} index=${raw?.index} total=${raw?.total})`,
        chunkId,
      }
    }
    if (total > MESH_MAX_CHUNKS) {
      this.buffers.delete(chunkId)
      return {
        status: 'failed',
        reason: 'too_many_chunks',
        detail: `chunk total ${total} exceeds the ${MESH_MAX_CHUNKS} cap`,
        chunkId,
      }
    }

    let entry = this.buffers.get(chunkId)
    if (!entry) {
      entry = { total, chunks: new Array(total).fill(''), received: 0, bytesReceived: 0, createdAt: this.now() }
      this.buffers.set(chunkId, entry)
    } else if (entry.total !== total) {
      // The sender disagrees with itself about the frame's shape — the stream is
      // corrupt; drop it loudly rather than reassembling a mixed frame.
      this.buffers.delete(chunkId)
      return {
        status: 'failed',
        reason: 'inconsistent_total',
        detail: `chunk ${index} declares total ${total} but the group was opened with ${entry.total}`,
        chunkId,
      }
    }

    const existing = entry.chunks[index]
    if (existing) {
      // A benign retransmit repeats identical bytes. Different bytes for the same slot
      // means the ordering/identity guarantee is broken — refuse instead of picking one.
      if (existing === data) return { status: 'partial', received: entry.received, total: entry.total }
      this.buffers.delete(chunkId)
      return {
        status: 'failed',
        reason: 'duplicate_chunk_mismatch',
        detail: `chunk ${index} arrived twice with different content`,
        chunkId,
      }
    }

    const chunkBytes = meshUtf8ByteLength(data)
    if (entry.bytesReceived + chunkBytes > MESH_MAX_REASSEMBLED_BYTES) {
      this.buffers.delete(chunkId)
      return {
        status: 'failed',
        reason: 'budget_exceeded',
        detail: `reassembled frame would exceed ${MESH_MAX_REASSEMBLED_BYTES} bytes`,
        chunkId,
      }
    }

    entry.chunks[index] = data
    entry.received += 1
    entry.bytesReceived += chunkBytes
    if (entry.received < entry.total) {
      return { status: 'partial', received: entry.received, total: entry.total }
    }

    this.buffers.delete(chunkId)
    try {
      return { status: 'complete', frame: JSON.parse(entry.chunks.join('')) }
    } catch (error) {
      // Every slot is filled yet the join is not valid JSON — the frame is unusable.
      // Explicit failure, never a silent drop.
      return {
        status: 'failed',
        reason: 'reassembled_parse_failed',
        detail: `reassembled frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        chunkId,
      }
    }
  }
}
