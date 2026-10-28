/**
 * Per-link protocol sessions. A session lives for ONE link generation: HELLO (channel
 * binding) -> RESUME_STATE (receiver) -> DATA/BLOCK_END/BLOCK_ACK -> done. A lost link
 * ends the session; the engine starts a new one on a new link (resume).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { TRANSFER_LIMITS, MAX_FRAME_PAYLOAD_BYTES } from './limits.js';
import { blockCount, type ContentManifest } from './manifest.js';
import {
  FrameError, FrameType, bindingTagsEqual, computeBindingTag, decodeFrame, encodeFrame, jsonPayload, parseJsonPayload,
  type Frame,
} from './protocol.js';
import type { TransferRateLimiter } from './rate-limit.js';
import type { TransferLink } from './link.js';
import { ReceiverError, type TransferReceiver } from './receiver.js';
import { spoolFilePath } from './spool.js';

export class SessionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

const IDLE_TIMEOUT_MS = 60_000;
/** Connect (30 s) + a margin: no valid HELLO by then means the peer is not who/what we expect. */
const HELLO_DEADLINE_MS = TRANSFER_LIMITS.linkConnectTimeoutMs + 15_000;

abstract class BaseSession {
  protected outSeq = 0;
  protected inSeq = -1;
  protected helloOk = false;
  protected done = false;
  protected settle!: { resolve: () => void; reject: (e: Error) => void };
  protected promise: Promise<void>;
  private idle?: NodeJS.Timeout;
  private helloTimer?: NodeJS.Timeout;

  constructor(
    protected readonly link: TransferLink,
    protected readonly transferId: string,
    protected readonly linkGen: number,
    protected readonly linkKey: Buffer,
    protected readonly roleName: 'sender' | 'receiver',
  ) {
    this.promise = new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    // A rejection nobody awaited yet must not crash the daemon.
    this.promise.catch(() => {});
    link.onMessage((d) => this.onRaw(d));
    link.onClose((reason) => this.fail(reason === 'DIRECT_UNAVAILABLE'
      ? new SessionError('DIRECT_UNAVAILABLE', 'link is not a direct (non-relayed) path')
      : new SessionError('LINK_LOST', `link closed: ${reason}`)));
    link.onOpen(() => this.sendHello());
    this.touch();
    this.helloTimer = setTimeout(() => this.fail(new SessionError('LINK_LOST', 'hello deadline exceeded')), HELLO_DEADLINE_MS);
    this.helloTimer.unref?.();
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fail(new SessionError('LINK_LOST', 'link idle timeout')), IDLE_TIMEOUT_MS);
    this.idle.unref?.();
  }

  protected finish(): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.idle);
    clearTimeout(this.helloTimer);
    this.settle.resolve();
  }

  fail(err: Error): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.idle);
    clearTimeout(this.helloTimer);
    this.settle.reject(err);
  }

  abort(code: string): void {
    if (!this.done) this.sendFrame(FrameType.ABORT, 0, 0, jsonPayload({ code }));
    this.fail(new SessionError(code, `aborted: ${code}`));
    try { this.link.close(); } catch { /* ignore */ }
  }

  protected sendFrame(type: FrameType, fileIndex: number, offset: number, payload: Buffer): boolean {
    return this.link.send(encodeFrame({ type, transferId: this.transferId, fileIndex, offset, seq: this.outSeq++, payload }));
  }

  private sendHello(): void {
    const local = this.link.localFingerprint();
    const remote = this.link.remoteFingerprint();
    if (!local || !remote) { this.abort('BINDING_MISMATCH'); return; }
    const tag = computeBindingTag(this.linkKey, this.transferId, this.linkGen, local, remote, this.roleName);
    this.sendFrame(FrameType.HELLO, 0, 0, jsonPayload({ tag, role: this.roleName }));
  }

  private onRaw(data: Uint8Array): void {
    if (this.done) return;
    let frame: Frame;
    try {
      frame = decodeFrame(data);
      if (frame.transferId !== this.transferId) throw new FrameError('PROTOCOL_ERROR', 'foreign transferId');
      if (frame.seq <= this.inSeq) return; // duplicate delivery: ignore, never resend
      if (frame.seq !== this.inSeq + 1) throw new FrameError('PROTOCOL_ERROR', 'sequence gap');
      this.inSeq = frame.seq;
      this.touch(); // only a valid, new-sequence frame proves the peer is alive
      if (frame.type === FrameType.ABORT) {
        this.fail(new SessionError(String(parseJsonPayload(frame.payload).code ?? 'PEER_ABORT'), 'peer aborted'));
        return;
      }
      if (!this.helloOk) {
        if (frame.type !== FrameType.HELLO) throw new FrameError('PROTOCOL_ERROR', 'expected HELLO');
        const local = this.link.localFingerprint();
        const remote = this.link.remoteFingerprint();
        const hello = parseJsonPayload(frame.payload);
        const peerTag = String(hello.tag ?? '');
        const peerRole = this.roleName === 'sender' ? 'receiver' : 'sender';
        // The tag covers the sender's role, so a HELLO reflected back to its author never verifies.
        if (hello.role !== peerRole || !local || !remote || !bindingTagsEqual(peerTag, computeBindingTag(this.linkKey, this.transferId, this.linkGen, local, remote, peerRole))) {
          this.abort('BINDING_MISMATCH');
          return;
        }
        this.helloOk = true;
        clearTimeout(this.helloTimer);
        this.onHelloOk();
        return;
      }
      this.onFrame(frame);
    } catch (err) {
      if (err instanceof FrameError) this.abort('PROTOCOL_ERROR');
      else if (err instanceof ReceiverError) this.abort(err.code === 'HASH_MISMATCH' || err.code === 'DISK_SPACE_EXHAUSTED' ? err.code : 'PROTOCOL_ERROR');
      else this.abort('IO_ERROR');
    }
  }

  protected abstract onHelloOk(): void;
  protected abstract onFrame(f: Frame): void;
  wait(): Promise<void> { return this.promise; }
}

