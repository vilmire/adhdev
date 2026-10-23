/**
 * Workspace-contained file resolution, allowlist enforcement, and bounded
 * descriptor-verified reading for Artifact Viewer (Task A).
 *
 * Security & TOCTOU notes:
 * - A single `realpathSync` check before `readFileSync` is NOT sufficient against
 *   concurrent symlink swaps or files growing past 4 MiB between `stat` and `read`.
 * - This module performs:
 *   1. Canonical workspace directory verification (`realpathSync` + `isDirectory`).
 *   2. Lexical and segment validation (rejecting `\0`, UNC paths, Windows reserved
 *      device names, and `..` traversal outside workspace).
 *   3. Step-by-step ancestor `lstatSync` + `realpathSync` containment inside
 *      `realWorkspaceRoot + path.sep` (blocking both direct and intermediate
 *      directory symlinks escaping the workspace).
 *   4. Opening the canonical target with `O_RDONLY | O_NOFOLLOW` (where supported
 *      by the OS) and verifying `fstatSync(fd)` is a regular file with the exact
 *      `(dev, ino)` observed before open and `size <= MAX_ARTIFACT_BYTES`.
 *   5. Reading from the open `fd` in bounded chunks capped at `MAX_ARTIFACT_BYTES + 1`
 *      bytes (never an unbounded `readFileSync`), immediately aborting with
 *      `artifact_too_large` if the file grows beyond 4 MiB during read.
 *   6. Re-verifying post-read `realpathSync(candidatePath)` and `(dev, ino)` so a
 *      concurrent path replacement during the read window is rejected.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { containsEncodedOrRawSecret } from '../logging/credential-redactor.js';
import {
    ARTIFACT_EXTENSION_MAP,
    ARTIFACT_KINDS,
    ArtifactGuardError,
    MAX_ARTIFACT_BYTES,
    MAX_PREVIEW_TEXT_CHARS,
    MIME_BY_KIND,
    type ArtifactKind,
} from './types.js';

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
    /^\.env/i,
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /\.kdbx$/i,
    /^id_(rsa|ed25519|ecdsa|dsa)/i,
    /^\.npmrc$/i,
    /^\.pypirc$/i,
    /^\.netrc$/i,
    /^credentials\.json$/i,
    /^client_secret.*\.json$/i,
];

const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\b(?:adk|adm|shr|wtk|wtt|wsb)_[A-Za-z0-9_-]{12,}\b/,
    /\bmcp_sess_[A-Za-z0-9_-]{8,}\b/,
    /\bADHDEV_MCP_SESSION_CREDENTIAL\b/,
    /\bmcpSessionCredential\s*["']?\s*[:=]\s*["']?(?!\[)[A-Za-z0-9/+._-]{8,}/i,
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:[A-Z0-9_]*?(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|SESSION_CREDENTIAL))\s*[:=]\s*['"]?[A-Za-z0-9/+._-]{16,}['"]?/i,
];

/**
 * OD-6 fail-closed secret path check: refuses `.env*`, `*.pem`, `id_rsa*`, and
 * common credential filenames before extension/MIME classification.
 */
export function assertNotSecretPath(candidatePathOrRel: string): void {
    if (typeof candidatePathOrRel !== 'string' || !candidatePathOrRel) {
        return;
    }
    const normalized = candidatePathOrRel.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    for (const seg of segments) {
        for (const pattern of SECRET_BASENAME_PATTERNS) {
            if (pattern.test(seg)) {
                throw new ArtifactGuardError(
                    'secret_file_refused',
                    `Artifact path "${candidatePathOrRel}" matches secret filename pattern and is refused (secret_file_refused)`,
                );
            }
        }
    }
}

/**
 * OD-6 fail-closed secret content check: refuses files containing private keys
 * or credential/token patterns (including polyglot/embedded payloads in image files).
 */
export function assertNotSecretContent(buffer: Buffer, _kind: ArtifactKind): void {
    if (buffer.byteLength === 0) {
        return;
    }
    const text = buffer.toString('utf8');
    if (containsEncodedOrRawSecret(text, SECRET_CONTENT_PATTERNS)) {
        throw new ArtifactGuardError(
            'secret_file_refused',
            'Artifact content matches a secret or token pattern and is refused (secret_file_refused)',
        );
    }
}

