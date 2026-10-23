// Personal-path / hostname leak scanner for the PUBLIC oss repo.
//
// Single source: scripts/check-personal-paths.mjs (tree scan) and
// scripts/check-public-push.mjs (history scan) re-use this, and the Refinery's
// oss auto-publish imports it via public-push-guard.mjs. Plain ESM (no TS) so
// the root git hook can load it straight from the checked-out submodule.
//
// What is flagged
//   1. Generic: a home-directory root followed by ANY name that is not in the
//      neutral allow-list below — `/Users/<x>`, `/home/<x>`, `C:\Users\<x>`
//      (also `C:/Users/<x>` and JSON/JS-escaped `C:\\Users\\<x>` with any number
//      of backslashes), matched case-insensitively (`c:\users\x`, `/users/x`),
//      and the dash-encoded form `-Users-<x>-` that agent tools use for project dirs.
//   2. Derived: the CURRENT user's own name (and the owner names callers pass in)
//      in those same positions, so the gate stays correct for any developer.
// NOT flagged: `github.com/<owner>/…` repo identities and package.json
// author/repository fields — public brand, not a home path.
//
// Allow-list: fixture-neutral names only. Add a name here only if it cannot
// identify a person.

import os from 'node:os';
import { basename } from 'node:path';

const NEUTRAL = new Set([
  'dev', 'devuser', 'user', 'username', 'name', 'me', 'you', 'x', 'foo', 'bar', 'test', 'tester',
  'example', 'someone', 'alice', 'bob', 'runner', 'runneradmin', 'root', 'ubuntu', 'admin',
  'shared', 'public', 'default', 'all', 'ci', 'node', 'home', 'u', 'a', 'b', 'w', 'botuser',
  // generic role words used as distinct fixture hosts/accounts
  // fictional accounts used by oss/packages/ghostty-vt-node/test/host-path-scan.test.mjs
  'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', '42',
  'remote', 'local', 'secret', 'peer', 'member', 'owner', 'other', 'gitbash', 'user-evil', 'style',
]);

// Capture group 1 = the whole name segment, INCLUDING interior '.', '-' and '_'
// (`alice.smith`, `dev-x`). Names end at a separator / quote / end; trailing
// sentence dots are trimmed in findLeaks.
const NAME = '([^\\s/\\\\"\'`:;,)\\]}<>*$|{…]+)';
const PATTERNS = [
  new RegExp(`/(?:Users|home)/${NAME}`, 'gi'),
  new RegExp(`[A-Za-z]:(?:\\\\+|/)Users(?:\\\\+|/)${NAME}`, 'gi'),
  /-Users-([A-Za-z0-9._]+?)-/g, // macOS dash-encoded project dir; `-home-…-` is too common in prose
];

// Personal machine hostnames must not appear in the public tree. The owner's FLEET
// names are deliberately NOT listed here — this file is public, so listing them would
// itself publish them. Callers that hold the list (the private root scripts) pass it as
// `knownHosts`; this module always applies the shape rules and the runtime hostname.
//   - A known host name is flagged as a CASE-SENSITIVE WHOLE WORD anywhere (prose,
//     comments, `hostname: X` fields, string literals). Longer words that merely contain
//     it are not whole words.
//   - Case-insensitive host SHAPES are flagged too: `<account>-<Host>`, `<Host>-N`,
//     `*<Host>*.local`, and a quoted literal equal to a host label.
//   - The runtime os.hostname() (and its short form) is flagged as a whole token.
//   - A known name that is also an ordinary word needs the line-level marker
//     `personal-paths-allow: generic-word` (in a comment on the same line).
const HOST_OPT_OUT = 'personal-paths-allow: generic-word';
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![A-Za-z0-9])'; // token boundary before
const A = '(?![A-Za-z0-9])';  // token boundary after

function hostPatterns(known, runtime) {
  const pats = [];
  if (known.length) {
    const alt = known.map(esc).join('|');
    pats.push(
      new RegExp(`${B}[A-Za-z0-9_.]+-(?:${alt})${A}`, 'i'), // <account>-<Host>
      new RegExp(`${B}(?:${alt})-\\d+${A}`, 'i'), // <Host>-N
      new RegExp(`${B}[\\w-]*(?:${alt})[\\w-]*\\.local${A}`, 'i'), // <Host>.local
      new RegExp(`(["'\`])(?:${alt})(?:-\\d+)?\\1`, 'i'), // quoted label
      new RegExp(`${B}(?:${alt})${A}`), // case-sensitive whole word, anywhere
    );
  }
  for (const h of runtime) {
    pats.push(new RegExp(`${B}${esc(h)}${A}`, 'i'));
    pats.push(new RegExp(`${B}${esc(h)}\\.local${A}`, 'i'));
  }
  return pats;
}

function currentHostLabels() {
  const out = new Set();
  try {
    const h = os.hostname().replace(/\.local$/i, '');
    for (const v of [h, h.split('.')[0]]) {
      if (v.length >= 6 && !/^(localhost|runner|ubuntu|github|fv-)/i.test(v)) out.add(v.toLowerCase());
    }
  } catch { /* no hostname */ }
  return out;
}

export function findLeaks(text, extraNames = currentUserNames(), runtimeHosts = [...currentHostLabels()], knownHosts = []) {
  const leaks = [];
  const hostPats = hostPatterns(knownHosts, runtimeHosts);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const hostOptOut = line.includes(HOST_OPT_OUT);
    if (!hostOptOut) for (const re of hostPats) {
      const m = re.exec(line);
      if (m) { leaks.push({ line: i + 1, match: line.trim().slice(0, 80), name: m[0] }); break; }
    }
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const raw = m[1].replace(/\.+$/, '');
        const name = raw.toLowerCase();
        if (!raw || raw.startsWith('~') || raw.startsWith('.')) continue; // `/Users/.`-style truncation fragments carry no name
        const neutral = NEUTRAL.has(name) && !extraNames.has(name);
        if (!neutral) leaks.push({ line: i + 1, match: m[0], name: raw });
      }
    }
    // Derived: a bare mention of the current user's name in a home-path position
    // is already covered above; this catches the encoded-with-other-separators case.
    for (const n of extraNames) {
      if (NEUTRAL.has(n)) continue;
      const needle = new RegExp(`(?:Users|home)[^A-Za-z0-9]{1,4}${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
      if (needle.test(line) && !leaks.some((l) => l.line === i + 1)) leaks.push({ line: i + 1, match: line.trim().slice(0, 80), name: n });
    }
  });
  return leaks;
}

export function currentUserNames() {
  const names = new Set();
  const add = (n) => { if (n && n.length >= 3) names.add(n.toLowerCase()); };
  try { add(os.userInfo().username); } catch { /* no passwd entry */ }
  for (const v of [process.env.HOME, process.env.USERPROFILE]) if (v) add(basename(v.replace(/[\\/]+$/, '')));
  return names;
}

/** Private literals and account/fleet inputs share one scanner in every caller. */
export function findLeaksWithPatterns(text, patterns, extraNames = currentUserNames(), runtimeHosts) {
  const leaks = findLeaks(text, new Set([...extraNames, ...patterns.ownerNames]), runtimeHosts, patterns.knownHosts);
  for (const [index, line] of text.split('\n').entries()) {
    for (const literal of patterns.blockedText || []) {
      if (line.toLowerCase().includes(literal.toLowerCase())) leaks.push({ line: index + 1, match: literal, name: literal });
    }
  }
  return leaks;
}
