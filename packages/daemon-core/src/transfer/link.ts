/**
 * Port for the dedicated bulk connection. The host (daemon-cloud) supplies a STUN-only
 * WebRTC implementation; tests use {@link createMemoryLinkPair}. A host that supplies no
 * factory cannot transfer (capabilities.supported=false) — there is no fallback transport.
 */
export interface TransferSignal {
  kind: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: string;
  mid?: string;
}

export interface TransferLink {
  /** Returns false when the message was queued rather than written; callers must NOT resend. */
  send(data: Uint8Array): boolean;
  bufferedAmount(): number;
  onMessage(cb: (data: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  /** Remote signalling input (from the authenticated control channel). */
  signalIn(s: TransferSignal): void;
  /** Local signalling output, to be delivered over the authenticated control channel. */
  onSignalOut(cb: (s: TransferSignal) => void): void;
  /** DTLS fingerprints (`alg HEX:HEX`), available once SDP has been exchanged. */
  localFingerprint(): string | null;
  remoteFingerprint(): string | null;
  close(): void;
}

export interface TransferLinkFactory {
  create(opts: { transferId: string; role: 'initiator' | 'responder'; linkGen: number }): TransferLink;
}

/** In-memory pair for tests: byte-faithful, ordered, with optional fingerprint override. */
export function createMemoryLinkPair(opts?: { fingerprints?: [string, string]; remoteSeenByA?: string; remoteSeenByB?: string }): [TransferLink, TransferLink] {
  const fpA = opts?.fingerprints?.[0] ?? 'sha-256 AA:AA';
  const fpB = opts?.fingerprints?.[1] ?? 'sha-256 BB:BB';
  type Side = {
    msg: Array<(d: Uint8Array) => void>; open: Array<() => void>; close: Array<(r: string) => void>; closed: boolean;
    peer?: Side; local: string; remote: string; tap?: (d: Uint8Array) => Uint8Array | null;
  };
  const a: Side = { msg: [], open: [], close: [], closed: false, local: fpA, remote: opts?.remoteSeenByA ?? fpB };
  const b: Side = { msg: [], open: [], close: [], closed: false, local: fpB, remote: opts?.remoteSeenByB ?? fpA };
  a.peer = b; b.peer = a;
  const mk = (s: Side): TransferLink => ({
    send(d) {
      if (s.closed || !s.peer || s.peer.closed) return false;
      const copy = Uint8Array.from(d);
      const out = s.tap ? s.tap(copy) : copy;
      if (out) queueMicrotask(() => { if (!s.peer!.closed) s.peer!.msg.forEach((cb) => cb(out)); });
      return true;
    },
    bufferedAmount: () => 0,
    onMessage: (cb) => { s.msg.push(cb); },
    onOpen: (cb) => {
      s.open.push(cb);
      // The channel "opens" only once both ends have a session attached (as a real DataChannel would).
      if (s.peer!.open.length > 0) queueMicrotask(() => { for (const side of [s.peer!, s]) if (!side.closed) side.open.forEach((f) => f()); });
    },
    onClose: (cb) => { s.close.push(cb); },
    signalIn: () => {},
    onSignalOut: () => {},
    localFingerprint: () => s.local,
    remoteFingerprint: () => s.remote,
    close() {
      if (s.closed) return;
      s.closed = true;
      s.close.forEach((cb) => cb('local_close'));
      const p = s.peer!;
      if (!p.closed) { p.closed = true; queueMicrotask(() => p.close.forEach((cb) => cb('remote_close'))); }
    },
  });
  const la = mk(a); const lb = mk(b);
  (la as any).__setTap = (fn: Side['tap']) => { a.tap = fn; };
  (lb as any).__setTap = (fn: Side['tap']) => { b.tap = fn; };
  return [la, lb];
}