export interface ArtifactTestRaceHooks {
    /** Invoked after pre-open `realpath`/`lstat` checks, right before `openSync`. */
    beforeOpen?: () => void;
    /** Invoked after `openSync` + initial `fstatSync`, right before chunked `readSync`. */
    afterStatBeforeRead?: () => void;
}

export interface ResolveArtifactFileOptions {
    declaredKind?: ArtifactKind;
    declaredMime?: string;
    title?: string;
    /**
     * When provided (e.g. from persisted `session_artifacts.workspace_root`),
     * `readVerifiedArtifactFile` refuses to re-baseline if `realpathSync(workspaceRoot)`
     * resolves to any directory other than this exact canonical path.
     */
    pinnedCanonicalWorkspaceRoot?: string;
    _testHooks?: ArtifactTestRaceHooks;
}

export interface ResolvedArtifactFile {
    workspaceRoot: string;
    absPath: string;
    relPath: string;
    filename: string;
    title: string;
    kind: ArtifactKind;
    mime: string;
    sizeBytes: number;
    sha256: string;
    previewText: string | null;
}

export interface VerifiedArtifactFileRead extends ResolvedArtifactFile {
    buffer: Buffer;
}

function isUncPath(raw: string): boolean {
    return raw.startsWith('\\\\') || raw.startsWith('//');
}

function isStrictSubpath(realRoot: string, targetPath: string): boolean {
    const rel = path.relative(realRoot, targetPath);
    if (!rel || rel === '.') {
        return false;
    }
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel)) {
        return false;
    }
    return true;
}

function normalizeOptions(
    declaredKindOrOptions?: ArtifactKind | ResolveArtifactFileOptions,
): ResolveArtifactFileOptions {
    if (!declaredKindOrOptions) {
        return {};
    }
    if (typeof declaredKindOrOptions === 'string') {
        return { declaredKind: declaredKindOrOptions };
    }
    return declaredKindOrOptions;
}

/**
 * Sanitize an optional user/caller-supplied artifact title, falling back to
 * the sanitized basename of `relPath`.
 */
export function sanitizeArtifactTitle(rawTitle: string | undefined, fallbackFilename: string): string {
    const cleanFallback = fallbackFilename.replace(/[\u0000-\u001F\u007F]+/g, '').trim() || 'artifact';
    if (typeof rawTitle !== 'string') {
        return cleanFallback;
    }
    const cleaned = rawTitle
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[\u0000-\u001F\u007F]+/g, '')
        .trim();
    if (!cleaned) {
        return cleanFallback;
    }
    const codePoints = Array.from(cleaned);
    if (codePoints.length <= MAX_TITLE_CHARS) {
        return cleaned;
    }
    return codePoints.slice(0, MAX_TITLE_CHARS).join('');
}

/**
 * Extract up to `maxChars` UTF-8 characters (Unicode code points) without
 * splitting multibyte UTF-8 sequences or UTF-16 surrogate pairs.
 */
export function extractUtf8Preview(buffer: Buffer, maxChars: number = MAX_PREVIEW_TEXT_CHARS): string {
    if (buffer.byteLength === 0 || maxChars <= 0) {
        return '';
    }
    // At most 4 UTF-8 bytes per Unicode code point; decode a safe prefix window
    // (+4 bytes so we can drop any trailing incomplete multibyte sequence if sliced).
    const maxSliceBytes = Math.min(buffer.byteLength, maxChars * 4 + 4);
    const slice = buffer.subarray(0, maxSliceBytes);
    const decoded = slice.toString('utf8');
    // If we truncated the byte buffer, the very last char might be U+FFFD from a
    // cut multibyte sequence; slicing to `maxChars` code points drops the extra +4 window.
    const codePoints = Array.from(decoded).slice(0, maxChars);
    // Also ensure UTF-16 `.length <= maxChars` without splitting surrogate pairs.
    while (codePoints.length > 0 && codePoints.join('').length > maxChars) {
        codePoints.pop();
    }
    return codePoints.join('');
}

