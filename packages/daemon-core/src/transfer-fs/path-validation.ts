/**
 * Portable path and segment validation for the handle-relative file transfer helper (Phase 1).
 *
 * Enforces the cross-platform path rules from PLAN.txt §4 and PROTOCOL.txt §5:
 * - Relative `/` paths only; no leading/trailing `/`, no `\`, no empty segments
 * - Rejects `.` and `..`, drive letters (`C:`), UNC/device paths (`\\`, `//`)
 * - Rejects NUL (`\0`) and control chars (`0x00..0x1F`, `0x7F`)
 * - Rejects `:` (NTFS Alternate Data Streams) and `~` (8.3 short-name aliases like `GIT~1`)
 * - Rejects trailing `.` or `' '` (stripped by Win32 path normalization)
 * - Rejects non-NFC Unicode strings and unpaired UTF-16 surrogates
 * - Rejects Windows reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`,
 *   `LPT1..9`, `COM¹..³`, `LPT¹..³`, `CONIN$`, `CONOUT$`, `CLOCK$`, bare or with `.ext`)
 */

export type TransferFsErrorCode =
  | 'PATH_TRAVERSAL_REJECTED'
  | 'SYMLINK_OR_REPARSE_REJECTED'
  | 'TARGET_EXISTS'
  | 'ROOT_UNAVAILABLE'
  | 'DISK_SPACE_EXHAUSTED'
  | 'CASE_COLLISION_REJECTED'
  | 'HARDLINK_REJECTED'
  | 'PUBLISHED_HARDLINK_DETECTED'
  | 'POST_RENAME_QUARANTINED'
  | 'ATOMIC_NOREPLACE_UNSUPPORTED'
  | 'INVALID_HANDLE'
  | 'IO_ERROR';

export class TransferFsError extends Error {
  public readonly reason: TransferFsErrorCode;
  public readonly code: string;
  public readonly nativeMessage?: string;

  constructor(reason: TransferFsErrorCode, message: string, nativeCode?: string, nativeMessage?: string) {
    super(message);
    this.name = 'TransferFsError';
    this.reason = reason;
    this.code = nativeCode ?? reason;
    this.nativeMessage = nativeMessage;
  }
}

export const MAX_RELATIVE_PATH_BYTES = 4096;
export const MAX_PATH_SEGMENTS = 64;
export const MAX_SEGMENT_BYTES = 255;

const WINDOWS_RESERVED_DOS_STEM_RE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;

const PROTECTED_METADATA_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.adhdev-transfer-staging',
]);

function hasUnpairedSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) return true;
      const low = str.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a segment is a protected VCS or staging metadata name (`.git`, `.hg`, `.svn`, `.adhdev-transfer-staging`).
 */
export function isProtectedMetadataSegment(segment: string): boolean {
  return PROTECTED_METADATA_SEGMENTS.has(segment.toLowerCase());
}

/**
 * Validate a single directory/file path segment against all cross-platform and Windows-specific hazards.
 */
export function validateTransferSegment(
  segment: string,
  options?: { allowProtectedMetadata?: boolean },
): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      'Path segment must be a non-empty string',
      'EINVAL',
    );
  }
  if (segment === '.' || segment === '..') {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Dot segment "${segment}" is forbidden`,
      'EINVAL',
    );
  }
  if (hasUnpairedSurrogate(segment)) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      'Path segment contains unpaired UTF-16 surrogate',
      'EINVAL',
    );
  }
  if (segment !== segment.normalize('NFC')) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Path segment "${segment}" is not Unicode NFC normalized`,
      'EINVAL',
    );
  }
  const byteLen = Buffer.byteLength(segment, 'utf8');
  if (byteLen === 0 || byteLen > MAX_SEGMENT_BYTES) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Path segment byte length (${byteLen}) exceeds ${MAX_SEGMENT_BYTES}`,
      'EINVAL',
    );
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Path segment "${segment}" has a trailing dot or space`,
      'EINVAL',
    );
  }

  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new TransferFsError(
        'PATH_TRAVERSAL_REJECTED',
        'Path segment contains NUL or control characters',
        'EINVAL',
      );
    }
    const ch = segment[i];
    if (ch === '/' || ch === '\\') {
      throw new TransferFsError(
        'PATH_TRAVERSAL_REJECTED',
        `Path segment "${segment}" contains a path separator`,
        'EINVAL',
      );
    }
    if (ch === ':') {
      throw new TransferFsError(
        'PATH_TRAVERSAL_REJECTED',
        `Path segment "${segment}" contains ":" (NTFS Alternate Data Stream / drive syntax forbidden)`,
        'EINVAL',
      );
    }
    if (ch === '~') {
      throw new TransferFsError(
        'PATH_TRAVERSAL_REJECTED',
        `Path segment "${segment}" contains "~" (Windows 8.3 short-name alias forbidden)`,
        'EINVAL',
      );
    }
  }

  const dotIdx = segment.indexOf('.');
  const rawStem = dotIdx === -1 ? segment : segment.slice(0, dotIdx);
  const stem = rawStem.replace(/ +$/g, '');
  if (WINDOWS_RESERVED_DOS_STEM_RE.test(stem)) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Path segment "${segment}" uses reserved Windows DOS device name "${stem}"`,
      'EINVAL',
    );
  }

  if (!options?.allowProtectedMetadata && isProtectedMetadataSegment(segment)) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Protected metadata segment "${segment}" is forbidden`,
      'EINVAL',
    );
  }

  return segment;
}

/**
 * Split and validate a portable `/`-separated relative path into validated segments.
 */
export function splitPortableRelativePath(
  relPath: string,
  options?: { allowProtectedMetadata?: boolean },
): string[] {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      'Relative path must be a non-empty string',
      'EINVAL',
    );
  }
  const totalBytes = Buffer.byteLength(relPath, 'utf8');
  if (totalBytes > MAX_RELATIVE_PATH_BYTES) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Relative path byte length (${totalBytes}) exceeds ${MAX_RELATIVE_PATH_BYTES}`,
      'EINVAL',
    );
  }
  if (relPath.startsWith('/') || relPath.endsWith('/') || relPath.includes('\\')) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Relative path "${relPath}" must use forward slashes without leading/trailing slashes or backslashes`,
      'EINVAL',
    );
  }
  const parts = relPath.split('/');
  if (parts.length === 0 || parts.length > MAX_PATH_SEGMENTS) {
    throw new TransferFsError(
      'PATH_TRAVERSAL_REJECTED',
      `Relative path segment count (${parts.length}) exceeds ${MAX_PATH_SEGMENTS}`,
      'EINVAL',
    );
  }
  for (const part of parts) {
    validateTransferSegment(part, options);
  }
  return parts;
}
