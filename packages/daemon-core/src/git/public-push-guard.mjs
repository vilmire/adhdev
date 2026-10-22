// Enforced guard for the PUBLIC oss remote (github.com/vilmire/adhdev).
//
// Nothing may be pushed there unless
//   (1) every pushed commit has author AND committer
//       vilmire <vilmire@users.noreply.github.com> (annotated tags: the tagger), and
//   (2) the personal-path scan passes over the FULL pushed history — every new
//       commit's added lines, message and file paths, not just the tip diff.
//       A path that entered in one commit and was deleted by a later one is
//       still published, so it still blocks.
//
// Plain ESM with no TypeScript so it can be loaded from three places:
//   - the root pre-push hook (scripts/check-public-push.mjs → this file),
//   - the Refinery's oss auto-publish (mesh-refine-gitlink-utils.ts), and
//   - OSS-only clones.
//
// Parsing notes (each one closed a bypass found in review of 9ce39e0de):
//   - Content comes from `git diff-tree --stdin -p --text --no-textconv`, parsed
//     with the unified-diff grammar: inside a hunk EVERY line starts with one of
//     `+ - space \`, so anything else is structure. An added line `++ x` (diff
//     text `+++ x`) is therefore content, never a header, and no in-band marker a
//     file could forge is used to split commits.
//   - `--text` makes binary files and `* -diff` attributes show their bytes; NUL
//     bytes are additionally stripped for a second scan (UTF-16 text).
//   - Messages and identities are read NUL-delimited (git forbids NUL in them).
//   - `diff --git a/<path> b/<path>` lines are scanned: file NAMES leak too.

import { spawn } from 'node:child_process';
import { findLeaks, currentUserNames } from './personal-paths.mjs';

export const REQUIRED_NAME = 'vilmire';
export const REQUIRED_EMAIL = 'vilmire@users.noreply.github.com';

const ZERO = /^0+$/;
const PUBLIC_REMOTE_RE = /[:/]vilmire\/adhdev(?:\.git)?\/?$/i;

/**
 * True for any URL form of the public oss repo, including SSH host aliases
 * (`git@github.com-work:vilmire/adhdev.git`) and ssh-over-443. Not for
 * `vilmire/adhdev-providers`.
 */
export function isPublicRemoteUrl(url) {
  return PUBLIC_REMOTE_RE.test(String(url || '').trim());
}