function validateExtensionKindAndMime(
    candidatePath: string,
    realTargetPath: string,
    options: ResolveArtifactFileOptions,
): { kind: ArtifactKind; mime: string } {
    const candidateExt = path.extname(candidatePath).toLowerCase();
    const realExt = path.extname(realTargetPath).toLowerCase();

    const candidateSpec = ARTIFACT_EXTENSION_MAP[candidateExt];
    const realSpec = ARTIFACT_EXTENSION_MAP[realExt];

    if (!candidateSpec || !realSpec) {
        throw new ArtifactGuardError(
            'unsupported_mime_or_kind',
            `Unsupported artifact file extension "${candidateExt || realExt || '(none)'}" (unsupported_mime_or_kind)`,
        );
    }

    if (candidateSpec.kind !== realSpec.kind || candidateSpec.mime !== realSpec.mime) {
        throw new ArtifactGuardError(
            'unsupported_mime_or_kind',
            `Symlink extension "${candidateExt}" does not match target extension "${realExt}" (unsupported_mime_or_kind)`,
        );
    }

    const { kind, mime: canonicalMime } = realSpec;

    if (options.declaredKind !== undefined) {
        if (
            !(ARTIFACT_KINDS as readonly string[]).includes(options.declaredKind) ||
            options.declaredKind !== kind
        ) {
            throw new ArtifactGuardError(
                'unsupported_mime_or_kind',
                `Declared kind "${options.declaredKind}" does not match file kind "${kind}" (unsupported_mime_or_kind)`,
            );
        }
    }

    let resolvedMime = canonicalMime;
    if (options.declaredMime !== undefined) {
        const normalizedMime = options.declaredMime.split(';')[0]?.trim().toLowerCase() ?? '';
        const allowedMimes = MIME_BY_KIND[kind];
        if (
            !normalizedMime ||
            normalizedMime === 'image/svg+xml' ||
            normalizedMime === 'text/html' ||
            normalizedMime === 'application/xhtml+xml' ||
            !allowedMimes.includes(normalizedMime) ||
            (kind === 'image' && normalizedMime !== canonicalMime)
        ) {
            throw new ArtifactGuardError(
                'unsupported_mime_or_kind',
                `Declared MIME "${options.declaredMime}" is not allowed for kind "${kind}" (unsupported_mime_or_kind)`,
            );
        }
        resolvedMime = normalizedMime;
    }

    return { kind, mime: resolvedMime };
}

function resolveCanonicalWorkspaceRoot(workspaceRoot: string): {
    realWorkspaceRoot: string;
    resolvedWorkspaceInput: string;
} {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0 || workspaceRoot.includes('\0')) {
        throw new ArtifactGuardError(
            'invalid_workspace_root',
            'Workspace root must be a non-empty valid directory path (invalid_workspace_root)',
        );
    }
    if (isUncPath(workspaceRoot)) {
        throw new ArtifactGuardError(
            'invalid_workspace_root',
            'UNC workspace roots are not allowed (invalid_workspace_root)',
        );
    }

    const resolvedWorkspaceInput = path.resolve(workspaceRoot);
    let realWorkspaceRoot: string;
    try {
        realWorkspaceRoot = fs.realpathSync(resolvedWorkspaceInput);
        const st = fs.statSync(realWorkspaceRoot);
        if (!st.isDirectory()) {
            throw new ArtifactGuardError(
                'invalid_workspace_root',
                'Workspace root is not a directory (invalid_workspace_root)',
            );
        }
    } catch (err) {
        if (err instanceof ArtifactGuardError) {
            throw err;
        }
        throw new ArtifactGuardError(
            'invalid_workspace_root',
            `Workspace root cannot be resolved: ${(err as Error).message} (invalid_workspace_root)`,
        );
    }

    return { realWorkspaceRoot, resolvedWorkspaceInput };
}

