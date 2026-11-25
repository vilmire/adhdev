/** Internal, lossless stage input format. This is evidence, never an authority token. */
import { assertStageDiffContent, STAGE_DIFF_SCAN_BYTES } from './stage-diff-content-guard.js';
import { createHash } from 'node:crypto';
import type { StageArtifactPort } from './stage-ports.js';

export const STAGE_DIFF_HEADER = 'adhdev-stage-diff';
export const STAGE_SOURCE_GENERATED_HEADER = 'adhdev-stage-source-generated';
export const STAGE_DIFF_CHUNK_BYTES = 4 * 1024 * 1024;
// Same ceiling as artifact payload admission; registration still enforces the daemon's remaining budget.
export const STAGE_DIFF_MAX_BYTES = 1024 * 1024 * 1024;
export interface StageDiffScope {
    meshId: string; parentTaskId: string; taskId: string; round: number;
    missionId?: string;
    producerRole: 'pipeline'; originDaemonId: string;
    baseSha: string; headSha: string;
    checkout: { path: string; identity: string };
    gitlinks: { base: string; head: string };
}
export interface StageDiffSection {
    repo: 'root' | 'oss'; baseSha: string; headSha: string; gitArgs: string[];
    offset: number; bytes: number; sha256: string;
}
export interface StageDiffChunk { id: string; index: number; offset: number; bytes: number; sha256: string }
export interface StageDiffManifest {
    header: typeof STAGE_DIFF_HEADER; version: 1; state: 'complete';
    scope: StageDiffScope; bytes: number; sha256: string;
    sections: StageDiffSection[]; chunks: StageDiffChunk[];
}
export type StageDiffSource = Omit<StageDiffSection, 'offset' | 'bytes' | 'sha256'> & { stream(): AsyncIterable<Buffer> };
export const diffDigest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export class StageDiffBlocked extends Error {
    readonly code: string;
    constructor(code: string, readonly details: Record<string, unknown>) { super(code); this.code = code; }
}

/** Reject unknown/malformed scope too, rather than silently dropping binding fields. */
export function decodeStageDiffManifest(raw: Buffer | string): StageDiffManifest | null {
    if (Buffer.byteLength(raw) > STAGE_DIFF_CHUNK_BYTES) throw new Error('review_diff_manifest_size');
    let m: StageDiffManifest;
    try { m = JSON.parse(raw.toString()); } catch { return null; }
    if ((m?.header as string) === STAGE_SOURCE_GENERATED_HEADER) throw new Error('review_source_generated_provider_required');
    if (m?.header !== STAGE_DIFF_HEADER) return null;
    const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const pin = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
    const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
    const s = m.scope;
    if (m.version !== 1 || m.state !== 'complete' || !s || Buffer.byteLength(JSON.stringify(s)) > 64 * 1024 || s.producerRole !== 'pipeline'
        || !s.meshId || s.taskId !== s.parentTaskId || !s.taskId || !s.originDaemonId
        || !integer(s.round) || !pin(s.baseSha) || !pin(s.headSha)
        || !s.checkout?.path || !s.checkout.identity || typeof s.gitlinks?.base !== 'string' || typeof s.gitlinks?.head !== 'string'
        || !integer(m.bytes) || m.bytes > STAGE_DIFF_MAX_BYTES || !sha(m.sha256)
        || !Array.isArray(m.chunks) || !m.chunks.length || m.chunks.length > 257
        || !Array.isArray(m.sections) || !m.sections.length || m.sections.length > 2) throw new Error('review_diff_manifest_invalid');
    let offset = 0;
    const ids = new Set<string>();
    for (const [i, c] of m.chunks.entries()) {
        if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 128 || ids.has(c.id) || c.index !== i || c.offset !== offset
            || !integer(c.bytes) || c.bytes > STAGE_DIFF_CHUNK_BYTES || (!c.bytes && m.bytes !== 0) || !sha(c.sha256)) throw new Error('review_diff_chunk_order');
        ids.add(c.id); offset += c.bytes;
    }
    if (offset !== m.bytes) throw new Error('review_diff_total_size');
    offset = 0;
    for (const [i, p] of m.sections.entries()) {
        if (p.repo !== (i === 0 ? 'root' : 'oss') || !pin(p.baseSha) || !pin(p.headSha)
            || !Array.isArray(p.gitArgs) || JSON.stringify(p.gitArgs) !== JSON.stringify(stageDiffArgs(p.baseSha, p.headSha))
            || p.offset !== offset || !integer(p.bytes) || !sha(p.sha256)) throw new Error('review_diff_section');
        offset += p.bytes;
    }
    if (offset !== m.bytes || m.sections[0].baseSha !== s.baseSha || m.sections[0].headSha !== s.headSha) throw new Error('review_diff_scope');
    return m;
}