export class SenderSession extends BaseSession {
  private ackedBlocks = 0;
  private sentBlocks = 0;
  private ackWaiters: Array<() => void> = [];
  private resume: number[] | null = null;

  constructor(
    link: TransferLink, transferId: string, linkGen: number, linkKey: Buffer,
    private readonly content: ContentManifest,
    private readonly spoolDir: string,
    private readonly rate: TransferRateLimiter,
    private readonly onProgress?: (fileIndex: number, blockIndex: number) => void,
  ) { super(link, transferId, linkGen, linkKey, 'sender'); }

  protected onHelloOk(): void { /* wait for RESUME_STATE */ }

  protected onFrame(f: Frame): void {
    if (f.type === FrameType.RESUME_STATE && this.resume === null) {
      const blocks = parseJsonPayload(f.payload).blocks;
      if (!Array.isArray(blocks) || blocks.length !== this.content.files.length ||
        !blocks.every((b, i) => Number.isInteger(b) && b >= 0 && b <= blockCount(this.content.files[i]!.size))) {
        throw new FrameError('PROTOCOL_ERROR', 'bad resume state');
      }
      this.resume = blocks as number[];
      void this.pump().catch((e) => this.fail(e instanceof SessionError ? e : new SessionError('IO_ERROR', String(e?.message ?? e))));
      return;
    }
    if (f.type === FrameType.BLOCK_ACK) {
      this.ackedBlocks++;
      this.ackWaiters.splice(0).forEach((w) => w());
      this.onProgress?.(f.fileIndex, f.offset / TRANSFER_LIMITS.blockBytes);
      return;
    }
    if (f.type === FrameType.DONE) { this.finish(); return; }
    throw new FrameError('PROTOCOL_ERROR', 'unexpected frame for sender');
  }

