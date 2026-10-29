/**
 * Driver package bundles: scaffold, validate, export and import (design
 * docs/design/2026-10-29-driver-authoring-and-sharing.md).
 *
 * Pure data + fs helpers; no command, trust or activation logic lives here. A
 * bundle is one JSON file (so it rides the existing 4 MiB `json` artifact kind)
 * whose `treeDigest` is the same value the activation store binds to
 * (`computeDriverTreeDigest`): `driver/<type>/<rel>\0<len>\0<bytes>` over the
 * sorted files. The digest proves "the bytes the owner approved are the bytes
 * that run", NOT who authored them — no signatures (trade-off recorded in the
 * design doc).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDriverProviderManifest } from '../providers/sdk/v1/validators/manifest.js';
import type { DriverManifest } from './contracts.js';
import { validDriverDigest } from './activation-store.js';
import { deriveDriverRiskClass, type DriverRiskClass } from './risk-class.js';

export const DRIVER_BUNDLE_FORMAT = 'adhdev-driver-bundle';
export const DRIVER_BUNDLE_MAX_FILES = 200;
export const DRIVER_BUNDLE_MAX_FILE_BYTES = 1024 * 1024;
/** Raw bytes; base64 expansion (4/3) plus JSON framing stays under the 4 MiB artifact cap. */
export const DRIVER_BUNDLE_MAX_TOTAL_BYTES = 2_560_000;
export const DRIVER_BUNDLE_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const DRIVER_MANIFEST_FILE = 'provider.v1.json';
const MAX_PATH_CHARS = 200;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Never exported and never accepted in a bundle. */
const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

export class DriverPackageError extends Error {
    constructor(readonly code: string, message: string) { super(`${message} (${code})`); this.name = 'DriverPackageError'; }
}
export interface PackageFile { path: string; bytes: Buffer }
export interface DriverPackageReport {
    type: string; name: string; providerVersion: string; treeDigest: string;
    riskClass: DriverRiskClass; reasons: string[];
    declaredAccess: NonNullable<DriverManifest['declaredAccess']>;
    runtime: DriverManifest['runtime']; actions: DriverManifest['actions'];
    files: number; totalBytes: number;
}
export interface VerifiedDriverPackage { manifest: DriverManifest; files: PackageFile[]; report: DriverPackageReport }

export function isSafeDriverRelPath(rel: unknown): rel is string {
    if (typeof rel !== 'string' || !rel || rel.length > MAX_PATH_CHARS || !SAFE_PATH.test(rel)) return false;
    if (rel.startsWith('/') || rel.endsWith('/') || rel.includes('//')) return false;
    return rel.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..' && !EXCLUDED_NAMES.has(seg));
}
export function isValidDriverType(type: unknown): type is string {
    return typeof type === 'string' && type.length <= 64 && TYPE_PATTERN.test(type);
}

/** Same bytes-in-order construction as `computeDriverTreeDigest`, from memory. */
export function digestDriverFiles(type: string, files: readonly PackageFile[]): string {
    const hash = createHash('sha256');
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(`driver/${type}/${file.path}\0${file.bytes.length}\0`).update(file.bytes);
    }
    return `sha256:${hash.digest('hex')}`;
}

/** Read a package directory. Symlinks and special files are refused; excluded names are skipped. */
export function readDriverPackageDir(dir: string): PackageFile[] {
    const root = lstatSync(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new DriverPackageError('invalid_directory', 'Driver package must be a real directory');
    const out: PackageFile[] = [];
    const walk = (sub: string) => {
        for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
            if (EXCLUDED_NAMES.has(entry.name)) continue;
            const rel = sub ? `${sub}/${entry.name}` : entry.name;
            const stat = lstatSync(join(dir, rel));
            if (stat.isSymbolicLink()) throw new DriverPackageError('symlink_refused', `Symbolic link in driver package: ${rel}`);
            if (stat.isDirectory()) walk(rel);
            else if (stat.isFile()) {
                if (out.length >= DRIVER_BUNDLE_MAX_FILES) throw new DriverPackageError('too_many_files', `More than ${DRIVER_BUNDLE_MAX_FILES} files`);
                if (stat.size > DRIVER_BUNDLE_MAX_FILE_BYTES) throw new DriverPackageError('file_too_large', `${rel} exceeds ${DRIVER_BUNDLE_MAX_FILE_BYTES} bytes`);
                out.push({ path: rel, bytes: readFileSync(join(dir, rel)) });
            } else throw new DriverPackageError('non_regular_entry', `Non-regular entry in driver package: ${rel}`);
        }
    };
    walk('');
    return out;
}

