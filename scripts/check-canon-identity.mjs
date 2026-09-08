#!/usr/bin/env node
/**
 * CANON-IDENTITY regression gate.
 *
 * A daemon answers to the same machine under three interchangeable id forms
 * (`mach_X` / `daemon_mach_X` / `standalone_mach_X` — see
 * packages/mesh-shared/src/daemon-normalize.ts). Raw string comparison of
 * daemon-id-carrying variables has caused a recurring defect class
 * (double-dispatch, dropped completion events, coordinator/worker cross-wire).
 * The sweep is done — this gate keeps new raw comparisons from reappearing.
 *
 * Rules (scanned in packages/{daemon-core,mcp-server,mesh-shared}/src):
 *  1. `a === b` / `a !== b` where either side is a daemonId-ish identifier
 *     (`…daemonId…`, `…DaemonId…`) is an error. Use daemonIdsEquivalent()
 *     (or canonicalDaemonId()/machineCoreFromDaemonId()) instead.
 *     typeof guards (`typeof x === 'string'`) and literal/null/undefined
 *     comparisons are ignored.
 *  2. `list.includes(someDaemonId)` is an error unless the statement shows the
 *     list is form-expanded — receiver named `daemonIds` (convention: built by
 *     expandDaemonIdForms) or an expression containing expandDaemonIdForms /
 *     normalizeCoordinatorDaemonIds / resolveCoordinatorDrainDaemonIds.
 *
 * Escape hatch: append `// canon-ok: <why>` to a line the gate flags when the
 * comparison is genuinely not a machine-identity check.
 *
 * Extra scan roots may be passed as CLI arguments (or ADHDEV_CANON_SCAN_ROOTS,
 * path-separator delimited), resolved against the process cwd. The superproject
 * uses this to also scan proprietary trees that live outside this repository —
 * those paths must never be hard-coded here, since this repo is published on its
 * own and only the defaults above are guaranteed to exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ossRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCAN_ROOTS = [
  'packages/daemon-core/src',
  'packages/mcp-server/src',
  'packages/mesh-shared/src',
].map((p) => join(ossRoot, p));

const extraRootArgs = [
  ...process.argv.slice(2),
  ...(process.env.ADHDEV_CANON_SCAN_ROOTS || '').split(delimiter),
].filter(Boolean);

const extraRoots = extraRootArgs.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));
const missing = extraRoots.filter((p) => !existsSync(p) || !statSync(p).isDirectory());
if (missing.length > 0) {
  console.error('canon-identity gate: scan root(s) not found:');
  for (const p of missing) console.error(`  ${p}`);
  process.exit(1);
}

const SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS, ...extraRoots];

const DAEMON_ID_TOKEN = /[a-zA-Z_$.]*[dD]aemonId[a-zA-Z_$]*/;
const EQ_COMPARISON = new RegExp(
  `(${DAEMON_ID_TOKEN.source})\\s*(?:===|!==)\\s*([a-zA-Z_$.][a-zA-Z0-9_$.]*)` +
  `|([a-zA-Z_$.][a-zA-Z0-9_$.]*)\\s*(?:===|!==)\\s*(${DAEMON_ID_TOKEN.source})`,
);
const INCLUDES_CALL = new RegExp(`([a-zA-Z_$.)\\]]+)\\.includes\\(\\s*(${DAEMON_ID_TOKEN.source})`);
const EXPANDED_LIST_MARKERS = /expandDaemonIdForms|normalizeCoordinatorDaemonIds|resolveCoordinatorDrainDaemonIds|daemonIds\b/;
const NON_IDENTITY_RHS = /^(?:'|"|`|undefined$|null$|true$|false$)/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield full;
  }
}

const findings = [];
for (const root of SCAN_ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('canon-ok')) return;
      const code = line.split('//')[0];
      if (code.includes('typeof ')) return;

      const eq = code.match(EQ_COMPARISON);
      if (eq) {
        const other = eq[2] ?? eq[3];
        if (other && !NON_IDENTITY_RHS.test(other.trim())) {
          findings.push({ file, line: i + 1, text: line.trim(), rule: 'raw ===/!== on a daemonId — use daemonIdsEquivalent()' });
          return;
        }
      }

      const inc = code.match(INCLUDES_CALL);
      if (inc && !EXPANDED_LIST_MARKERS.test(code)) {
        findings.push({ file, line: i + 1, text: line.trim(), rule: '.includes(daemonId) on a non-expanded list — expand with expandDaemonIdForms()' });
      }
    });
  }
}

if (findings.length > 0) {
  console.error(`canon-identity gate: ${findings.length} raw daemon-id comparison(s) found:`);
  for (const f of findings) {
    console.error(`  ${relative(process.cwd(), f.file)}:${f.line} — ${f.rule}`);
    console.error(`      ${f.text}`);
  }
  console.error('Fix with helpers from packages/mesh-shared/src/daemon-normalize.ts, or annotate `// canon-ok: <why>` when not a machine-identity comparison.');
  process.exit(1);
}
console.log('canon-identity gate: no raw daemon-id comparisons');
