/** Project file transfer limits (owner decision D3, 2026-10-28). */
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const TRANSFER_LIMITS = Object.freeze({
  maxFileBytes: 2 * GIB,
  maxTransferBytes: 5 * GIB,
  maxEntries: 1000,
  maxManifestBytes: 2 * MIB,
  maxConcurrentPerDaemon: 2,
  totalBytesPerSecond: 4 * MIB,
  /** Hash / ACK / checkpoint unit. */
  blockBytes: MIB,
  /** Unacknowledged blocks a sender may have in flight. */
  windowBlocks: 4,
  /** Whole bulk frame (header + payload). */
  maxFrameBytes: 16 * 1024,
  frameHeaderBytes: 128,
  /** Extra free disk required beyond the transfer size. */
  diskMarginBytes: 256 * MIB,
  /** Sender pauses while the link buffers more than this. */
  maxBufferedBytes: MIB,
  linkConnectTimeoutMs: 30_000,
});

export const TRANSFER_RETENTION_MS = Object.freeze({
  preview: 15 * 60_000,
  consent: 24 * 3_600_000,
  tempIdle: 24 * 3_600_000,
  tempMax: 7 * 24 * 3_600_000,
  receipt: 7 * 24 * 3_600_000,
  audit: 30 * 24 * 3_600_000,
});

export const MAX_FRAME_PAYLOAD_BYTES = TRANSFER_LIMITS.maxFrameBytes - TRANSFER_LIMITS.frameHeaderBytes;
