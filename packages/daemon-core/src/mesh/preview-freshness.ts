import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type PreviewFreshnessStatus = 'fresh' | 'stale' | 'unknown' | 'not_configured';

export interface PreviewFreshness {
    status: PreviewFreshnessStatus;
    lastPreviewCommit: string | null;
    currentMainCommit: string | null;
    currentMainCommitSource: 'origin/main' | 'HEAD' | 'unknown';
    recordPath: string;
    lastDeployedAt?: string;
    lastTarget?: string;
    previewVersion?: string;
    targets: Record<'npm' | 'server' | 'web', {
        commit: string | null;
        deployedAt?: string;
        status: PreviewFreshnessStatus;
    }>;
    nextAction: string;
}

const PREVIEW_DEPLOY_RECORD = '.adhdev/preview-deploy.json';

function runGit(repoRoot: string, args: readonly string[]): string {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        }).trim();
    } catch {
        return '';
    }
}

function readRecord(repoRoot: string): Record<string, unknown> | null {
    const path = resolve(repoRoot, PREVIEW_DEPLOY_RECORD);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function normalizeCommit(value: unknown): string | null {
    return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())
        ? value.trim()
        : null;
}

function readTargetFreshness(record: Record<string, unknown> | null, currentCommit: string | null): PreviewFreshness['targets'] {
    const targets = record?.targets && typeof record.targets === 'object' && !Array.isArray(record.targets)
        ? record.targets as Record<string, unknown>
        : {};
    const result = {} as PreviewFreshness['targets'];
    for (const targetName of ['npm', 'server', 'web'] as const) {
        const targetRecord = targets[targetName] && typeof targets[targetName] === 'object' && !Array.isArray(targets[targetName])
            ? targets[targetName] as Record<string, unknown>
            : {};
        const commit = normalizeCommit(targetRecord.commit);
        result[targetName] = {
            commit,
            deployedAt: typeof targetRecord.deployedAt === 'string' ? targetRecord.deployedAt : undefined,
            status: commit && currentCommit ? (commit === currentCommit ? 'fresh' : 'stale') : 'unknown',
        };
    }
    return result;
}

function readCurrentMainCommit(repoRoot: string): Pick<PreviewFreshness, 'currentMainCommit' | 'currentMainCommitSource'> {
    const originMain = runGit(repoRoot, ['rev-parse', '--verify', 'origin/main^{commit}']);
    if (originMain) {
        return { currentMainCommit: originMain, currentMainCommitSource: 'origin/main' };
    }
    const head = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    if (head) {
        return { currentMainCommit: head, currentMainCommitSource: 'HEAD' };
    }
    return { currentMainCommit: null, currentMainCommitSource: 'unknown' };
}

export function buildPreviewFreshness(repoRoot: string): PreviewFreshness {
    const current = readCurrentMainCommit(repoRoot);
    const record = readRecord(repoRoot);
    const lastPreviewCommit = normalizeCommit(record?.lastPreviewCommit);
    const targets = readTargetFreshness(record, current.currentMainCommit);
    let status: PreviewFreshnessStatus = 'unknown';
    let nextAction = 'Run npm run deploy:preview from the current main commit, then smoke preview.';

    if (lastPreviewCommit && current.currentMainCommit) {
        status = lastPreviewCommit === current.currentMainCommit ? 'fresh' : 'stale';
        nextAction = status === 'fresh'
            ? 'No preview deploy action needed.'
            : 'Run npm run deploy:preview from origin/main, then smoke preview.';
    } else if (!current.currentMainCommit) {
        nextAction = 'Resolve the current main commit before judging preview freshness.';
    }

    return {
        status,
        lastPreviewCommit,
        currentMainCommit: current.currentMainCommit,
        currentMainCommitSource: current.currentMainCommitSource,
        recordPath: PREVIEW_DEPLOY_RECORD,
        lastDeployedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : undefined,
        lastTarget: typeof record?.target === 'string' ? record.target : undefined,
        previewVersion: typeof record?.previewVersion === 'string' ? record.previewVersion : undefined,
        targets,
        nextAction,
    };
}