const normRef = (value: string): string => value.replace(/^\.\//, '');

/** Structure, manifest and reference checks. Throws DriverPackageError on the first hard failure. */
export function verifyDriverFiles(files: readonly PackageFile[], opts: { checkReferences?: boolean } = {}): VerifiedDriverPackage {
    if (!files.length) throw new DriverPackageError('empty_package', 'Driver package has no files');
    if (files.length > DRIVER_BUNDLE_MAX_FILES) throw new DriverPackageError('too_many_files', `More than ${DRIVER_BUNDLE_MAX_FILES} files`);
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
        if (!isSafeDriverRelPath(file.path)) throw new DriverPackageError('unsafe_path', `Unsafe path in driver package: ${String(file.path).slice(0, 80)}`);
        const key = file.path.toLowerCase();
        if (seen.has(key)) throw new DriverPackageError('duplicate_path', `Duplicate path: ${file.path}`);
        seen.add(key);
        if (file.bytes.length > DRIVER_BUNDLE_MAX_FILE_BYTES) throw new DriverPackageError('file_too_large', `${file.path} exceeds ${DRIVER_BUNDLE_MAX_FILE_BYTES} bytes`);
        total += file.bytes.length;
    }
    if (total > DRIVER_BUNDLE_MAX_TOTAL_BYTES) throw new DriverPackageError('package_too_large', `Driver package exceeds ${DRIVER_BUNDLE_MAX_TOTAL_BYTES} bytes`);
    const manifestFile = files.find(f => f.path === DRIVER_MANIFEST_FILE);
    if (!manifestFile) throw new DriverPackageError('manifest_missing', `${DRIVER_MANIFEST_FILE} is required`);
    let manifest: DriverManifest;
    try { manifest = JSON.parse(manifestFile.bytes.toString('utf8')); }
    catch { throw new DriverPackageError('manifest_invalid', `${DRIVER_MANIFEST_FILE} is not valid JSON`); }
    const validation = validateDriverProviderManifest(manifest);
    if (!validation.ok) throw new DriverPackageError('manifest_invalid', `Manifest invalid: ${JSON.stringify(validation.issues).slice(0, 400)}`);
    if (!isValidDriverType(manifest.type)) throw new DriverPackageError('manifest_invalid', 'Invalid driver type');
    const paths = new Set(files.map(f => f.path));
    const refs: string[] = [];
    for (const action of manifest.actions) if (action.inputSchema) refs.push(action.inputSchema);
    if (manifest.guidance) refs.push(manifest.guidance);
    for (const arg of manifest.runtime.args ?? []) if (arg.startsWith('./')) refs.push(arg);
    for (const ref of opts.checkReferences === false ? [] : refs) {
        const rel = normRef(ref);
        if (!isSafeDriverRelPath(rel) || !paths.has(rel)) throw new DriverPackageError('missing_reference', `Manifest references a file that is not in the package: ${ref}`);
    }
    const risk = deriveDriverRiskClass(manifest);
    return { manifest, files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)), report: {
        type: manifest.type, name: manifest.name, providerVersion: manifest.providerVersion,
        treeDigest: digestDriverFiles(manifest.type, files), riskClass: risk.riskClass, reasons: risk.reasons,
        declaredAccess: structuredClone(manifest.declaredAccess ?? {}), runtime: structuredClone(manifest.runtime),
        actions: structuredClone(manifest.actions), files: files.length, totalBytes: total } };
}

