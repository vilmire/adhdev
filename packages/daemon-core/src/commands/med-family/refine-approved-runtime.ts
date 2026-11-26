import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import { delimiter, join } from 'node:path';
import { devNull } from 'node:os';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { canonicalPushIdentity } from '../../git/public-push-guard.mjs';
import { gitChildEnv } from '../../git/git-locale.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { resolveMeshRefineValidationPlan } from '../../mesh/refine-config.js';
import { loadMeshWorktreeBootstrapConfig, validateMeshWorktreeBootstrapConfig } from '../../mesh/worktree-bootstrap-config.js';
import { readAuthenticatedMcpScope } from '../mcp-command-ingress.js';
import { getArtifactStore, getMeshRuntimeStore } from './artifact-runtime.js';
import type { MedFamilyContext } from './types.js';

// A release-specific migration of one existing owner decision. A caller cannot
// register a grant, pick an artifact, or supply executable environment values.
export const APPROVED_RUNTIME_COMMAND = 'refine_mesh_node_approved_runtime';
export const approvedRuntime = Symbol('approved refinery runtime');
const decisionId = 'mi_917b95c8c342';
const publicationDecisionId = 'mi_729d08b91f11';
const artifactId = 'art_8e90c58cbd79f9af';
const digest = '4a070077fa1860ba7eee1c79f9279a98922ed088c673f09a4875f9632c3082a9';
const meshId = 'mesh_271444af883843e9b36c67155b87b22f';
const hostDaemonId = 'daemon_mach_6733c865d60f432dbeb119a6875ee303';
const nodeId = 'node_346dc118ddb04ab5841a60bd209f9bdf';
const root = '441a8fa59dcff03cacd13a1f584af9a7ab609dab';
const oss = '86ce8d27e2f064088a61b38bfe560a760c670c54';
const ossBase = '6ea2081ddbdd58468904667f0cb45a79d40162e7';
const bootstrapFile = '.adhdev/worktree_bootstrap.json';
const refineFile = '.adhdev/refine.json';

function requireApproval(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error(reason);
}

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['--no-replace-objects', ...args], {
        cwd, env: { ...gitChildEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull }, encoding: 'utf8', timeout: 10_000,
    });
    return stdout.trim();
}

export function requireApprovedPins(actual: { root: string; oss: string; gitlink: string }) {
    requireApproval(actual.root === root && actual.oss === oss
        && actual.gitlink === `160000 commit ${oss}\toss`, 'approved_source_changed');
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
    audit: Record<string, unknown>;
    publication: { mergeMode: 'ff-only'; approvedTargetShas: Record<string, string>; approvedPublishShas: Record<string, string[]> };
    verify: (workspace: string) => Promise<void>;
    checkAuthority: () => void;
    checkPublication: (workspace: string, commit: string, branch: string, base: string) => Promise<void>;
}

