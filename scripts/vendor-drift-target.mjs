import { execFileSync } from 'node:child_process';

// Default committed-HEAD semantics remain unchanged. Retirement may validate a
// frozen prospective tree, never the mutable index or an arbitrary revision.
export function vendorDriftTarget(repo, args = []) {
  if (!args.length) return 'HEAD';
  if (args.length !== 2 || args[0] !== '--tree' || !/^[a-f0-9]{40,64}$/.test(args[1])) throw Error('expected --tree <tree-object>');
  const type = execFileSync('git', ['cat-file', '-t', args[1]], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (type !== 'tree') throw Error('candidate must be a tree object');
  return args[1];
}
