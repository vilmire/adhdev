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
import { StringDecoder } from 'node:string_decoder';
import { devNull } from 'node:os';
import { findLeaks, currentUserNames } from './personal-paths.mjs';

export const REQUIRED_NAME = 'vilmire';
export const REQUIRED_EMAIL = 'vilmire@users.noreply.github.com';

const ZERO = /^0+$/;
const KNOWN_PUBLIC_RE = /[:/]vilmire\/adhdev(?:-providers)?(?:\.git)?\/?$/i;

// Only the known private GitHub repository is trusted by URL. Host aliases and
// local/file URLs need explicit remote.<name>.adhdev-private=true configuration.
function isKnownPrivateUrl(url) {
  return /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:git@)?github\.com(?::[0-9]+)?\/|git@github\.com:)vilmire\/adhdev-cloud(?:\.git)?\/?$/i.test(String(url || '').trim());
}

/** Public means not proven private; URL-only classification has no local override. */
export function isPublicRemoteUrl(url) {
  return !isKnownPrivateUrl(url);
}

const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull, GIT_TERMINAL_PROMPT: '0' };

// `env` adds to the replacement/graft isolation; `onStdout` streams decoded text
// instead of buffering the whole output (the resolved value is then '').
function runGit(cwd, args, { input, env, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    // Read the real object graph, irrespective of local replacement refs/grafts.
    const child = spawn('git', ['--no-replace-objects', ...args], {
      cwd, env: { ...process.env, ...GIT_ENV, ...env },
      timeout: args[0] === 'ls-remote' ? 30_000 : undefined,
      windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const decoder = new StringDecoder('utf8');
    let callbackError;
    child.stdout.on('data', (d) => {
      if (!onStdout) return out.push(d);
      try { onStdout(decoder.write(d)); } catch (e) { callbackError = callbackError || e; child.kill(); }
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (callbackError) return reject(callbackError);
      const stdout = onStdout ? '' : Buffer.concat(out).toString('utf-8');
      if (code === 0) { if (onStdout) { try { onStdout(decoder.end()); } catch (e) { return reject(e); } } return resolve(stdout); }
      reject(new Error(`git ${args.slice(0, 3).join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf-8').trim().slice(0, 500)}`));
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const tryGit = async (cwd, args) => { try { return (await runGit(cwd, args)).trim(); } catch { return null; } };

/** All configured and rewritten push destinations; an unreadable config throws. */
export async function pushDestinations(cwd, remoteName = 'origin') {
  // get-url --all applies insteadOf/pushInsteadOf and Git's pushurl/url fallback.
  const urls = (await runGit(cwd, ['remote', 'get-url', '--push', '--all', remoteName])).trim().split('\n').filter(Boolean);
  const pushurls = await tryGit(cwd, ['config', '--get-all', `remote.${remoteName}.pushurl`]);
  const configured = pushurls || await runGit(cwd, ['config', '--get-all', `remote.${remoteName}.url`]);
  if (!urls.length) throw new Error(`no push destinations for ${remoteName}`);
  const all = [...urls, ...configured.trim().split('\n')];
  const explicitlyPrivate = await tryGit(cwd, ['config', '--local', '--bool', '--get', `remote.${remoteName}.adhdev-private`]) === 'true';
  return { urls, isPublic: all.some(url => KNOWN_PUBLIC_RE.test(url)) || (!explicitlyPrivate && all.some(isPublicRemoteUrl)) };
}

// Noninteractive ssh: insert our option before existing options, since ssh uses
// the first value. Keep the executable (including a quoted path) and its arguments.
async function networkEnv(cwd) {
  const env = { GIT_ASKPASS: 'false', SSH_ASKPASS: 'false', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' };
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const ssh = process.env.GIT_SSH_COMMAND || await tryGit(cwd, ['config', '--get', 'core.sshCommand']) || (process.env.GIT_SSH ? quote(process.env.GIT_SSH) : 'ssh');
  const executable = /^(?:"[^"\n]+"|'[^'\n]+'|[^\s'";|&<>]+)(?=\s|$)/.exec(ssh);
  if (!executable) throw new Error('cannot make configured ssh command noninteractive');
  env.GIT_SSH_COMMAND = `${executable[0]} -o BatchMode=yes${ssh.slice(executable[0].length)}`;
  return env;
}

/** Fresh union of commits absent from each actual push destination branch.
 * Unlike the history scan's optional proof, unreadable approval evidence is fatal.
 */
export async function publicPushPendingCommits(cwd, commit, remoteRef, urls) {
  if (!urls.length) throw new Error('no readable push destination');
  const pending = new Set();
  for (const destination of urls) {
    const rewritten = (await runGit(cwd, ['ls-remote', '--get-url', '--', destination])).trim();
    if (rewritten !== destination) throw new Error('push destination would be rewritten during approval lookup');
    const raw = await runGit(cwd, ['ls-remote', '--refs', '--', destination, remoteRef], { env: await networkEnv(cwd) });
    const lines = raw.trim().split('\n').filter(Boolean);
    let remoteSha;
    if (lines.length) {
      const fields = lines[0].split(/\s+/);
      if (lines.length !== 1 || !/^[0-9a-f]{40,64}$/.test(fields[0]) || fields[1] !== remoteRef) throw new Error('invalid destination branch advertisement');
      remoteSha = fields[0];
    }
    for (const sha of await newCommits(cwd, 'origin', commit, remoteSha, [])) pending.add(sha);
  }
  return [...pending];
}

/** Only fresh destination advertisements prove possession, never refs/remotes/*. */
async function advertisedCommits(cwd, destination) {
  try {
    // `destination` is already the URL git pushes to. If url.*.insteadOf would rewrite
    // it AGAIN for ls-remote, the advertisement could come from a different repository:
    // no proof, so scan the full ancestry.
    const rewritten = (await runGit(cwd, ['ls-remote', '--get-url', '--', destination])).trim();
    if (rewritten !== destination) return [];
    const refs = await runGit(cwd, ['ls-remote', '--refs', '--', destination], { env: await networkEnv(cwd) });
    const shas = new Set(refs.split('\n').map((line) => line.split(/\s+/)[0]).filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)));
    return await locallyReadableCommits(cwd, shas);
  } catch {
    return []; // No proof: scan full ancestry (plus any pre-push stdin proof).
  }
}

async function destinationCommits(cwd, remoteName, remoteUrl) {
  // The hook URL identifies the actual destination, even for a differently named
  // remote. A caller without that URL must supply one unambiguous push target.
  let destination = remoteUrl;
  if (!destination) {
    try {
      const { urls } = await pushDestinations(cwd, remoteName);
      if (urls.length === 1) destination = urls[0];
    } catch { /* no destination proof: full ancestry */ }
  }
  return destination ? await advertisedCommits(cwd, destination) : [];
}

// One `cat-file --batch-check` instead of a spawn per sha: a destination with
// thousands of refs (refs/pull/*) must not make the hook take minutes.
async function locallyReadableCommits(cwd, shas) {
  const wanted = [...shas].filter((sha) => sha && !ZERO.test(sha));
  if (!wanted.length) return [];
  const out = await runGit(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: wanted.map((sha) => `${sha}^{commit}`).join('\n') + '\n' });
  return out.split('\n').map((line) => /^([0-9a-f]{40,64}) commit$/.exec(line)?.[1]).filter(Boolean);
}

/** Commits introduced by one pushed ref. Throws when the ref is not a commit. */
export async function newCommits(cwd, remoteName, localSha, remoteSha, provenCommits) {
  const tip = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${localSha}^{commit}`]);
  if (!tip) throw new Error(`cannot resolve ${localSha} to a commit`);
  const proven = provenCommits ?? await destinationCommits(cwd, remoteName);
  const bases = await locallyReadableCommits(cwd, new Set([remoteSha, ...proven]));
  const revisions = [tip, ...bases.map((sha) => `^${sha}`)].join('\n') + '\n';
  return (await runGit(cwd, ['rev-list', '--stdin'], { input: revisions })).split('\n').filter(Boolean);
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
  const raw = await runGit(cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00', '--stdin'], { input: shas.join('\n') + '\n' });
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
  out.push(...await headerViolations(cwd, shas, scan));
  return out;
}

// `%B` hides everything git does not treat as the message: custom headers,
// `mergetag` (an embedded tag object) and `gpgsig` are all published with the
// commit. `rev-list --header` prints the raw buffer, one NUL-terminated record per commit.
async function headerViolations(cwd, shas, scan) {
  if (!shas.length) return [];
  const raw = await runGit(cwd, ['rev-list', '--header', '--no-walk=unsorted', '--stdin'], { input: shas.join('\n') + '\n' });
  const out = [];
  const identityOk = (name, email) => name === REQUIRED_NAME && email === REQUIRED_EMAIL;
  for (const record of raw.split('\0')) {
    const nl = record.indexOf('\n');
    if (nl === -1) continue;
    const sha = record.slice(0, nl).trim();
    const body = record.slice(nl + 1);
    const sep = body.indexOf('\n\n');
    const header = sep === -1 ? body : body.slice(0, sep);
    for (const l of scanText(scan, header)) out.push({ kind: 'path', sha, file: '(commit header)', line: l.line, detail: l.name || l.match });
    // Every author/committer header (a forged duplicate is published too) and every
    // tagger inside an embedded mergetag must be the required identity.
    const lines = header.split('\n');
    const counts = { author: 0, committer: 0 };
    for (const line of lines) {
      const m = /^(author|committer) (.*) <(.*)> \d+ [+-]\d{4}$/.exec(line);
      if (!m) continue;
      // The first of each is what git parsed (%an/%ce, already checked); report only duplicates.
      if (++counts[m[1]] > 1 && !identityOk(m[2], m[3])) out.push({ kind: 'identity', sha, detail: `raw ${m[1]} header is "${m[2]} <${m[3]}>", required "${REQUIRED_NAME} <${REQUIRED_EMAIL}>"` });
    }
    for (const role of ['author', 'committer']) {
      if (counts[role] !== 1) out.push({ kind: 'identity', sha, detail: `expected exactly one ${role} header, found ${counts[role]}` });
    }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('mergetag ')) continue;
      const tagLines = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith(' ')) tagLines.push(lines[++i].slice(1));
      const tagger = /^tagger (.*) <(.*)> \d+ [+-]\d{4}$/m.exec(tagLines.join('\n'));
      if (!tagger || !identityOk(tagger[1], tagger[2])) {
        out.push({ kind: 'identity', sha, detail: `mergetag tagger is ${tagger ? `"${tagger[1]} <${tagger[2]}>"` : 'missing'}, required "${REQUIRED_NAME} <${REQUIRED_EMAIL}>"` });
      }
    }
  }
  return out;
}

const SHA_LINE = /^([0-9a-f]{40,64})(?: \(from [0-9a-f]{40,64}\))?$/;

/**
 * Incremental parser for `diff-tree -p` output: feed text chunks as they arrive,
 * `end()` returns the violations. Only the CURRENT commit's added lines are held,
 * so a 100,000-commit history is never buffered as one string.
 */
export function createDiffTreeParser(scan) {
  const out = [];
  let sha = '';
  let file = '';
  let lineNo = 0;
  let inHunk = false;
  let pending = []; // {text, file, line} for the current commit
  let tail = '';
  const flush = () => {
    if (!pending.length) return;
    const block = pending.map((p) => p.text).join('\n');
    for (const l of scanText(scan, block)) {
      const p = pending[l.line - 1] || pending[0];
      out.push({ kind: 'path', sha, file: p.file, line: p.line, detail: l.name || l.match });
    }
    pending = [];
  };
  const handle = (line) => {
    if (inHunk) {
      const c = line[0];
      if (c === '+') { pending.push({ text: line.slice(1), file, line: lineNo++ }); return; }
      if (c === '-' || c === ' ' || c === '\\') return;
    }
    if (line.startsWith('@@')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      lineNo = h ? Number(h[1]) : 0;
      inHunk = true;
      return;
    }
    inHunk = false;
    const m = SHA_LINE.exec(line);
    if (m) { flush(); sha = m[1]; file = ''; return; }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      file = line.replace(/^diff --\S+ /, '').replace(/^"?a\//, '').split(/ "?b\//)[0];
      pending.push({ text: line.replace(/^diff --\S+ /, ''), file: file || '(file name)', line: 0 });
    }
  };
  return {
    feed(chunk) {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop();
      for (const line of lines) handle(line);
    },
    end() {
      if (tail) handle(tail);
      tail = '';
      flush();
      return out;
    },
  };
}

/** Added lines + file names of the given commits, via the unified-diff grammar. */
export function parseDiffTree(text, scan) {
  const parser = createDiffTreeParser(scan);
  parser.feed(text);
  return parser.end();
}

async function patchViolations(cwd, shas, scan) {
  if (!shas.length) return [];
  const parser = createDiffTreeParser(scan);
  await runGit(cwd, [
    '-c', 'core.quotepath=off',
    'diff-tree', '--stdin', '-r', '-p', '-m', '--root', '-U0', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color',
  ], { input: shas.join('\n') + '\n', onStdout: (chunk) => parser.feed(chunk) });
  return parser.end();
}

// One long-lived `cat-file --batch` for the whole tag walk: one process for any
// chain depth instead of two spawns per level. Requests are strictly sequential.
function openBatchReader(cwd) {
  const child = spawn('git', ['--no-replace-objects', 'cat-file', '--batch'], { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = Buffer.alloc(0);
  let waiter = null;
  let dead = null;
  const settle = () => {
    if (!waiter) return;
    if (dead) { const w = waiter; waiter = null; return w.reject(dead); }
    const nl = buf.indexOf(10);
    if (nl === -1) return;
    const head = buf.subarray(0, nl).toString('utf-8');
    if (head.endsWith(' missing')) { const w = waiter; waiter = null; buf = buf.subarray(nl + 1); return w.resolve(null); }
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(head);
    if (!m) { const w = waiter; waiter = null; return w.reject(new Error(`unexpected cat-file --batch header: ${head.slice(0, 80)}`)); }
    const size = Number(m[3]);
    if (buf.length < nl + 1 + size + 1) return;
    const content = buf.subarray(nl + 1, nl + 1 + size);
    buf = buf.subarray(nl + 1 + size + 1);
    const w = waiter; waiter = null;
    w.resolve({ type: m[2], content });
  };
  child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); settle(); });
  child.on('error', (e) => { dead = e; settle(); });
  child.on('close', (code) => { dead = dead || new Error(`git cat-file --batch exited ${code}`); settle(); });
  child.stdin.on('error', () => {});
  return {
    read(name) {
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; if (dead) return settle(); child.stdin.write(`${name}\n`); });
    },
    close() { try { child.stdin.end(); } catch { /* already closed */ } },
  };
}

/** Annotated tag objects: tagger identity + name/message scan (nested tags too). */
async function tagViolations(reader, objectSha, scan, scanRef) {
  const out = [];
  let cur = objectSha;
  const seen = new Set();
  while (true) {
    if (seen.has(cur)) throw new Error(`cycle in tag chain at ${cur}`);
    if (seen.size >= 100_000) throw new Error('unresolved tag chain exceeds safety bound');
    seen.add(cur);
    const obj = await reader.read(cur);
    if (!obj) throw new Error(`missing object ${cur} in tag chain`);
    if (obj.type !== 'tag') break;
    const raw = obj.content.toString('utf-8');
    const sep = raw.indexOf('\n\n');
    const header = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? '' : raw.slice(sep + 2);
    const tagger = /^tagger (.*) <(.*)> \d+ [+-]\d{4}$/m.exec(header);
    if (!tagger || tagger[1] !== REQUIRED_NAME || tagger[2] !== REQUIRED_EMAIL) {
      out.push({ kind: 'identity', sha: cur, detail: `tagger is ${tagger ? `"${tagger[1]} <${tagger[2]}>"` : 'missing'}, required "${REQUIRED_NAME} <${REQUIRED_EMAIL}>"` });
    }
    for (const l of scanText(scan, `${header.replace(/^tagger .*$/m, '')}\n${message}`)) out.push({ kind: 'path', sha: cur, file: '(tag object)', line: l.line, detail: l.name || l.match });
    const tagName = /^tag (.*)$/m.exec(header);
    if (!tagName) throw new Error(`missing name in tag ${cur}`);
    for (const l of scanRef(tagName[1])) out.push({ kind: 'path', sha: cur, file: '(tag name)', line: l.line, detail: l.name || l.match });
    const next = /^object ([0-9a-f]{40,64})$/m.exec(header);
    if (!next) throw new Error(`unresolved target in tag ${cur}`);
    cur = next[1];
  }
  return out;
}

/**
 * @param entries [{ localRef, localSha, remoteRef, remoteSha }]
 * @returns {Promise<{ violations: object[], checked: number }>}
 */
export async function checkPush(entries, { cwd = process.cwd(), remoteName = 'origin', remoteUrl, findLeaksFn, ownerNames = currentUserNames() } = {}) {
  const names = currentUserNames();
  const scan = findLeaksFn || ((t) => findLeaks(t, names));
  // Ref names have no public repository-owner context: owner account tokens
  // there are identifying, even without a home-directory prefix.
  const refOwners = new Set([REQUIRED_NAME, ...ownerNames]);
  const scanRef = (name) => {
    const hits = scanText(scan, `/${name}`);
    for (const owner of refOwners) {
      const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(name)) hits.push({ line: 1, name: owner });
    }
    return hits;
  };
  const violations = [];
  const seen = new Set();
  let batch;
  const reader = () => (batch ||= openBatchReader(cwd));
  try {
  const active = entries.filter((e) => e.localSha && !ZERO.test(e.localSha));
  const proven = active.length ? await destinationCommits(cwd, remoteName, remoteUrl) : [];
  proven.push(...await locallyReadableCommits(cwd, new Set(entries.map((e) => e.remoteSha))));
  for (const e of entries) {
    if (!e.localSha || ZERO.test(e.localSha)) continue; // deleting a ref pushes no content
    const ref = e.localRef || e.localSha;
    const add = (list) => list.forEach((v) => violations.push({ ...v, ref }));
    for (const l of scanRef(e.remoteRef || '')) add([{ kind: 'path', sha: e.localSha, file: '(destination ref)', line: l.line, detail: l.name || l.match }]);
    if (e.localRef?.startsWith('refs/tags/')) {
      for (const l of scanRef(e.localRef)) add([{ kind: 'path', sha: e.localSha, file: '(tag name)', line: l.line, detail: l.name || l.match }]);
    }
    if (e.localSha !== e.remoteSha) add(await tagViolations(reader(), e.localSha, scan, scanRef));
    const shas = (await newCommits(cwd, remoteName, e.localSha, e.remoteSha, proven)).filter((s) => !seen.has(s));
    shas.forEach((s) => seen.add(s));
    add(await identityViolations(cwd, shas));
    add(await messageViolations(cwd, shas, scan));
    add(await patchViolations(cwd, shas, scan));
  }
  return { violations, checked: seen.size };
  } finally { batch?.close(); }
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
export async function assertPublishableToPublicOss(cwd, commit, { remoteName = 'origin', remoteUrl, remoteRef = 'refs/heads/main' } = {}) {
  const { violations, checked } = await checkPush([{ localRef: commit, localSha: commit, remoteRef, remoteSha: '0'.repeat(40) }], { cwd, remoteName, remoteUrl });
  if (violations.length) {
    throw new Error(`public-oss push guard BLOCKED ${violations.length} violation(s) in ${checked} commit(s):\n${violations.slice(0, 20).map(formatViolation).join('\n')}\n${BLOCKED_HINT}`);
  }
  return { checked };
}
