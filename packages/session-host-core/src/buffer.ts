import type { SessionBufferSnapshot } from './types.js';

export interface SessionRingBufferOptions {
  maxBytes?: number;
}

export class SessionRingBuffer {
  private maxBytes: number;
  private chunks: { seq: number; data: string; bytes: number }[] = [];
  private nextSeq = 1;
  private totalBytes = 0;

  constructor(options: SessionRingBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? 512 * 1024;
  }

  append(data: string): number {
    const normalized = typeof data === 'string' ? data : String(data ?? '');
    const bytes = Buffer.byteLength(normalized, 'utf8');
    const seq = this.nextSeq++;

    this.chunks.push({ seq, data: normalized, bytes });
    this.totalBytes += bytes;
    this.trim();
    return seq;
  }

  snapshot(sinceSeq?: number): SessionBufferSnapshot {
    const relevant = typeof sinceSeq === 'number'
      ? this.chunks.filter(chunk => chunk.seq > sinceSeq)
      : this.chunks;

    const text = relevant.map(chunk => chunk.data).join('');
    const truncated = !!this.chunks[0] && typeof sinceSeq === 'number' && sinceSeq < this.chunks[0].seq - 1;

    return {
      seq: this.nextSeq - 1,
      text,
      truncated,
    };
  }

  getState(): { scrollbackBytes: number; snapshotSeq: number } {
    return {
      scrollbackBytes: this.totalBytes,
      snapshotSeq: this.nextSeq - 1,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.nextSeq = 1;
  }

  restore(snapshot: { seq: number; text: string }): void {
    this.clear();
    const text = String(snapshot.text || '');
    if (!text) {
      this.nextSeq = Math.max(1, Number(snapshot.seq || 0) + 1);
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const seq = Math.max(1, Number(snapshot.seq || 1));
    this.chunks = [{ seq, data: text, bytes }];
    this.totalBytes = bytes;
    this.nextSeq = seq + 1;
    this.trim();
  }

  private trim(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.totalBytes -= removed.bytes;
    }
  }
}
