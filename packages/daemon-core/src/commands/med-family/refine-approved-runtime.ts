import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import { delimiter, join } from 'node:path';
import { devNull } from 'node:os';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { canonicalPushIdentity, resolvePushPolicy } from '../../git/public-push-guard.mjs';
import { gitChildEnv } from '../../git/git-locale.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { resolveMeshRefineValidationPlan } from '../../mesh/refine-config.js';
import { loadMeshWorktreeBootstrapConfig, validateMeshWorktreeBootstrapConfig } from '../../mesh/worktree-bootstrap-config.js';
import { readAuthenticatedMcpScope } from '../mcp-command-ingress.js';
import { getArtifactStore, getMeshRuntimeStore } from './artifact-runtime.js';
import { resolveMeshPolicy } from '../../repo-mesh-types.js';
import type { MedFamilyContext } from './types.js';

// Two explicitly pinned stages of one approved release. A caller cannot
// register a grant, pick an artifact, or supply executable environment values.
export const APPROVED_RUNTIME_COMMAND = 'refine_mesh_node_approved_runtime';
export const approvedRuntime = Symbol('approved refinery runtime');
const decisionId = 'mi_917b95c8c342';
const publicationDecisionId = 'mi_729d08b91f11';
const artifactId = 'art_8e90c58cbd79f9af';
const digest = '4a070077fa1860ba7eee1c79f9279a98922ed088c673f09a4875f9632c3082a9';
const meshId = 'mesh_271444af883843e9b36c67155b87b22f';
const hostDaemonId = 'daemon_mach_6733c865d60f432dbeb119a6875ee303';
const securityRoot = '441a8fa59dcff03cacd13a1f584af9a7ab609dab';
const securityOss = '86ce8d27e2f064088a61b38bfe560a760c670c54';
const stages = [
    {
        nodeId: 'node_346dc118ddb04ab5841a60bd209f9bdf', root: securityRoot, oss: securityOss,
        rootBase: '50d555860be05306095f296c7418f87c454f5454', ossBase: '6ea2081ddbdd58468904667f0cb45a79d40162e7',
        count: 10,
    },
    {
        nodeId: 'node_127a5a2ab7154904916a9356e6692ca0',
        root: '062f2077fe9e892cefb643547482ca013dbe09ad', oss: '9245cf92b4f05d2ba095f9b5e02a5a0de1aad9ac',
        rootBase: securityRoot, ossBase: securityOss, count: 2,
    },
] as const;
const incrementalDecisionId = 'mi_b8876f8fedba';
const incrementalOss = ['b10aa6348c01d324372c0c79ac26a921cb6a34d4', stages[1].oss];

export function selectApprovedRuntimeStage(nodeId: unknown, mode: unknown, targets: unknown) {
    const stage = stages.find(entry => entry.nodeId === nodeId);
    requireApproval(stage, 'approval_scope_mismatch');
    const publishRoot = mode !== undefined || targets !== undefined;
    requireApproval(!publishRoot || (mode === 'ff-only' && isDeepStrictEqual(targets, { [stage.nodeId]: stage.root })),
        'private_root_contract_mismatch');
    return { ...stage, publishRoot };
}

export function requireApprovedMain(
    stage: typeof stages[number],
    rootMain: string,
    ossMain: string,
    requireOssTarget = false,
    incrementalReachable = false,
) {
    const exactStage2Descendant = stage.count === 10 && ossMain === stages[1].oss && incrementalReachable;
    requireApproval(
        rootMain === stage.rootBase
            && (ossMain === stage.oss || (!requireOssTarget && ossMain === stage.ossBase) || exactStage2Descendant),
        'approved_main_changed',
    );
}
const bootstrapFile = '.adhdev/worktree_bootstrap.json';
const refineFile = '.adhdev/refine.json';

function requireApproval(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error(reason);
}

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['--no-replace-objects', ...args], {
        cwd, env: { ...gitChildEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull }, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    return stdout.trim();
}

export function requireApprovedPins(actual: { root: string; oss: string; gitlink: string }, expected: { root: string; oss: string } = stages[0]) {
    requireApproval(actual.root === expected.root && actual.oss === expected.oss
        && actual.gitlink === `160000 commit ${expected.oss}\toss`, 'approved_source_changed');
}

