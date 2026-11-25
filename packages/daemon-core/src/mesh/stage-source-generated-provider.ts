import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { gitChildEnv } from '../git/git-locale.js';
import { join } from 'node:path';
import type { StageArtifactPort } from './stage-ports.js';
import { diffDigest, StageDiffBlocked, STAGE_DIFF_CHUNK_BYTES, STAGE_DIFF_MAX_BYTES, STAGE_SOURCE_GENERATED_HEADER,
    type StageDiffChunk, type StageDiffScope } from './stage-diff-manifest.js';
import { assertStageDiffContent, STAGE_DIFF_SCAN_BYTES } from './stage-diff-content-guard.js';
import { isStageVendorOutput } from './stage-vendor-replay.js';
import { createStageSourceGeneratedGit } from './stage-source-generated-git.js';
import { verifyStageSourceGenerated, type GeneratedEvidence, type Payload, type StageSourceGeneratedManifest } from './stage-source-generated-evidence.js';

export type StageSourceGeneratedInput = StageSourceGeneratedManifest & { sourceChunks: StageDiffChunk[] };

/** Installed by the host. The recipe owns its executable/input closure and must
 * replay both immutable trees. No worker report, Git file or artifact selects a recipe. */
export interface StageGeneratedRecipe {
    matches(repo: 'root' | 'oss', path: string): boolean;
    reproduce(git: ReturnType<typeof createStageSourceGeneratedGit>, scope: StageDiffScope): {
        producerSha256: string; configSha256: string; inputGraphSha256: string;
        outputs: ReadonlyMap<string, { before?: Buffer; after?: Buffer }>;
    };
}

export type StageGeneratedRetention = (input: { taskId: string; operationKey: string; index: number;
    sha256: string; bytes: number }) => Buffer;

let recipe: StageGeneratedRecipe | undefined;
let defaultRecipe: StageGeneratedRecipe | undefined;
let readRetention: StageGeneratedRetention | undefined;

export function setStageGeneratedRecipe(value: StageGeneratedRecipe | undefined): void { recipe = value; }
export function setDefaultStageGeneratedRecipe(value: StageGeneratedRecipe): void { defaultRecipe = value; }
export function setStageGeneratedRetention(value: StageGeneratedRetention): void { readRetention = value; }