function runGit(cwd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf-8');
      if (code === 0) return resolve(stdout);
      reject(new Error(`git ${args.slice(0, 3).join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf-8').trim().slice(0, 500)}`));
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const tryGit = async (cwd, args) => { try { return (await runGit(cwd, args)).trim(); } catch { return null; } };

/** Commits introduced by one pushed ref. Throws when the ref is not a commit. */
export async function newCommits(cwd, remoteName, localSha, remoteSha) {
  const tip = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${localSha}^{commit}`]); // peels annotated tags
  if (!tip) throw new Error(`cannot resolve ${localSha} to a commit`);
  const args = ['rev-list', tip, '--not'];
  const remoteKnown = remoteSha && !ZERO.test(remoteSha) && (await tryGit(cwd, ['cat-file', '-e', `${remoteSha}^{commit}`])) !== null;
  if (remoteKnown) args.push(remoteSha);
  else {
    const base = await tryGit(cwd, ['merge-base', tip, `${remoteName}/main`]);
    if (base) args.push(base);
  }
  // Whatever the remote already has is not ours to re-judge.
  args.push(`--remotes=${remoteName}`);
  return (await runGit(cwd, args)).split('\n').filter(Boolean);
}

async function identityViolations(cwd, shas) {
  const out = [];
  for (const rec of await readCommits(cwd, shas)) {
    for (const [role, n, e] of [['author', rec.an, rec.ae], ['committer', rec.cn, rec.ce]]) {
      if (n !== REQUIRED_NAME || e !== REQUIRED_EMAIL) {
        out.push({ kind: 'identity', sha: rec.sha, detail: `${role} is "${n} <${e}>", required "${REQUIRED_NAME} <${REQUIRED_EMAIL}>"` });
      }
    }
  }
  return out;
}

// sha, author, committer and message are NUL-separated: git forbids NUL in all of
// them, so (unlike \x01/\x02 markers) a message can never forge a record edge.
async function readCommits(cwd, shas) {
  if (!shas.length) return [];
  const raw = await runGit(cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00', ...shas]);
  const t = raw.split('\0');
  const recs = [];
  for (let i = 0; i + 5 < t.length; i += 6) {
    recs.push({ sha: t[i].replace(/^\n+/, ''), an: t[i + 1], ae: t[i + 2], cn: t[i + 3], ce: t[i + 4], message: t[i + 5] });
  }
  if (recs.length !== shas.length) throw new Error(`commit metadata parse mismatch: expected ${shas.length}, got ${recs.length}`);
  return recs;
}

/** Scan text; also scan it with NULs removed so UTF-16 text cannot hide a path. */
function scanText(scan, text) {
  const hits = scan(text);
  if (text.includes('\0')) hits.push(...scan(text.replaceAll('\0', '')));
  return hits;
}

async function messageViolations(cwd, shas, scan) {
  const out = [];
  for (const rec of await readCommits(cwd, shas)) {
    for (const l of scanText(scan, rec.message)) out.push({ kind: 'path', sha: rec.sha, file: '(commit message)', line: l.line, detail: l.name || l.match });
  }
  return out;
}

const SHA_LINE = /^([0-9a-f]{40,64})(?: \(from [0-9a-f]{40,64}\))?$/;

/** Added lines + file names of the given commits, via the unified-diff grammar. */
export function parseDiffTree(text, scan) {
  const out = [];
  let sha = '';
  let file = '';
  let lineNo = 0;
  let inHunk = false;
  let pending = []; // {text, file, line} for the current commit
  const flush = () => {
    if (!pending.length) return;
    const block = pending.map((p) => p.text).join('\n');
    for (const l of scanText(scan, block)) {
      const p = pending[l.line - 1] || pending[0];
      out.push({ kind: 'path', sha, file: p.file, line: p.line, detail: l.name || l.match });
    }
    pending = [];
  };
  for (const line of text.split('\n')) {
    if (inHunk) {
      const c = line[0];
      if (c === '+') { pending.push({ text: line.slice(1), file, line: lineNo++ }); continue; }
      if (c === '-' || c === ' ' || c === '\\') continue;
    }
    if (line.startsWith('@@')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      lineNo = h ? Number(h[1]) : 0;
      inHunk = true;
      continue;
    }
    inHunk = false;
    const m = SHA_LINE.exec(line);
    if (m) { flush(); sha = m[1]; file = ''; continue; }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      file = line.replace(/^diff --\S+ /, '').replace(/^"?a\//, '').split(/ "?b\//)[0];
      pending.push({ text: line.replace(/^diff --\S+ /, ''), file: file || '(file name)', line: 0 });
    }
  }
  flush();
  return out;
}

async function patchViolations(cwd, shas, scan) {
  if (!shas.length) return [];
  const raw = await runGit(cwd, [
    '-c', 'core.quotepath=off',
    'diff-tree', '--stdin', '-r', '-p', '-m', '--root', '-U0', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color',
  ], { input: shas.join('\n') + '\n' });
  return parseDiffTree(raw, scan);
}

/** Annotated tag objects: tagger identity + name/message scan (nested tags too). */
async function tagViolations(cwd, objectSha, scan) {
  const out = [];
  let cur = objectSha;
  for (let depth = 0; depth < 8; depth++) {
    if ((await tryGit(cwd, ['cat-file', '-t', cur])) !== 'tag') break;
    const raw = await runGit(cwd, ['cat-file', 'tag', cur]);
    const sep = raw.indexOf('\n\n');
    const header = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? '' : raw.slice(sep + 2);
    const tagger = /^tagger (.*) <(.*)> \d+ [+-]\d{4}$/m.exec(header);
    if (!tagger || tagger[1] !== REQUIRED_NAME || tagger[2] !== REQUIRED_EMAIL) {
      out.push({ kind: 'identity', sha: cur, detail: `tagger is ${tagger ? `"${tagger[1]} <${tagger[2]}>"` : 'missing'}, required "${REQUIRED_NAME} <${REQUIRED_EMAIL}>"` });
    }
    for (const l of scanText(scan, `${header.replace(/^tagger .*$/m, '')}\n${message}`)) out.push({ kind: 'path', sha: cur, file: '(tag object)', line: l.line, detail: l.name || l.match });
    const next = /^object ([0-9a-f]+)$/m.exec(header);
    if (!next) break;
    cur = next[1];
  }
  return out;
}

/**
 * @param entries [{ localRef, localSha, remoteRef, remoteSha }]
 * @returns {Promise<{ violations: object[], checked: number }>}
 */
export async function checkPush(entries, { cwd = process.cwd(), remoteName = 'origin', findLeaksFn } = {}) {
  const names = currentUserNames();
  const scan = findLeaksFn || ((t) => findLeaks(t, names));
  const violations = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e.localSha || ZERO.test(e.localSha)) continue; // deleting a ref pushes no content
    const ref = e.localRef || e.localSha;
    const add = (list) => list.forEach((v) => violations.push({ ...v, ref }));
    if (e.localSha !== e.remoteSha) add(await tagViolations(cwd, e.localSha, scan));
    const shas = (await newCommits(cwd, remoteName, e.localSha, e.remoteSha)).filter((s) => !seen.has(s));
    shas.forEach((s) => seen.add(s));
    add(await identityViolations(cwd, shas));
    add(await messageViolations(cwd, shas, scan));
    add(await patchViolations(cwd, shas, scan));
  }
  return { violations, checked: seen.size };
}

export function formatViolation(v) {
  if (v.kind === 'identity') return `  ${v.sha.slice(0, 12)} [${v.ref}] identity: ${v.detail}`;
  return `  ${v.sha.slice(0, 12)} [${v.ref}] ${v.file}:${v.line}  personal path: ${v.detail}`;
}

export const BLOCKED_HINT = `Required identity: ${REQUIRED_NAME} <${REQUIRED_EMAIL}> (author AND committer). Personal paths in ANY pushed commit block the push even if a later commit removes them — rewrite the unpushed history (git rebase -i / filter-branch) and push again.`;

/**
 * Refinery/auto-publish entry point: throws (message = full report) unless
 * `commit` may be published to the public oss remote. Fail-closed: scan errors throw.
 */
export async function assertPublishableToPublicOss(cwd, commit, { remoteName = 'origin' } = {}) {
  const { violations, checked } = await checkPush([{ localRef: commit, localSha: commit, remoteRef: '', remoteSha: '0'.repeat(40) }], { cwd, remoteName });
  if (violations.length) {
    throw new Error(`public-oss push guard BLOCKED ${violations.length} violation(s) in ${checked} commit(s):\n${violations.slice(0, 20).map(formatViolation).join('\n')}\n${BLOCKED_HINT}`);
  }
  return { checked };
}