function hash(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export function verifyRuntimePayload(
    bootstrap: any, refine: any, policy: any, approvedPath: string,
) {
    const candidates = structuredClone({ worktreeBootstrapConfig: bootstrap, refineConfig: refine });
    const validation = candidates.refineConfig.validation;
    const groups = [candidates.worktreeBootstrapConfig.commands, validation.bootstrapCommands, validation.schedule?.prepare, validation.commands];
    const commandCounts = [1, 1, 1, 45];
    groups.forEach((group, index) => {
        requireApproval(Array.isArray(group) && group.length === commandCounts[index], 'command_count_changed');
        for (const command of group) {
            requireApproval(command.env?.PATH === undefined, 'existing_command_path');
            command.env = { ...command.env, PATH: approvedPath };
        }
    });
    requireApproval(isDeepStrictEqual(candidates, policy), 'payload_contains_non_path_changes');
    return { commandCounts, equivalent: true, environmentKeys: ['PATH'] };
}

export interface ApprovedRefineRuntime {
    path: string;
    rootBase: string;
    publishRoot: boolean;
    checkRootPublication: (workspace: string, target: string, branch: string, base: string) => Promise<void>;
    audit: Record<string, unknown>;
    publication: { mergeMode: 'ff-only'; approvedTargetShas: Record<string, string>; approvedPublishShas: Record<string, string[]> };
    verify: (workspace: string) => Promise<void>;
    checkAuthority: () => void;
    checkPublication: (workspace: string, commit: string, branch: string, base: string) => Promise<void>;
}

export async function resolveApprovedRefineRuntime(ctx: MedFamilyContext, args: any): Promise<ApprovedRefineRuntime> {
    const scope = readAuthenticatedMcpScope(args, APPROVED_RUNTIME_COMMAND);
    requireApproval(scope?.isCoordinator && scope.sessionId && scope.meshId === meshId, 'local_coordinator_required');
    requireApproval(args.meshId === meshId && args.runtimeApprovalId === decisionId, 'approval_scope_mismatch');

    const stage = selectApprovedRuntimeStage(args.nodeId, args.mergeMode, args.approvedTargetShas);
    const { nodeId, root, oss, ossBase, rootBase, publishRoot } = stage;
    const meshStore = getMeshRuntimeStore(ctx);
    const items = meshStore.missionItems();
    const store = getArtifactStore(ctx);
    let requireIncremental = stage.count === 2;
    function readDecisions() {
        const item = items.getItem(meshId, decisionId);
        const publication = items.getItem(meshId, publicationDecisionId);
        const incremental = requireIncremental ? items.getItem(meshId, incrementalDecisionId) : undefined;
        const decisions = requireIncremental ? [item, publication, incremental] : [item, publication];
        for (const entry of decisions) {
            requireApproval(entry?.kind === 'decision' && entry.state === 'answered'
                && entry.decision?.answer?.by === 'owner'
                && entry.decision.answer.optionId === 'a', 'owner_decision_changed');
        }
        requireApproval(item?.decision?.answerRevision === 1 && item.decision.answer?.via === 'dashboard'
            && item.decision.answer?.at === '2026-11-26T15:20:41.346Z'
            && item.refs.some(ref => ref.value === artifactId), 'runtime_decision_changed');
        requireApproval(meshStore.getMission(meshId, item.missionId)?.status === 'active', 'runtime_mission_inactive');
        if (requireIncremental) requireApproval(incremental?.decision?.answerRevision === 1
            && incremental.decision.answer?.at === '2026-11-27T03:38:58.306Z', 'incremental_decision_changed');
        return decisions.map(entry => ({
            missionId: entry?.missionId, refs: entry?.refs, machine: entry?.machine,
            context: entry?.decision?.context, question: entry?.decision?.question,
            options: entry?.decision?.options, answer: entry?.decision?.answer, revision: entry?.decision?.answerRevision,
        }));
    }
    let decisions = readDecisions();
    // This is a CAS snapshot of the current authority. It is not an
    // approval-time signature or a retrospective digest.
    let fingerprint = hash(Buffer.from(JSON.stringify(decisions)));
    function readProposal() {
        const meta = store.get(artifactId);
        requireApproval(meta?.meshId === meshId && meta.missionId === decisions[0].missionId && daemonIdsEquivalent(meta.originDaemonId, hostDaemonId) && meta.kind === 'json' && meta.sha256 === digest, 'artifact_scope_or_digest_mismatch');
        const page = store.readArtifactContent(artifactId);
        const bytes = Buffer.from(page.byteContentBase64, 'base64');
        requireApproval(!page.hasMore && bytes.length === page.totalBytes && hash(bytes) === digest, 'artifact_content_changed');
        return JSON.parse(bytes.toString('utf8'));
    }
    const proposal = readProposal();
    const approvedPath: string = proposal.diff.proposedPath;
    requireApproval(process.platform === 'darwin' && process.arch === 'arm64'
        && proposal.current.daemonPath === process.env.PATH
        && approvedPath.split(delimiter).slice(2).join(delimiter) === process.env.PATH, 'daemon_runtime_changed');

    function verifyConfigBytes(workspace: string) {
        for (const file of [bootstrapFile, refineFile]) {
            requireApproval(hash(readFileSync(join(workspace, file))) === proposal.current.configSha256[file], 'approved_config_changed');
        }
    }

    function checkAuthority() {
        requireApproval(readAuthenticatedMcpScope(args, APPROVED_RUNTIME_COMMAND)?.sessionId === scope?.sessionId, 'coordinator_revoked');
        requireApproval(hash(Buffer.from(JSON.stringify(readDecisions()))) === fingerprint, 'approval_changed_during_job');
        readProposal();
        requireApproval(proposal.current.daemonPath === process.env.PATH, 'daemon_runtime_changed');
    }

    async function checkWorkspace(workspace?: string) {
        const record = await ctx.getMeshForCommand(meshId, undefined, { preferInline: true });
        const mesh = record?.mesh;
        const self = ctx.deps.statusInstanceId;
        const node = mesh?.nodes?.find((candidate: any) => candidate.id === nodeId);
        const host = resolveMeshHostStatus(mesh, { localDaemonId: self });
        requireApproval(self && daemonIdsEquivalent(self, hostDaemonId) && mesh?.id === meshId && host.role === 'host'
            && daemonIdsEquivalent(host.hostDaemonId, self)
            && node?.isLocalWorktree && node.workspace && daemonIdsEquivalent(node.daemonId, self)
            && (!workspace || workspace === node.workspace), 'local_approved_workspace_required');
        requireApproval(!publishRoot || !resolveMeshPolicy(mesh.policy).requireApprovalForPush, 'private_root_policy_requires_approval');
        requireApproval(mesh.policy?.refineConfig == null && mesh.policy?.worktreeBootstrapConfig == null, 'persistent_override_present');
        const cwd = node.workspace;
        const [rootHead, ossHead, gitlink, status] = await Promise.all([
            git(cwd, 'rev-parse', 'HEAD'), git(join(cwd, 'oss'), 'rev-parse', 'HEAD'),
            git(cwd, 'ls-tree', 'HEAD', 'oss'), git(cwd, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules=none', '--untracked-files=all'),
        ]);
        requireApprovedPins({ root: rootHead, oss: ossHead, gitlink }, stage);
        requireApproval(status === '', 'approved_worktree_dirty');
        for (const dir of [cwd, join(cwd, 'oss')]) {
            requireApproval(!['node', 'npm', 'npx'].some(bin => existsSync(join(dir, 'node_modules', '.bin', bin))), 'unexpected_local_runtime_shim');
        }
        verifyConfigBytes(cwd);
        const bootstrap = loadMeshWorktreeBootstrapConfig(mesh, cwd);
        const refine = resolveMeshRefineValidationPlan(mesh, cwd);
        requireApproval(bootstrap.source === bootstrapFile && bootstrap.config && refine.source === refineFile
            && refine.bootstrapMode === 'inherit' && !refine.rejectedCommands.length
            && !validateMeshWorktreeBootstrapConfig(bootstrap.config, bootstrapFile).rejectedCommands.length, 'runtime_config_resolution_changed');
        checkAuthority();
        return { cwd, bootstrap };
    }

    async function main(workspace: string, identity: string) {
        const urls = (await git(workspace, 'remote', 'get-url', '--all', 'origin')).split('\n');
        requireApproval(urls.length === 1 && canonicalPushIdentity(urls[0]) === identity, 'publication_destination_changed');
        const row = await git(workspace, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main');
        return /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(row)?.[1] ?? '';
    }
    async function checkMain(workspace: string, requireOssTarget = false) {
        const [rootMain, ossMain] = await Promise.all([
            main(workspace, 'github.com/vilmire/adhdev-cloud'), main(join(workspace, 'oss'), 'github.com/vilmire/adhdev'),
        ]);
        let incrementalReachable = false;
        if (stage.count === 10 && ossMain === stages[1].oss) {
            if (!requireIncremental) {
                requireApproval(hash(Buffer.from(JSON.stringify(readDecisions()))) === fingerprint, 'approval_changed_during_job');
                requireIncremental = true;
                decisions = readDecisions();
                fingerprint = hash(Buffer.from(JSON.stringify(decisions)));
            } else {
                checkAuthority();
            }
            const ossDir = join(workspace, 'oss');
            await git(ossDir, 'merge-base', '--is-ancestor', stage.oss, ossMain);
            const aheadShas = (await git(ossDir, 'rev-list', `${stage.oss}..${ossMain}`)).split('\n').filter(Boolean);
            const totalShas = (await git(ossDir, 'rev-list', `${stage.ossBase}..${ossMain}`)).split('\n').filter(Boolean);
            requireApproval(
                aheadShas.length === stages[1].count
                    && isDeepStrictEqual([...aheadShas].sort(), [...incrementalOss].sort())
                    && totalShas.length === stages[0].count + stages[1].count,
                'approved_oss_range_changed',
            );
            incrementalReachable = true;
        }
        requireApprovedMain(stage, rootMain, ossMain, requireOssTarget, incrementalReachable);
    }
    async function checkPrivateDestination(workspace: string) {
        const policy = await resolvePushPolicy(workspace);
        requireApproval(!policy.isPublic && policy.keyed.length === 1
            && policy.keyed[0].visibility === 'private'
            && canonicalPushIdentity(policy.keyed[0].url) === 'github.com/vilmire/adhdev-cloud', 'private_root_destination_required');
    }

    const { cwd, bootstrap } = await checkWorkspace();
    await checkMain(cwd);
    if (publishRoot) await checkPrivateDestination(cwd);
    const bootstrapPlan = validateMeshWorktreeBootstrapConfig(bootstrap.config, bootstrapFile);
    const proof = verifyRuntimePayload(bootstrap.config, JSON.parse(readFileSync(join(cwd, refineFile), 'utf8')),
        proposal.applyAfterSeparateAuthorization.args.policy, approvedPath);
    const publicationShas = (await git(join(cwd, 'oss'), 'rev-list', `${ossBase}..${oss}`)).split('\n');
    requireApproval(publicationShas.length === stage.count && (stage.count !== 2
        || isDeepStrictEqual([...publicationShas].sort(), [...incrementalOss].sort())), 'approved_oss_range_changed');
    const rootShas = publishRoot ? (await git(cwd, 'rev-list', `${rootBase}..${root}`)).split('\n') : [];
    requireApproval(!publishRoot || rootShas.length === stage.count, 'approved_root_range_changed');
    const [npmBin, nodeBin] = approvedPath.split(delimiter);
    const verifyTools = async () => {
        const nodePath = join(nodeBin, 'node');
        const npmPath = join(npmBin, 'npm');
        const npxPath = join(npmBin, 'npx');
        [nodePath, npmPath, npxPath].forEach(file => accessSync(file, constants.X_OK));
        requireApproval(!existsSync(join(npmBin, 'node')), 'approved_runtime_shadowed');
        const run = async (command: string, ...params: string[]) => (await exec(command, params, {
            cwd: '/', env: { PATH: approvedPath }, encoding: 'utf8', timeout: 5_000, windowsHide: true,
        })).stdout.trim();
        const versions = await Promise.all([
            run(nodePath, '-p', 'process.version + "/" + process.versions.modules'),
            run(npmPath, '--version'), run(npxPath, '--version'),
            run('node', '-p', 'require("fs").realpathSync(process.execPath)'),
        ]);
        requireApproval(isDeepStrictEqual(versions, ['v22.22.0/127', '10.9.2', '10.9.2', realpathSync(nodePath)]), 'approved_toolchain_unavailable');
    };
    await verifyTools();
    checkAuthority();
    return {
        path: approvedPath,
        rootBase, publishRoot,
        checkRootPublication: async (workspace, target, branch, base) => {
            requireApproval(publishRoot && target === root && branch === 'main' && base === rootBase, 'private_root_contract_mismatch');
            await checkWorkspace(cwd);
            await checkMain(cwd, true);
            await checkPrivateDestination(workspace);
            checkAuthority();
        },
        audit: { ...proof, worktreeBootstrapCommands: bootstrapPlan.commands.map(command => command.displayCommand), decisionId, publicationDecisionId, ...(requireIncremental ? { incrementalDecisionId } : {}), rootBase, ossBase, publishRoot, revision: 1, checkedDecisionDigest: fingerprint, payloadDigest: digest,
            root, oss, node: '22.22.0', abi: '127', npm: '10.9.2', npx: '10.9.2' },
        publication: { mergeMode: 'ff-only', approvedTargetShas: { [nodeId]: root }, approvedPublishShas: { root: rootShas, oss: publicationShas } },
        verify: async workspace => { await verifyTools(); await checkWorkspace(workspace); await checkMain(cwd); checkAuthority(); },
        checkPublication: async (workspace, commit, branch, base) => {
            requireApproval(commit === oss && branch === 'main' && base === ossBase, 'publication_scope_changed');
            await checkWorkspace(cwd);
            await checkMain(cwd);
            const targets = (await git(workspace, 'remote', 'get-url', '--push', '--all', 'origin')).split('\n');
            requireApproval(targets.length === 1 && canonicalPushIdentity(targets[0]) === 'github.com/vilmire/adhdev', 'publication_destination_changed');
            checkAuthority();
        },
        checkAuthority: () => { checkAuthority(); verifyConfigBytes(cwd); },
    };
}
