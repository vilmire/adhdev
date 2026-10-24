// Versioned Product B source/batch contract. This is also used by normal hooks.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_MARKER = 'scripts/refine-source-phase.json';
export const ROOT_SOURCE_MARKER = 'scripts/lib/refine-source-phase.json';
export const RECEIPT = 'scripts/refine-batch-ready.json';
export const ROOT_RECEIPT = 'scripts/lib/refine-batch-ready.json';
export const GENERATED = ['packages/daemon-cloud/vendor/mcp-server/', 'packages/daemon-standalone/vendor/mcp-server/'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function privateContractPath(repo, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) stop('invalid_contract_digest', 'SHA256 required');
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', `refine-source-contracts/${digest}.json`]));
}
export function privateReadyProofPath(repo, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) stop('invalid_receipt_digest', 'SHA256 required');
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', `refine-batch-proofs/${digest}.json`]));
}
export function stop(code, detail) { throw Object.assign(new Error(`${code}: ${detail}`), { code }); }
export function cleanEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_TERMINAL_PROMPT', 'GIT_MERGE_AUTOEDIT', 'GIT_TRACE'].includes(key)) delete env[key];
  return env;
}
export function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
export function commitObject(repo, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) stop('invalid_pin', sha);
}
export const generated = p => GENERATED.some(dir => p.startsWith(dir));
const metadata = p => [SOURCE_MARKER, ROOT_SOURCE_MARKER, RECEIPT, ROOT_RECEIPT].includes(p);
export function indexEntries(repo, env) {
  return git(repo, ['ls-files', '-s', '-z'], { ...(env ? { env } : {}) }).split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) ([a-f0-9]{40}) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[3] !== '0') stop('unmerged_source', line);
    return { mode: match[1], oid: match[2], path: match[4] };
  });
}
export function sourceHash(repo, env) {
  return sha256(JSON.stringify(indexEntries(repo, env).filter(e => !metadata(e.path) && !generated(e.path))));
}
export function outputHashes(repo, env) {
  return indexEntries(repo, env).filter(e => generated(e.path)).map(e => {
    if (e.mode !== '100644' && e.mode !== '100755') stop('invalid_generated_mode', e.path);
    return [e.path, e.oid];
  });
}
export function readIndexJson(repo, name, env) {
  const found = indexEntries(repo, env).find(e => e.path === name);
  if (!found) return null;
  if (found.mode !== '100644') stop('invalid_contract_mode', name);
  try { return JSON.parse(git(repo, ['show', `:${name}`], { ...(env ? { env } : {}) })); }
  catch { stop('invalid_contract', name); }
}
export function validateBatch(contract, { allowUncommitted = false } = {}) {
  if (!contract || contract.version !== 1 || !/^[\w.-]{1,100}$/.test(contract.batchId || '') ||
      contract.bundleInvocationCount !== 1 || contract.normalHooksRequired !== true ||
      contract.independentReviewRequired !== true || contract.ownerLandingApprovalRequired !== true ||
      !Array.isArray(contract.candidates) || !contract.candidates.length || !Array.isArray(contract.integrationOrder) ||
      !Array.isArray(contract.requiredGates) || !contract.requiredGates.length ||
      contract.requiredGates.some(id => typeof id !== 'string' || !/^[\w:.-]{1,100}$/.test(id)) ||
      new Set(contract.requiredGates).size !== contract.requiredGates.length ||
      contract.candidates.some(c => !c || typeof c !== 'object' || Array.isArray(c))) stop('invalid_batch', 'V1 frozen contract required');
  const ids = contract.candidates.map(c => c.taskId);
  if (new Set(ids).size !== ids.length || contract.integrationOrder.length !== ids.length ||
      new Set(contract.integrationOrder).size !== ids.length || contract.integrationOrder.some(id => !ids.includes(id))) stop('invalid_order', 'exact candidate permutation required');
  let mission, identity, anchor;
  for (const c of contract.candidates) {
    if (c.version !== 1 || !(c.readiness === 'verified_source_candidate' || (allowUncommitted && c.readiness === 'uncommitted')) || !c.settledCommands ||
        !Number.isSafeInteger(c.revision) || c.revision < 0 || !/^[\w.-]{1,100}$/.test(c.taskId || '') || !c.missionId || !c.repoIdentity ||
        !c.machineId || !c.canonicalWorktree || !c.integrationTaskId ||
        !/^[a-f0-9]{64}$/.test(c.patchSha256 || '') || !/^[a-f0-9]{64}$/.test(c.manifestSha256 || '') ||
        !Array.isArray(c.tests) || !c.tests.length || c.tests.some(t => !t.command || t.exit !== 0 || !/^[a-f0-9]{64}$/.test(t.logSha256 || '')) ||
        !Array.isArray(c.touchedPaths) || c.touchedPaths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\\')) ||
        !Array.isArray(c.logicalOverlapTaskIds)) stop('invalid_source_candidate', c.taskId || 'missing task');
    if (mission && (mission !== c.missionId || identity !== c.repoIdentity || anchor !== c.integrationTaskId)) stop('candidate_identity_mismatch', c.taskId);
    [mission, identity, anchor] = [c.missionId, c.repoIdentity, c.integrationTaskId];
    for (const key of ['rootBaseSha', 'ossBaseSha', ...(c.readiness === 'verified_source_candidate' ? ['rootCandidateSha', 'ossCandidateSha'] : [])]) if (!/^[a-f0-9]{40}$/.test(c[key] || '')) stop('invalid_pin', `${c.taskId}.${key}`);
    for (const peer of c.logicalOverlapTaskIds) if (!ids.includes(peer) || peer === c.taskId) stop('invalid_overlap', c.taskId);
  }
  for (let i = 0; i < contract.candidates.length; i++) for (const b of contract.candidates.slice(i + 1)) {
    const a = contract.candidates[i];
    const overlap = a.touchedPaths.some(p => b.touchedPaths.some(q => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)));
    if (overlap && (!a.logicalOverlapTaskIds.includes(b.taskId) || !b.logicalOverlapTaskIds.includes(a.taskId))) stop('undeclared_overlap', `${a.taskId},${b.taskId}`);
  }
  return contract;
}
// Hooks never accept an environment skip flag. A staged source marker binds the
// whole index and frozen contract, and explicitly cannot confer release authority.
export function validatePhaseIndex(repo, layer, env) {
  const marker = readIndexJson(repo, layer === 'oss' ? SOURCE_MARKER : ROOT_SOURCE_MARKER, env);
  if (!marker) return null;
  const contract = validateBatch(JSON.parse(readFileSync(privateContractPath(repo, marker.contractSha256), 'utf8')), { allowUncommitted: true });
  if (marker.version !== 1 || marker.readiness !== 'source_ready' || marker.releaseReady !== false ||
      marker.sourceHash !== sourceHash(repo, env) || marker.batchId !== contract.batchId || marker.contractSha256 !== sha256(JSON.stringify(contract)) ||
      !marker.completedTaskIds?.length || marker.completedTaskIds.some((id, i) => contract.integrationOrder[i] !== id)) stop('invalid_source_phase', 'index/contract/order mismatch');
  return marker;
}
export function validateReadyIndex(repo, layer, env) {
  const receipt = readIndexJson(repo, layer === 'oss' ? RECEIPT : ROOT_RECEIPT, env);
  if (!receipt) return null;
  if (readIndexJson(repo, layer === 'oss' ? SOURCE_MARKER : ROOT_SOURCE_MARKER, env)) stop('source_not_publishable', repo);
  if (receipt.version !== 1 || receipt.readiness !== 'batch_ready' || receipt.releaseReady !== false || receipt.bundleInvocationCount !== 1 ||
      receipt.sourceHash !== sourceHash(repo, env) || JSON.stringify(receipt.outputs) !== JSON.stringify(outputHashes(repo, env)) ||
      !/^[a-f0-9]{64}$/.test(receipt.contractSha256 || '') || !/^[a-f0-9]{64}$/.test(receipt.bundleLogSha256 || '') ||
      !receipt.requiredGates?.length || receipt.gates?.length !== receipt.requiredGates.length ||
      receipt.gates.some((g, i) => g.id !== receipt.requiredGates[i] || g.exit !== 0 || !/^[a-f0-9]{64}$/.test(g.logSha256 || ''))) stop('invalid_batch_receipt', 'index/outputs/gates mismatch');
  const proof = JSON.parse(readFileSync(privateReadyProofPath(repo, sha256(JSON.stringify(receipt))), 'utf8'));
  const contract = validateBatch(proof.contract);
  if (sha256(JSON.stringify(contract)) !== receipt.contractSha256 || proof.bundleInvocationCount !== 1 ||
      proof.bundle?.exit !== 0 || proof.bundle.logSha256 !== receipt.bundleLogSha256 ||
      JSON.stringify(proof.bundle.args) !== JSON.stringify(['run', 'bundle:vendor:all']) ||
      !['npm', 'npm.cmd'].includes(proof.bundle.command) ||
      sha256(readFileSync(proof.bundleLog)) !== receipt.bundleLogSha256 ||
      JSON.stringify(contract.requiredGates) !== JSON.stringify(receipt.requiredGates) ||
      proof.gates?.length !== contract.requiredGates.length || proof.gateSpecs?.length !== proof.gates.length) stop('invalid_batch_proof', 'full frozen contract and actual combined command log required');
  for (let i = 0; i < proof.gates.length; i++) {
    const gate = proof.gates[i], spec = proof.gateSpecs[i];
    if (gate.id !== contract.requiredGates[i] || gate.id !== spec.id || gate.exit !== 0 || gate.command !== spec.command ||
        JSON.stringify(gate.args) !== JSON.stringify(spec.args || []) || gate.cwd !== (spec.cwd || '.') ||
        gate.logSha256 !== receipt.gates[i].logSha256 || sha256(readFileSync(proof.gateLogs[i])) !== gate.logSha256) stop('invalid_batch_proof', 'required gate command/log mismatch');
  }
  return receipt;
}
export function verifyEvidence(candidate, files) {
  for (const [key, digest] of [['patch', candidate.patchSha256], ['manifest', candidate.manifestSha256]]) {
    if (!files?.[key] || sha256(readFileSync(files[key])) !== digest) stop('source_evidence_mismatch', `${candidate.taskId}.${key}`);
  }
  if (files.logs?.length !== candidate.tests.length || files.logs.some((p, i) => sha256(readFileSync(p)) !== candidate.tests[i].logSha256)) stop('source_evidence_mismatch', `${candidate.taskId}.logs`);
}
