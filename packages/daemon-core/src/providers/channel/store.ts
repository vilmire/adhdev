/**
 * Content-addressed provider store (Stage 2 runtime loader).
 *
 * Layout (under `<configDir>/providers/.store/` — dot-prefixed, so the
 * provider manifest scanner never mistakes store internals for providers):
 *
 *   objects/<digest-hex>/        verified provider trees, repo-root-relative
 *                                layout (e.g. objects/<hex>/cli/claude-cli/…).
 *                                Each object dir appears atomically (single
 *                                rename from staging), so readers never
 *                                observe a partial tree.
 *   staging/<random>/            temporary download/extraction/verification
 *                                work area. Same filesystem as objects/ so
 *                                the final rename is atomic.
 *   active/<channel>/<type>.json activation pointers. Each pointer holds the
 *                                active activation plus the previous one
 *                                (N=2 retention) so rollback is a local
 *                                pointer flip that needs no network.
 *
 * Crash/interruption boundaries:
 * - Crash during download/extract/verify: only staging/ is dirty; the active
 *   pointers still reference the last-known-good objects.
 * - Crash after the object rename but before the pointer flip: the new
 *   object is an unreferenced orphan; pointers still govern and gc() reclaims
 *   the orphan.
 * - Pointer writes are write-temp-then-rename (atomic on POSIX), so a crash
 *   can never leave a half-written pointer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfigDir } from '../../config/config.js';
import {
  BUNDLE_DIGEST_RE,
  ProviderChannelError,
  type ActivatableEntry,
  type ProviderChannel,
} from './contract.js';

export interface ActivationRef {
  providerType: string;
  providerVersion: string;
  category: string;
  digest: string;
  digestAlgorithm: string;
  activatedAt: string;
}

export interface ActivationPointer {
  version: 1;
  active: ActivationRef;
  previous: ActivationRef | null;
}

export interface ActivateResult {
  changed: boolean;
  ref: ActivationRef;
  objectDir: string;
}

export class ProviderChannelStore {
  readonly rootDir: string;
  private readonly logFn: (msg: string) => void;

  constructor(rootDir: string, logFn?: (msg: string) => void) {
    this.rootDir = rootDir;
    this.logFn = logFn ?? (() => {});
  }

  /** Default store root, resolved through the config-dir abstraction. */
  static defaultRoot(): string {
    return path.join(getConfigDir(), 'providers', '.store');
  }

  private get objectsDir(): string {
    return path.join(this.rootDir, 'objects');
  }

  private get stagingDir(): string {
    return path.join(this.rootDir, 'staging');
  }

  private activeDir(channel: ProviderChannel): string {
    return path.join(this.rootDir, 'active', channel);
  }

  private pointerPath(channel: ProviderChannel, providerType: string): string {
    return path.join(this.activeDir(channel), `${providerType}.json`);
  }

  private log(msg: string): void {
    this.logFn(`[ProviderChannelStore] ${msg}`);
  }

  // ─── Staging ─────────────────────────────────────────────

  /** Create a fresh staging directory. Caller must clean it up (or gc will). */
  createStagingDir(kind: string): string {
    const dir = path.join(this.stagingDir, `${kind}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  removeStagingDir(dir: string): void {
    // Only ever remove paths inside our own staging area.
    if (!dir.startsWith(this.stagingDir + path.sep)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // ─── Objects ─────────────────────────────────────────────

  private static objectName(digest: string): string {
    if (!BUNDLE_DIGEST_RE.test(digest)) {
      throw new ProviderChannelError('ENTRY_DIGEST_INVALID', `malformed digest "${digest}" — refusing store operation`);
    }
    return digest.slice('sha256:'.length);
  }

  getObjectDir(digest: string): string {
    return path.join(this.objectsDir, ProviderChannelStore.objectName(digest));
  }

  hasObject(digest: string): boolean {
    try {
      return fs.statSync(this.getObjectDir(digest)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Move a verified staged tree into the object store. Atomic: the object
   * dir becomes visible in a single rename. If the object already exists
   * (content-addressed dedupe) the staged copy is discarded instead.
   *
   * Returns the final object dir.
   */
  putObject(stagedObjectDir: string, digest: string): string {
    const objectDir = this.getObjectDir(digest);
    if (this.hasObject(digest)) {
      this.removeStagingDir(stagedObjectDir);
      return objectDir;
    }
    fs.mkdirSync(this.objectsDir, { recursive: true });
    fs.renameSync(stagedObjectDir, objectDir);
    return objectDir;
  }

  // ─── Pointers ────────────────────────────────────────────

  /**
   * Read a pointer. Returns null when no activation exists. Throws a typed
   * STORE_CORRUPT error when the file exists but is unreadable — callers
   * treat that as "no usable activation" and fail closed (never load
   * unverified bytes).
   */
  getPointer(channel: ProviderChannel, providerType: string): ActivationPointer | null {
    const file = this.pointerPath(channel, providerType);
    if (!fs.existsSync(file)) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e: any) {
      throw new ProviderChannelError(
        'STORE_CORRUPT',
        `activation pointer ${file} is corrupt: ${e?.message || e}`,
        providerType,
      );
    }
    const active = parsed?.active;
    if (
      parsed?.version !== 1 ||
      !active ||
      typeof active.digest !== 'string' ||
      !BUNDLE_DIGEST_RE.test(active.digest) ||
      typeof active.providerType !== 'string'
    ) {
      throw new ProviderChannelError(
        'STORE_CORRUPT',
        `activation pointer ${file} has an invalid shape — refusing to use it`,
        providerType,
      );
    }
    return parsed as ActivationPointer;
  }

  /**
   * List all valid pointers for a channel. Corrupt pointer files are
   * collected as typed errors (and skipped), never silently loaded.
   */
  listPointers(channel: ProviderChannel): {
    pointers: Map<string, ActivationPointer>;
    errors: ProviderChannelError[];
  } {
    const pointers = new Map<string, ActivationPointer>();
    const errors: ProviderChannelError[] = [];
    const dir = this.activeDir(channel);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { pointers, errors };
    }
    for (const file of files) {
      const type = file.slice(0, -'.json'.length);
      try {
        const pointer = this.getPointer(channel, type);
        if (pointer) pointers.set(type, pointer);
      } catch (e: any) {
        errors.push(e instanceof ProviderChannelError
          ? e
          : new ProviderChannelError('STORE_CORRUPT', String(e?.message || e), type));
      }
    }
    return { pointers, errors };
  }

  /** Object dirs currently activated for a channel (for the loader). */
  listActiveActivations(channel: ProviderChannel): {
    activations: Array<{ ref: ActivationRef; objectDir: string }>;
    errors: ProviderChannelError[];
  } {
    const { pointers, errors } = this.listPointers(channel);
    const activations: Array<{ ref: ActivationRef; objectDir: string }> = [];
    for (const pointer of pointers.values()) {
      const objectDir = this.getObjectDir(pointer.active.digest);
      if (!fs.existsSync(objectDir)) {
        errors.push(new ProviderChannelError(
          'STORE_CORRUPT',
          `active object ${pointer.active.digest} for "${pointer.active.providerType}" is missing — skipping (fail closed)`,
          pointer.active.providerType,
        ));
        continue;
      }
      activations.push({ ref: pointer.active, objectDir });
    }
    return { activations, errors };
  }

  /**
   * Atomically activate a verified staged tree for (channel, type).
   *
   * Order: object into place first (atomic rename), then pointer flip
   * (atomic rename). A crash anywhere before the pointer flip leaves the
   * previous activation governing.
   */
  activate(channel: ProviderChannel, entry: ActivatableEntry, stagedObjectDir: string): ActivateResult {
    const ref: ActivationRef = {
      providerType: entry.providerType,
      providerVersion: entry.providerVersion,
      category: entry.category,
      digest: entry.bundleDigest,
      digestAlgorithm: entry.digestAlgorithm,
      activatedAt: new Date().toISOString(),
    };

    const objectDir = this.putObject(stagedObjectDir, entry.bundleDigest);

    const current = this.getPointer(channel, entry.providerType);
    if (current?.active.digest === ref.digest) {
      return { changed: false, ref: current.active, objectDir };
    }

    const next: ActivationPointer = {
      version: 1,
      active: ref,
      previous: current?.active ?? null,
    };
    this.writePointerAtomic(channel, entry.providerType, next);
    this.log(`Activated ${entry.providerType}@${entry.providerVersion} (${entry.bundleDigest.slice(0, 19)}…) on channel ${channel}`);
    return { changed: true, ref, objectDir };
  }

  /**
   * Roll back (channel, type) to the previously activated object. Pure
   * local pointer flip — no network, no object writes. Returns the new
   * active ref, or null when there is nothing to roll back to.
   */
  rollback(channel: ProviderChannel, providerType: string): ActivationRef | null {
    const current = this.getPointer(channel, providerType);
    if (!current?.previous) return null;
    if (!this.hasObject(current.previous.digest)) {
      throw new ProviderChannelError(
        'STORE_CORRUPT',
        `rollback object ${current.previous.digest} for "${providerType}" is missing from the store`,
        providerType,
      );
    }
    const next: ActivationPointer = {
      version: 1,
      active: current.previous,
      previous: current.active,
    };
    this.writePointerAtomic(channel, providerType, next);
    this.log(`Rolled back ${providerType} to ${current.previous.digest.slice(0, 19)}… on channel ${channel}`);
    return current.previous;
  }

  /** Remove an activation pointer (e.g. provider uninstalled). */
  removePointer(channel: ProviderChannel, providerType: string): boolean {
    const file = this.pointerPath(channel, providerType);
    if (!fs.existsSync(file)) return false;
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private writePointerAtomic(channel: ProviderChannel, providerType: string, pointer: ActivationPointer): void {
    const dir = this.activeDir(channel);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.pointerPath(channel, providerType);
    const tmp = path.join(dir, `.${providerType}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  // ─── GC (N=2 retention) ──────────────────────────────────

  /**
   * Reclaim unreferenced objects and stale staging dirs.
   *
   * Every pointer references at most its active + previous digest (N=2 per
   * provider type/channel), so anything else in objects/ is either an older
   * generation or a crash orphan and is safe to delete.
   */
  gc(): { removedObjects: string[]; removedStaging: number } {
    const referenced = new Set<string>();
    for (const channel of ['stable', 'preview'] as const) {
      const dir = this.activeDir(channel);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          if (typeof parsed?.active?.digest === 'string') referenced.add(parsed.active.digest);
          if (typeof parsed?.previous?.digest === 'string') referenced.add(parsed.previous.digest);
        } catch { /* corrupt pointer — its objects stay until the pointer is repaired/removed */ }
      }
    }

    const removedObjects: string[] = [];
    let objectNames: string[] = [];
    try {
      objectNames = fs.readdirSync(this.objectsDir);
    } catch {
      objectNames = [];
    }
    for (const name of objectNames) {
      const digest = `sha256:${name}`;
      if (referenced.has(digest)) continue;
      try {
        fs.rmSync(path.join(this.objectsDir, name), { recursive: true, force: true });
        removedObjects.push(digest);
      } catch { /* best-effort */ }
    }

    let removedStaging = 0;
    let stagingEntries: string[] = [];
    try {
      stagingEntries = fs.readdirSync(this.stagingDir);
    } catch {
      stagingEntries = [];
    }
    for (const name of stagingEntries) {
      try {
        fs.rmSync(path.join(this.stagingDir, name), { recursive: true, force: true });
        removedStaging++;
      } catch { /* best-effort */ }
    }

    if (removedObjects.length > 0 || removedStaging > 0) {
      this.log(`GC: removed ${removedObjects.length} unreferenced object(s), ${removedStaging} staging dir(s)`);
    }
    return { removedObjects, removedStaging };
  }
}
