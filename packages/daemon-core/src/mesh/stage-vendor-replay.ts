import { createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { diffDigest, StageDiffBlocked, type StageDiffScope } from './stage-diff-manifest.js';
import type { StageGeneratedRecipe } from './stage-source-generated-provider.js';

const ROOT_VENDOR = 'packages/daemon-cloud/vendor/';
const OSS_VENDOR = 'packages/daemon-standalone/vendor/';
const VENDOR_NAMES: Readonly<Record<'root' | 'oss', ReadonlySet<string>>> = {
    root: new Set(['mcp-server', 'session-host-daemon', 'terminal-mux-cli']),
    oss: new Set(['mcp-server', 'session-host-daemon']),
};
const sha256 = /^[a-f0-9]{64}$/;
const commitPin = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function isStageVendorOutput(repo: 'root' | 'oss', file: string): boolean {
    const prefix = repo === 'root' ? ROOT_VENDOR : OSS_VENDOR;
    return file.startsWith(prefix) && VENDOR_NAMES[repo].has(file.slice(prefix.length).split('/')[0]!);
}

interface VendorReplayOutput {
    repo: 'root' | 'oss';
    path: string;
    mode: string;
    sha256: string;
    bytes: number;
}
interface VendorReplayReceipt {
    version: 1;
    recipe: 'adhdev-combined-vendor';
    rootSha: string;
    inputGraphSha256: string;
    configSha256: string;
    toolchainSha256: string;
    buildLogSha256: string;
    outputs: VendorReplayOutput[];
}

const deny = (code: string): never => { throw new StageDiffBlocked(code, {}); };

function readPrivate(path: string, max: number): Buffer {
    if (realpathSync.native(path) !== path) return deny('review_source_generated_producer_path');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > max
            || (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))) {
            return deny('review_source_generated_producer_path');
        }
        const bytes = Buffer.alloc(before.size + 1);
        let size = 0;
        while (size < bytes.length) {
            const n = readSync(fd, bytes, size, bytes.length - size, null);
            if (!n) break;
            size += n;
        }
        const after = fstatSync(fd);
        if (size !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            return deny('review_source_generated_producer_path');
        }
        return bytes.subarray(0, size);
    } finally { closeSync(fd); }
}

type Objects = Parameters<StageGeneratedRecipe['reproduce']>[0];
type Side = 'before' | 'after';

export function stageVendorReplayInputs(git: Objects, scope: StageDiffScope, side: Side) {
    const source = [];
    const configuration = [];
    const outputs = [];
    for (const repo of ['root', 'oss'] as const) {
        for (const [path, entry] of git.files(scope, repo, side)) {
            const descriptor = { repo, path, ...entry };
            if (isStageVendorOutput(repo, path)) {
                outputs.push(descriptor);
                continue;
            }
            source.push(descriptor);
            if (/^(?:scripts\/|(?:packages\/[^/]+\/)?(?:package(?:-lock)?\.json|ts(?:up|config)[^/]*|scripts\/))/.test(path)) {
                configuration.push(descriptor);
            }
        }
    }
    return { source, outputs, inputGraphSha256: diffDigest(JSON.stringify(source)), configSha256: diffDigest(JSON.stringify(configuration)) };
}

/**
 * Read attestations from the host's private replay store. The verifier rebuilds
 * the complete input/config graph from Git and checks every retained output.
 * The receipt signer represents the isolated builder, with its key kept outside
 * the candidate checkout and task artifacts.
 */
export function createHostStageVendorRecipe(directory: () => string): StageGeneratedRecipe {
    return {
        matches: isStageVendorOutput,
        reproduce(git, scope) {
            const root = directory();
            const outputs = new Map<string, { before?: Buffer; after?: Buffer }>();
            const inputs: string[] = [], configs: string[] = [], producers: string[] = [];
            let totalBytes = 0;
            try {
                const authority = createPublicKey(readPrivate(join(root, 'authority.pem'), 8192));
                if (authority.asymmetricKeyType !== 'ed25519') return deny('review_source_generated_producer_authority');
                for (const side of ['before', 'after'] as const) {
                    const rootSha = side === 'before' ? scope.baseSha : scope.headSha;
                    if (!commitPin.test(rootSha)) return deny('review_source_generated_producer_scope');
                    const snapshot = join(root, rootSha);
                    const raw = readPrivate(join(snapshot, 'receipt.json'), 4 * 1024 * 1024);
                    if (!verify(null, raw, authority, readPrivate(join(snapshot, 'receipt.sig'), 64))) {
                        return deny('review_source_generated_producer_signature');
                    }
                    const receipt = JSON.parse(raw.toString('utf8')) as VendorReplayReceipt;
                    const input = stageVendorReplayInputs(git, scope, side);
                    if (receipt.version !== 1 || receipt.recipe !== 'adhdev-combined-vendor' || receipt.rootSha !== rootSha
                        || receipt.inputGraphSha256 !== input.inputGraphSha256 || receipt.configSha256 !== input.configSha256
                        || !sha256.test(receipt.toolchainSha256) || !sha256.test(receipt.buildLogSha256)
                        || !Array.isArray(receipt.outputs) || receipt.outputs.length !== input.outputs.length) {
                        return deny('review_source_generated_producer_scope');
                    }
                    const log = readPrivate(join(snapshot, 'build.log'), 16 * 1024 * 1024);
                    if (diffDigest(log) !== receipt.buildLogSha256) return deny('review_source_generated_producer_scope');
                    for (const [index, expected] of input.outputs.entries()) {
                        const row = receipt.outputs[index];
                        if (!row || row.repo !== expected.repo || row.path !== expected.path || row.mode !== expected.mode
                            || !sha256.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_OUTPUT_BYTES) {
                            return deny('review_source_generated_producer_scope');
                        }
                        totalBytes += row.bytes;
                        if (totalBytes > 512 * 1024 * 1024) return deny('review_source_generated_producer_budget');
                        const bytes = readPrivate(join(root, 'outputs', row.sha256), row.bytes);
                        if (bytes.length !== row.bytes || diffDigest(bytes) !== row.sha256) return deny('review_source_generated_producer_bytes');
                        const key = row.repo + ':' + row.path;
                        const paired = outputs.get(key) ?? {};
                        paired[side] = bytes;
                        outputs.set(key, paired);
                    }
                    inputs.push(input.inputGraphSha256);
                    configs.push(input.configSha256);
                    producers.push(diffDigest(JSON.stringify([receipt.recipe, receipt.toolchainSha256, receipt.buildLogSha256])));
                }
                return { outputs, producerSha256: diffDigest(JSON.stringify(producers)),
                    configSha256: diffDigest(JSON.stringify(configs)), inputGraphSha256: diffDigest(JSON.stringify(inputs)) };
            } catch (error) {
                if (error instanceof StageDiffBlocked) throw error;
                return deny('review_source_generated_producer_authority');
            }
        },
    };
}