export function encodeDriverBundle(pkg: VerifiedDriverPackage): string {
    const text = JSON.stringify({ format: DRIVER_BUNDLE_FORMAT, version: 1, type: pkg.report.type, name: pkg.report.name,
        providerVersion: pkg.report.providerVersion, treeDigest: pkg.report.treeDigest,
        files: pkg.files.map(f => ({ path: f.path, size: f.bytes.length, content: f.bytes.toString('base64') })) }, null, 1);
    if (Buffer.byteLength(text) > DRIVER_BUNDLE_MAX_JSON_BYTES) throw new DriverPackageError('package_too_large', 'Encoded bundle exceeds the 4 MiB artifact limit');
    return text;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BUNDLE_KEYS = new Set(['format', 'version', 'type', 'name', 'providerVersion', 'treeDigest', 'files']);

/** Strictly parse and verify a bundle. The declared digest must match the recomputed one. */
export function decodeDriverBundle(text: string): VerifiedDriverPackage {
    if (typeof text !== 'string' || Buffer.byteLength(text) > DRIVER_BUNDLE_MAX_JSON_BYTES) throw new DriverPackageError('package_too_large', 'Bundle exceeds the 4 MiB limit');
    let raw: any;
    try { raw = JSON.parse(text); } catch { throw new DriverPackageError('bundle_invalid', 'Bundle is not valid JSON'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.format !== DRIVER_BUNDLE_FORMAT || raw.version !== 1
        || Object.keys(raw).some(k => !BUNDLE_KEYS.has(k)) || !isValidDriverType(raw.type) || !validDriverDigest(raw.treeDigest)
        || !Array.isArray(raw.files)) throw new DriverPackageError('bundle_invalid', 'Not an adhdev-driver-bundle v1');
    if (raw.files.length > DRIVER_BUNDLE_MAX_FILES) throw new DriverPackageError('too_many_files', `More than ${DRIVER_BUNDLE_MAX_FILES} files`);
    const files: PackageFile[] = raw.files.map((entry: any) => {
        if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.content !== 'string'
            || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > DRIVER_BUNDLE_MAX_FILE_BYTES
            || Object.keys(entry).some(k => !['path', 'size', 'content'].includes(k)) || !BASE64.test(entry.content)) {
            throw new DriverPackageError('bundle_invalid', 'Malformed file entry in bundle');
        }
        const bytes = Buffer.from(entry.content, 'base64');
        if (bytes.length !== entry.size) throw new DriverPackageError('bundle_invalid', `Size mismatch for ${entry.path.slice(0, 80)}`);
        return { path: entry.path, bytes };
    });
    const pkg = verifyDriverFiles(files);
    if (pkg.manifest.type !== raw.type) throw new DriverPackageError('bundle_invalid', 'Bundle type does not match its manifest');
    if (pkg.report.treeDigest !== raw.treeDigest) throw new DriverPackageError('bundle_digest_mismatch', 'Bundle contents do not match the declared digest');
    return pkg;
}

export interface ScaffoldInput {
    type: string; name: string; command: string; args?: string[]; env?: string[];
    actions: Array<{ id: string; tool: string; risk?: 'read' | 'write' | 'destructive' }>;
    declaredAccess?: DriverManifest['declaredAccess']; guidance?: string; providerVersion?: string; publisher?: string;
}
/**
 * Package files wrapping an EXISTING MCP server command. Deliberately does not
 * launch the command to discover tools: that would let a worker make the daemon
 * run an arbitrary command without owner approval. Actions are explicit.
 * Unspecified risk defaults to `write` (fail toward more scrutiny).
 */
export function scaffoldDriverFiles(input: ScaffoldInput): PackageFile[] {
    const manifest: Record<string, unknown> = {
        $schema: 'https://adhf.dev/schemas/v1/driver/provider.schema.json',
        type: input.type, category: 'driver', name: input.name, providerVersion: input.providerVersion ?? '1.0.0',
        ...(input.publisher ? { publisher: input.publisher } : {}),
        compatibility: { driverApi: '^1.0.0' },
        runtime: { kind: 'mcp-stdio', command: input.command, ...(input.args?.length ? { args: input.args } : {}),
            ...(input.env?.length ? { env: input.env } : {}), startupTimeoutMs: 20_000, idleStopMs: 600_000 },
        actions: input.actions.map(a => ({ id: a.id, tool: a.tool, risk: a.risk ?? 'write' })),
        guidance: './guidance/usage.md',
        declaredAccess: input.declaredAccess ?? { filesystem: ['workspace'] },
    };
    const lines = input.actions.map(a => `- \`${a.id}\` (${a.risk ?? 'write'}) calls MCP tool \`${a.tool}\``);
    const guidance = `# ${input.name}\n\n${input.guidance?.trim() || `Driver wrapping \`${input.command}\`.`}\n\n## Actions\n\n${lines.join('\n')}\n`;
    return [
        { path: DRIVER_MANIFEST_FILE, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
        { path: 'guidance/usage.md', bytes: Buffer.from(guidance) },
    ];
}
