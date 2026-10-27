// Local build evidence only. This grants no publication, release or task authority.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { devNull } from 'node:os';

export const retirementMarkers = ['scripts/refine-source-phase.json', 'scripts/lib/refine-source-phase.json', '.adhdev-source-candidate.json'];
export const retirementVendorDirs = {
  root: ['packages/daemon-cloud/vendor/mcp-server', 'packages/daemon-cloud/vendor/session-host-daemon', 'packages/daemon-cloud/vendor/terminal-mux-cli'],
  oss: ['packages/daemon-standalone/vendor/mcp-server', 'packages/daemon-standalone/vendor/session-host-daemon'],
};
export const digest = value => createHash('sha256').update(value).digest('hex');
export function retirementGit(repo, args, env, raw = false) {
  const clean = Object.fromEntries(Object.entries(env || process.env).filter(([key]) => !key.startsWith('GIT_') || (env && key === 'GIT_INDEX_FILE')));
  clean.GIT_NO_REPLACE_OBJECTS = '1';
  clean.GIT_GRAFT_FILE = devNull;
  const value = execFileSync('git', ['--no-replace-objects', ...args], { cwd: repo, env: clean, encoding: raw ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return raw ? value : value.trim();
}
function entries(repo, ref, env) {
  const args = ref ? ['ls-tree', '-r', '-z', ref] : ['ls-files', '-s', '-z'];
  return retirementGit(repo, args, env).split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (?:\w+ )?([a-f0-9]{40,64})(?: (\d))?\t([\s\S]+)$/.exec(line);
    if (!match || (match[3] && match[3] !== '0')) throw Error('unmerged retirement index');
    return [match[1], match[2], match[4]];
  });
}
export function retirementSnapshot(repo, layer, ref, env) {
  const files = entries(repo, ref, env);
  if (files.some(e => retirementMarkers.includes(e[2]))) throw Error('temporary source marker remains');
  return digest(JSON.stringify(files.filter(e => !(layer === 'root' && e[2] === 'oss'))));
}
export function retirementProofPath(repo, layer, ref, env) {
  layer ||= retirementGit(repo, ref ? ['ls-tree', ref, '--', 'oss'] : ['ls-files', '--', 'oss'], env) ? 'root' : 'oss';
  const key = retirementSnapshot(repo, layer, ref, env);
  // Worktrees of the same repository can verify the same immutable candidate.
  // Logs remain private; no proof or machine path is committed or published.
  return path.resolve(repo, retirementGit(repo, ['rev-parse', '--git-common-dir']), 'normal-marker-retirement', `${key}.json`);
}
export function requiresRetirementProof(repo, ref = 'HEAD', base) {
  // Existing batch-ready finalization retains its separate, stricter contract.
  if (retirementGit(repo, ['ls-tree', ref, '--', 'scripts/refine-batch-ready.json', 'scripts/lib/refine-batch-ready.json'])) return false;
  if (base !== undefined && !/^[a-f0-9]{40,64}$/.test(base)) throw Error('invalid retirement base');
  return !!retirementGit(repo, ['log', '-1', '--format=%H', '--diff-filter=D', ref, ...(base ? [`^${base}`] : []), '--', ...retirementMarkers]);
}
export function configuredRetirementGates(root, env) {
  const config = JSON.parse(retirementGit(root, ['show', ':.adhdev/refine.json'], env));
  const commands = config.validation?.commands;
  if (config.validation?.required !== true || !Array.isArray(commands) || !commands.length ||
      new Set(commands.map(c => c.id)).size !== commands.length) throw Error('required retirement gates missing');
  const prepare = config.validation.schedule?.prepare || [];
  return [...prepare.map((c, i) => ({ ...c, id: `prepare-${i}` })), ...commands].map(c => {
    if (!c.id || typeof c.command !== 'string' || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string')) throw Error('invalid retirement gate');
    return { id: c.id, command: c.command, args: c.args, cwd: c.cwd || '.', timeoutMs: c.timeoutMs || 600000 };
  });
}
export function validateRetirementProof(repo, layer, { ref, env, proofFile } = {}) {
  const fail = () => { throw Error('invalid_normal_retirement_proof: current source/output/config and successful command logs required'); };
  try {
    const proof = JSON.parse(readFileSync(proofFile || retirementProofPath(repo, layer, ref, env)));
    if (proof.version !== 1 || proof.releaseReady !== false || !proof.rootRepo || !proof.ossRepo ||
        proof.snapshots?.[layer] !== retirementSnapshot(repo, layer, ref, env)) fail();
    // Both repos are one build input. Root gitlink is checked separately after
    // the OSS commit; excluding it allows the ordinary two-commit Git wave.
    for (const target of ['root', 'oss']) {
      if (target !== layer && proof.snapshots[target] !== retirementSnapshot(proof[`${target}Repo`], target)) fail();
      if (proof.snapshots[target] !== retirementSnapshot(proof[`${target}Repo`], target, proof.trees?.[target])) fail();
    }
    if (layer === 'root') {
      const pin = retirementGit(repo, ref ? ['rev-parse', `${ref}:oss`] : ['rev-parse', ':oss'], env);
      if (retirementSnapshot(proof.ossRepo, 'oss', pin) !== proof.snapshots.oss) fail();
    }
    const specs = configuredRetirementGates(proof.rootRepo, layer === 'root' ? env : undefined);
    if (JSON.stringify(specs) !== JSON.stringify(proof.specs) || proof.gates?.length !== specs.length) fail();
    const verifyLog = receipt => receipt?.exit === 0 && receipt.logSha256 === digest(readFileSync(receipt.log));
    if (proof.generation?.command !== 'npm run bundle:vendor:all' || !verifyLog(proof.generation)) fail();
    for (const target of ['root', 'oss']) {
      const repo = proof[`${target}Repo`];
      const files = entries(repo, proof.trees[target]);
      const generated = name => retirementVendorDirs[target].some(dir => name.startsWith(`${dir}/`));
      const sources = files.filter(e => !(target === 'root' && e[2] === 'oss') && !generated(e[2]))
        .map(([mode, oid, path]) => ({ mode, oid, path }));
      const outputs = files.filter(e => generated(e[2])).map(([mode, oid, name]) =>
        [name, mode, digest(retirementGit(repo, ['cat-file', 'blob', oid], undefined, true))]);
      if (proof.generation.sources?.[target] !== digest(JSON.stringify(sources)) ||
          JSON.stringify(proof.generation.outputs?.[target]) !== JSON.stringify(outputs)) fail();
    }
    for (let i = 0; i < specs.length; i++) {
      if (JSON.stringify(proof.gates[i].spec) !== JSON.stringify(specs[i]) || !verifyLog(proof.gates[i])) fail();
      const args = [...specs[i].args];
      if (['vendor-drift-root', 'vendor-drift-oss'].includes(specs[i].id)) args.push('--tree', proof.trees[specs[i].id === 'vendor-drift-root' ? 'root' : 'oss']);
      if (JSON.stringify(args) !== JSON.stringify(proof.gates[i].args)) fail();
    }
    return proof;
  } catch { fail(); }
}
