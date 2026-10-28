/**
 * Transfer manifests: the selection manifest (what the owner previews and approves on
 * BOTH machines) and the content manifest (selection + per-file SHA-256 / block hashes,
 * produced when the approved bytes are frozen into the spool).
 */
import { createHash } from 'node:crypto';
import { TransferFsError, splitPortableRelativePath } from '../transfer-fs/index.js';
import { TRANSFER_LIMITS } from './limits.js';
import { matchSecretPath } from './secret-exclusion.js';

export type ManifestEntryKind = 'file' | 'dir';

export interface SelectionEntry {
  path: string;
  kind: ManifestEntryKind;
  /** Files only. */
  size?: number;
}

export interface ExcludedEntry {
  path: string;
  reason: string;
}

export interface SelectionManifest {
  v: 1;
  transferId: string;
  sourceDaemonId: string;
  targetDaemonId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  finalName: string;
  entries: SelectionEntry[];
  excluded: ExcludedEntry[];
}

export interface ContentFileInfo {
  path: string;
  size: number;
  sha256: string;
  /** SHA-256 hex of every TRANSFER_LIMITS.blockBytes block (last may be short). */
  blockHashes: string[];
}

export interface ContentManifest {
  v: 1;
  transferId: string;
  selectionDigest: string;
  files: ContentFileInfo[];
}

export class ManifestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TRANSFER_ID_RE = /^[0-9a-f]{32}$/;

export function isTransferId(v: unknown): v is string {
  return typeof v === 'string' && TRANSFER_ID_RE.test(v);
}

/** Canonical JSON: sorted object keys, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Normalise ordering so equal selections produce equal bytes. */
export function normalizeSelection(m: SelectionManifest): SelectionManifest {
  return {
    ...m,
    entries: [...m.entries].sort((a, b) => byteCompare(a.path, b.path)),
    excluded: [...m.excluded].sort((a, b) => byteCompare(a.path, b.path)),
  };
}

export function selectionDigest(m: SelectionManifest): string {
  return sha256Hex(canonicalJson(normalizeSelection(m)));
}

export function contentDigest(m: ContentManifest): string {
  return sha256Hex(canonicalJson(m));
}

export function manifestByteLength(m: SelectionManifest | ContentManifest): number {
  return Buffer.byteLength(canonicalJson(m), 'utf8');
}

export function blockCount(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / TRANSFER_LIMITS.blockBytes);
}

/** Validate a folder name the owner chose for the new target folder (single segment). */
export function validateFinalName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) throw new ManifestError('INVALID_FINAL_NAME', 'finalName required');
  try {
    const segs = splitPortableRelativePath(name);
    if (segs.length !== 1) throw new ManifestError('INVALID_FINAL_NAME', 'finalName must be a single path segment');
    return segs[0]!;
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    if (err instanceof TransferFsError) throw new ManifestError('INVALID_FINAL_NAME', err.message);
    throw err;
  }
}

/**
 * Strict structural validation of a selection manifest (own or received from a peer).
 * Throws ManifestError with a stable code. Enforces D3 limits, portable paths,
 * case-collision freedom and parent-directory closure.
 */
