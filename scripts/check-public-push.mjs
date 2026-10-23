#!/usr/bin/env node
// Release entry point: the same in-process identity/history guard as Refinery.
// External private roots require ADHDEV_PRIVATE_ROOT and an out-of-band
// ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 pin of their committed pattern blob.
import { resolve } from 'node:path';
import { checkPush, loadPublicPushPatternsForRepo, formatViolation } from '../packages/daemon-core/src/git/public-push-guard.mjs';

let repo = process.cwd();
const entries = [];
try {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--repo' && process.argv[i + 1]) repo = resolve(process.argv[++i]);
    else if (arg === '--ref' && process.argv[i + 1]) {
      const [localSha, remoteSha = '0'.repeat(40)] = process.argv[++i].split(':');
      entries.push({ localRef: localSha, localSha, remoteSha });
    } else throw new Error('expected --repo <path> and --ref <ref>[:<remote-ref>]');
  }
  if (!entries.length) throw new Error('no push refs supplied');
  const patterns = await loadPublicPushPatternsForRepo(repo);
  const result = await checkPush(entries, { cwd: repo, patterns });
  if (result.violations.length) throw new Error(result.violations.map(formatViolation).join('\n'));
  console.log(`check-public-push: OK — ${result.checked} commit(s), identity + history path scan clean`);
} catch (error) {
  console.error(`check-public-push: BLOCKED — ${error.message}`);
  process.exitCode = 1;
}