export async function resolveApprovedRefineRuntime(ctx: MedFamilyContext, args: any): Promise<ApprovedRefineRuntime> {
    const scope = readAuthenticatedMcpScope(args, APPROVED_RUNTIME_COMMAND);
    requireApproval(scope?.isCoordinator && scope.sessionId && scope.meshId === meshId, 'local_coordinator_required');
    requireApproval(args.meshId === meshId && args.nodeId === nodeId && args.runtimeApprovalId === decisionId, 'approval_scope_mismatch');

    const meshStore = getMeshRuntimeStore(ctx);
    const items = meshStore.missionItems();
    const store = getArtifactStore(ctx);
    function readDecisions() {
        const item = items.getItem(meshId, decisionId);
        const publication = items.getItem(meshId, publicationDecisionId);
        for (const entry of [item, publication]) {
            requireApproval(entry?.kind === 'decision' && entry.state === 'answered'
                && entry.decision?.answer?.by === 'owner'
                && entry.decision.answer.optionId === 'a', 'owner_decision_changed');
        }
        requireApproval(item?.decision?.answerRevision === 1 && item.decision.answer?.via === 'dashboard'
            && item.decision.answer?.at === '2026-11-26T15:20:41.346Z'
            && item.refs.some(ref => ref.value === artifactId), 'runtime_decision_changed');
        requireApproval(meshStore.getMission(meshId, item.missionId)?.status === 'active', 'runtime_mission_inactive');
        return [item, publication].map(entry => ({
            missionId: entry?.missionId, refs: entry?.refs, machine: entry?.machine,
            context: entry?.decision?.context, question: entry?.decision?.question,
            options: entry?.decision?.options, answer: entry?.decision?.answer, revision: entry?.decision?.answerRevision,
        }));
    }
    const decisions = readDecisions();
    // This is a CAS snapshot of the current authority. It is not an
    // approval-time signature or a retrospective digest.
    const fingerprint = hash(Buffer.from(JSON.stringify(decisions)));
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
        requireApproval(mesh.policy?.refineConfig == null && mesh.policy?.worktreeBootstrapConfig == null, 'persistent_override_present');
        const cwd = node.workspace;
        const [rootHead, ossHead, gitlink, status] = await Promise.all([
            git(cwd, 'rev-parse', 'HEAD'), git(join(cwd, 'oss'), 'rev-parse', 'HEAD'),
            git(cwd, 'ls-tree', 'HEAD', 'oss'), git(cwd, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules=none', '--untracked-files=all'),
        ]);
        requireApprovedPins({ root: rootHead, oss: ossHead, gitlink });
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

    const { cwd, bootstrap } = await checkWorkspace();
    const bootstrapPlan = validateMeshWorktreeBootstrapConfig(bootstrap.config, bootstrapFile);
    const proof = verifyRuntimePayload(bootstrap.config, JSON.parse(readFileSync(join(cwd, refineFile), 'utf8')),
        proposal.applyAfterSeparateAuthorization.args.policy, approvedPath);
    const publicationShas = (await git(join(cwd, 'oss'), 'rev-list', `${ossBase}..${oss}`)).split('\n');
    requireApproval(publicationShas.length === 10, 'approved_oss_range_changed');
    const [npmBin, nodeBin] = approvedPath.split(delimiter);
    const verifyTools = async () => {
        const nodePath = join(nodeBin, 'node');
        const npmPath = join(npmBin, 'npm');
        const npxPath = join(npmBin, 'npx');
        [nodePath, npmPath, npxPath].forEach(file => accessSync(file, constants.X_OK));
        requireApproval(!existsSync(join(npmBin, 'node')), 'approved_runtime_shadowed');
        const run = async (command: string, ...params: string[]) => (await exec(command, params, {
            cwd: '/', env: { PATH: approvedPath }, encoding: 'utf8', timeout: 5_000,
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
        audit: { ...proof, worktreeBootstrapCommands: bootstrapPlan.commands.map(command => command.displayCommand), decisionId, publicationDecisionId, revision: 1, checkedDecisionDigest: fingerprint, payloadDigest: digest,
            root, oss, node: '22.22.0', abi: '127', npm: '10.9.2', npx: '10.9.2' },
        publication: { mergeMode: 'ff-only', approvedTargetShas: { [nodeId]: root }, approvedPublishShas: { root: [], oss: publicationShas } },
        verify: async workspace => { await verifyTools(); await checkWorkspace(workspace); },
        checkPublication: async (workspace, commit, branch, base) => {
            requireApproval(commit === oss && branch === 'main' && base === ossBase, 'publication_scope_changed');
            await checkWorkspace(cwd);
            const targets = (await git(workspace, 'remote', 'get-url', '--push', '--all', 'origin')).split('\n');
            requireApproval(targets.length === 1 && canonicalPushIdentity(targets[0]) === 'github.com/vilmire/adhdev', 'publication_destination_changed');
            checkAuthority();
        },
        checkAuthority: () => { checkAuthority(); verifyConfigBytes(cwd); },
    };
}