export const stageDiffArgs = (base: string, head: string): string[] => ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', `${base}..${head}`];

/** One bounded chunk at a time. Resolver MUST authenticate each record independently of the manifest. */
export function validateStageDiffManifest(
    manifest: StageDiffManifest, expected: StageDiffScope,
    resolve: (chunk: StageDiffChunk) => Buffer,
): void {
    const m = decodeStageDiffManifest(JSON.stringify(manifest));
    if (!m || JSON.stringify(m.scope) !== JSON.stringify(expected)) throw new Error('review_diff_scope');
    if (m.bytes > STAGE_DIFF_SCAN_BYTES) throw new StageDiffBlocked('review_diff_scan_budget_exceeded', { bytes: m.bytes });
    const scan: Buffer[] = [];
    const whole = createHash('sha256');
    const sections = m.sections.map(() => createHash('sha256'));
    for (const c of m.chunks) {
        const b = resolve(c);
        if (b.length !== c.bytes || diffDigest(b) !== c.sha256) throw new Error('review_diff_chunk_hash');
        whole.update(b); scan.push(b);
        for (const [i, p] of m.sections.entries()) {
            const start = Math.max(c.offset, p.offset), end = Math.min(c.offset + c.bytes, p.offset + p.bytes);
            if (end > start) sections[i].update(b.subarray(start - c.offset, end - c.offset));
        }
    }
    if (whole.digest('hex') !== m.sha256 || sections.some((h, i) => h.digest('hex') !== m.sections[i].sha256)) throw new Error('review_diff_whole_hash');
    assertStageDiffContent(Buffer.concat(scan, m.bytes));
}

/** Existing artifact_read can page a logical input without materializing it or putting it in a prompt. */
export function readStageDiffPage(manifest: StageDiffManifest, resolve: (chunk: StageDiffChunk) => Buffer, offset = 0, limit = 256 * 1024) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('review_diff_page_range');
    const start = Math.min(offset, manifest.bytes), end = Math.min(start + Math.min(limit, 256 * 1024), manifest.bytes);
    const page = Buffer.alloc(end - start);
    validateStageDiffManifest(manifest, manifest.scope, c => {
        const b = resolve(c), lo = Math.max(start, c.offset), hi = Math.min(end, c.offset + c.bytes);
        if (hi > lo) b.copy(page, lo - start, lo - c.offset, hi - c.offset);
        return b;
    });
    return { content: page.toString('utf8'), encoding: 'utf8' as const, byteContentBase64: page.toString('base64'),
        offset: start, pageBytes: page.length, totalBytes: manifest.bytes, sizeBytes: manifest.bytes,
        sha256: manifest.sha256, hasMore: end < manifest.bytes, nextOffset: end < manifest.bytes ? end : null };
}

/**
 * Commit-last: incomplete captures/register failures have a journal, never a usable manifest id.
 * Stable op keys + immutable artifact registration preserve retries across process loss.
 * Budget overflow continues hashing/counting (no retention) so the blocked receipt is exact.
 */
