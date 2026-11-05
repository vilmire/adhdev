/**
 * Driver results -> shareable session artifacts.
 *
 * Driver output is untrusted. This module never takes a file name, path, kind or
 * mime from the driver: names are generated here, images are sniffed by their
 * magic bytes, and every file lands under a daemon-owned directory inside the
 * worker's workspace. Registration itself is an injected port (the daemon binds
 * the real artifact store), so a failure here degrades the result, never the call.
 */
import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { MAX_ARTIFACT_BYTES, type ArtifactKind } from '../artifacts/types.js';
import { ensureLocalGitExclude } from '../git/git-local-exclude.js';
import type { DriverToolResult } from './mcp-client.js';
import type { DriverWorkerIdentity } from './staged-action.js';

/** Workspace-relative parent of every generated file. Only this subtree is git-excluded. */
export const DRIVER_RESULTS_DIR = '.adhdev/driver-results';
/** Inline cap for a whole result (JSON chars); above it the full result becomes an artifact. */
export const DRIVER_INLINE_CAP = 64_000;
/** Preview kept inline when the full text went to an artifact. */
export const DRIVER_PREVIEW_CHARS = 4_000;
/** One call can register at most this many artifacts; the rest are omitted with a code. */
export const MAX_DRIVER_ARTIFACTS_PER_CALL = 8;

