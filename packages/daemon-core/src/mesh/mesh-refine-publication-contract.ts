import type { RefineContext, RefineStageOutcome } from './mesh-refine-gates.js';
import type { PublicPublishApprovals } from './mesh-refine-gitlink-utils.js';
import { gitChildEnv } from '../git/git-locale.js';
import { devNull } from 'node:os';
import { validateRetirementProof } from '../git/normal-retirement-proof.mjs';

/** Requests without approval fields retain the intentional legacy merge workflow. */
export interface RefinePublicationOptions {
    mergeMode?: 'merge' | 'ff-only';
    /** Exact final root target for each node, also usable in a sequential batch. */
    approvedTargetShas?: Record<string, string>;
    approvedPublishShas?: PublicPublishApprovals;
    /** Batch steps need distinct exact sets after each preceding publication. */
    approvedPublishShasByNode?: Record<string, PublicPublishApprovals>;
}

export type RefineCommandArgs = RefinePublicationOptions & Record<string, any>;

const own = (value: unknown, key: string): boolean => !!value && Object.prototype.hasOwnProperty.call(value, key);
const approvalKeys = ['approvedTargetShas', 'approvedPublishShas', 'approvedPublishShasByNode'] as const;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
// Match the existing publication evaluator's syntax; it still verifies unique real objects and exact set equality.
const shaList = (value: unknown): boolean => Array.isArray(value)
    && value.every(entry => typeof entry === 'string' && /^[0-9a-f]{7,64}$/i.test(entry.trim()));
// Empty lists explicitly approve zero commits; an empty mapping grants no repository authority.
const approvals = (value: unknown): boolean => shaList(value) || (record(value) && Object.keys(value).length > 0 && Object.values(value).every(shaList));

export function hasRefineApprovalContract(args: RefineCommandArgs): boolean {
    return approvalKeys.some(key => own(args, key));
}

/** Preserve presence even through JSON: explicit undefined becomes invalid null, never legacy absence. */
export function snapshotRefinePublicationContract(args: RefineCommandArgs): RefinePublicationOptions {
    return JSON.parse(JSON.stringify(Object.fromEntries(
        ['mergeMode', ...approvalKeys].filter(key => own(args, key) && (key !== 'mergeMode' || args[key] !== undefined)).map(key => [key, args[key]]),
    ), (_key, value) => value === undefined ? null : value));
}

/** A corrupt durable envelope is explicit invalid authority, never an old legacy dispatch. */
export function restoreRefinePublicationContract(value: unknown): RefinePublicationOptions {
    return record(value) ? snapshotRefinePublicationContract(value) : { approvedPublishShas: null as any };
}

/** Structural authority is checked before batch side effects and before resolving any single node. */
export function refinePublicationAuthorityRefusal(args: RefineCommandArgs, nodeId: string) {
    let code: string | undefined;
    if (own(args, 'approvedTargetShas') && (!record(args.approvedTargetShas)
        || !Object.values(args.approvedTargetShas).every(sha) || !own(args.approvedTargetShas, nodeId))) code = 'approved_target_mismatch';
    if (own(args, 'approvedPublishShas') && !approvals(args.approvedPublishShas)) code = 'publish_approval_required';
    if (own(args, 'approvedPublishShasByNode') && (!record(args.approvedPublishShasByNode)
        || !Object.values(args.approvedPublishShasByNode).every(approvals)
        || !own(args.approvedPublishShasByNode, nodeId))) code = 'publish_approval_required';
    if (!code) return undefined;
    return { success: false, code, convergenceStatus: 'blocked_review', merged: false, pushed: false,
        error: `Publication approval contract is absent or invalid for node '${nodeId}'. Supply valid exact authority for every selected node; no fallback is permitted.` };
}

export function selectRefineNodePublicationArgs(args: RefineCommandArgs, nodeId: string): RefineCommandArgs {
    return own(args, 'approvedPublishShasByNode')
        ? { ...args, approvedPublishShas: args.approvedPublishShasByNode![nodeId] } : args;
}

/** Runs before sync can rewrite anything, and again inside the merge CAS window. */
export async function checkRefinePublicationContract(ctx: RefineContext): Promise<RefineStageOutcome | undefined> {
    const { args, nodeId, branchHead, baseHead, repoRoot, execFileAsync } = ctx;
    const malformed = refinePublicationAuthorityRefusal(args, nodeId);
    if (malformed) return { kind: 'terminal', result: { ...malformed, refineStages: ctx.refineStages } };
    // This applies to private roots and legacy requests too: source checkpoints
    // intentionally precede combined generation and final integration gates.
    // Keep this independent of owner SHA authority and remote advertisements.
    const phase = await execFileAsync('git', ['--no-replace-objects', 'ls-tree', '-z', branchHead, '--',
        'scripts/refine-source-phase.json', 'scripts/lib/refine-source-phase.json', '.adhdev-source-candidate.json'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
    if (phase.stdout.trim()) return { kind: 'terminal', result: {
        success: false, code: 'source_not_publishable', convergenceStatus: 'blocked_review', merged: false, pushed: false,
        error: 'Source-only checkpoint: complete the frozen combined batch and required normal gates before exact-SHA review and publication.',
        refineStages: ctx.refineStages,
    } };
    const retired = await execFileAsync('git', ['--no-replace-objects', 'log', '-1', '--format=%H', '--diff-filter=D',
        branchHead, `^${baseHead}`, '--', 'scripts/refine-source-phase.json', 'scripts/lib/refine-source-phase.json', '.adhdev-source-candidate.json'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
    const batch = retired.stdout.trim() ? await execFileAsync('git', ['--no-replace-objects', 'ls-tree', branchHead, '--',
        'scripts/refine-batch-ready.json', 'scripts/lib/refine-batch-ready.json'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() }) : undefined;
    if (retired.stdout.trim() && !batch?.stdout.trim()) {
        try {
            const root = await execFileAsync('git', ['ls-tree', branchHead, '--', 'oss'],
                { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
            validateRetirementProof(repoRoot, root.stdout.trim() ? 'root' : 'oss', { ref: branchHead });
        } catch (error) {
            return { kind: 'terminal', result: {
                success: false, code: 'source_not_publishable', convergenceStatus: 'blocked_review', merged: false, pushed: false,
                error: String(error), refineStages: ctx.refineStages,
            } };
        }
    }
    const mode = args?.mergeMode;
    const target = args?.approvedTargetShas?.[nodeId];
    const preserve = hasRefineApprovalContract(args);
    let code: string | undefined;
    if (mode !== undefined && mode !== 'merge' && mode !== 'ff-only') code = 'invalid_merge_mode';
    else if ((mode === 'ff-only' || target !== undefined) && (!sha(target) || target !== branchHead)) code = 'approved_target_mismatch';
    else if (mode === 'ff-only' && args.approvedPublishShas === undefined) code = 'publish_approval_required';
    else if (mode === 'ff-only' || preserve) {
        try {
            await execFileAsync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', baseHead, branchHead], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: { ...gitChildEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull } });
        } catch { code = mode === 'ff-only' ? 'ff_only_required' : 'approved_history_requires_ff'; }
    }
    if (!code) return undefined;
    return { kind: 'terminal', result: {
        success: false, code, convergenceStatus: 'blocked_review', merged: false, pushed: false,
        error: 'Publication approval contract refused. Approved history must remain unchanged and fast-forward from the base. Ask the owner for explicit merge authorization if fast-forward is impossible; no rule-B terms are available. Candidate and base are retained.',
        refineStages: ctx.refineStages,
    } };
}