export async function writeStageDiffManifest(input: {
    artifacts: StageArtifactPort; scope: StageDiffScope; sources: StageDiffSource[]; operationKey: string;
    maxBytes?: number;
}): Promise<{ artifactId: string; manifest: StageDiffManifest }> {
    const { artifacts, scope, operationKey } = input;
    // Reserve the existing 64MiB free-space hint for bounded journals/manifest and an unadmitted final chunk.
    const maxBytes = Math.min(input.maxBytes ?? STAGE_DIFF_MAX_BYTES, STAGE_DIFF_MAX_BYTES - 64 * 1024 * 1024);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || Buffer.byteLength(JSON.stringify(scope)) > 64 * 1024) throw new StageDiffBlocked('review_diff_budget_invalid', {});
    const chunks: StageDiffChunk[] = [], sections: StageDiffSection[] = [];
    const whole = createHash('sha256');
    let bytes = 0, retainedBytes = 0, used = 0, failure: string | undefined;
    let budgetDetails: Record<string, unknown> = {};
    let completeByteCount = false;
    let completeSha256: string | undefined;
    let journalDisabled = false;
    const staged: Array<{ index: number; bytes: number; sha256: string; relPath: string }> = [];
    const scan: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(STAGE_DIFF_CHUNK_BYTES);
    const journal = (state: string, extra: Record<string, unknown> = {}) => {
        if (journalDisabled) return;
        const result = artifacts.writeRecovery?.({ taskId: scope.taskId, operationKey: `${operationKey}-journal`, ext: '.json',
            content: JSON.stringify({ header: STAGE_DIFF_HEADER, version: 1, state, scope, bytes, retainedBytes, chunks, sections, staged, ...extra }) });
        if (!result?.ok) {
            if (result && result.code === 'artifact_storage_budget_exceeded') {
                journalDisabled = true;
                failure ??= result.code;
                budgetDetails = { ...budgetDetails, journalUnavailable: true, journalError: result.message };
                return;
            }
            throw new StageDiffBlocked('review_diff_journal_unavailable', { bytes, retainedBytes, state });
        }
    };
    const register = (content: Buffer | string, key: string, ext: '.txt' | '.json') => {
        const r = artifacts.register({ meshId: scope.meshId, taskId: scope.taskId, ...(scope.missionId ? { missionId: scope.missionId } : {}), kind: 'diff', title: `Review input ${key}`, content, ext, operationKey: key });
        if (!r.ok) throw new StageDiffBlocked(r.code, { ...r.details, bytes, retainedBytes, preserved: r.preserved,
            state: 'incomplete', completeByteCount, inputComplete: false, ...(completeSha256 ? { sha256: completeSha256 } : {}) });
        const sha256 = diffDigest(content);
        if (!artifacts.verifyRegistered?.({ meshId: scope.meshId, taskId: scope.taskId, artifactId: r.artifactId, bytes: Buffer.byteLength(content), sha256 })) {
            throw new StageDiffBlocked('review_diff_registration_unverified', { bytes, retainedBytes, artifactId: r.artifactId });
        }
        return r.artifactId;
    };
    const flush = () => {
        const payload = scratch.subarray(0, used);
        // Private recovery storage has no SQL artifact row, remote grant or preview.
        // Exact binary bytes, immutable digest paths; never automatically garbage-collected.
        const r = artifacts.writeRecovery?.({ taskId: scope.taskId, operationKey: `${operationKey}-staging-${staged.length}`, content: payload, ext: '.txt' });
        if (!r?.ok) {
            failure = r?.code ?? 'review_diff_staging_unavailable';
            budgetDetails = { stagingUnavailable: true }; used = 0;
            return;
        }
        if (r.bytes !== used || r.sha256 !== diffDigest(payload)) throw new StageDiffBlocked('review_diff_staging_unverified', { bytes, retainedBytes });
        staged.push({ index: staged.length, bytes: used, sha256: r.sha256, relPath: r.relPath });
        retainedBytes += used;
        if (retainedBytes <= STAGE_DIFF_SCAN_BYTES) scan.push(Buffer.from(payload));
        else scan.length = 0;
        used = 0;
        journal('capturing_private');
    };
    journal('capturing');
    try {
        for (const source of input.sources) {
            const sectionHash = createHash('sha256');
            const offset = bytes;
            for await (const b of source.stream()) {
                whole.update(b); sectionHash.update(b); bytes += b.length;
                if (bytes > maxBytes) { failure ??= 'review_diff_budget_exceeded'; continue; }
                if (failure) continue;
                let cursor = 0;
                while (cursor < b.length) {
                    const size = Math.min(scratch.length - used, b.length - cursor);
                    b.copy(scratch, used, cursor, cursor + size); used += size; cursor += size;
                    if (used === scratch.length) flush();
                    if (failure) break;
                }
            }
            const { stream: _, ...descriptor } = source;
            sections.push({ ...descriptor, offset, bytes: bytes - offset, sha256: sectionHash.digest('hex') });
        }
        const sha256 = whole.digest('hex');
        completeByteCount = true; completeSha256 = sha256;
        if (failure) { journal('blocked', { code: failure, sha256, completeByteCount: true, inputComplete: false }); throw new StageDiffBlocked(failure, { ...budgetDetails, bytes, sha256, retainedBytes, completeByteCount: true, inputComplete: false }); }
        if (used || !staged.length) flush();
        if (failure) { journal('blocked', { code: failure, sha256, completeByteCount: true, inputComplete: false }); throw new StageDiffBlocked(failure, { ...budgetDetails, bytes, sha256, retainedBytes, completeByteCount: true, inputComplete: false }); }
        if (bytes > STAGE_DIFF_SCAN_BYTES) throw new StageDiffBlocked('review_diff_scan_budget_exceeded', { bytes, sha256, retainedBytes, completeByteCount: true });
        const complete = Buffer.concat(scan, bytes);
        // Producer success and complete logical input validation MUST precede the first registration.
        assertStageDiffContent(complete);
        for (const item of staged) {
            const offset = item.index * STAGE_DIFF_CHUNK_BYTES;
            const payload = complete.subarray(offset, offset + item.bytes);
            const id = register(payload, `${operationKey}-chunk-${item.index}`, '.txt');
            chunks.push({ id, index: item.index, offset, bytes: item.bytes, sha256: item.sha256 });
        }
        const manifest: StageDiffManifest = { header: STAGE_DIFF_HEADER, version: 1, state: 'complete', scope, bytes, sha256, sections, chunks };
        decodeStageDiffManifest(JSON.stringify(manifest));
        journal('registering_manifest', { sha256 });
        if (failure) throw new StageDiffBlocked(failure, { ...budgetDetails, bytes, sha256, retainedBytes, completeByteCount: true, inputComplete: false });
        // Revalidate all chunk records after the entire producer exited successfully, before commit.
        for (const c of chunks) if (!artifacts.verifyRegistered?.({ meshId: scope.meshId, taskId: scope.taskId, artifactId: c.id, bytes: c.bytes, sha256: c.sha256 })) throw new Error('review_diff_registration_unverified');
        const artifactId = register(JSON.stringify(manifest), `${operationKey}-manifest`, '.json');
        journal('complete', { artifactId, sha256 });
        if (failure) throw new StageDiffBlocked(failure, { ...budgetDetails, bytes, sha256, retainedBytes, completeByteCount: true, inputComplete: false });
        return { artifactId, manifest };
    } catch (e) {
        // Retain the unregistered tail on producer interruption too. No promotion on this path.
        if (used && !failure) flush();
        const code = typeof (e as { code?: unknown })?.code === 'string' ? String((e as { code: string }).code) : 'review_diff_producer_failed';
        journal('incomplete', { code, completeByteCount, ...(completeSha256 ? { sha256: completeSha256 } : {}) });
        if (e instanceof StageDiffBlocked) throw e;
        throw new StageDiffBlocked(code, { bytes, retainedBytes, ...(completeSha256 ? { sha256: completeSha256 } : {}), error: String(e), completeByteCount, inputComplete: false });
    }
}