function resolveCandidateWithinWorkspace(
    realWorkspaceRoot: string,
    resolvedWorkspaceInput: string,
    rawPath: string,
): { candidatePath: string; lexicalRel: string } {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Artifact path must be a non-empty string without null bytes (path_outside_workspace)',
        );
    }
    if (isUncPath(rawPath)) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'UNC artifact paths are not allowed (path_outside_workspace)',
        );
    }
    if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(rawPath)) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Windows drive-letter paths are not allowed on POSIX (path_outside_workspace)',
        );
    }

    let candidatePath: string;
    if (path.isAbsolute(rawPath)) {
        const normalizedAbs = path.resolve(rawPath.replace(/[\\/]+/g, path.sep));
        if (normalizedAbs === realWorkspaceRoot || normalizedAbs === resolvedWorkspaceInput) {
            throw new ArtifactGuardError(
                'not_a_regular_file',
                'Target path is the workspace root directory (not_a_regular_file)',
            );
        }
        if (isStrictSubpath(realWorkspaceRoot, normalizedAbs)) {
            candidatePath = normalizedAbs;
        } else if (isStrictSubpath(resolvedWorkspaceInput, normalizedAbs)) {
            const relFromInput = path.relative(resolvedWorkspaceInput, normalizedAbs);
            candidatePath = path.resolve(realWorkspaceRoot, relFromInput);
        } else {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Artifact path "${rawPath}" is outside workspace root (path_outside_workspace)`,
            );
        }
    } else {
        const normalizedRelInput = rawPath.replace(/[\\/]+/g, path.sep);
        candidatePath = path.resolve(realWorkspaceRoot, normalizedRelInput);
        if (candidatePath === realWorkspaceRoot) {
            throw new ArtifactGuardError(
                'not_a_regular_file',
                'Target path resolves to workspace root directory (not_a_regular_file)',
            );
        }
        if (!isStrictSubpath(realWorkspaceRoot, candidatePath)) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Relative path "${rawPath}" escapes workspace root (path_outside_workspace)`,
            );
        }
    }

    const lexicalRel = path.relative(realWorkspaceRoot, candidatePath);
    if (!isStrictSubpath(realWorkspaceRoot, candidatePath)) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Resolved path "${rawPath}" escapes workspace root (path_outside_workspace)`,
        );
    }

    const segments = lexicalRel.split(path.sep);
    for (const seg of segments) {
        if (!seg || seg === '.' || seg === '..' || WINDOWS_RESERVED_NAME_RE.test(seg)) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Invalid or reserved path segment "${seg}" in artifact path (path_outside_workspace)`,
            );
        }
    }

    return { candidatePath, lexicalRel };
}