const deny = (code: string): never => { throw new StageDiffBlocked(code, {}); };
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function openGit(scope: StageDiffScope) {
    const directory = (cwd: string) => {
        const run = (...args: string[]) => execFileSync('git', ['--no-replace-objects', '-C', cwd, 'rev-parse', ...args],
            { encoding: 'utf8', env: gitChildEnv(), windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (realpathSync.native(run('--show-toplevel')) !== cwd) deny('review_source_generated_checkout');
        return { gitDir: realpathSync.native(run('--absolute-git-dir')), head: run('HEAD') };
    };
    const root = realpathSync.native(scope.checkout.path);
    const st = statSync(root);
    if (root !== scope.checkout.path || `${st.dev}:${st.ino}` !== scope.checkout.identity) deny('review_source_generated_checkout');
    const ossPath = join(root, 'oss');
    if (realpathSync.native(ossPath) !== ossPath) deny('review_source_generated_checkout');
    const rootGit = directory(root), ossGit = directory(ossPath);
    if (rootGit.head !== scope.headSha || !scope.gitlinks.head.split('\n').includes(`160000 commit ${ossGit.head}\toss`)) {
        deny('review_source_generated_checkout');
    }
    return createStageSourceGeneratedGit(rootGit.gitDir, ossGit.gitDir);
}

function hostFor(scope: StageDiffScope, write?: StageArtifactPort['writeRecovery']) {
    const git = openGit(scope);
    const blocks = new Map<string, { sha256: string; bytes: number }[]>();
    return {
        ...git,
        reproduce(expected: StageDiffScope, changes: ReturnType<typeof git.inventory>['changes']) {
            const installed = recipe ?? defaultRecipe;
            const candidates = changes.filter(c => isStageVendorOutput(c.repo, c.path) || installed?.matches(c.repo, c.path));
            const evidence = new Map<string, GeneratedEvidence>();
            if (!candidates.length) return evidence;
            if (!installed || candidates.some(c => !installed.matches(c.repo, c.path))) return deny('review_source_generated_producer_authority');
            const { outputs, producerSha256, configSha256, inputGraphSha256 } = installed.reproduce(git, expected);
            if (![producerSha256, configSha256, inputGraphSha256].every(digest)) {
                deny('review_source_generated_producer');
            }
            const candidateKeys = new Set(candidates.map(change => change.repo + ':' + change.path));
            for (const entry of changes) {
                if (!candidateKeys.has(entry.repo + ':' + entry.path) && candidates.some(candidate => candidate.repo === entry.repo
                    && (candidate.path.startsWith(entry.path + '/') || entry.path.startsWith(candidate.path + '/')))) {
                    deny('review_source_generated_path_conflict');
                }
            }
            const outputKeys = new Set<string>();
            const parity: Array<[string, string, string, string, number]> = [];
            let total = 0;
            for (const repo of ['root', 'oss'] as const) {
                for (const side of ['before', 'after'] as const) {
                    const covered = new Set<string>();
                    for (const [file, entry] of git.files(expected, repo, side)) {
                        if (!isStageVendorOutput(repo, file) && !installed.matches(repo, file)) continue;
                        const key = repo + ':' + file;
                        const replayed = outputs.get(key)?.[side];
                        if (!installed.matches(repo, file) || !/^100(?:644|755)$/.test(entry.mode)
                            || !Buffer.isBuffer(replayed) || replayed.length > STAGE_DIFF_MAX_BYTES - total) {
                            return deny('review_source_generated_producer');
                        }
                        if (!git.blob(repo, entry.oid, Math.max(1, replayed.length)).equals(replayed)) return deny('review_source_generated_parity');
                        total += replayed.length;
                        parity.push([key, side, entry.oid, diffDigest(replayed), replayed.length]);
                        covered.add(key);
                        outputKeys.add(key);
                    }
                    for (const [key, value] of outputs) {
                        if (key.startsWith(repo + ':') && value[side] !== undefined && !covered.has(key)) {
                            return deny('review_source_generated_producer');
                        }
                    }
                }
            }
            if (outputKeys.size !== outputs.size) return deny('review_source_generated_producer');
            const paritySha256 = diffDigest(JSON.stringify(parity));
            for (const change of candidates) {
                const key = change.repo + ':' + change.path;
                const replay = outputs.get(key);
                if (!replay) return deny('review_source_generated_producer');
                const retentionId = 'diff-generated-' + diffDigest(JSON.stringify([expected, change.before?.oid, change.after?.oid])).slice(0, 48);
                const retain = (side: 'before' | 'after', oid: string, bytes: Buffer) => {
                    const operationKey = retentionId + '-' + side;
                    const parts = [];
                    for (let offset = 0; offset < bytes.length; offset += STAGE_DIFF_CHUNK_BYTES) {
                        const part = bytes.subarray(offset, offset + STAGE_DIFF_CHUNK_BYTES);
                        const sha256 = diffDigest(part);
                        if (write) {
                            const result = write({ taskId: expected.taskId, operationKey: operationKey + '-' + parts.length, content: part, ext: '.bin' });
                            if (!result.ok || result.sha256 !== sha256 || result.bytes !== part.length) {
                                deny(result.ok ? 'review_source_generated_retention' : result.code);
                            }
                        }
                        parts.push({ sha256, bytes: part.length });
                    }
                    blocks.set(operationKey, parts);
                    return { blob: oid, sha256: diffDigest(bytes), bytes: bytes.length };
                };
                const output = change.after && replay.after ? retain('after', change.after.oid, replay.after) : undefined;
                const previous = change.before && replay.before ? retain('before', change.before.oid, replay.before) : undefined;
                const reproductionSha256 = diffDigest(JSON.stringify([expected, key, producerSha256, configSha256, inputGraphSha256, paritySha256, previous, output]));
                evidence.set(key, { producerSha256, configSha256, inputGraphSha256, reproductionSha256, retentionId, ...(output ? { output } : {}), ...(previous ? { previous } : {}) });
            }
            return evidence;
        },
        *retainedBytes(id: string, _output: Payload, side: 'before' | 'after') {
            const operationKey = id + '-' + side;
            const parts = blocks.get(operationKey);
            if (!parts || !readRetention) return deny('review_source_generated_retention');
            for (const [index, part] of parts.entries()) {
                yield readRetention({ taskId: scope.taskId, operationKey, index, ...part });
            }
        },
    };
}

export function decodeStageSourceGenerated(raw: Buffer): StageSourceGeneratedInput | null {
    if (raw.length > STAGE_DIFF_CHUNK_BYTES) return deny('review_diff_manifest_size');
    let input: StageSourceGeneratedInput;
    try { input = JSON.parse(raw.toString()); } catch { return null; }
    if (input?.header !== STAGE_SOURCE_GENERATED_HEADER) return null;
    if (!input.scope || input.scope.producerRole !== 'pipeline' || !input.scope.checkout?.path
        || !input.scope.gitlinks?.base || !input.scope.gitlinks.head || !Array.isArray(input.sourceChunks)
        || !input.sourceChunks.length || !input.source || !digest(input.source.sha256)) return deny('review_source_generated_manifest');
    let offset = 0;
    const ids = new Set();
    for (const [index, chunk] of input.sourceChunks.entries()) {
        if (!chunk?.id || ids.has(chunk.id) || chunk.index !== index || chunk.offset !== offset || !digest(chunk.sha256)
            || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > STAGE_DIFF_CHUNK_BYTES) {
            return deny('review_source_generated_manifest');
        }
        ids.add(chunk.id);
        offset += chunk.bytes;
    }
    if (offset !== input.source.bytes || offset > STAGE_DIFF_SCAN_BYTES) return deny('review_source_generated_manifest');
    return input;
}

export function readStageSourceGenerated(input: StageSourceGeneratedInput, resolve: (chunk: StageDiffChunk) => Buffer): void {
    const patch = verifyStageSourceGenerated(input, input.scope, hostFor(input.scope));
    for (const chunk of input.sourceChunks) {
        if (!resolve(chunk).equals(patch.subarray(chunk.offset, chunk.offset + chunk.bytes))) deny('review_source_generated_chunk');
    }
}

function prepareStageSourceGenerated(scope: StageDiffScope, write?: StageArtifactPort['writeRecovery']) {
    const host = hostFor(scope, write);
    const { trees, changes } = host.inventory(scope);
    const reproduced = host.reproduce(scope, changes);
    const source = changes.filter(change => !reproduced.has(change.repo + ':' + change.path));
    const parts = [...host.sourcePatch(scope, source)];
    const bytes = parts.reduce((sum, part) => sum + part.length, 0);
    if (!bytes || bytes > STAGE_DIFF_SCAN_BYTES) return deny('review_source_generated_source');
    const patch = Buffer.concat(parts, bytes);
    assertStageDiffContent(patch);
    const manifest: StageSourceGeneratedInput = {
        header: STAGE_SOURCE_GENERATED_HEADER, version: 1, state: 'complete', scope, trees,
        inventory: changes.map(change => {
            const evidence = reproduced.get(change.repo + ':' + change.path);
            return evidence ? { ...change, kind: 'generated', evidence } : { ...change, kind: 'source' };
        }),
        source: { bytes, sha256: diffDigest(patch) }, sourceChunks: [],
    };
    return { manifest, patch };
}

/** CAS over the verified pins, inventory, producer receipts and source bytes, before registration assigns chunk ids. */
export function stageSourceGeneratedDigest(manifest: StageSourceGeneratedInput): string {
    return diffDigest(JSON.stringify({ ...manifest, sourceChunks: [] }));
}

export function previewStageSourceGenerated(scope: StageDiffScope) {
    return prepareStageSourceGenerated(scope).manifest;
}

export function writeStageSourceGenerated(artifacts: StageArtifactPort, scope: StageDiffScope, operationKey: string) {
    const { manifest, patch } = prepareStageSourceGenerated(scope, artifacts.writeRecovery);
    const bytes = patch.length;
    const register = (content: Buffer, key: string, ext: '.txt' | '.json') => {
        const { meshId, taskId, missionId } = scope;
        const result = artifacts.register({ meshId, taskId, missionId, kind: 'diff', content, ext, title: 'Review input', operationKey: key });
        if (!result.ok) throw new StageDiffBlocked(result.code, result.details ?? {});
        if (!artifacts.verifyRegistered?.({ meshId, taskId, artifactId: result.artifactId, bytes: content.length, sha256: diffDigest(content) })) {
            deny('review_diff_registration_unverified');
        }
        return result.artifactId;
    };
    for (let offset = 0; offset < bytes; offset += STAGE_DIFF_CHUNK_BYTES) {
        const part = patch.subarray(offset, offset + STAGE_DIFF_CHUNK_BYTES);
        const index = manifest.sourceChunks.length;
        const id = register(part, operationKey + '-source-' + index, '.txt');
        manifest.sourceChunks.push({ id, index, offset, bytes: part.length, sha256: diffDigest(part) });
    }
    readStageSourceGenerated(manifest, chunk => patch.subarray(chunk.offset, chunk.offset + chunk.bytes));
    const raw = Buffer.from(JSON.stringify(manifest));
    decodeStageSourceGenerated(raw);
    return { artifactId: register(raw, operationKey + '-manifest', '.json'), manifest };
}
