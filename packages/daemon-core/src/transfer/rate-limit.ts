import { TRANSFER_LIMITS } from './limits.js';

/** Daemon-wide token bucket (bytes/second). `take` resolves once the bytes may be sent. */
export class TransferRateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private readonly bytesPerSecond: number = TRANSFER_LIMITS.totalBytesPerSecond,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = bytesPerSecond; // one second of burst
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((t - this.last) / 1000) * this.bytesPerSecond);
    this.last = t;
  }

  async take(bytes: number): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= bytes) { this.tokens -= bytes; return; }
      const waitMs = Math.max(5, Math.ceil(((bytes - this.tokens) / this.bytesPerSecond) * 1000));
      await this.sleep(waitMs);
    }
  }
}