function verifyAncestorAndTargetContainment(
    realWorkspaceRoot: string,
    candidatePath: string,
    lexicalRel: string,
): { realTargetPath: string; targetLstat: fs.Stats } {
    const segments = lexicalRel.split(path.sep);
    let currentPath = realWorkspaceRoot;

    for (let i = 0; i < segments.length; i++) {
        currentPath = path.join(currentPath, segments[i]!);
        let entryLstat: fs.Stats;
        try {
            entryLstat = fs.lstatSync(currentPath);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                throw new ArtifactGuardError(
                    'artifact_not_found',
                    `Artifact file not found: ${lexicalRel} (artifact_not_found)`,
                );
            }
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Cannot stat artifact path component: ${(err as Error).message} (path_outside_workspace)`,
            );
        }

        if (entryLstat.isSymbolicLink()) {
            let resolvedLink: string;
            try {
                resolvedLink = fs.realpathSync(currentPath);
            } catch {
                // Broken symlink: check raw link target or reject as escaping/invalid symlink.
                throw new ArtifactGuardError(
                    'path_outside_workspace',
                    `Symlink at "${segments.slice(0, i + 1).join('/')}" cannot be resolved inside workspace (path_outside_workspace)`,
                );
            }
            if (!isStrictSubpath(realWorkspaceRoot, resolvedLink)) {
                throw new ArtifactGuardError(
                    'path_outside_workspace',
                    `Symlink at "${segments.slice(0, i + 1).join('/')}" escapes workspace root (path_outside_workspace)`,
                );
            }
        }
    }

    let realTargetPath: string;
    try {
        realTargetPath = fs.realpathSync(candidatePath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            throw new ArtifactGuardError(
                'artifact_not_found',
                `Artifact file not found: ${lexicalRel} (artifact_not_found)`,
            );
        }
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Cannot resolve canonical artifact path: ${(err as Error).message} (path_outside_workspace)`,
        );
    }

    if (!isStrictSubpath(realWorkspaceRoot, realTargetPath)) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Canonical target "${realTargetPath}" escapes workspace root (path_outside_workspace)`,
        );
    }

    let targetLstat: fs.Stats;
    try {
        targetLstat = fs.lstatSync(realTargetPath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            throw new ArtifactGuardError(
                'artifact_not_found',
                `Artifact target disappeared: ${lexicalRel} (artifact_not_found)`,
            );
        }
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Cannot lstat canonical target: ${(err as Error).message} (path_outside_workspace)`,
        );
    }

    if (targetLstat.isSymbolicLink()) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Canonical target unexpectedly remained a symbolic link (path_outside_workspace)',
        );
    }

    if (!targetLstat.isFile()) {
        throw new ArtifactGuardError(
            'not_a_regular_file',
            `Artifact target "${lexicalRel}" is not a regular file (not_a_regular_file)`,
        );
    }

    if (targetLstat.nlink > 1) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Hard-linked regular files (nlink=${targetLstat.nlink}) are refused for "${lexicalRel}" (path_outside_workspace)`,
        );
    }

    if (targetLstat.size > MAX_ARTIFACT_BYTES) {
        throw new ArtifactGuardError(
            'artifact_too_large',
            `Artifact size ${targetLstat.size} exceeds limit of ${MAX_ARTIFACT_BYTES} bytes (artifact_too_large)`,
        );
    }

    return { realTargetPath, targetLstat };
}

/**
 * Validate and read an artifact file using descriptor identity checks and
 * bounded chunked reads (`<= MAX_ARTIFACT_BYTES`).
 */
export function readVerifiedArtifactFile(
    workspaceRoot: string,
    rawPath: string,
    declaredKindOrOptions?: ArtifactKind | ResolveArtifactFileOptions,
): VerifiedArtifactFileRead {
    const options = normalizeOptions(declaredKindOrOptions);
    const expectedPinnedRoot =
        typeof options.pinnedCanonicalWorkspaceRoot === 'string' &&
        options.pinnedCanonicalWorkspaceRoot.trim().length > 0
            ? path.resolve(options.pinnedCanonicalWorkspaceRoot)
            : null;
    const { realWorkspaceRoot, resolvedWorkspaceInput } = resolveCanonicalWorkspaceRoot(workspaceRoot);
    if (expectedPinnedRoot !== null && realWorkspaceRoot !== expectedPinnedRoot) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Canonical workspace root changed from pinned workspace root before read (path_outside_workspace)',
        );
    }
    const { candidatePath, lexicalRel } = resolveCandidateWithinWorkspace(
        realWorkspaceRoot,
        resolvedWorkspaceInput,
        rawPath,
    );
    const { realTargetPath, targetLstat } = verifyAncestorAndTargetContainment(
        realWorkspaceRoot,
        candidatePath,
        lexicalRel,
    );
    assertNotSecretPath(rawPath);
    assertNotSecretPath(lexicalRel);
    assertNotSecretPath(path.relative(realWorkspaceRoot, realTargetPath));
    const { kind, mime } = validateExtensionKindAndMime(candidatePath, realTargetPath, options);

    let rootLstat: fs.Stats;
    try {
        rootLstat = fs.lstatSync(realWorkspaceRoot);
    } catch {
        throw new ArtifactGuardError(
            'invalid_workspace_root',
            'Canonical workspace root is inaccessible (invalid_workspace_root)',
        );
    }
    if (
        rootLstat.isSymbolicLink() ||
        !rootLstat.isDirectory() ||
        (expectedPinnedRoot !== null && realWorkspaceRoot !== expectedPinnedRoot)
    ) {
        throw new ArtifactGuardError(
            'path_outside_workspace',
            'Canonical workspace root is not a regular directory (path_outside_workspace)',
        );
    }

    options._testHooks?.beforeOpen?.();

    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    let fd: number;
    try {
        fd = fs.openSync(realTargetPath, openFlags);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EMLINK') {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Target was swapped with a symbolic link before open (path_outside_workspace)',
            );
        }
        if (code === 'EISDIR') {
            throw new ArtifactGuardError(
                'not_a_regular_file',
                'Target is a directory, not a regular file (not_a_regular_file)',
            );
        }
        if (code === 'ENOENT') {
            throw new ArtifactGuardError(
                'artifact_not_found',
                `Artifact file disappeared before open: ${lexicalRel} (artifact_not_found)`,
            );
        }
        throw new ArtifactGuardError(
            'path_outside_workspace',
            `Failed to open artifact file safely: ${(err as Error).message} (path_outside_workspace)`,
        );
    }

    let buffer: Buffer;
    try {
        const fdStat = fs.fstatSync(fd);
        if (!fdStat.isFile()) {
            throw new ArtifactGuardError(
                'not_a_regular_file',
                'Opened descriptor is not a regular file (not_a_regular_file)',
            );
        }
        if (fdStat.nlink > 1) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Opened descriptor has multiple hard links (nlink=${fdStat.nlink}) (path_outside_workspace)`,
            );
        }
        if (fdStat.dev !== targetLstat.dev || fdStat.ino !== targetLstat.ino) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'File inode/device changed between lstat and open (path_outside_workspace)',
            );
        }
        if (fdStat.size > MAX_ARTIFACT_BYTES) {
            throw new ArtifactGuardError(
                'artifact_too_large',
                `Artifact size ${fdStat.size} exceeds limit of ${MAX_ARTIFACT_BYTES} bytes (artifact_too_large)`,
            );
        }

        options._testHooks?.afterStatBeforeRead?.();

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let position = 0;
        const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, fdStat.size + 1)));

        while (true) {
            const bytesRead = fs.readSync(fd, scratch, 0, scratch.byteLength, position);
            if (bytesRead <= 0) {
                break;
            }
            totalBytes += bytesRead;
            position += bytesRead;
            if (totalBytes > MAX_ARTIFACT_BYTES) {
                throw new ArtifactGuardError(
                    'artifact_too_large',
                    `Artifact grew beyond ${MAX_ARTIFACT_BYTES} bytes during read (artifact_too_large)`,
                );
            }
            chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
        }

        const postFdStat = fs.fstatSync(fd);
        if (!postFdStat.isFile()) {
            throw new ArtifactGuardError(
                'not_a_regular_file',
                'Descriptor ceased to be a regular file after read (not_a_regular_file)',
            );
        }
        if (postFdStat.nlink > 1) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Descriptor acquired additional hard links during read (nlink=${postFdStat.nlink}) (path_outside_workspace)`,
            );
        }
        if (postFdStat.size > MAX_ARTIFACT_BYTES) {
            throw new ArtifactGuardError(
                'artifact_too_large',
                `Artifact size ${postFdStat.size} exceeds limit of ${MAX_ARTIFACT_BYTES} bytes after read (artifact_too_large)`,
            );
        }

        // Re-verify that the canonical workspace root and candidate path still
        // resolve inside the exact same directory/file inodes we validated.
        let postRootReal: string;
        let postRootLstat: fs.Stats;
        let postRealTarget: string;
        let postTargetLstat: fs.Stats;
        try {
            postRootLstat = fs.lstatSync(realWorkspaceRoot);
            postRootReal = fs.realpathSync(realWorkspaceRoot);
            postRealTarget = fs.realpathSync(candidatePath);
            postTargetLstat = fs.lstatSync(postRealTarget);
        } catch {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Artifact path or workspace root was removed or replaced during read (path_outside_workspace)',
            );
        }
        if (
            postRootLstat.isSymbolicLink() ||
            !postRootLstat.isDirectory() ||
            postRootReal !== realWorkspaceRoot ||
            postRootLstat.dev !== rootLstat.dev ||
            postRootLstat.ino !== rootLstat.ino ||
            !isStrictSubpath(realWorkspaceRoot, postRealTarget) ||
            postTargetLstat.isSymbolicLink() ||
            !postTargetLstat.isFile() ||
            postTargetLstat.nlink > 1 ||
            postTargetLstat.dev !== fdStat.dev ||
            postTargetLstat.ino !== fdStat.ino
        ) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Artifact path escaped workspace or changed inode during read (path_outside_workspace)',
            );
        }

        buffer = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, totalBytes);
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            // Ignore close errors on already-closing descriptor.
        }
    }

    assertNotSecretContent(buffer, kind);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const relPath = lexicalRel.split(path.sep).join('/');
    const filename = path.posix.basename(relPath);
    const title = sanitizeArtifactTitle(options.title, filename);
    const previewText = kind === 'image' ? null : extractUtf8Preview(buffer, MAX_PREVIEW_TEXT_CHARS);

    return {
        workspaceRoot: realWorkspaceRoot,
        absPath: realTargetPath,
        relPath,
        filename,
        title,
        kind,
        mime,
        sizeBytes: buffer.byteLength,
        sha256,
        previewText,
        buffer,
    };
}

/**
 * Validate and resolve an artifact file inside `workspaceRoot`, returning
 * metadata (`sizeBytes`, `sha256`, `previewText`, `kind`, `mime`, `relPath`,
 * `title`) without retaining the full file buffer.
 */
export function resolveArtifactFile(
    workspaceRoot: string,
    rawPath: string,
    declaredKindOrOptions?: ArtifactKind | ResolveArtifactFileOptions,
): ResolvedArtifactFile {
    const { buffer: _buffer, ...metadata } = readVerifiedArtifactFile(
        workspaceRoot,
        rawPath,
        declaredKindOrOptions,
    );
    return metadata;
}
