#!/usr/bin/env node
// Local operator workflow: prepare/resume one frozen V1 batch. Never publishes,
// updates main, rebases, installs dependencies, or controls a daemon.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync, realpathSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  SOURCE_MARKER, ROOT_SOURCE_MARKER, RECEIPT, ROOT_RECEIPT, sha256, stop, cleanEnv,
  git, commitObject, generated, indexEntries, sourceHash, outputHashes, validateBatch, verifyEvidence, privateContractPath, privateReadyProofPath,
} from './refine-batch-contract.mjs';

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(path.dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function takeLease(common) {
  const file = path.join(common, 'refine-source-batch.lease');
  const token = randomUUID();
  try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ version: 1, token, pid: process.pid })); fsyncSync(fd); closeSync(fd); }
  catch { stop('integration_lease_held', 'No automatic takeover; settle the prior process and lease through normal admission.'); }
  return () => { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); };
}
function freeBytes(dir) { const s = statfsSync(dir); return s.bavail * s.bsize; }
function command(root, spec, logFile) {
  const began = Date.now();
  let exit = 0;
  const fd = openSync(logFile, 'w', 0o600);
  try {
    execFileSync(spec.command, spec.args || [], { cwd: path.resolve(root, spec.cwd || '.'), env: cleanEnv(), stdio: ['ignore', fd, fd], timeout: spec.timeoutMs || 600_000, windowsHide: true });
  } catch (error) { exit = Number.isInteger(error.status) ? error.status : 1; }
  finally { fsyncSync(fd); closeSync(fd); }
  return { id: spec.id, command: spec.command, args: spec.args || [], cwd: spec.cwd || '.', exit, wallMs: Date.now() - began, logSha256: sha256(readFileSync(logFile)) };
}
function requireClean(repo) {
  if (git(repo, ['status', '--porcelain', '--untracked-files=normal'])) stop('dirty_integration_workspace', repo);
}
function requireIdentity(repo) {
  if (git(repo, ['var', 'GIT_AUTHOR_IDENT']).split('>')[0] !== 'vilmire <vilmire@users.noreply.github.com' ||
      git(repo, ['var', 'GIT_COMMITTER_IDENT']).split('>')[0] !== 'vilmire <vilmire@users.noreply.github.com') stop('invalid_identity', repo);
}
function normalHooks(repo) {
  const hook = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'hooks/pre-commit']));
  // Foreign hook chains remain authoritative; never install/override them here.
  if (!existsSync(hook) || !(readFileSync(hook, 'utf8').includes('vendor-precommit'))) stop('normal_hook_required', repo);
}
function validateInputs(plan) {
  const c = validateBatch(plan.contract);
  commitObject(plan.rootRepo, c.approvedRootSha); commitObject(plan.ossRepo, c.approvedOssSha);
  if (git(plan.rootRepo, ['rev-parse', `${c.approvedRootSha}:oss`]) !== c.approvedOssSha) stop('base_gitlink_mismatch', c.batchId);
  for (const source of c.candidates) {
    const record = plan.resolvedTasks?.find(r => r.taskId === source.taskId);
    if (!record || record.revision !== source.revision || record.missionId !== source.missionId || record.repoIdentity !== source.repoIdentity ||
        record.integrationTaskId !== source.integrationTaskId || record.candidateSha256 !== sha256(JSON.stringify(source)) ||
        record.branchState !== 'not_mergeable' || record.phase !== 'source' || record.status !== 'completed') stop('source_revision_mismatch', source.taskId);
    verifyEvidence(source, plan.evidence?.[source.taskId]);
    for (const [repo, base, tip] of [[plan.rootRepo, source.rootBaseSha, source.rootCandidateSha], [plan.ossRepo, source.ossBaseSha, source.ossCandidateSha]]) {
      commitObject(repo, base); commitObject(repo, tip);
      try { git(repo, ['merge-base', '--is-ancestor', base, tip]); } catch { stop('source_base_mismatch', source.taskId); }
    }
    if (git(plan.rootRepo, ['rev-parse', `${source.rootCandidateSha}:oss`]) !== source.ossCandidateSha) stop('candidate_gitlink_mismatch', source.taskId);
    const touched = [...git(plan.rootRepo, ['diff', '--name-only', '-z', source.rootBaseSha, source.rootCandidateSha]).split('\0').filter(Boolean),
      ...git(plan.ossRepo, ['diff', '--name-only', '-z', source.ossBaseSha, source.ossCandidateSha]).split('\0').filter(Boolean).map(p => `oss/${p}`)];
    if (touched.some(p => !source.touchedPaths.includes(p))) stop('undeclared_source_path', source.taskId);
  }
  if (!Number.isSafeInteger(plan.reserveBytes) || plan.reserveBytes < 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(plan.peakAdditionalBytes) || plan.peakAdditionalBytes < 1) stop('phase_budget_required', 'positive measured peak plus >=1GiB reserve');
  if (freeBytes(plan.rootRepo) < plan.reserveBytes + plan.peakAdditionalBytes) stop('phase_budget_exceeded', `need ${plan.reserveBytes + plan.peakAdditionalBytes} available bytes; have ${freeBytes(plan.rootRepo)}`);
}
function configuredGates(root, contract) {
  const config = JSON.parse(readFileSync(path.join(root, '.adhdev/refine.json'), 'utf8'));
  if (config.validation?.required !== true || !Array.isArray(config.validation.commands)) stop('required_gates_missing', root);
  const gates = config.validation.commands;
  // The configured integration gates remain mandatory. Bootstrap is a separate
  // provisioning operation; this workflow requires an already prepared checkout.
  if (gates.length !== contract.requiredGates.length || gates.some((g, i) => g.id !== contract.requiredGates[i])) stop('required_gates_mismatch', 'freeze the entire configured ordered gate set');
  return gates;
}
function marker(repo, layer, contract, completed) {
  const name = layer === 'oss' ? SOURCE_MARKER : ROOT_SOURCE_MARKER;
  const digest = sha256(JSON.stringify(contract));
  // Full task/worktree/evidence metadata stays private, outside all Git trees.
  atomicJson(privateContractPath(repo, digest), contract);
  const value = { version: 1, readiness: 'source_ready', releaseReady: false, batchId: contract.batchId, contractSha256: digest, completedTaskIds: completed, sourceHash: sourceHash(repo) };
  atomicJson(path.join(repo, name), value); git(repo, ['add', '--', name]);
}
function mergeSource(repo, tip, baseline, combinedOss) {
  const begin = Date.now();
  try { git(repo, ['merge', '--no-ff', '--no-commit', tip]); }
  catch (error) {
    const entries = git(repo, ['ls-files', '-u', '-z']).split('\0').filter(Boolean).map(line => {
      const m = /^(\d+) ([a-f0-9]{40}) (\d)\t([\s\S]+)$/.exec(line);
      if (!m) stop('merge_failed', error.message);
      return { mode: m[1], path: m[4] };
    });
    if (!entries.length) stop('merge_failed', error.message);
    const markerConflict = e => [SOURCE_MARKER, ROOT_SOURCE_MARKER].includes(e.path) && ['100644', '100755'].includes(e.mode);
    const realConflicts = entries.filter(e => !(generated(e.path) && ['100644', '100755'].includes(e.mode)) && !markerConflict(e) && !(e.path === 'oss' && e.mode === '160000' && combinedOss));
    if (realConflicts.length) stop('source_conflict', JSON.stringify([...new Set(realConflicts.map(e => e.path))]));
    // Restore frozen baseline blobs, never either sibling's stale bundle. The
    // deferred paths are regenerated from the combined sources before readiness.
    for (const file of new Set(entries.filter(e => generated(e.path)).map(e => e.path))) {
      try { git(repo, ['restore', `--source=${baseline}`, '--staged', '--worktree', '--', file]); }
      catch { git(repo, ['rm', '-f', '--', file]); }
    }
    // Each source branch has its own source-only receipt. Replace that metadata
    // with this integration checkpoint's frozen-batch receipt after the merge;
    // it is not a source-file conflict or a choice of a sibling's authority.
    for (const file of new Set(entries.filter(markerConflict).map(e => e.path))) git(repo, ['rm', '-f', '--', file]);
  }
  if (combinedOss) git(repo, ['update-index', '--cacheinfo', `160000,${combinedOss},oss`]);
  indexEntries(repo);
  return { command: 'git merge --no-ff --no-commit', tip, wallMs: Date.now() - begin };
}
function commitCheckpoint(repo, layer, contract, completed) {
  marker(repo, layer, contract, completed);
  requireIdentity(repo); normalHooks(repo);
  git(repo, ['commit', '-m', `Stage source batch ${contract.batchId}: ${completed.at(-1)}`]);
  requireClean(repo);
  return git(repo, ['rev-parse', 'HEAD']);
}
function snapshot(root) {
  return { root: sourceHash(root), oss: sourceHash(path.join(root, 'oss')) };
}
function stageOutputs(root) {
  for (const [repo, dir] of [[root, 'packages/daemon-cloud/vendor/mcp-server'], [path.join(root, 'oss'), 'packages/daemon-standalone/vendor/mcp-server']]) git(repo, ['add', '-A', '--', dir]);
}
function receipt(repo, layer, state, stateDir) {
  const name = layer === 'oss' ? RECEIPT : ROOT_RECEIPT;
  const value = {
    version: 1, readiness: 'batch_ready', releaseReady: false, batchId: state.contract.batchId,
    contractSha256: sha256(JSON.stringify(state.contract)), sourceHash: sourceHash(repo),
    outputs: outputHashes(repo), bundleInvocationCount: 1, bundleLogSha256: state.bundle.logSha256,
    requiredGates: state.contract.requiredGates, gates: state.gates.map(({ id, exit, logSha256 }) => ({ id, exit, logSha256 })),
  };
  atomicJson(privateReadyProofPath(repo, sha256(JSON.stringify(value))), {
    version: 1, contract: state.contract, bundleInvocationCount: state.bundleInvocationCount,
    bundle: state.bundle, bundleLog: path.join(stateDir, 'bundle.log'), gates: state.gates,
    gateSpecs: state.gateSpecs, gateLogs: state.gates.map((_g, i) => path.join(stateDir, `gate-${i}.log`)),
  });
  atomicJson(path.join(repo, name), value);
  git(repo, ['add', '--', name]);
}
export function prepareSourceBatch(plan, { signal } = {}) {
  validateInputs(plan);
  const common = path.resolve(plan.rootRepo, git(plan.rootRepo, ['rev-parse', '--git-common-dir']));
  const release = takeLease(common);
  const stateDir = path.join(common, 'refine-source-batches', plan.contract.batchId);
  const stateFile = path.join(stateDir, 'state.json');
  mkdirSync(stateDir, { recursive: true });
  let state;
  const save = () => atomicJson(stateFile, state);
  const checkCancel = () => { if (signal?.aborted) { state.cancelled = true; save(); stop('batch_cancelled', 'no publication was attempted'); } };
  try {
    const planHash = sha256(JSON.stringify(plan));
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state.planHash !== planHash) stop('batch_contract_changed', plan.contract.batchId);
      if (state.phase === 'batch_ready') return state;
      // Command effects cannot be inferred from status labels. No replay of a
      // possibly launched build, commit, merge, or gate; preserve it for review.
      if (state.inFlight) stop('interrupted_step_requires_reconciliation', JSON.stringify(state.inFlight));
      if (state.cancelled) stop('batch_cancelled', 'create an explicitly replanned batch');
    } else {
      if (existsSync(plan.workspace)) stop('workspace_exists', plan.workspace);
      state = { version: 1, contract: plan.contract, planHash, workspace: path.resolve(plan.workspace), phase: 'creating', completedTaskIds: [], stages: [], gates: [], bundleInvocationCount: 0, startedAt: Date.now(), publicationCount: 0 };
      state.inFlight = { step: 'create_worktrees' }; save();
      git(plan.rootRepo, ['worktree', 'add', '--detach', state.workspace, plan.contract.approvedRootSha]);
      git(plan.ossRepo, ['worktree', 'add', '--detach', path.join(state.workspace, 'oss'), plan.contract.approvedOssSha]);
      state.inFlight = null; state.phase = 'staging'; save();
    }
    const root = state.workspace, oss = path.join(root, 'oss');
    // The operator must provision dependencies normally before preparation. The
    // CLI never links another writer's node_modules or runs a hidden install.
    if (!existsSync(path.join(root, 'node_modules'))) stop('prepared_workspace_required', `${root}: dependencies must be provisioned under a separately budgeted phase`);
    requireClean(root); requireClean(oss);
    if (git(root, ['rev-parse', 'HEAD']) !== (state.rootCheckpoint || state.contract.approvedRootSha) ||
        git(oss, ['rev-parse', 'HEAD']) !== (state.ossCheckpoint || state.contract.approvedOssSha)) stop('integration_checkpoint_changed', 'resume requires exact recorded heads');
    state.gateSpecs = configuredGates(root, state.contract);
    for (const id of state.contract.integrationOrder.slice(state.completedTaskIds.length)) {
      checkCancel(); requireClean(root); requireClean(oss);
      const c = state.contract.candidates.find(candidate => candidate.taskId === id);
      state.inFlight = { step: 'merge_source', taskId: id }; save();
      state.stages.push(mergeSource(oss, c.ossCandidateSha, state.contract.approvedOssSha));
      const completed = [...state.completedTaskIds, id];
      const combinedOss = commitCheckpoint(oss, 'oss', state.contract, completed);
      state.stages.push(mergeSource(root, c.rootCandidateSha, state.contract.approvedRootSha, combinedOss));
      state.rootCheckpoint = commitCheckpoint(root, 'root', state.contract, completed);
      state.ossCheckpoint = combinedOss; state.completedTaskIds = completed; state.inFlight = null; save();
    }
    checkCancel();
    if (state.bundleInvocationCount !== 0) stop('bundle_already_started', 'reconciliation required; never run twice');
    if (freeBytes(root) < plan.reserveBytes + plan.peakAdditionalBytes) stop('phase_budget_exceeded', `build requires ${plan.reserveBytes + plan.peakAdditionalBytes} bytes; have ${freeBytes(root)}`);
    state.phase = 'building'; state.bundleInvocationCount = 1; state.inFlight = { step: 'combined_bundle', invocation: 1 }; save();
    const before = snapshot(root);
    state.bundle = command(root, { id: 'combined-bundle', command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'bundle:vendor:all'] }, path.join(stateDir, 'bundle.log'));
    save();
    if (state.bundle.exit) stop('combined_bundle_failed', state.bundle.logSha256);
    stageOutputs(root);
    if (JSON.stringify(snapshot(root)) !== JSON.stringify(before)) stop('bundle_changed_source', state.contract.batchId);
    // Committed-HEAD gates (notably check:vendor) deliberately reject a fresh
    // working-tree bundle against an old source-only HEAD. Materialize the
    // generated bytes locally first, retaining source-only publication fences.
    // These NORMAL checkpoint hooks validate the frozen source contract and do
    // not generate again. Final readiness still requires every configured gate.
    state.inFlight = { step: 'generated_source_checkpoints' }; save();
    state.generatedOssSha = commitCheckpoint(oss, 'oss', state.contract, state.completedTaskIds);
    git(root, ['add', '--', 'oss']);
    state.generatedRootSha = commitCheckpoint(root, 'root', state.contract, state.completedTaskIds);
    state.generatedCheckpointCommands = 2; save();
    const beforeGates = snapshot(root);
    for (const gate of configuredGates(root, state.contract)) {
      checkCancel(); state.inFlight = { step: 'gate', id: gate.id }; save();
      const result = command(root, gate, path.join(stateDir, `gate-${state.gates.length}.log`));
      state.gates.push(result); save();
      if (result.exit) stop('required_gate_failed', gate.id);
      if (JSON.stringify(snapshot(root)) !== JSON.stringify(beforeGates)) stop('gate_changed_source', gate.id);
    }
    // Normal hooks validate receipts binding exact source, generated blobs and
    // every required successful gate. Source markers are removed only now.
    state.inFlight = { step: 'final_normal_commits' }; save();
    git(oss, ['rm', '--', SOURCE_MARKER]); git(root, ['rm', '--', ROOT_SOURCE_MARKER]);
    receipt(oss, 'oss', state, stateDir); requireIdentity(oss); normalHooks(oss);
    git(oss, ['commit', '-m', `Generate combined source batch ${state.contract.batchId}`]);
    state.finalOssSha = git(oss, ['rev-parse', 'HEAD']);
    git(root, ['add', '--', 'oss']); receipt(root, 'root', state, stateDir);
    requireIdentity(root); normalHooks(root);
    git(root, ['commit', '-m', `Prepare combined source batch ${state.contract.batchId}`]);
    state.finalRootSha = git(root, ['rev-parse', 'HEAD']);
    requireClean(root); requireClean(oss);
    if (git(root, ['rev-parse', 'HEAD:oss']) !== state.finalOssSha) stop('final_gitlink_mismatch', state.contract.batchId);
    const cloud = outputHashes(root).map(([p, oid]) => [p.replace('daemon-cloud', 'daemon'), oid]);
    const standalone = outputHashes(oss).map(([p, oid]) => [p.replace('daemon-standalone', 'daemon'), oid]);
    if (!cloud.length || JSON.stringify(cloud) !== JSON.stringify(standalone)) stop('generated_parity_failed', state.contract.batchId);
    state.phase = 'batch_ready'; state.inFlight = null; state.finishedAt = Date.now(); state.wallMs = state.finishedAt - state.startedAt;
    state.releaseReady = false; state.next = 'Independent combined review, then owner exact-SHA approval; use ordinary pinned Refinery publication with fresh per-node/per-repo authority and all existing fences.';
    save(); return state;
  } catch (error) {
    if (state) { state.stop = { code: error.code || 'operation_failed', message: error.message }; save(); }
    throw error;
  } finally { release(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) stop('usage', 'node oss/scripts/refine-source-batch.mjs <frozen-plan.json>');
    console.log(JSON.stringify(prepareSourceBatch(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