  private async waitForWindow(): Promise<void> {
    while (!this.done && this.sentBlocks - this.ackedBlocks >= TRANSFER_LIMITS.windowBlocks) {
      await new Promise<void>((r) => this.ackWaiters.push(r));
    }
  }

  private async pump(): Promise<void> {
    const resume = this.resume!;
    const buf = Buffer.allocUnsafe(MAX_FRAME_PAYLOAD_BYTES);
    for (let i = 0; i < this.content.files.length && !this.done; i++) {
      const f = this.content.files[i]!;
      const nBlocks = blockCount(f.size);
      if (resume[i]! >= nBlocks) continue;
      const fd = fs.openSync(spoolFilePath(this.spoolDir, i), 'r');
      try {
        for (let b = resume[i]!; b < nBlocks && !this.done; b++) {
          await this.waitForWindow();
          if (this.done) return;
          const start = b * TRANSFER_LIMITS.blockBytes;
          const end = Math.min(f.size, start + TRANSFER_LIMITS.blockBytes);
          const hash = createHash('sha256');
          for (let o = start; o < end; ) {
            const len = Math.min(buf.length, end - o);
            const n = fs.readSync(fd, buf, 0, len, o);
            if (n !== len) throw new SessionError('SOURCE_CHANGED', 'spool file truncated');
            hash.update(buf.subarray(0, len));
            await this.rate.take(len);
            while (this.link.bufferedAmount() > TRANSFER_LIMITS.maxBufferedBytes && !this.done) await new Promise((r) => setTimeout(r, 10));
            if (this.done) return;
            // send()===false means queued by the transport: never resend.
            this.sendFrame(FrameType.DATA, i, o, Buffer.from(buf.subarray(0, len)));
            o += len;
          }
          const digest = hash.digest('hex');
          if (digest !== f.blockHashes[b]) throw new SessionError('SOURCE_CHANGED', 'spool block no longer matches manifest');
          this.sendFrame(FrameType.BLOCK_END, i, start, Buffer.from(digest, 'hex'));
          this.sentBlocks++;
        }
      } finally { fs.closeSync(fd); }
    }
    // Wait for the last acknowledgements, then tell the receiver we are done.
    while (!this.done && this.ackedBlocks < this.sentBlocks) await new Promise<void>((r) => this.ackWaiters.push(r));
    if (!this.done) { this.sendFrame(FrameType.DONE, 0, 0, Buffer.alloc(0)); this.finish(); }
  }
}

export class ReceiverSession extends BaseSession {
  constructor(
    link: TransferLink, transferId: string, linkGen: number, linkKey: Buffer,
    private readonly receiver: TransferReceiver,
    private readonly resumeBlocks: number[],
  ) { super(link, transferId, linkGen, linkKey, 'receiver'); }

  protected onHelloOk(): void {
    this.sendFrame(FrameType.RESUME_STATE, 0, 0, jsonPayload({ blocks: this.resumeBlocks }));
    if (this.receiver.complete) { this.sendFrame(FrameType.DONE, 0, 0, Buffer.alloc(0)); this.finish(); }
  }

  protected onFrame(f: Frame): void {
    if (f.type === FrameType.DATA) { this.receiver.handleData(f.fileIndex, f.offset, f.payload); return; }
    if (f.type === FrameType.BLOCK_END) {
      if (f.payload.length !== 32) throw new FrameError('PROTOCOL_ERROR', 'bad block hash');
      const r = this.receiver.handleBlockEnd(f.fileIndex, f.offset, f.payload.toString('hex'));
      this.sendFrame(FrameType.BLOCK_ACK, f.fileIndex, f.offset, Buffer.alloc(0));
      void r;
      return;
    }
    if (f.type === FrameType.DONE) {
      if (!this.receiver.complete) throw new FrameError('PROTOCOL_ERROR', 'DONE before all files received');
      this.finish();
      return;
    }
    throw new FrameError('PROTOCOL_ERROR', 'unexpected frame for receiver');
  }

  /** The receiver finishes the stream after the last BLOCK_ACK; the sender then sends DONE. */
}
