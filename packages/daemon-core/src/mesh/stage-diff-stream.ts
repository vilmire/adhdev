/** Bounded git output: stdout is consumed under backpressure; exit failure is never an empty diff. */
import { spawn, execFileSync } from 'node:child_process';
import { gitChildEnv } from '../git/git-locale.js';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { StageGitPort, StageArtifactPort } from './stage-ports.js';
import { StageDiffBlocked, STAGE_DIFF_CHUNK_BYTES, stageDiffArgs, writeStageDiffManifest, type StageDiffScope, type StageDiffSource } from './stage-diff-manifest.js';

export async function* streamStageGit(workspace: string, args: string[]): AsyncGenerator<Buffer> {
    const child = spawn('git', ['--no-replace-objects', ...args], { cwd: workspace, env: gitChildEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-64 * 1024); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Attach immediately; spawn failures must not become an unhandled rejection while stdout closes.
    void exited.catch(() => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    try {
        for await (const b of child.stdout) yield Buffer.from(b);
        const result = await exited;
        if (result.code !== 0 || result.signal) throw new Error(`review_diff_git_failed:${result.code}:${result.signal ?? ''}:${stderr}`);
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited.catch(() => undefined);
    }
}

export async function hashStageGit(workspace: string, args: string[]): Promise<string> {
    const hash = createHash('sha256');
    for await (const b of streamStageGit(workspace, args)) hash.update(b);
    return hash.digest('hex');
}

/** Legacy text callers keep the single-artifact contract; oversized bytes require the manifest route. */
export async function singleStageDiff(workspace: string, base: string, head: string): Promise<string> {
    const chunks: Buffer[] = [], hash = createHash('sha256');
    let bytes = 0, oversized = false;
    for await (const b of streamStageGit(workspace, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}..${head}`])) {
        bytes += b.length; hash.update(b);
        if (bytes > STAGE_DIFF_CHUNK_BYTES) { oversized = true; chunks.length = 0; }
        if (!oversized) chunks.push(b);
    }
    const sha256 = hash.digest('hex');
    if (!oversized) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { /* Invalid text must take the byte-preserving route too. */ }
    }
    throw new StageDiffBlocked('review_diff_requires_manifest', { bytes, sha256, completeByteCount: true, limitBytes: STAGE_DIFF_CHUNK_BYTES });
}

const git = (workspace: string, args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: workspace, env: gitChildEnv(), windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
});

/** root + the exact OSS gitlink range, including generated/vendor content. Never source-only filtering. */
export function stageDiffSources(workspace: string, base: string, head: string, port: StageGitPort): {
    checkout: StageDiffScope['checkout']; gitlinks: StageDiffScope['gitlinks']; sources: StageDiffSource[];
} {
    if (![base, head].every(pin => /^[a-f0-9]{40,64}$/.test(pin))) throw new Error('review_diff_pin_required');
    const canonical = realpathSync.native(workspace), st = statSync(canonical);
    if (git(canonical, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('review_diff_root_head_changed');
    const links = (pin: string) => git(canonical, ['ls-tree', '-r', pin]).split('\n').filter(line => line.startsWith('160000 ')).join('\n');
    const gitlinks = { base: links(base), head: links(head) };
    const source = (repo: 'root' | 'oss', cwd: string, b: string, h: string): StageDiffSource => ({
        repo, baseSha: b, headSha: h, gitArgs: stageDiffArgs(b, h),
        stream: () => port.diffStream ? port.diffStream(cwd, stageDiffArgs(b, h)) : (async function* () {
            // Compatibility seam for old injected ports; production always uses diffStream.
            yield Buffer.from(await port.diff(cwd, b, h), 'utf8');
        })(),
    });
    const sources = [source('root', canonical, base, head)];
    const parse = (raw: string) => new Map(raw.split('\n').filter(Boolean).map(line => {
        const m = /^160000 commit ([a-f0-9]+)\t(.+)$/.exec(line);
        if (!m) throw new Error('review_diff_gitlink_invalid');
        return [m[2], m[1]];
    }));
    const old = parse(gitlinks.base), next = parse(gitlinks.head);
    for (const name of new Set([...old.keys(), ...next.keys()])) {
        if (name !== 'oss') {
            if (old.get(name) !== next.get(name)) throw new Error('review_diff_other_gitlink_changed');
            continue;
        }
        const b = old.get(name), h = next.get(name), cwd = path.join(canonical, name);
        if (!b || !h || realpathSync.native(cwd) !== cwd) throw new Error('review_diff_oss_checkout');
        if (git(cwd, ['rev-parse', 'HEAD']).trim() !== h) throw new Error('review_diff_oss_head_changed');
        sources.push(source('oss', cwd, b, h));
    }
    return { checkout: { path: canonical, identity: `${st.dev}:${st.ino}` }, gitlinks, sources };
}

interface RegisterStageDiffInput {
    git: StageGitPort; artifacts: StageArtifactPort; workspace: string; base: string; head: string;
    meshId: string; taskId: string; missionId?: string; round: number; originDaemonId: string; operationKey: string;
    sourceGenerated?: typeof import('./stage-source-generated-provider.js').writeStageSourceGenerated;
}
export function registerStageDiff(input: RegisterStageDiffInput & { sourceGenerated?: undefined }): ReturnType<typeof writeStageDiffManifest>;
export function registerStageDiff(input: RegisterStageDiffInput): Promise<Awaited<ReturnType<typeof writeStageDiffManifest>>
    | ReturnType<NonNullable<RegisterStageDiffInput['sourceGenerated']>>>;
export async function registerStageDiff(input: RegisterStageDiffInput) {
    const evidence = stageDiffSources(input.workspace, input.base, input.head, input.git);
    const scope = stageDiffScope(input, evidence);
    const result = input.sourceGenerated && evidence.sources.some(source => source.repo === 'oss')
        ? input.sourceGenerated(input.artifacts, scope, input.operationKey)
        : await writeStageDiffManifest({ artifacts: input.artifacts, operationKey: input.operationKey, sources: evidence.sources, scope });
    const after = stageDiffSources(input.workspace, input.base, input.head, input.git);
    if (JSON.stringify(after.checkout) !== JSON.stringify(evidence.checkout) || JSON.stringify(after.gitlinks) !== JSON.stringify(evidence.gitlinks)) throw new Error('review_diff_checkout_changed');
    return result;
}

export function stageDiffScope(input: Pick<RegisterStageDiffInput, 'meshId' | 'taskId' | 'missionId' | 'round' | 'originDaemonId' | 'base' | 'head'>,
    evidence: Pick<ReturnType<typeof stageDiffSources>, 'checkout' | 'gitlinks'>): StageDiffScope {
    return { meshId: input.meshId, parentTaskId: input.taskId, taskId: input.taskId,
        ...(input.missionId ? { missionId: input.missionId } : {}), round: input.round, producerRole: 'pipeline',
        originDaemonId: input.originDaemonId, baseSha: input.base, headSha: input.head, checkout: evidence.checkout, gitlinks: evidence.gitlinks };
}
