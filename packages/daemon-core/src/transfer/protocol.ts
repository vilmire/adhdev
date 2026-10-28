/**
 * Bulk-channel frame format and channel binding for project file transfer.
 *
 * Frame = 128-byte header + payload, whole frame <= 16 KiB:
 *   0  magic "ATF1" (4)   4 type (1)   5 flags (1)   6 rsv (2)
 *   8  transferId (16)    24 fileIndex u32   28 offset u64   36 length u32   40 seq u64
 *   48..127 zero
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_FRAME_PAYLOAD_BYTES, TRANSFER_LIMITS } from './limits.js';

export const FRAME_MAGIC = Buffer.from('ATF1', 'ascii');

export enum FrameType {
  HELLO = 1,
  RESUME_STATE = 2,
  DATA = 3,
  BLOCK_END = 4,
  BLOCK_ACK = 5,
  FILE_ACK = 6,
  DONE = 7,
  ABORT = 8,
}

export interface Frame {
  type: FrameType;
  transferId: string; // 32 hex
  fileIndex: number;
  offset: number;
  seq: number;
  payload: Buffer;
}

export class FrameError extends Error {
  constructor(public readonly code: 'PROTOCOL_ERROR', message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeFrame(f: Frame): Buffer {
  if (f.payload.length > MAX_FRAME_PAYLOAD_BYTES) throw new FrameError('PROTOCOL_ERROR', 'payload too large');
  const out = Buffer.alloc(TRANSFER_LIMITS.frameHeaderBytes + f.payload.length);
  FRAME_MAGIC.copy(out, 0);
  out.writeUInt8(f.type, 4);
  Buffer.from(f.transferId, 'hex').copy(out, 8);
  out.writeUInt32BE(f.fileIndex, 24);
  out.writeBigUInt64BE(BigInt(f.offset), 28);
  out.writeUInt32BE(f.payload.length, 36);
  out.writeBigUInt64BE(BigInt(f.seq), 40);
  f.payload.copy(out, TRANSFER_LIMITS.frameHeaderBytes);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < TRANSFER_LIMITS.frameHeaderBytes || b.length > TRANSFER_LIMITS.maxFrameBytes) throw new FrameError('PROTOCOL_ERROR', 'bad frame size');
  if (!b.subarray(0, 4).equals(FRAME_MAGIC)) throw new FrameError('PROTOCOL_ERROR', 'bad magic');
  const type = b.readUInt8(4);
  if (!(type >= FrameType.HELLO && type <= FrameType.ABORT)) throw new FrameError('PROTOCOL_ERROR', 'bad frame type');
  if (b.readUInt8(5) !== 0 || b.readUInt16BE(6) !== 0) throw new FrameError('PROTOCOL_ERROR', 'reserved bits set');
  for (let i = 48; i < TRANSFER_LIMITS.frameHeaderBytes; i++) if (b[i] !== 0) throw new FrameError('PROTOCOL_ERROR', 'reserved header bytes set');
  const length = b.readUInt32BE(36);
  if (length !== b.length - TRANSFER_LIMITS.frameHeaderBytes) throw new FrameError('PROTOCOL_ERROR', 'length mismatch');
  const offset = b.readBigUInt64BE(28);
  const seq = b.readBigUInt64BE(40);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || seq > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameError('PROTOCOL_ERROR', 'counter overflow');
  return {
    type: type as FrameType,
    transferId: b.subarray(8, 24).toString('hex'),
    fileIndex: b.readUInt32BE(24),
    offset: Number(offset),
    seq: Number(seq),
    payload: Buffer.from(b.subarray(TRANSFER_LIMITS.frameHeaderBytes)),
  };
}

export function jsonPayload(obj: unknown): Buffer {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  if (buf.length > MAX_FRAME_PAYLOAD_BYTES) throw new FrameError('PROTOCOL_ERROR', 'json payload too large');
  return buf;
}

export function parseJsonPayload(p: Buffer): Record<string, any> {
  try {
    const v = JSON.parse(p.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fallthrough */ }
  throw new FrameError('PROTOCOL_ERROR', 'bad json payload');
}

/**
 * DTLS fingerprint of an SDP (`a=fingerprint:sha-256 AA:BB:...`), normalised. Session- and
 * media-level repeats of the SAME value are fine; an SDP carrying several distinct
 * fingerprints is ambiguous about which one DTLS will present, so it yields null.
 */
export function extractSdpFingerprint(sdp: string): string | null {
  const found = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:\s*(\S+)\s+([0-9A-Fa-f:]+)\s*$/gm)) found.add(`${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`);
  return found.size === 1 ? [...found][0]! : null;
}

/** True when an SDP contains a TURN-relayed candidate line (`a=candidate:... typ relay`). */
export function sdpHasRelayCandidate(sdp: string): boolean {
  return /^a=candidate:.*\btyp relay\b/im.test(sdp);
}

/** Channel-binding tag over the one-time link key, transfer, link generation and both DTLS fingerprints. */
export function computeBindingTag(linkKey: Buffer, transferId: string, linkGen: number, fpA: string, fpB: string, role: 'sender' | 'receiver'): string {
  const [lo, hi] = [fpA, fpB].sort();
  return createHmac('sha256', linkKey).update(`adhdev-file/1|${role}|${transferId}|${linkGen}|${lo}|${hi}`).digest('hex');
}

export function bindingTagsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}
