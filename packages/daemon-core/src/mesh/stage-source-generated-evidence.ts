/** Verification for the two-part stage input. The caller must bind the expected
 * scope and supply host-owned checkout, retention, and reproduction ports. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertStageDiffContent, STAGE_DIFF_SCAN_BYTES } from './stage-diff-content-guard.js';
import { diffDigest, StageDiffBlocked, STAGE_DIFF_MAX_BYTES, STAGE_SOURCE_GENERATED_HEADER, type StageDiffScope } from './stage-diff-manifest.js';

type Repo = 'root' | 'oss';
export interface Entry {
    repo: Repo;
    path: string;
    before: { mode: string; oid: string } | null;
    after: { mode: string; oid: string } | null;
}
export interface Payload {
    blob: string;
    sha256: string;
    bytes: number;
}
export interface GeneratedEvidence {
    producerSha256: string;
    configSha256: string;
    inputGraphSha256: string;
    reproductionSha256: string;
    output?: Payload;
    retentionId: string;
    previous?: Payload;
}
interface Pins {
    root: { baseTree: string; headTree: string };
    oss: { baseTree: string; headTree: string };
}
type Classified = Entry & (
    { kind: 'source' } | { kind: 'generated'; evidence: GeneratedEvidence }
);

export interface StageSourceGeneratedManifest {
    header: typeof STAGE_SOURCE_GENERATED_HEADER;
    version: 1;
    state: 'complete';
    scope: StageDiffScope;
    trees: Pins;
    inventory: Classified[];
    source: { bytes: number; sha256: string };
}

export interface StageSourceGeneratedHost {
    /** Enumerate the complete immutable Git delta in canonical repo/path order.
     * Reproduce renames as a deletion and an addition. Include gitlinks. */
    inventory(scope: StageDiffScope): { trees: Pins; changes: Entry[] };
    /** Exact Git patch for all listed source entries, including old/new object IDs.
     * This port derives paths from the verified inventory, never from a request. */
    sourcePatch(scope: StageDiffScope, entries: readonly Entry[]): Iterable<Buffer>;
    /** Independently verify the full producer inventory, and reproduce its
     * outputs from trusted configuration and input authority. */
    reproduce(scope: StageDiffScope, changes: readonly Entry[]): ReadonlyMap<string, GeneratedEvidence>;
    /** Host-private retained bytes. Never export this stream as an artifact. */
    retainedBytes(retentionId: string, output: Payload, side: 'before' | 'after'): Iterable<Buffer>;
}

export function verifyStageSourceGenerated(
    manifest: StageSourceGeneratedManifest,
    expected: StageDiffScope,
    host: StageSourceGeneratedHost,
): Buffer {
    const deny = (code: string): never => { throw new StageDiffBlocked(code, {}); };
    if (manifest?.header !== STAGE_SOURCE_GENERATED_HEADER || manifest.version !== 1 || manifest.state !== 'complete'
        || !isDeepStrictEqual(manifest.scope, expected)) deny('review_source_generated_scope');
    const inventory = host.inventory(expected);
    if (!Array.isArray(manifest.inventory) || !inventory.changes.length || !isDeepStrictEqual(manifest.trees, inventory.trees)
        || manifest.inventory.length !== inventory.changes.length) deny('review_source_generated_inventory');
    const reproduced = host.reproduce(expected, inventory.changes);
    const source: Entry[] = [];
    const seen = new Set<string>();
    let generatedBytes = 0;
    for (const [i, change] of inventory.changes.entries()) {
        const key = change.repo + ':' + change.path;
        const classification = manifest.inventory[i];
        if (!classification || seen.has(key) || !isDeepStrictEqual(change, {
            repo: classification.repo, path: classification.path, before: classification.before, after: classification.after,
        })) deny('review_source_generated_inventory');
        seen.add(key);
        const proof = reproduced.get(key);
        if (classification.kind === 'source') {
            if (proof) deny('review_source_generated_classification');
            source.push(change);
            continue;
        }
        if (classification.kind !== 'generated' || !proof
            || !isDeepStrictEqual(proof, classification.evidence)
            || (change.after && change.after.mode !== '100644' && change.after.mode !== '100755')
            || (change.before && change.before.mode !== '100644' && change.before.mode !== '100755')
            || (proof.output?.blob ?? null) !== (change.after?.oid ?? null)) throw new StageDiffBlocked('review_source_generated_producer', {});
        if ((proof.previous?.blob ?? null) !== (change.before?.oid ?? null)) deny('review_source_generated_producer');
        for (const [side, output] of [['after', proof.output], ['before', proof.previous]] as const) {
            if (!output) continue;
            if (!Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > STAGE_DIFF_MAX_BYTES - generatedBytes
                || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(output.blob)) deny('review_source_generated_budget');
            generatedBytes += output.bytes;
            const digest = createHash('sha256');
            const git = createHash(output.blob.length === 40 ? 'sha1' : 'sha256').update(`blob ${output.bytes}\0`);
            let bytes = 0;
            for (const part of host.retainedBytes(proof.retentionId, output, side)) {
                bytes += part.length;
                if (bytes > output.bytes) deny('review_source_generated_bytes');
                digest.update(part);
                git.update(part);
            }
            if (bytes !== output.bytes || digest.digest('hex') !== output.sha256 || git.digest('hex') !== output.blob) {
                deny('review_source_generated_bytes');
            }
        }
    }
    if ([...reproduced.keys()].some(key => !seen.has(key))) deny('review_source_generated_inventory');
    const parts: Buffer[] = [];
    let bytes = 0;
    for (const part of host.sourcePatch(expected, source)) {
        bytes += part.length;
        if (bytes > STAGE_DIFF_SCAN_BYTES) deny('review_diff_scan_budget_exceeded');
        parts.push(Buffer.from(part));
    }
    const patch = Buffer.concat(parts, bytes);
    if ((!source.length || !bytes) || manifest.source?.bytes !== bytes || manifest.source?.sha256 !== diffDigest(patch)) {
        deny('review_source_generated_source');
    }
    assertStageDiffContent(patch);
    return patch;
}