/** `relPath` is workspace-relative and daemon-generated, so a worker can open the file with its own file reader. */
export interface DriverArtifactRef { type: string; artifactId: string; digest: string; relPath: string }
export interface DriverArtifactError { code: string; message: string }
export interface DriverArtifactRegistration { artifactId: string; sha256: string; sizeBytes: number }
export interface DriverArtifactSink {
    workspaceRoot: string;
    register(input: { relPath: string; kind: ArtifactKind; mime: string; title: string }): Promise<DriverArtifactRegistration>;
}
export interface DriverArtifactPort {
    /** Null when the worker has no trusted local workspace (session gone, remote worker). */
    resolve(identity: DriverWorkerIdentity): Promise<DriverArtifactSink | null>;
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

class DriverArtifactRefusal extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
const refuse = (code: string, message: string): never => { throw new DriverArtifactRefusal(code, message); };

/** Magic-number sniff for the four allowed raster types. SVG and everything else is null. */
export function sniffImageMime(b: Buffer): string | null {
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6) {
        const head = b.subarray(0, 6).toString('latin1');
        if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    }
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

/** Decode and validate an MCP image block. Throws a refusal with a stable code. */
export function decodeDriverImage(block: { data?: unknown; mimeType?: unknown }): { bytes: Buffer; mime: string } {
    const data = typeof block.data === 'string' ? block.data : '';
    if (!data) return refuse('image_invalid', 'Image block has no base64 data');
    // Size gate first, so a hostile multi-hundred-MB string is never decoded.
    if (Math.floor(data.length * 3 / 4) > MAX_ARTIFACT_BYTES + 3) return refuse('artifact_too_large', `Image exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    if (data.length % 4 !== 0 || !BASE64.test(data)) return refuse('image_invalid', 'Image data is not canonical base64');
    const declared = typeof block.mimeType === 'string' ? block.mimeType.split(';')[0]!.trim().toLowerCase() : '';
    if (!IMAGE_EXT[declared]) return refuse('unsupported_mime_or_kind', `Image mime "${declared || '(none)'}" is not an allowed artifact type`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_ARTIFACT_BYTES) return refuse('artifact_too_large', `Image exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    const sniffed = sniffImageMime(bytes);
    if (sniffed !== declared) return refuse('mime_mismatch', `Image bytes are ${sniffed ?? 'not a supported image'}, declared ${declared}`);
    return { bytes, mime: declared };
}

const digestOf = (hex: string): string => `sha256:${hex}`;

/** Create `<workspace>/.adhdev/driver-results/<invocationId>` without following links. */
function prepareDir(workspaceRoot: string, invocationId: string): { abs: string; rel: string } {
    const root = realpathSync(workspaceRoot);
    const parts = ['.adhdev', 'driver-results', invocationId];
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        let stat;
        try { stat = lstatSync(current); } catch { stat = null; }
        if (!stat) mkdirSync(current, { mode: 0o700 });
        else if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('unsafe_path', 'Driver results directory is not a plain directory');
    }
    if (realpathSync(current) !== current || !current.startsWith(root + sep)) return refuse('unsafe_path', 'Driver results directory escapes the workspace');
    ensureLocalGitExclude(root, join(root, ...parts.slice(0, 2)), 'driver results');
    return { abs: current, rel: parts.join('/') };
}

async function writeAndRegister(sink: DriverArtifactSink, invocationId: string, file: string, bytes: Buffer,
    spec: { kind: ArtifactKind; mime: string; title: string }): Promise<DriverArtifactRegistration & { relPath: string }> {
    const dir = prepareDir(sink.workspaceRoot, invocationId);
    const abs = join(dir.abs, file);
    writeFileSync(abs, bytes, { flag: 'wx', mode: 0o600 });
    try {
        const relPath = `${dir.rel}/${file}`;
        return { ...await sink.register({ relPath, ...spec }), relPath };
    } catch (error) {
        try { unlinkSync(abs); } catch { /* best effort */ }
        throw error;
    }
}

const errorOf = (error: unknown): DriverArtifactError => error instanceof DriverArtifactRefusal
    ? { code: error.code, message: error.message }
    : { code: (error as { code?: unknown })?.code && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : 'artifact_register_failed',
        message: error instanceof Error ? error.message : String(error) };

export interface CapturedDriverResult {
    output: unknown;
    artifacts: DriverArtifactRef[];
    artifactError?: DriverArtifactError;
}

/**
 * Turn image blocks and oversized text into artifacts. Base64 never survives into
 * the returned output, whether or not registration worked.
 */
export async function captureDriverArtifacts(input: {
    result: DriverToolResult; identity: DriverWorkerIdentity; invocationId: string; title: string;
    port?: DriverArtifactPort;
}): Promise<CapturedDriverResult> {
    const { result, identity, invocationId, title, port } = input;
    const artifacts: DriverArtifactRef[] = [];
    let artifactError: DriverArtifactError | undefined;
    const note = (error: DriverArtifactError) => { artifactError ??= error; };
    let sink: DriverArtifactSink | null | undefined;
    const getSink = async (): Promise<DriverArtifactSink | null> => {
        if (sink !== undefined) return sink;
        try { sink = port ? await port.resolve(identity) : null; } catch (error) { note(errorOf(error)); sink = null; }
        if (!sink) note({ code: 'artifact_unavailable', message: 'No trusted workspace is available for this worker; result returned inline' });
        return sink;
    };
    let seq = 0;
    const content: unknown[] = [];
    for (const block of Array.isArray(result.content) ? result.content : []) {
        const b = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
        if (!b || b.type !== 'image') { content.push(block); continue; }
        const approxBytes = typeof b.data === 'string' ? Math.floor(b.data.length * 3 / 4) : 0;
        const mime = typeof b.mimeType === 'string' ? b.mimeType.split(';')[0]!.trim().toLowerCase().slice(0, 40) : undefined;
        const omitted = (error: DriverArtifactError) => {
            note(error);
            content.push({ type: 'image', omitted: true, code: error.code, ...(mime ? { mime } : {}), sizeBytes: approxBytes });
        };
        if (artifacts.length >= MAX_DRIVER_ARTIFACTS_PER_CALL) { omitted({ code: 'too_many_artifacts', message: `At most ${MAX_DRIVER_ARTIFACTS_PER_CALL} artifacts per call` }); continue; }
        try {
            const decoded = decodeDriverImage(b);
            const target = await getSink();
            if (!target) { omitted(artifactError ?? { code: 'artifact_unavailable', message: 'artifact registration unavailable' }); continue; }
            const registered = await writeAndRegister(target, invocationId, `image-${++seq}.${IMAGE_EXT[decoded.mime]}`, decoded.bytes,
                { kind: 'image', mime: decoded.mime, title });
            artifacts.push({ type: 'image', artifactId: registered.artifactId, digest: digestOf(registered.sha256), relPath: registered.relPath });
            content.push({ type: 'image', artifactId: registered.artifactId, relPath: registered.relPath, mime: decoded.mime, sizeBytes: registered.sizeBytes, sha256: registered.sha256 });
        } catch (error) { omitted(errorOf(error)); }
    }
    let output: unknown = { ...result, content };
    const json = JSON.stringify(output);
    if (json.length <= DRIVER_INLINE_CAP) return { output, artifacts, ...(artifactError ? { artifactError } : {}) };

    // Oversized: the full result is kept as an artifact, the caller gets a preview + id.
    const textOnly = !result.structuredContent && content.every(c => (c as { type?: unknown })?.type === 'text' && typeof (c as { text?: unknown }).text === 'string');
    const full = textOnly ? content.map(c => (c as { text: string }).text).join('\n') : json;
    const bytes = Buffer.from(full, 'utf8');
    const stored = (extra: Record<string, unknown>) => ({ truncated: true, text: full.slice(0, DRIVER_PREVIEW_CHARS), ...extra });
    const cutOff = (extra: Record<string, unknown>) => ({ truncated: true, text: json.slice(0, DRIVER_INLINE_CAP), ...extra });
    try {
        if (artifacts.length >= MAX_DRIVER_ARTIFACTS_PER_CALL) refuse('too_many_artifacts', `At most ${MAX_DRIVER_ARTIFACTS_PER_CALL} artifacts per call`);
        if (bytes.length > MAX_ARTIFACT_BYTES) refuse('artifact_too_large', `Result is ${bytes.length} bytes; the artifact limit is ${MAX_ARTIFACT_BYTES}`);
        const target = await getSink();
        if (!target) throw new DriverArtifactRefusal('artifact_unavailable', 'artifact registration unavailable');
        const kind: ArtifactKind = textOnly ? 'text' : 'json';
        const registered = await writeAndRegister(target, invocationId, textOnly ? 'result.txt' : 'result.json', bytes,
            { kind, mime: textOnly ? 'text/plain' : 'application/json', title });
        artifacts.push({ type: kind, artifactId: registered.artifactId, digest: digestOf(registered.sha256), relPath: registered.relPath });
        output = stored({ artifactId: registered.artifactId, relPath: registered.relPath, sizeBytes: registered.sizeBytes, sha256: registered.sha256 });
    } catch (error) {
        const e = errorOf(error);
        note(e);
        output = cutOff({ note: `Result exceeded ${DRIVER_INLINE_CAP} characters and could not be stored as an artifact (${e.code}); the rest is cut off.` });
    }
    return { output, artifacts, ...(artifactError ? { artifactError } : {}) };
}