export function validateSelectionManifest(raw: unknown): SelectionManifest {
  const m = raw as SelectionManifest;
  if (!m || typeof m !== 'object' || m.v !== 1) throw new ManifestError('MANIFEST_INVALID', 'unsupported manifest version');
  if (!isTransferId(m.transferId)) throw new ManifestError('MANIFEST_INVALID', 'bad transferId');
  for (const k of ['sourceDaemonId', 'targetDaemonId', 'sourceWorkspaceId', 'targetWorkspaceId'] as const) {
    if (typeof m[k] !== 'string' || !m[k] || m[k].length > 256) throw new ManifestError('MANIFEST_INVALID', `bad ${k}`);
  }
  validateFinalName(m.finalName);
  if (!Array.isArray(m.entries) || !Array.isArray(m.excluded)) throw new ManifestError('MANIFEST_INVALID', 'entries/excluded required');
  if (m.entries.length > TRANSFER_LIMITS.maxEntries) throw new ManifestError('LIMIT_EXCEEDED', `more than ${TRANSFER_LIMITS.maxEntries} entries`);
  if (m.entries.length === 0) throw new ManifestError('MANIFEST_INVALID', 'nothing selected');
  if (m.excluded.length > TRANSFER_LIMITS.maxEntries * 4) throw new ManifestError('LIMIT_EXCEEDED', 'too many excluded entries');

  const seen = new Map<string, ManifestEntryKind>();
  let total = 0;
  for (const e of m.entries) {
    if (!e || typeof e !== 'object' || (e.kind !== 'file' && e.kind !== 'dir') || typeof e.path !== 'string') {
      throw new ManifestError('MANIFEST_INVALID', 'bad entry');
    }
    try { splitPortableRelativePath(e.path); } catch (err) {
      throw new ManifestError('PATH_REJECTED', `entry path rejected: ${(err as Error).message}`);
    }
    // Receiver-side enforcement: a peer (or a tampered source) can never smuggle a secret path through.
    if (matchSecretPath(e.path) !== null) throw new ManifestError('SECRET_PATH_REJECTED', 'entry path matches a secret exclusion rule');
    const key = e.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ManifestError('CASE_COLLISION', 'case-insensitive duplicate path');
    seen.set(key, e.kind);
    if (e.kind === 'file') {
      if (!Number.isSafeInteger(e.size) || (e.size as number) < 0) throw new ManifestError('MANIFEST_INVALID', 'bad file size');
      if ((e.size as number) > TRANSFER_LIMITS.maxFileBytes) throw new ManifestError('LIMIT_EXCEEDED', 'file exceeds per-file limit');
      total += e.size as number;
    } else if (e.size !== undefined) {
      throw new ManifestError('MANIFEST_INVALID', 'dir entry with size');
    }
  }
  if (total > TRANSFER_LIMITS.maxTransferBytes) throw new ManifestError('LIMIT_EXCEEDED', 'transfer exceeds total size limit');
  // Parent closure: every parent of an entry must be a dir entry of the manifest.
  for (const e of m.entries) {
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/').normalize('NFC').toLowerCase();
      if (seen.get(parent) !== 'dir') throw new ManifestError('MANIFEST_INVALID', 'entry parent directory missing from manifest');
    }
  }
  for (const x of m.excluded) {
    if (!x || typeof x.path !== 'string' || typeof x.reason !== 'string' || x.path.length > 4096 || x.reason.length > 128) {
      throw new ManifestError('MANIFEST_INVALID', 'bad excluded entry');
    }
  }
  if (manifestByteLength(m) > TRANSFER_LIMITS.maxManifestBytes) throw new ManifestError('LIMIT_EXCEEDED', 'manifest exceeds 2 MiB');
  return m;
}

export function selectionTotalBytes(m: SelectionManifest): number {
  return m.entries.reduce((n, e) => n + (e.kind === 'file' ? (e.size as number) : 0), 0);
}

export function selectionFiles(m: SelectionManifest): Array<SelectionEntry & { size: number }> {
  return normalizeSelection(m).entries.filter((e): e is SelectionEntry & { size: number } => e.kind === 'file');
}

/** Validate a content manifest against the approved selection (exact file set and sizes). */
export function validateContentManifest(raw: unknown, selection: SelectionManifest): ContentManifest {
  const c = raw as ContentManifest;
  if (!c || typeof c !== 'object' || c.v !== 1 || c.transferId !== selection.transferId) throw new ManifestError('MANIFEST_INVALID', 'content manifest mismatch');
  if (c.selectionDigest !== selectionDigest(selection)) throw new ManifestError('APPROVAL_MISMATCH', 'content manifest is for a different selection');
  const want = selectionFiles(selection);
  if (!Array.isArray(c.files) || c.files.length !== want.length) throw new ManifestError('SOURCE_CHANGED', 'file set differs from approved selection');
  const sorted = [...c.files].sort((a, b) => byteCompare(a.path, b.path));
  sorted.forEach((f, i) => {
    const w = want[i]!;
    if (matchSecretPath(f.path) !== null) throw new ManifestError('SECRET_PATH_REJECTED', 'content path matches a secret exclusion rule');
    if (f.path !== w.path || f.size !== w.size) throw new ManifestError('SOURCE_CHANGED', 'file differs from approved selection');
    if (!SHA256_HEX.test(f.sha256) || !Array.isArray(f.blockHashes) || f.blockHashes.length !== blockCount(f.size) || !f.blockHashes.every((h) => SHA256_HEX.test(h))) {
      throw new ManifestError('MANIFEST_INVALID', 'bad file hashes');
    }
  });
  if (manifestByteLength(c) > TRANSFER_LIMITS.maxManifestBytes) throw new ManifestError('LIMIT_EXCEEDED', 'content manifest exceeds 2 MiB');
  return { ...c, files: sorted };
}
