#!/usr/bin/env node
// Seal staged source bytes through NORMAL source-only commits, with zero vendor
// generation. Call only from an already host-admitted source task/worktree.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, sha256, stop, validateBatch, sourceHash, privateContractPath, SOURCE_MARKER, ROOT_SOURCE_MARKER, commitObject } from './refine-batch-contract.mjs';

function json(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, file);
}
function changed(repo, base) { return git(repo, ['diff', '--cached', '--name-only', '-z', base]).split('\0').filter(Boolean); }
function marker(repo, name, contract) {
  const digest = sha256(JSON.stringify(contract));
  json(privateContractPath(repo, digest), contract);
  json(path.join(repo, name), { version: 1, readiness: 'source_ready', releaseReady: false, batchId: contract.batchId,
    contractSha256: digest, completedTaskIds: contract.integrationOrder, sourceHash: sourceHash(repo) });
  git(repo, ['add', '--', name]);
}
export function sealSourceCandidate(plan) {
  const root = realpathSync(plan.rootRepo), oss = realpathSync(path.join(root, 'oss'));
  const c = { ...plan.candidate, readiness: 'uncommitted' }; delete c.rootCandidateSha; delete c.ossCandidateSha;
  const contract = { version: 1, batchId: `${c.taskId}.source`, candidates: [{ ...c, logicalOverlapTaskIds: [] }],
    integrationOrder: [c.taskId], approvedRootSha: c.rootBaseSha, approvedOssSha: c.ossBaseSha, bundleInvocationCount: 1,
    requiredGates: plan.requiredGates, normalHooksRequired: true, independentReviewRequired: true, ownerLandingApprovalRequired: true };
  validateBatch(contract, { allowUncommitted: true });
  if (realpathSync(c.canonicalWorktree) !== root) stop('source_workspace_mismatch', c.taskId);
  if (git(root, ['rev-parse', `${c.rootBaseSha}:oss`]) !== c.ossBaseSha) stop('base_gitlink_mismatch', c.taskId);
  if (plan.logs?.length !== c.tests.length || plan.logs.some((file, i) => sha256(readFileSync(file)) !== c.tests[i].logSha256)) stop('source_evidence_mismatch', 'settled test logs required');
  for (const [repo, base] of [[root, c.rootBaseSha], [oss, c.ossBaseSha]]) {
    commitObject(repo, base);
    if (git(repo, ['rev-parse', 'HEAD']) !== base || git(repo, ['branch', '--show-current']) === 'main') stop('source_base_mismatch', repo);
    if (git(repo, ['var', 'GIT_AUTHOR_IDENT']).split('>')[0] !== 'vilmire <vilmire@users.noreply.github.com' ||
        git(repo, ['var', 'GIT_COMMITTER_IDENT']).split('>')[0] !== 'vilmire <vilmire@users.noreply.github.com') stop('invalid_identity', repo);
    const dirty = git(repo, ['diff', '--name-only', '-z']).split('\0').filter(Boolean).filter(p => !(repo === root && p === 'oss'));
    if (dirty.length) stop('unstaged_source', JSON.stringify(dirty));
    if (git(repo, ['ls-files', '--others', '--exclude-standard'])) stop('unstaged_source', 'stage all source files before sealing');
    const hook = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'hooks/pre-commit']));
    if (!existsSync(hook) || !readFileSync(hook, 'utf8').includes('vendor-precommit')) stop('normal_hook_required', repo);
  }
  const actual = [...changed(root, c.rootBaseSha), ...changed(oss, c.ossBaseSha).map(p => `oss/${p}`)];
  if (!actual.length || actual.some(p => !c.touchedPaths.includes(p))) stop('undeclared_source_path', c.taskId);
  const privateDir = path.resolve(root, git(root, ['rev-parse', '--git-path', `refine-source-candidates/${c.taskId}`]));
  if (existsSync(path.join(privateDir, 'state.json'))) stop('source_seal_already_started', 'reconcile the retained source commits; do not replay');
  const state = { version: 1, taskId: c.taskId, revision: c.revision, readiness: 'source_only', releaseReady: false, inFlight: 'oss_source_commit' };
  json(path.join(privateDir, 'state.json'), state);
  marker(oss, SOURCE_MARKER, contract); git(oss, ['commit', '-m', `Seal source candidate ${c.taskId}`]);
  state.ossCandidateSha = git(oss, ['rev-parse', 'HEAD']); state.inFlight = 'root_source_commit'; json(path.join(privateDir, 'state.json'), state);
  git(root, ['add', '--', 'oss']); marker(root, ROOT_SOURCE_MARKER, contract);
  git(root, ['commit', '-m', `Pin source candidate ${c.taskId}`]);
  state.rootCandidateSha = git(root, ['rev-parse', 'HEAD']);
  if (git(root, ['rev-parse', 'HEAD:oss']) !== state.ossCandidateSha) stop('source_gitlink_mismatch', c.taskId);
  if (git(root, ['status', '--porcelain']) || git(oss, ['status', '--porcelain'])) stop('dirty_source_checkpoint', 'preserve commits and reconcile');
  const candidate = { ...c, readiness: 'verified_source_candidate', rootCandidateSha: state.rootCandidateSha, ossCandidateSha: state.ossCandidateSha };
  candidate.touchedPaths = [...new Set([...c.touchedPaths,
    ...git(root, ['diff', '--name-only', '-z', c.rootBaseSha, state.rootCandidateSha]).split('\0').filter(Boolean),
    ...git(oss, ['diff', '--name-only', '-z', c.ossBaseSha, state.ossCandidateSha]).split('\0').filter(Boolean).map(p => `oss/${p}`)])];
  const patch = path.join(privateDir, 'source.patch'), manifest = path.join(privateDir, 'manifest.json');
  writeFileSync(patch, git(root, ['diff', '--binary', c.rootBaseSha, state.rootCandidateSha]) + '\n' + git(oss, ['diff', '--binary', c.ossBaseSha, state.ossCandidateSha]) + '\n', { mode: 0o600 });
  json(manifest, { version: 1, taskId: c.taskId, revision: c.revision, rootBaseSha: c.rootBaseSha, ossBaseSha: c.ossBaseSha,
    rootCandidateSha: state.rootCandidateSha, ossCandidateSha: state.ossCandidateSha, touchedPaths: candidate.touchedPaths, tests: c.tests, releaseReady: false });
  candidate.patchSha256 = sha256(readFileSync(patch)); candidate.manifestSha256 = sha256(readFileSync(manifest));
  const logs = plan.logs.map((file, i) => { const copy = path.join(privateDir, `test-${i}.log`); writeFileSync(copy, readFileSync(file), { mode: 0o600 }); return copy; });
  state.inFlight = null; state.candidate = candidate; state.evidence = { patch, manifest, logs }; json(path.join(privateDir, 'state.json'), state);
  return state;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) stop('usage', 'node oss/scripts/refine-source-candidate.mjs <private-source-plan.json>');
    console.log(JSON.stringify(sealSourceCandidate(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
